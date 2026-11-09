// Billing reminders (Montek, 2026-11-08). Customers are emailed when an
// invoice is issued, on its due date, and at 3 and 7 days past due;
// quotes get a follow-up at 3 and 7 days after sending. A daily sweep
// on the existing cron sends whatever is due. Every stage is recorded
// in system_state (rem_inv_<id> / rem_quote_<id>) so nothing ever sends
// twice, and the admin Billing tab has manual Send reminder buttons
// that work any time. Reminders stop on their own: the sweep only ever
// looks at sent quotes and unpaid invoices.
import { sendEmail, invoiceIssuedEmail, invoiceReminderEmail, quoteReminderEmail } from "./email.js";
import { audit } from "./access.js";
import { fileInvoiceCopy } from "./projects.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtMoney(cents) {
  return "$" + (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDateUS(iso) {
  const s = String(iso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  return `${MONTHS[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8, 10))}, ${s.slice(0, 4)}`;
}
function origin(env) { return env.APP_ORIGIN || "https://portal.flossbyte.com"; }
function dayNum(dateStr) { return Math.floor(Date.parse(String(dateStr).slice(0, 10) + "T00:00:00Z") / 86400000); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

async function getState(db, key) {
  const r = await db.prepare("SELECT value FROM system_state WHERE key = ?").bind(key).first().catch(() => null);
  return r ? r.value : null;
}
async function setState(db, key, value) {
  await db.prepare(
    "INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, String(value)).run();
}
async function stageOf(db, key) {
  try { return JSON.parse((await getState(db, key)) || "{}"); } catch { return {}; }
}

// Reminder timing, configurable on the Device sync page and stored as
// one JSON row. Each value is a day count; 0 turns that reminder off.
export async function getReminderSettings(db) {
  const dflt = { quote1: 3, quote2: 7, od1: 3, od2: 7 };
  let raw = null;
  try { raw = JSON.parse((await getState(db, "reminder_settings")) || "null"); } catch { raw = null; }
  const pick = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(90, Math.max(0, n)) : d;
  };
  if (!raw || typeof raw !== "object") return dflt;
  return {
    quote1: pick(raw.quote1, dflt.quote1), quote2: pick(raw.quote2, dflt.quote2),
    od1: pick(raw.od1, dflt.od1), od2: pick(raw.od2, dflt.od2),
  };
}

// The org contact is the reminder address (the same inbox that gets the
// quote email); fall back to the main admin login when no contact
// email is on file.
async function recipient(db, customerId) {
  const cust = await db.prepare("SELECT name, contact_name, contact_email FROM customers WHERE id = ?")
    .bind(customerId).first().catch(() => null);
  if (cust && cust.contact_email) return { email: cust.contact_email, name: cust.contact_name || "there" };
  const main = await db.prepare(
    `SELECT u.email, u.name FROM user_access ua JOIN users u ON u.id = ua.user_id
     WHERE ua.customer_id = ? AND ua.is_main_admin = 1 AND u.status = 'active' LIMIT 1`)
    .bind(customerId).first().catch(() => null);
  if (main && main.email) return { email: main.email, name: main.name || "there" };
  return null;
}

export async function sendInvoiceIssued(env, inv) {
  const db = env.DB;
  // Every issued invoice gets its paperwork filed into the office's
  // Documents (projects.js), whether or not the email below can go
  // out. Idempotent: the filed copy is keyed to the invoice.
  await fileInvoiceCopy(env, inv);
  const key = `rem_inv_${inv.id}`;
  const st = await stageOf(db, key);
  if (st.issued) return false;
  const to = await recipient(db, inv.customer_id);
  if (!to) return false;
  const mail = invoiceIssuedEmail(env, {
    name: to.name, invoiceNo: `INV-${1000 + inv.id}`, title: inv.title,
    amount: fmtMoney(inv.amount_cents), dueDate: inv.due_date ? fmtDateUS(inv.due_date) : "",
    isDeposit: inv.kind === "deposit",
    link: `${origin(env)}/app/invoices/${inv.id}`,
  });
  await sendEmail(env, { to: to.email, template: "invoice_issued", ...mail });
  st.issued = new Date().toISOString();
  if (!st.stage) st.stage = 1;
  await setState(db, key, JSON.stringify(st));
  return true;
}

// kind: "reminder" (before the due date), "due" (due today), "overdue".
export async function sendInvoiceReminder(env, inv, kind, daysLate) {
  const to = await recipient(env.DB, inv.customer_id);
  if (!to) return false;
  const mail = invoiceReminderEmail(env, {
    name: to.name, invoiceNo: `INV-${1000 + inv.id}`, title: inv.title,
    amount: fmtMoney(inv.amount_cents), kind, daysLate: daysLate || 0,
    dueDate: inv.due_date ? fmtDateUS(inv.due_date) : "",
    link: `${origin(env)}/app/invoices/${inv.id}`,
  });
  await sendEmail(env, { to: to.email, template: "invoice_reminder", ...mail });
  return true;
}

export async function sendQuoteReminder(env, quote, second) {
  const db = env.DB;
  const to = await recipient(db, quote.customer_id);
  if (!to) return false;
  const t = await db.prepare(
    "SELECT COALESCE(SUM(ROUND(qty * unit_price_cents)), 0) AS total FROM quote_items WHERE quote_id = ?")
    .bind(quote.id).first().catch(() => null);
  const mail = quoteReminderEmail(env, {
    name: to.name, quoteTitle: quote.title,
    total: fmtMoney(t ? t.total : 0), second: !!second,
    link: `${origin(env)}/app/quotes/${quote.id}`,
  });
  await sendEmail(env, { to: to.email, template: "quote_reminder", ...mail });
  return true;
}

// Daily sweep, called from the scheduled handler. Self-guarded by a
// day marker so the quarter-hour cron only runs it once a day.
export async function runBillingReminders(env) {
  const db = env.DB;
  const today = todayStr();
  if ((await getState(db, "reminders_last_run")) === today) return;
  await setState(db, "reminders_last_run", today);
  const now = dayNum(today);
  const cfg = await getReminderSettings(db);

  const { results: quotes } = await db.prepare(
    "SELECT * FROM quotes WHERE status = 'sent' AND sent_at IS NOT NULL").all().catch(() => ({ results: [] }));
  for (const q of quotes || []) {
    try {
      const age = now - dayNum(q.sent_at);
      const due = cfg.quote2 > 0 && age >= cfg.quote2 ? 2 : cfg.quote1 > 0 && age >= cfg.quote1 ? 1 : 0;
      const key = `rem_quote_${q.id}`;
      const st = await stageOf(db, key);
      if (due > (st.stage || 0) && await sendQuoteReminder(env, q, due === 2)) {
        st.stage = due;
        st.at = new Date().toISOString();
        await setState(db, key, JSON.stringify(st));
        await audit(db, null, "reminder_sent", "quote", q.id,
          due === 2 ? `Quote follow-up (${cfg.quote2} days)` : `Quote follow-up (${cfg.quote1} days)`);
      }
    } catch { /* one bad row never stops the sweep */ }
  }

  const { results: invoices } = await db.prepare(
    "SELECT * FROM invoices WHERE status = 'unpaid'").all().catch(() => ({ results: [] }));
  for (const inv of invoices || []) {
    try {
      const key = `rem_inv_${inv.id}`;
      const st = await stageOf(db, key);
      let stage = st.stage || 0;
      let issuedNow = false;
      // The issued email only fires while the invoice is fresh; older
      // unpaid invoices are the manual button's job, not a surprise
      // "new invoice" email weeks later.
      if (!st.issued && now - dayNum(inv.created_at) <= 2) {
        if (await sendInvoiceIssued(env, inv)) {
          issuedNow = true;
          stage = Math.max(stage, 1);
          await audit(db, null, "reminder_sent", "invoice", inv.id, "Invoice issued email");
        }
      }
      if (inv.due_date && !issuedNow) {
        const late = now - dayNum(inv.due_date);
        // Stage 2 is the due-date reminder: it fires on the due date
        // itself (one day of grace for a missed run). After that, only
        // the configured overdue stages fire; 0 turns a stage off.
        const due = late < 0 ? 0
          : cfg.od2 > 0 && late >= cfg.od2 ? 4
          : cfg.od1 > 0 && late >= cfg.od1 ? 3
          : late <= 1 ? 2 : 0;
        if (due > stage && await sendInvoiceReminder(env, inv, due === 2 ? "due" : "overdue", Math.max(late, 0))) {
          const st2 = await stageOf(db, key);
          st2.stage = due;
          st2.at = new Date().toISOString();
          await setState(db, key, JSON.stringify(st2));
          await audit(db, null, "reminder_sent", "invoice", inv.id,
            due === 2 ? "Invoice due-date reminder" : `Invoice overdue reminder (${late} days past due)`);
        }
      }
    } catch { /* keep sweeping */ }
  }
}
