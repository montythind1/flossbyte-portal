// Stripe payments for portal invoices (Montek, 2026-11-07).
// The customer pays on Stripe's own checkout page; the portal never sees
// a card number. Stripe calls /api/stripe/webhook when a payment lands,
// and the invoice flips to paid on its own. Keys live only as Worker
// secrets: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. Without them the
// portal behaves exactly as before (a pasted payment link, or mark-paid
// by hand on the admin side).

import { audit } from "./access.js";
import { sendEmail, wrap } from "./email.js";

export function stripeOn(env) {
  return !!(env.STRIPE_SECRET_KEY && String(env.STRIPE_SECRET_KEY).trim());
}

function apiBase(env) {
  return String(env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, "");
}

// Starts a Stripe Checkout session for one unpaid invoice and returns the
// session (its .url is where the customer is sent to pay). The invoice id
// rides in the session metadata and as the client reference, which is how
// the webhook later knows which invoice a payment belongs to. The
// idempotency key is per invoice, amount, and day, so a double click
// reuses the same session instead of opening two checkouts.
export async function createInvoiceCheckout(env, inv, orgName, origin) {
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", `${origin}/app/invoices/${inv.id}?paid=1`);
  params.set("cancel_url", `${origin}/app/invoices/${inv.id}`);
  params.set("client_reference_id", String(inv.id));
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][unit_amount]", String(inv.amount_cents));
  params.set("line_items[0][price_data][product_data][name]", `INV-${1000 + inv.id} - ${inv.title}`);
  if (orgName) params.set("line_items[0][price_data][product_data][description]", orgName);
  params.set("metadata[invoice_id]", String(inv.id));
  params.set("payment_intent_data[metadata][invoice_id]", String(inv.id));
  const day = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${apiBase(env)}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `flossbyte-inv-${inv.id}-${inv.amount_cents}-${day}`,
      "User-Agent": "FlossBytePortal/1.0",
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.url) {
    throw new Error(`Stripe answered ${res.status} when starting checkout`);
  }
  return data;
}

// ---------- Recurring monthly plans ----------
// A plan's live state sits in system_state under `stripe_plan_<orgId>` as
// JSON ({sub, cus, status, amountCents, quoteId, at, lastPaidAt}), so no
// table changes are needed and the webhook can find the organization
// again from a bare subscription id.

async function getState(db, key) {
  try {
    const row = await db.prepare("SELECT value FROM system_state WHERE key = ?").bind(key).first();
    return row ? row.value : null;
  } catch { return null; }
}

async function setState(db, key, value) {
  await db.prepare(
    "INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value).run();
}

export async function getPlanState(db, orgId) {
  const raw = await getState(db, `stripe_plan_${orgId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function savePlanState(db, orgId, patch) {
  const prev = (await getPlanState(db, orgId)) || {};
  await setState(db, `stripe_plan_${orgId}`, JSON.stringify({ ...prev, ...patch }));
}

async function findOrgBySubscription(db, subId) {
  if (!subId) return null;
  const { results } = await db.prepare(
    "SELECT key, value FROM system_state WHERE key LIKE 'stripe_plan_%'")
    .all().catch(() => ({ results: [] }));
  for (const row of results || []) {
    let st = null;
    try { st = JSON.parse(row.value); } catch { /* skip unreadable rows */ }
    if (st && st.sub === subId) {
      return { orgId: Number(String(row.key).slice("stripe_plan_".length)), state: st };
    }
  }
  return null;
}

// Starts a subscription-mode Checkout session for an accepted plan
// quote: the customer enters a card once and Stripe charges it monthly.
// The org and quote ids ride in both the session metadata and the
// subscription metadata, so later subscription events can be matched
// back to the plan even without the session.
export async function createPlanCheckout(env, quote, totalCents, orgName, origin) {
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("success_url", `${origin}/app/billing?plan=started`);
  params.set("cancel_url", `${origin}/app/quotes/${quote.id}`);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][unit_amount]", String(totalCents));
  params.set("line_items[0][price_data][product_data][name]", quote.title);
  if (orgName) params.set("line_items[0][price_data][product_data][description]", orgName);
  params.set("line_items[0][price_data][recurring][interval]", "month");
  params.set("metadata[portal_customer_id]", String(quote.customer_id));
  params.set("metadata[quote_id]", String(quote.id));
  params.set("subscription_data[metadata][portal_customer_id]", String(quote.customer_id));
  params.set("subscription_data[metadata][quote_id]", String(quote.id));
  const day = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${apiBase(env)}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `flossbyte-plan-${quote.id}-${totalCents}-${day}`,
      "User-Agent": "FlossBytePortal/1.0",
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.url) {
    throw new Error(`Stripe answered ${res.status} when starting plan checkout`);
  }
  return data;
}

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtUsd(cents) {
  return "$" + (Number(cents || 0) / 100).toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function alertPlanFailed(env, orgId, amountDue) {
  const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?")
    .bind(orgId).first().catch(() => null);
  const orgName = cust ? cust.name : `Organization ${orgId}`;
  let recipients = [];
  if (env.ADMIN_ALERT_EMAIL) {
    recipients = [env.ADMIN_ALERT_EMAIL];
  } else {
    const { results } = await env.DB.prepare(
      "SELECT email FROM users WHERE kind = 'flossbyte' AND status = 'active'")
      .all().catch(() => ({ results: [] }));
    recipients = (results || []).map((r) => r.email).filter(Boolean);
  }
  const html = wrap("A monthly plan payment failed",
    `<p>The monthly Stripe payment for <strong>${escHtml(orgName)}</strong> did not go through.</p>
     <p>Amount due: <strong>${fmtUsd(amountDue)}</strong></p>
     <p>The plan is marked "Payment failed" on the client's Billing page and in the admin console until a payment succeeds.</p>`);
  const text = `The monthly Stripe payment for ${orgName} did not go through. Amount due: ${fmtUsd(amountDue)}.`;
  for (const to of recipients) {
    await sendEmail(env, {
      to, template: "stripe_plan_failed",
      subject: "A monthly plan payment failed", html, text,
    }).catch(() => {});
  }
}

// Stripe's signature scheme: HMAC-SHA256 over "<t>.<raw body>", hex,
// compared in constant time against every v1 value in the
// Stripe-Signature header. Events older than five minutes are refused.
async function verifySignature(secret, payload, header) {
  if (!header) return false;
  let t = "";
  const sigs = [];
  for (const part of String(header).split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!t || !sigs.length) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => {
    if (s.length !== hex.length) return false;
    let diff = 0;
    for (let i = 0; i < hex.length; i++) diff |= s.charCodeAt(i) ^ hex.charCodeAt(i);
    return diff === 0;
  });
}

// POST /api/stripe/webhook (public; the signature is the credential).
// On a completed, fully paid one-time checkout whose amount matches the
// invoice, the invoice is marked paid with method "card (Stripe)" and
// the payment lands in the Activity log. Subscription checkouts instead
// record the plan's live state; each paid monthly invoice from Stripe
// lands in the portal as a paid invoice of its own. Anything else is
// acknowledged and ignored, so Stripe does not retry events the portal
// does not act on. Plan branches are individually guarded: a failure in
// one must never cost the 200 that stops Stripe retrying.
export async function stripeWebhook(env, request) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook is not configured.", { status: 400 });
  const raw = await request.text();
  const ok = await verifySignature(secret, raw, request.headers.get("Stripe-Signature"));
  if (!ok) return new Response("Signature check failed.", { status: 400 });
  let event = null;
  try { event = JSON.parse(raw); } catch { return new Response("Bad payload.", { status: 400 }); }
  const type = (event && event.type) || "";
  const obj = (event && event.data && event.data.object) || {};
  if (type === "checkout.session.completed" && obj.mode === "subscription") {
    try {
      const orgId = Number((obj.metadata && obj.metadata.portal_customer_id) || 0);
      if (orgId) {
        await savePlanState(env.DB, orgId, {
          sub: obj.subscription || null,
          cus: obj.customer || null,
          status: "active",
          amountCents: Number(obj.amount_total || 0),
          quoteId: Number((obj.metadata && obj.metadata.quote_id) || 0) || null,
          at: new Date().toISOString(),
        });
      }
    } catch { /* ack anyway; Stripe must not retry */ }
  } else if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    const s = obj;
    if (s.mode !== "subscription" &&
        (s.payment_status === "paid" || type === "checkout.session.async_payment_succeeded")) {
      const invoiceId = Number((s.metadata && s.metadata.invoice_id) || s.client_reference_id || 0);
      if (invoiceId) {
        const inv = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?")
          .bind(invoiceId).first().catch(() => null);
        if (inv && inv.status === "unpaid" && Number(s.amount_total) === Number(inv.amount_cents)) {
          await env.DB.prepare(
            "UPDATE invoices SET status = 'paid', paid_at = datetime('now'), paid_method = ?, updated_at = datetime('now') WHERE id = ?")
            .bind("card (Stripe)", invoiceId).run();
          await audit(env.DB, null, "invoice_paid", "invoice", invoiceId,
            "Stripe payment " + (s.payment_intent || ""));
        }
      }
    }
  } else if (type === "invoice.paid" && obj.subscription) {
    try {
      const found = await findOrgBySubscription(env.DB, obj.subscription);
      if (found) {
        const dedupKey = `stripe_in_${obj.id}`;
        if (!(await getState(env.DB, dedupKey))) {
          const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
          const when = new Date(Number(obj.created || 0) * 1000);
          const title = `Monthly plan - ${MONTHS[when.getUTCMonth()]} ${when.getUTCFullYear()}`;
          await env.DB.prepare(
            `INSERT INTO invoices (customer_id, quote_id, title, kind, amount_cents, status, paid_at, paid_method, created_by)
             VALUES (?, ?, ?, 'standard', ?, 'paid', datetime('now'), 'card (Stripe plan)', NULL)`)
            .bind(found.orgId, found.state.quoteId || null, title, Number(obj.amount_paid || 0)).run();
          await setState(env.DB, dedupKey, new Date().toISOString());
        }
        await savePlanState(env.DB, found.orgId, {
          status: "active", lastPaidAt: new Date().toISOString(),
        });
      }
    } catch { /* ack anyway; Stripe must not retry */ }
  } else if (type === "invoice.payment_failed" && obj.subscription) {
    try {
      const found = await findOrgBySubscription(env.DB, obj.subscription);
      if (found) {
        await savePlanState(env.DB, found.orgId, { status: "past_due" });
        await alertPlanFailed(env, found.orgId, obj.amount_due);
      }
    } catch { /* ack anyway; Stripe must not retry */ }
  } else if (type === "customer.subscription.deleted") {
    try {
      const found = await findOrgBySubscription(env.DB, obj.id);
      if (found) await savePlanState(env.DB, found.orgId, { status: "canceled" });
    } catch { /* ack anyway; Stripe must not retry */ }
  }
  return Response.json({ received: true });
}
