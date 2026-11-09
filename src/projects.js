// One-Time Project flow: the project record behind the product switch,
// its progress stages, the paperwork it files into Documents, and the
// stage emails the customer gets as the job moves.
//
// A project is one row per location (projects table), bound to the
// location's project quote. Quotes are organization-level in this
// portal, so the binding is a resolution rule, not a column on the
// quote: the project's quote is the latest sent/accepted/declined
// project quote for the organization, persisted on the project row
// once resolved. With two offices running projects at once, both
// would resolve to the same newest quote; that is a known limit of
// org-level quotes, not something to paper over here.
//
// Storage follows the ensureGeniusProduct precedent: the Worker
// creates what it needs idempotently at runtime (ensureProjectSchema,
// called on every signed-in request), so there is no manual D1 step.
// migrations/0015_one_time_projects.sql is the written record.
import { productEnabled, geniusEnabled, audit } from "./access.js";
import { sendEmail, projectStageEmail } from "./email.js";
import { esc, fmtDateUS } from "./layout.js";

// ---------- Schema (self-converging, no manual step) ----------
let projectSchemaEnsured = false;
export async function ensureProjectSchema(db) {
  if (projectSchemaEnsured) return;
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        location_id INTEGER NOT NULL UNIQUE REFERENCES locations(id),
        quote_id INTEGER REFERENCES quotes(id),
        name TEXT,
        scheduled_date TEXT,
        in_progress_at TEXT,
        work_complete_date TEXT,
        support_days INTEGER NOT NULL DEFAULT 30,
        finished INTEGER NOT NULL DEFAULT 0,
        finished_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects (customer_id)").run();
    // SOW attachment and SOW acceptance live on the quote itself.
    // SQLite has no ADD COLUMN IF NOT EXISTS; a duplicate-column error
    // just means the column is already there.
    for (const col of ["sow_r2_key TEXT", "sow_name TEXT", "sow_mime TEXT", "sow_size INTEGER",
                       "sow_accepted_at TEXT", "sow_accepted_by TEXT"]) {
      try { await db.prepare(`ALTER TABLE quotes ADD COLUMN ${col}`).run(); } catch { /* already there */ }
    }
    projectSchemaEnsured = true;
  } catch { /* schema not there yet (pre-migration env): retry on the next request */ }
}

// ---------- Small date helpers (date-only math, UTC) ----------
function dayNum(dateStr) { return Math.floor(Date.parse(String(dateStr).slice(0, 10) + "T00:00:00Z") / 86400000); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtMoney(cents) {
  return "$" + (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------- Recipients ----------
// The org's customer admins: the same definition the request
// confirmation flow uses (role customer_admin, anyone not disabled;
// an invited admin still has a working inbox).
export async function customerAdmins(db, customerId) {
  try {
    const { results } = await db.prepare(
      `SELECT DISTINCT u.id, u.name, u.email FROM user_access ua JOIN users u ON u.id = ua.user_id
       WHERE ua.customer_id = ? AND u.kind = 'customer' AND u.role = 'customer_admin' AND u.status != 'disabled'`)
      .bind(customerId).all();
    return results || [];
  } catch { return []; }
}

// ---------- Project rows ----------
export async function getProjectRow(db, locationId) {
  try {
    return await db.prepare("SELECT * FROM projects WHERE location_id = ?").bind(locationId).first();
  } catch { return null; }
}

export async function getOrCreateProject(db, loc) {
  const existing = await getProjectRow(db, loc.id);
  if (existing) return existing;
  await db.prepare("INSERT INTO projects (customer_id, location_id) VALUES (?, ?)")
    .bind(loc.customer_id, loc.id).run();
  return getProjectRow(db, loc.id);
}

// A project record must exist whenever One-Time Project is on for an
// office, however the switch got turned on. The Products-tab toggle
// creates it (onOtpToggledOn), but the create-organization wizard
// writes the product rows directly and never did, which left
// wizard-created offices with the switch on and no tracker anywhere.
// This is the converging half, in the ensureGeniusProduct spirit:
// called on the reads where a missing record is visible (the office
// rail, the project page) and at wizard completion, it inserts a
// fresh row only when the switch is effectively on for the office
// and no row exists. An existing row, finished or not, is returned
// untouched, and no row is ever created while the switch is off.
// It sends no email: the activation email belongs to real toggle
// transitions only.
export async function ensureProjectForLocation(db, customerId, locationId) {
  try {
    await ensureProjectSchema(db);
    const existing = await getProjectRow(db, locationId);
    if (existing) return existing;
    if (!(await productEnabled(db, customerId, locationId, "one_time_project"))) return null;
    const loc = await db.prepare("SELECT id, customer_id FROM locations WHERE id = ? AND customer_id = ?")
      .bind(locationId, customerId).first().catch(() => null);
    if (!loc) return null;
    return getOrCreateProject(db, loc);
  } catch { return null; }
}

// Days of post-install support remaining once work is marked complete:
// the full X on the completion day itself, counting down to zero.
export function supportRemaining(project) {
  if (!project || !project.work_complete_date) return null;
  const x = Math.max(1, Number(project.support_days || 30));
  return x - (dayNum(todayStr()) - dayNum(project.work_complete_date));
}
export function projectExpired(project) {
  const left = supportRemaining(project);
  return left !== null && left <= 0;
}
export function supportEndDate(project) {
  if (!project || !project.work_complete_date) return null;
  const end = new Date(Date.parse(String(project.work_complete_date).slice(0, 10) + "T00:00:00Z")
    + Math.max(1, Number(project.support_days || 30)) * 86400000);
  return end.toISOString().slice(0, 10);
}

// Is the project lane live at this office right now? The product
// switch says on, and the project has not finished. Expiry is computed
// from the dates on every check, so access ends the day the window
// closes even before anything flips the stored switch off.
export async function otpProjectActive(db, customerId, locationId) {
  if (!(await productEnabled(db, customerId, locationId, "one_time_project"))) return false;
  const proj = await getProjectRow(db, locationId);
  if (!proj) return true;
  if (proj.finished) return false;
  if (projectExpired(proj)) return false;
  return true;
}

// Genius at an office: its own switch, or an active One-Time Project
// running there. The bundle is the project's gift, not a switch
// change: when the project finishes, the office falls back to whatever
// its own Genius switch says.
export async function geniusAvailable(db, customerId, locationId) {
  if (await geniusEnabled(db, customerId, locationId)) return true;
  return otpProjectActive(db, customerId, locationId);
}

// ---------- Quote binding and money ----------
export async function loadProjectQuote(db, quoteId, customerId) {
  if (!quoteId) return null;
  const quote = await db.prepare("SELECT * FROM quotes WHERE id = ? AND customer_id = ?")
    .bind(quoteId, customerId).first().catch(() => null);
  if (!quote) return null;
  const { results: items } = await db.prepare(
    "SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort, id").bind(quoteId).all().catch(() => ({ results: [] }));
  const total = (items || []).reduce((s, i) => s + Math.round(i.qty * i.unit_price_cents), 0);
  return { quote, items: items || [], total };
}

// The project's quote: the stored binding when it still points at a
// live quote, else the organization's latest project quote that has
// left draft. The resolved id is written back so invoice hooks can
// find the project by quote id without resolving again.
export async function resolveBoundQuote(db, project) {
  if (!project) return null;
  if (project.quote_id) {
    const bound = await loadProjectQuote(db, project.quote_id, project.customer_id);
    if (bound && ["sent", "accepted", "declined"].includes(bound.quote.status)) return bound;
  }
  const latest = await db.prepare(
    `SELECT id FROM quotes WHERE customer_id = ? AND kind = 'project'
     AND status IN ('sent','accepted','declined') ORDER BY id DESC LIMIT 1`)
    .bind(project.customer_id).first().catch(() => null);
  if (!latest) return null;
  if (Number(latest.id) !== Number(project.quote_id)) {
    await db.prepare("UPDATE projects SET quote_id = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(latest.id, project.id).run().catch(() => {});
    project.quote_id = latest.id;
  }
  return loadProjectQuote(db, latest.id, project.customer_id);
}

export async function projectMoney(db, quoteId) {
  const { results } = await db.prepare(
    "SELECT * FROM invoices WHERE quote_id = ? AND status != 'void' ORDER BY id").bind(quoteId).all().catch(() => ({ results: [] }));
  const invoices = results || [];
  const deposits = invoices.filter((i) => i.kind === "deposit");
  const deposit = deposits.length ? deposits[deposits.length - 1] : null;
  const anyDepositPaid = deposits.some((i) => i.status === "paid");
  const paidSum = invoices.filter((i) => i.status === "paid").reduce((s, i) => s + Number(i.amount_cents || 0), 0);
  return { invoices, deposit, anyDepositPaid, paidSum };
}

// 'none' when the quote carries no deposit, 'waiting' while money is
// still owed on it, 'paid' once a deposit invoice shows paid.
export function depositState(quote, money) {
  if (!quote || quote.status !== "accepted") return "none";
  if (!money || (!money.deposit && !(Number(quote.deposit_percent || 0) > 0))) return "none";
  if (money && money.anyDepositPaid) return "paid";
  return "waiting";
}

// ---------- Stage derivation ----------
// Auto stages read the quote and its invoices; manual stages read the
// admin-set fields on the project row. One key out, used for the
// next-step line and the admin controls alike.
export function deriveStage(project, quote, money) {
  if (!quote) return "pre";
  if (quote.status === "declined") return "declined";
  if (project && project.finished) return "finished";
  if (project && project.work_complete_date) return projectExpired(project) ? "finished" : "support";
  if (project && project.in_progress_at) return "in_progress";
  if (project && project.scheduled_date) return "scheduled";
  if (quote.status === "accepted") {
    const dep = depositState(quote, money);
    if (dep === "waiting") return "waiting_deposit";
    if (dep === "paid") return "deposit_paid";
    return "accepted";
  }
  return "waiting_customer";
}

// The bar: one entry per stage with a state of done, current, or
// todo. Deposit stages only exist when the quote actually carries a
// deposit. A declined quote ends the bar where it stands.
export function projectSteps(project, quote, money, stage) {
  if (!quote) return [];
  if (quote.status === "declined") {
    return [
      { label: "Quote sent", state: "done" },
      { label: "Waiting on customer", state: "done" },
      { label: "Declined", state: "declined" },
    ];
  }
  const dep = depositState(quote, money);
  const accepted = quote.status === "accepted";
  const steps = [
    { label: "Quote sent", done: true },
    { label: "Waiting on customer", done: accepted },
    { label: "Accepted", done: accepted },
  ];
  if (dep !== "none") {
    steps.push({ label: "Waiting for deposit", done: dep === "paid" });
    steps.push({ label: "Deposit paid", done: dep === "paid" });
  }
  steps.push({ label: "Scheduled", done: !!(project && project.scheduled_date) });
  steps.push({ label: "In progress", done: !!(project && project.in_progress_at) });
  steps.push({ label: "Work complete", done: !!(project && project.work_complete_date) });
  steps.push({ label: "Post-install support", done: stage === "finished" });
  steps.push({ label: "Finished", done: stage === "finished" });
  let currentSet = false;
  return steps.map((s) => {
    if (s.done) return { label: s.label, state: "done" };
    if (!currentSet) { currentSet = true; return { label: s.label, state: "current" }; }
    return { label: s.label, state: "todo" };
  });
}

export function projectName(project, quote) {
  if (project && project.name) return project.name;
  if (quote) return quote.title;
  return "One-Time Project";
}

// ---------- Filed documents ----------
// Generated paperwork lives in R2 under a stable generated/ key, so
// re-filing (an invoice flipping to paid) replaces the same document
// row instead of piling up copies. Filed rows are FlossByte-class for
// the delete rule: uploaded_by is a FlossByte login when one is known,
// and a missing uploader counts as FlossByte's on the delete check.
async function flossbyteUploader(db, userId) {
  if (!userId) return null;
  const u = await db.prepare("SELECT kind FROM users WHERE id = ?").bind(userId).first().catch(() => null);
  return u && u.kind === "flossbyte" ? userId : null;
}

async function putFiledDoc(env, { locationId, name, r2Key, body, size, mime, uploadedBy }) {
  if (env.DOCS) {
    await env.DOCS.put(r2Key, body, { httpMetadata: { contentType: mime || "application/octet-stream" } });
  }
  const existing = await env.DB.prepare("SELECT id FROM documents WHERE r2_key = ?")
    .bind(r2Key).first().catch(() => null);
  if (existing) {
    await env.DB.prepare("UPDATE documents SET name = ?, mime = ?, size = ? WHERE id = ?")
      .bind(name, mime || null, size || null, existing.id).run();
    return existing.id;
  }
  const res = await env.DB.prepare(
    "INSERT INTO documents (location_id, name, r2_key, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(locationId, name, env.DOCS ? r2Key : null, mime || null, size || null, uploadedBy || null).run();
  return res.meta.last_row_id;
}

function docShell(title, inner) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1F2D3D;margin:0;padding:32px;background:#fff}
.wrap{max-width:680px;margin:0 auto}.brand{background:#0A1628;color:#fff;padding:16px 22px;border-radius:8px}
.brand b{font-size:18px}.brand span{display:block;color:#7FD8C8;font-size:10px;letter-spacing:2px;margin-top:2px}
h1{font-size:20px;color:#0A1628;margin:22px 0 4px}table{border-collapse:collapse;width:100%;margin:14px 0}
td,th{padding:7px 10px;border-bottom:1px solid #E1E7ED;text-align:left;font-size:14px}.num{text-align:right}
.muted{color:#5B6B82;font-size:13px}pre{white-space:pre-wrap;font-family:inherit;font-size:14px}</style></head>
<body><div class="wrap"><div class="brand"><b>FlossByte</b><span>DENTAL IT SUPPORT</span></div>${inner}</div></body></html>`;
}

export function quoteCopyHtml(quote, items, total, customerName) {
  const rows = (items || []).map((i) =>
    `<tr><td>${esc(i.description)}</td><td class="num">${esc(String(i.qty))}</td><td class="num">${fmtMoney(i.unit_price_cents)}</td><td class="num">${fmtMoney(Math.round(i.qty * i.unit_price_cents))}</td></tr>`).join("");
  const accepted = quote.status === "accepted"
    ? `<p>Accepted by ${esc(quote.accepted_by || "")} on ${esc(fmtDateUS(quote.accepted_at || ""))}.${quote.sow_accepted_at ? " The attached Statement of Work was accepted with this quote." : ""}</p>` : "";
  const deposit = Number(quote.deposit_percent || 0) > 0
    ? `<p class="muted">Deposit: ${quote.deposit_percent}% (${fmtMoney(Math.round(total * quote.deposit_percent / 100))}) due on acceptance.</p>` : "";
  return docShell(`Quote: ${quote.title}`, `
    <h1>${esc(quote.title)}</h1>
    <p class="muted">Quote from FlossByte for ${esc(customerName || "")}. Filed in the portal when the quote was accepted.</p>
    ${accepted}
    <table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p><strong>Total: ${fmtMoney(total)}</strong></p>${deposit}
    ${quote.terms ? `<h3>Terms</h3><pre>${esc(quote.terms)}</pre>` : ""}`);
}

export function invoiceCopyHtml(inv, customerName) {
  const no = `INV-${1000 + inv.id}`;
  const kind = inv.kind === "deposit" ? "Deposit" : inv.kind === "final" ? "Final balance" : "Invoice";
  const status = inv.status === "paid"
    ? `Paid on ${esc(fmtDateUS(inv.paid_at || ""))}${inv.paid_method ? " by " + esc(inv.paid_method) : ""}`
    : inv.status === "void" ? "Void" : "Unpaid";
  return docShell(`Invoice ${no}`, `
    <h1>${no}</h1>
    <p class="muted">${esc(inv.title)}</p>
    <table><tbody>
    <tr><td>Billed to</td><td>${esc(customerName || "")}</td></tr>
    <tr><td>Type</td><td>${kind}</td></tr>
    <tr><td>Amount</td><td><strong>${fmtMoney(inv.amount_cents)}</strong></td></tr>
    <tr><td>Status</td><td>${status}</td></tr>
    ${inv.due_date ? `<tr><td>Due</td><td>${esc(fmtDateUS(inv.due_date))}</td></tr>` : ""}
    </tbody></table>
    <p class="muted">Kept in the portal Documents for this office. The live invoice, with payment options while it is unpaid, is on the Billing page.</p>`);
}

// Where an invoice's paperwork files: the office whose project the
// invoice belongs to when it hangs off a project quote, otherwise the
// organization's first office.
export async function invoiceFilingLocation(db, inv) {
  if (inv.quote_id) {
    const proj = await db.prepare("SELECT location_id FROM projects WHERE quote_id = ?")
      .bind(inv.quote_id).first().catch(() => null);
    if (proj) return proj.location_id;
  }
  const loc = await db.prepare("SELECT id FROM locations WHERE customer_id = ? ORDER BY id LIMIT 1")
    .bind(inv.customer_id).first().catch(() => null);
  return loc ? loc.id : null;
}

// File (or re-file) the portal's copy of one invoice. Called when the
// invoice is issued and again when it is paid, so the Documents copy
// always shows the invoice's current state, one document per invoice.
export async function fileInvoiceCopy(env, inv) {
  try {
    const locationId = await invoiceFilingLocation(env.DB, inv);
    if (!locationId) return;
    const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(inv.customer_id).first().catch(() => null);
    const html = invoiceCopyHtml(inv, cust ? cust.name : "");
    const name = `Invoice INV-${1000 + inv.id}: ${inv.title}${inv.status === "paid" ? " (Paid)" : ""}`;
    await putFiledDoc(env, {
      locationId, name, r2Key: `generated/invoice-${inv.id}.html`,
      body: html, size: new TextEncoder().encode(html).length, mime: "text/html",
      uploadedBy: await flossbyteUploader(env.DB, inv.created_by),
    });
  } catch { /* filing is best-effort; it never blocks billing */ }
}

// On quote acceptance: file the SOW as-is and a copy of the quote
// into the project's office (or the first office for a project quote
// with no project switched on yet), and send the acceptance stage
// email when a live project is bound to this quote.
export async function onQuoteAccepted(env, quoteId, signerName) {
  try {
    const db = env.DB;
    const loadedQuote = await db.prepare("SELECT * FROM quotes WHERE id = ?").bind(quoteId).first();
    if (!loadedQuote || loadedQuote.status !== "accepted") return;
    const loaded = await loadProjectQuote(db, quoteId, loadedQuote.customer_id);
    if (!loaded) return;
    // Find the office whose project this quote belongs to.
    let project = null, projectLoc = null;
    const { results: locs } = await db.prepare("SELECT * FROM locations WHERE customer_id = ? ORDER BY id")
      .bind(loadedQuote.customer_id).all().catch(() => ({ results: [] }));
    for (const loc of locs || []) {
      if (!(await productEnabled(db, loadedQuote.customer_id, loc.id, "one_time_project"))) continue;
      const proj = await getOrCreateProject(db, loc);
      const bound = await resolveBoundQuote(db, proj);
      if (bound && Number(bound.quote.id) === Number(quoteId)) { project = proj; projectLoc = loc; break; }
    }
    const fileLoc = projectLoc || (loadedQuote.kind === "project" ? (locs || [])[0] : null);
    if (fileLoc) {
      const uploadedBy = await flossbyteUploader(db, loadedQuote.created_by);
      if (loadedQuote.sow_r2_key && env.DOCS) {
        const obj = await env.DOCS.get(loadedQuote.sow_r2_key).catch(() => null);
        if (obj) {
          await putFiledDoc(env, {
            locationId: fileLoc.id,
            name: loadedQuote.sow_name || "Statement of Work.pdf",
            r2Key: `generated/quote-${quoteId}-sow`,
            body: obj.body, size: obj.size || loadedQuote.sow_size || null,
            mime: loadedQuote.sow_mime || "application/pdf", uploadedBy,
          });
        }
      }
      const cust = await db.prepare("SELECT name FROM customers WHERE id = ?").bind(loadedQuote.customer_id).first().catch(() => null);
      const html = quoteCopyHtml(loaded.quote, loaded.items, loaded.total, cust ? cust.name : "");
      await putFiledDoc(env, {
        locationId: fileLoc.id, name: `Quote: ${loadedQuote.title}`,
        r2Key: `generated/quote-${quoteId}.html`,
        body: html, size: new TextEncoder().encode(html).length, mime: "text/html", uploadedBy,
      });
    }
    if (project && projectLoc) {
      const money = await projectMoney(db, quoteId);
      const dep = depositState(loaded.quote, money);
      const depAmount = money && money.deposit ? fmtMoney(money.deposit.amount_cents)
        : fmtMoney(Math.round(loaded.total * (Number(loadedQuote.deposit_percent || 0)) / 100));
      const lines = [
        `${esc(signerName || "Your practice admin")} accepted the quote${loadedQuote.sow_r2_key ? " and the Statement of Work" : ""} for <strong>${esc(projectName(project, loaded.quote))}</strong>. The accepted paperwork is filed in this office's Documents.`,
        dep === "waiting"
          ? `A deposit invoice of ${depAmount} is on the Billing page. Work is scheduled once the deposit is paid.`
          : dep === "paid"
            ? "The deposit is already in, so the next step is scheduling."
            : "No deposit is due on this quote. The next step is scheduling, and the date will show on the project page.",
      ];
      await sendProjectStageEmail(env, project, projectLoc, "accepted", "Project accepted", lines);
    }
  } catch { /* acceptance already happened; filing and email are best-effort */ }
}

// An invoice tied to a project quote was paid: refresh its filed copy
// to the paid version and send the payment stage email, once per
// invoice. Non-project invoices just get their filed copy refreshed
// (fileInvoiceCopy, called by the caller).
export async function onInvoicePaid(env, inv) {
  try {
    await fileInvoiceCopy(env, inv);
    if (!inv.quote_id) return;
    const found = await findProjectForQuote(env.DB, inv.customer_id, inv.quote_id);
    if (!found) return;
    const { project, loc } = found;
    const loaded = await loadProjectQuote(env.DB, inv.quote_id, inv.customer_id);
    if (!loaded) return;
    const money = await projectMoney(env.DB, inv.quote_id);
    const pct = loaded.total > 0 ? Math.round(100 * (money ? money.paidSum : 0) / loaded.total) : 0;
    let headline, lines;
    if (pct >= 100) {
      headline = "Paid in full";
      lines = [`The quote for <strong>${esc(projectName(project, loaded.quote))}</strong> is now paid in full (${fmtMoney(loaded.total)}). The paid invoices are filed in this office's Documents.`];
    } else if (inv.kind === "deposit") {
      headline = "Deposit received";
      lines = [
        `We received the deposit of ${fmtMoney(inv.amount_cents)} for <strong>${esc(projectName(project, loaded.quote))}</strong>. That is ${pct}% of the quote paid so far.`,
        "Next step: FlossByte confirms the schedule, and the date will show on the project page.",
      ];
    } else {
      headline = "Payment received";
      lines = [`We received a payment of ${fmtMoney(inv.amount_cents)} toward <strong>${esc(projectName(project, loaded.quote))}</strong>. That is ${pct}% of the quote paid so far.`];
    }
    await sendProjectStageEmail(env, project, loc, `paid_invoice_${inv.id}`, headline, lines);
  } catch { /* the payment already landed; email is best-effort */ }
}

// Locate the project bound to a quote id, resolving bindings for the
// organization's project offices as needed.
export async function findProjectForQuote(db, customerId, quoteId) {
  try {
    const direct = await db.prepare("SELECT * FROM projects WHERE customer_id = ? AND quote_id = ?")
      .bind(customerId, quoteId).first().catch(() => null);
    if (direct) {
      const loc = await db.prepare("SELECT * FROM locations WHERE id = ?").bind(direct.location_id).first().catch(() => null);
      if (loc) return { project: direct, loc };
    }
    const { results: locs } = await db.prepare("SELECT * FROM locations WHERE customer_id = ? ORDER BY id")
      .bind(customerId).all().catch(() => ({ results: [] }));
    for (const loc of locs || []) {
      if (!(await productEnabled(db, customerId, loc.id, "one_time_project"))) continue;
      const proj = await getProjectRow(db, loc.id);
      if (!proj || proj.finished) continue;
      const bound = await resolveBoundQuote(db, proj);
      if (bound && Number(bound.quote.id) === Number(quoteId)) return { project: proj, loc };
    }
  } catch { /* projects table may not exist yet in webhook isolates */ }
  return null;
}

// ---------- Stage emails ----------
// One email per stage transition to the org's customer admins. The
// send is recorded in the audit log under a per-transition key and
// checked before sending, so a lazy finalization, a repeat POST, or
// a redriven webhook can never send the same stage twice.
export async function sendProjectStageEmail(env, project, loc, key, headline, linesHtml, subjectOverride) {
  try {
    const db = env.DB;
    const seen = await db.prepare(
      "SELECT id FROM audit_log WHERE action = 'project_stage_email' AND entity = 'project' AND entity_id = ? AND detail = ?")
      .bind(project.id, key).first().catch(() => null);
    if (seen) return false;
    const admins = await customerAdmins(db, loc.customer_id);
    if (!admins.length) return false;
    for (const ca of admins) {
      const mail = projectStageEmail(env, {
        name: ca.name, locationName: loc.name, headline, linesHtml, subjectOverride,
        link: `${env.APP_ORIGIN || "https://portal.flossbyte.com"}/app/locations/${loc.id}/products/one_time_project`,
      });
      await sendEmail(env, { to: ca.email, template: "project_stage", ...mail });
    }
    await audit(db, null, "project_stage_email", "project", project.id, key);
    return true;
  } catch { return false; }
}

// ---------- Finish ----------
// Flip a project whose support window has closed: mark it finished,
// switch One-Time Project off for the office (a location-level row,
// so an org-wide switch stays on for the other offices), audit it,
// and tell the customer admins it ended. Access itself is computed
// from the dates everywhere it matters, so this flip is bookkeeping
// the portal converges on, not a gate.
export async function finalizeProject(env, project, actorId) {
  const db = env.DB;
  if (!project || project.finished) return project;
  await db.prepare(
    "UPDATE projects SET finished = 1, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .bind(project.id).run();
  const existing = await db.prepare(
    "SELECT id FROM customer_products WHERE customer_id = ? AND location_id = ? AND product = 'one_time_project'")
    .bind(project.customer_id, project.location_id).first().catch(() => null);
  if (existing) {
    await db.prepare("UPDATE customer_products SET enabled = 0, updated_at = datetime('now') WHERE id = ?").bind(existing.id).run();
  } else {
    await db.prepare(
      "INSERT INTO customer_products (customer_id, location_id, product, enabled, plan_note) VALUES (?, ?, 'one_time_project', 0, NULL)")
      .bind(project.customer_id, project.location_id).run();
  }
  await audit(db, actorId || null, "project_finished", "project", project.id, `location ${project.location_id}`);
  const fresh = await getProjectRow(db, project.location_id);
  const loc = await db.prepare("SELECT * FROM locations WHERE id = ?").bind(project.location_id).first().catch(() => null);
  if (fresh && loc) {
    const managed = await productEnabled(db, project.customer_id, project.location_id, "managed_it");
    const bound = await resolveBoundQuote(db, fresh).catch(() => null);
    const lines = [
      `The project <strong>${esc(projectName(fresh, bound ? bound.quote : null))}</strong> at this office is complete and closed.`,
      managed
        ? "Your Managed IT service continues as before. The project page stays up as the record of the work."
        : "The access that came with the project (Genius, Equipment, and Tickets for this office) has ended. The project page stays up as the record of the work.",
      "The quote, the Statement of Work, and the invoices stay in this office's Documents.",
    ];
    await sendProjectStageEmail(env, fresh, loc, "finished", "Project finished", lines);
  }
  return fresh;
}

// Cron sweep: finalize every project whose window has closed. Each
// row is independent; one bad row never stops the sweep.
export async function runProjectFinalizer(env) {
  try {
    await ensureProjectSchema(env.DB);
    const { results } = await env.DB.prepare(
      "SELECT * FROM projects WHERE finished = 0 AND work_complete_date IS NOT NULL").all();
    for (const proj of results || []) {
      try { if (projectExpired(proj)) await finalizeProject(env, proj, null); } catch { /* keep sweeping */ }
    }
  } catch { /* schema not there yet: next run retries */ }
}

// Turning One-Time Project on for an office: a finished project from
// a past job resets to a fresh record, and the customer admins get
// the activation email. Called from the product toggle only when the
// switch actually transitions to on.
export async function onOtpToggledOn(env, customerId, locationId, actorId) {
  try {
    const db = env.DB;
    await ensureProjectSchema(db);
    let loc = null;
    const locSql = `SELECT l.*, c.name AS customer_name FROM locations l JOIN customers c ON c.id = l.customer_id`;
    if (locationId) {
      loc = await db.prepare(`${locSql} WHERE l.id = ? AND l.customer_id = ?`).bind(locationId, customerId).first().catch(() => null);
    } else {
      loc = await db.prepare(`${locSql} WHERE l.customer_id = ? ORDER BY l.id LIMIT 1`).bind(customerId).first().catch(() => null);
    }
    if (!loc) return;
    const proj = await getOrCreateProject(db, loc);
    if (proj.finished) {
      await db.prepare(
        `UPDATE projects SET finished = 0, finished_at = NULL, quote_id = NULL, name = NULL,
         scheduled_date = NULL, in_progress_at = NULL, work_complete_date = NULL,
         support_days = 30, updated_at = datetime('now') WHERE id = ?`).bind(proj.id).run();
      await audit(db, actorId || null, "project_restart", "project", proj.id, `location ${loc.id}`);
    }
    const fresh = await getProjectRow(db, loc.id);
    const lines = [
      `One-Time Project is now on for <strong>${esc(loc.name)}</strong>. While the project runs, this office has a project page with the quote, the progress, and the paperwork in one place.`,
      "Tickets, Equipment, and Genius are open for this office while the project is active. Nothing about your other services changes.",
    ];
    // The toggle's own off-to-on transition check is the once-guard
    // for this one (a project row can be activated again after a
    // restart), so the audit key carries the moment, not the stage.
    await sendProjectStageEmail(env, fresh, loc,
      `activated_${Date.now()}`, "One-Time Project is on", lines,
      locationId ? `One-Time Project is on for ${loc.name}` : `One-Time Project is on for ${loc.customer_name || loc.name}`);
  } catch { /* the toggle already landed; the email is best-effort */ }
}
