// Stripe payments for portal invoices (Montek, 2026-11-07).
// The customer pays on Stripe's own checkout page; the portal never sees
// a card number. Stripe calls /api/stripe/webhook when a payment lands,
// and the invoice flips to paid on its own. Keys live only as Worker
// secrets: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. Without them the
// portal behaves exactly as before (a pasted payment link, or mark-paid
// by hand on the admin side).

import { audit } from "./access.js";

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
// On a completed, fully paid checkout whose amount matches the invoice,
// the invoice is marked paid with method "card (Stripe)" and the payment
// lands in the Activity log. Anything else is acknowledged and ignored,
// so Stripe does not retry events the portal does not act on.
export async function stripeWebhook(env, request) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook is not configured.", { status: 400 });
  const raw = await request.text();
  const ok = await verifySignature(secret, raw, request.headers.get("Stripe-Signature"));
  if (!ok) return new Response("Signature check failed.", { status: 400 });
  let event = null;
  try { event = JSON.parse(raw); } catch { return new Response("Bad payload.", { status: 400 }); }
  const type = (event && event.type) || "";
  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    const s = (event.data && event.data.object) || {};
    if (s.payment_status === "paid" || type === "checkout.session.async_payment_succeeded") {
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
  }
  return Response.json({ received: true });
}
