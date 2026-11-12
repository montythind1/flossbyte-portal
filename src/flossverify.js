import { esc } from "./layout.js";

// FlossVerify data layer: verification requests (one per patient
// visit) and the benefit breakdown recorded for each. The checking
// itself is done by a person today; an eligibility API (Toothfairy or
// similar) plugs into the same tables later, writing the same
// breakdown shape. Until patient data lives somewhere covered by a
// HIPAA agreement, only invented test patients belong in these tables.

export const FV_STATUSES = {
  waiting: "Waiting",
  in_progress: "In progress",
  verified: "Verified",
  problem: "Problem",
};
export const FV_PILL = { waiting: "", in_progress: "warn", verified: "on", problem: "off" };

// True once migration 0018 has been applied. Every FlossVerify surface
// checks this first so the portal runs cleanly before the tables land.
export async function fvReady(db) {
  try {
    const r = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fv_requests'").first();
    return !!r;
  } catch { return false; }
}

// ---------- Dates: the queue covers 2 weeks back to 2 weeks ahead ----------
export function isoDay(d) {
  return d.toISOString().slice(0, 10);
}
export function addDaysISO(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}
export function todayISO() { return isoDay(new Date()); }

// Reads ?from / ?to, defaults to the whole window, and clamps both
// ends into [today - 14, today + 14] so a hand-typed URL cannot pull
// the list outside the two-weeks-either-way window.
export function fvRange(searchParams) {
  const today = todayISO();
  const lo = addDaysISO(today, -14);
  const hi = addDaysISO(today, 14);
  const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");
  let from = ok(searchParams.get("from")) ? searchParams.get("from") : lo;
  let to = ok(searchParams.get("to")) ? searchParams.get("to") : hi;
  if (from < lo) from = lo;
  if (from > hi) from = hi;
  if (to < lo) to = lo;
  if (to > hi) to = hi;
  if (from > to) { const t = from; from = to; to = t; }
  return { from, to, lo, hi, today };
}

// "09:30" (24h, as stored) to "9:30 AM"; anything else passes through.
export function fmtTime(t) {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t || "";
  let h = Number(m[1]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-11-12" to "Thu, Nov 12"
export function fmtApptDay(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || "";
  const d = new Date(iso + "T00:00:00Z");
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

// ---------- Breakdown shape ----------
// The rows a finished verification reports, in the order the office
// reads them. Values are plain text ("100%", "2 per year", "Not
// covered") so a person can fill them today and an API can fill the
// same keys tomorrow.
export const BREAKDOWN_SECTIONS = [
  { title: "What this plan pays", fields: [
    ["pct_preventive", "Preventive & diagnostic"],
    ["pct_basic", "Basic (fillings, extractions)"],
    ["pct_major", "Major (crowns, root canals)"],
    ["implants", "Implants"],
    ["ortho", "Orthodontics"],
  ]},
  { title: "Frequencies & limits", fields: [
    ["exams", "Exams"],
    ["cleanings", "Cleanings"],
    ["bitewings", "Bitewing x-rays"],
    ["fmx", "Full-mouth x-ray / pano"],
    ["fluoride", "Fluoride"],
    ["crown_replacement", "Crown replacement"],
    ["waiting_basic", "Waiting period, basic"],
    ["waiting_major", "Waiting period, major"],
    ["missing_tooth", "Missing tooth clause"],
    ["downgrade", "Posterior composites"],
  ]},
];
export function parseBreakdownRows(b) {
  if (!b || !b.rows_json) return {};
  try { const o = JSON.parse(b.rows_json); return o && typeof o === "object" ? o : {}; }
  catch { return {}; }
}
export function breakdownHasContent(b) {
  if (!b) return false;
  if (b.coverage_active != null || b.deductible_cents != null || b.max_cents != null ||
      b.est_patient_cents != null || b.verified_at) return true;
  return Object.values(parseBreakdownRows(b)).some((v) => String(v || "").trim());
}

// ---------- Shared rendering (client queue + admin inbox) ----------
export function fvPill(status) {
  return `<span class="pill ${FV_PILL[status] || ""}">${esc(FV_STATUSES[status] || status)}</span>`;
}
// The queue as one table: Name / Insurance / Date / Status, whole row
// clickable (same pattern as Equipment). hrefFor(row) gives each
// row's breakdown page.
export function fvTable(rows, hrefFor, officeCol) {
  const body = rows.map((r) => `<tr class="eqrow" data-href="${hrefFor(r)}">
    <td><span style="font-weight:700">${esc(r.patient_name)}</span>${r.is_test ? ` <span class="pill warn">Test</span>` : ""}</td>
    <td>${esc(r.carrier || "")}${r.plan_name ? `<br><span class="muted">${esc(r.plan_name)}</span>` : ""}</td>
    ${officeCol ? `<td>${esc(r.location_name || "")}<br><span class="muted">${esc(r.customer_name || "")}</span></td>` : ""}
    <td>${esc(fmtApptDay(r.appt_date))}${r.appt_time ? `<br><span class="muted">${esc(fmtTime(r.appt_time))}</span>` : ""}</td>
    <td>${fvPill(r.status)}</td></tr>`).join("");
  return `<div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Name</th><th>Insurance</th>${officeCol ? "<th>Office</th>" : ""}<th>Date</th><th>Status</th></tr></thead>
    <tbody>${body || `<tr><td colspan="${officeCol ? 5 : 4}" class="muted">No visits in this date range.</td></tr>`}</tbody></table></div></div>
    <script>document.querySelectorAll("tr.eqrow").forEach(function(tr){tr.addEventListener("click",function(ev){if(ev.target.closest("a,button,input,select,textarea,label"))return;var h=tr.getAttribute("data-href");if(h)location.href=h;});});</script>`;
}

// ---------- Queries ----------
export async function listRequests(db, where, binds, from, to) {
  const { results } = await db.prepare(
    `SELECT r.*, l.name AS location_name, c.name AS customer_name
     FROM fv_requests r
     JOIN locations l ON l.id = r.location_id
     JOIN customers c ON c.id = r.customer_id
     WHERE ${where} AND r.appt_date >= ? AND r.appt_date <= ?
     ORDER BY r.appt_date ASC, r.appt_time ASC, r.id ASC`)
    .bind(...binds, from, to).all();
  return results || [];
}
export async function getRequest(db, id) {
  return db.prepare("SELECT * FROM fv_requests WHERE id = ?").bind(id).first();
}
export async function getBreakdown(db, requestId) {
  return db.prepare("SELECT * FROM fv_breakdowns WHERE request_id = ?").bind(requestId).first();
}
export async function countTestRows(db, locationId) {
  const r = await db.prepare(
    "SELECT COUNT(*) AS n FROM fv_requests WHERE location_id = ? AND is_test = 1").bind(locationId).first();
  return r ? r.n : 0;
}
export async function countRequests(db, locationId) {
  const r = await db.prepare(
    "SELECT COUNT(*) AS n FROM fv_requests WHERE location_id = ?").bind(locationId).first();
  return r ? r.n : 0;
}

// ---------- Test patients ----------
// Clearly invented people covering every state the queue shows, dated
// relative to today so they always land inside the two-week window.
// Seeding is skipped when the office already has any requests, so it
// can never bury real work. Returns how many were inserted.
export async function seedFvTestData(db, customerId, locationId) {
  if ((await countRequests(db, locationId)) > 0) return 0;
  const t = todayISO();
  const people = [
    { name: "TEST Patient Five", dob: "1988-04-17", member: "TEST-1005", sub: null, rel: null,
      carrier: "Delta Dental", plan: "PPO Premier", group: "00482", phone: "(800) 555-0142",
      off: -2, time: "11:00", provider: "Dr. Patel", treat: "Exam, cleaning",
      status: "verified",
      bd: { active: 1, eff: "2026-01-01", ded: 5000, dedMet: 5000, max: 150000, maxUsed: 64000, est: 0,
        rows: { pct_preventive: "100%", pct_basic: "80%", pct_major: "50%", implants: "Not covered", ortho: "Not covered",
          exams: "2 per year", cleanings: "2 per year", bitewings: "1 per year", fmx: "Every 3 years, last Jun 2025",
          fluoride: "Covered to age 14", crown_replacement: "Replace after 7 years", waiting_basic: "None",
          waiting_major: "12 months", missing_tooth: "Yes, applies", downgrade: "Paid as amalgam" },
        method: "Payer portal", ref: "7731-08" } },
    { name: "TEST Patient One", dob: "1990-06-12", member: "TEST-1001", sub: null, rel: null,
      carrier: "Delta Dental", plan: "PPO Plus", group: "00917", phone: "(800) 555-0142",
      off: 1, time: "09:00", provider: "Dr. Patel", treat: "Cleaning, exam, 1 filling",
      status: "verified",
      bd: { active: 1, eff: "2026-01-01", ded: 5000, dedMet: 3800, max: 200000, maxUsed: 76000, est: 6400,
        rows: { pct_preventive: "100%", pct_basic: "80%", pct_major: "50%", implants: "Not covered", ortho: "Not covered",
          exams: "2 per year", cleanings: "2 per year", bitewings: "1 per year", fmx: "Every 3 years, last Mar 2024",
          fluoride: "Covered to age 16", crown_replacement: "Replace after 7 years", waiting_basic: "None",
          waiting_major: "12 months", missing_tooth: "Yes, applies", downgrade: "Paid as amalgam" },
        method: "Payer portal", ref: "8841-22" } },
    { name: "TEST Patient Two", dob: "1985-11-03", member: "TEST-1002", sub: "TEST Spouse Two", rel: "Spouse",
      carrier: "Cigna", plan: "Dental PPO", group: "77120", phone: "(800) 555-0119",
      off: 1, time: "10:30", provider: "Dr. Patel", treat: "Crown consult",
      status: "in_progress",
      bd: { active: 1, eff: "2026-03-01", ded: null, dedMet: null, max: null, maxUsed: null, est: null,
        rows: {}, method: "Payer portal", ref: "" } },
    { name: "TEST Patient Three", dob: "1979-02-25", member: "TEST-1003", sub: null, rel: null,
      carrier: "MetLife", plan: "PDP Plus", group: "55231", phone: "(800) 555-0163",
      off: 1, time: "13:00", provider: "Dr. Patel", treat: "Exam, x-rays",
      status: "problem",
      problem: "Coverage ended Oct 31, 2026. No active plan found under this member ID. Ask the patient for their new insurance card before the visit." },
    { name: "TEST Patient Four", dob: "1996-08-30", member: "TEST-1004", sub: null, rel: null,
      carrier: "Aetna", plan: "Dental DMO", group: "30118", phone: "(800) 555-0127",
      off: 2, time: "08:00", provider: "Dr. Patel", treat: "New patient exam",
      status: "waiting" },
    { name: "TEST Patient Six", dob: "2001-01-19", member: "TEST-1006", sub: null, rel: null,
      carrier: "Guardian", plan: "DentalGuard Preferred", group: "90844", phone: "(800) 555-0190",
      off: 7, time: "14:30", provider: "Dr. Patel", treat: "Cleaning, exam",
      status: "waiting" },
  ];
  let n = 0;
  for (const p of people) {
    const res = await db.prepare(
      `INSERT INTO fv_requests (customer_id, location_id, patient_name, patient_dob, member_id,
        subscriber_name, subscriber_dob, relationship, carrier, plan_name, group_number, payer_phone,
        appt_date, appt_time, provider, planned_treatment, status, problem_note, is_test)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .bind(customerId, locationId, p.name, p.dob, p.member, p.sub, p.rel, p.carrier, p.plan,
        p.group, p.phone, addDaysISO(t, p.off), p.time, p.provider, p.treat, p.status, p.problem || null)
      .run();
    const id = res.meta.last_row_id;
    n++;
    if (p.bd) {
      await db.prepare(
        `INSERT INTO fv_breakdowns (request_id, coverage_active, effective_date, deductible_cents,
          deductible_met_cents, max_cents, max_used_cents, est_patient_cents, rows_json,
          verified_by, verified_at, method, payer_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'FlossByte (test data)', datetime('now'), ?, ?)`)
        .bind(id, p.bd.active, p.bd.eff, p.bd.ded, p.bd.dedMet, p.bd.max, p.bd.maxUsed, p.bd.est,
          JSON.stringify(p.bd.rows), p.bd.method, p.bd.ref).run();
    }
  }
  return n;
}

// Removes only the invented patients (is_test = 1) for one office.
// Returns how many were removed.
export async function removeFvTestData(db, locationId) {
  const before = await countTestRows(db, locationId);
  if (!before) return 0;
  await db.prepare(
    `DELETE FROM fv_breakdowns WHERE request_id IN
       (SELECT id FROM fv_requests WHERE location_id = ? AND is_test = 1)`).bind(locationId).run();
  await db.prepare(
    "DELETE FROM fv_requests WHERE location_id = ? AND is_test = 1").bind(locationId).run();
  return before;
}
