// FlossByte admin console: clients, locations, product switches, logins,
// pending signups, and (Super Admin only) admin account management.
import { page, redirect, esc, icon, fmtDateUS, withStatus } from "./layout.js";
import { createAuthToken, revokeAllSessions, verifyPassword, normalizePhone, splitName, joinName } from "./auth.js";
import { audit, isSuperAdmin, grantUserAccess, findCustomerByContactEmail, isValidEmail, productEnabled, geniusEnabled } from "./access.js";
import { onOtpToggledOn, onInvoicePaid, ensureProjectForLocation } from "./projects.js";
import { sendEmail, wrap, inviteEmail, newCustomerNoticeEmail, ownershipTransferEmail, quoteSentEmail } from "./email.js";
import { sendInvoiceIssued, sendInvoiceReminder, sendQuoteReminder, getReminderSettings } from "./reminders.js";
import { resendInviteEmail } from "./pages-public.js";
import { runUnifiSync, lastUnifiSync } from "./unifi.js";
import { runSophosSync, lastSophosSync } from "./sophos.js";
import { runAteraSync, lastAteraSync } from "./atera.js";
import { chatReady, getThread, threadMessages, addChatMessage, endChat, briefHtml, renderChatMessages, relTimeChat, notifyCustomerReply, setTyping, clearTyping, getTyping } from "./chat.js";
import { mergeEquipmentRows } from "./merge.js";
import { getPlanState } from "./stripe.js";

function origin(env) { return env.APP_ORIGIN || "https://portal.flossbyte.com"; }
function q(request) { return new URL(request.url).searchParams; }
function fmtMoney(cents) {
  return "$" + (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parseDollarsToCents(v) {
  const n = parseFloat(String(v || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
// Default quote terms, prefilled in the builder and editable per quote.
// Draft wording: Montek reviews and adjusts before a quote is sent.
const PROJECT_TERMS = "The deposit is due before work is scheduled, and scheduling happens once the deposit payment is received. The remaining balance is due when the work above is complete.";
const PLAN_TERMS = "Service is billed monthly at the amount above, starting on the service start date agreed with FlossByte. The service agreement and business associate agreement signed with FlossByte govern the service.";

// App shell opener: renders the left rail (desktop) / chip bar (phone)
// and opens the content column. The shell divs are closed implicitly by
// the end of <main> in layout.js, the same pattern the whole portal uses.
function adminNav(active) {
  const item = (key, href, label, ic) =>
    `<a class="rail-item${active === key ? " active" : ""}" href="${href}">${icon(ic)}${label}</a>`;
  return `<div class="shell"><aside class="rail">
    <div class="rail-context"><div class="rc-t">FlossByte</div><div class="rc-s">Admin console</div></div>
    ${item("clients", "/admin", "Clients", "users")}${item("tickets", "/admin/tickets", "Tickets", "ticket")}${item("chats", "/admin/chats", "Live chat", "chat")}
    ${item("admins", "/admin/admins", "Admins", "shield")}
    ${item("sync", "/admin/sync", "Device sync", "refresh")}${item("activity", "/admin/activity", "Activity", "activity")}</aside><div class="shell-main">`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;

// ---------- Clients list (with Needs Attention + search) ----------
export async function clientsPage(env, request, user) {
  const db = env.DB;
  const query = (new URL(request.url).searchParams.get("q") || "").trim();
  // Needs Attention: the day in one card. Every count is one query away.
  const expRows = (await db.prepare(
    `SELECT e.vendor, e.model, e.type, e.name, e.license_expires, e.warranty_expires, l.id AS loc_id, l.name AS loc_name, c.name AS cust_name
     FROM equipment e JOIN locations l ON l.id = e.location_id JOIN customers c ON c.id = l.customer_id
     WHERE date(e.license_expires) <= date('now', '+90 days') OR date(e.warranty_expires) <= date('now', '+90 days')
     ORDER BY MIN(COALESCE(e.license_expires, '9999'), COALESCE(e.warranty_expires, '9999')) LIMIT 50`).all()).results || [];
  const todayStr = new Date().toISOString().slice(0, 10);
  const expAll = expRows.map((e) => {
    const kind = e.license_expires && (!e.warranty_expires || e.license_expires <= e.warranty_expires) ? "License" : "Warranty";
    return { ...e, kind, date: kind === "License" ? e.license_expires : e.warranty_expires };
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const expiredItems = expAll.filter((e) => e.date && e.date < todayStr);
  const expiringItems = expAll.filter((e) => e.date && e.date >= todayStr);
  const expList = (items) => `<ul style="margin:0;padding-left:18px">${items.slice(0, 5).map((e) => `<li><a href="/app/locations/${e.loc_id}/equipment">${esc(e.vendor || "")} ${esc(e.model || e.type || "Equipment")}</a> <span class="muted">${esc(e.cust_name)} · ${e.kind.toLowerCase()} ${esc(fmtDateUS(e.date))}</span></li>`).join("")}</ul>`;
  const openTickets = (await db.prepare(
    `SELECT t.id, t.title, t.priority, t.status, l.id AS loc_id, l.name AS loc_name, c.name AS cust_name
     FROM tickets t JOIN locations l ON l.id = t.location_id JOIN customers c ON c.id = l.customer_id
     WHERE t.status != 'closed' ORDER BY t.updated_at DESC LIMIT 5`).all()).results || [];
  const openTicketCount = await db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status != 'closed'").first();
  const unpaid = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total FROM invoices WHERE status = 'unpaid'").first().catch(() => ({ n: 0, total: 0 }));
  const unpaidRows = (await db.prepare(
    `SELECT i.id, i.title, i.amount_cents, c.id AS cust_id, c.name AS cust_name FROM invoices i
     JOIN customers c ON c.id = i.customer_id WHERE i.status = 'unpaid' ORDER BY i.created_at DESC LIMIT 5`).all().catch(() => ({ results: [] }))).results || [];
  const attention = `<div class="card"><h2 style="margin-top:0">Needs attention</h2><div class="grid">
    <div>${expiredItems.length ? `<h3 style="margin-top:0">Expired (${expiredItems.length})</h3>${expList(expiredItems)}` : ""}
      <h3 style="margin-top:${expiredItems.length ? "16px" : "0"}">Expiring in 90 days (${expiringItems.length})</h3>
      ${expiringItems.length ? expList(expiringItems) : `<p class="muted">Nothing expiring.</p>`}</div>
    <div><h3 style="margin-top:0">Open tickets (${openTicketCount ? openTicketCount.n : 0})</h3>
      ${openTickets.length ? `<ul style="margin:0;padding-left:18px">${openTickets.map((t) => `<li><a href="/app/locations/${t.loc_id}/tickets/${t.id}">${esc(t.title)}</a> <span class="muted">${esc(t.cust_name)} · ${esc(t.priority)}</span></li>`).join("")}</ul><p style="margin:8px 0 0"><a href="/admin/tickets">All tickets</a></p>` : `<p class="muted">No open tickets.</p>`}</div>
    <div><h3 style="margin-top:0">Unpaid invoices</h3>
      <p style="margin:4px 0">${plural(unpaid.n || 0, "unpaid invoice")} · ${fmtMoney(unpaid.total || 0)} outstanding</p>
      ${unpaidRows.length ? `<ul style="margin:0;padding-left:18px">${unpaidRows.map((i) => `<li><a href="/admin/customers/${i.cust_id}?tab=billing">INV-${1000 + i.id} · ${fmtMoney(i.amount_cents)}</a> <span class="muted">${esc(i.cust_name)}</span></li>`).join("")}</ul>` : ""}</div>
    </div></div>`;
  // Client cards, optionally filtered by the search box.
  let sql = `SELECT c.*,
      (SELECT COUNT(*) FROM locations WHERE customer_id = c.id) AS locations,
      (SELECT COUNT(*) FROM user_access WHERE customer_id = c.id) AS logins,
      (SELECT COUNT(*) FROM equipment e JOIN locations l ON l.id = e.location_id WHERE l.customer_id = c.id) AS equipment,
      (SELECT COUNT(*) FROM tickets t JOIN locations l ON l.id = t.location_id WHERE l.customer_id = c.id AND t.status != 'closed') AS open_tickets
     FROM customers c`;
  const binds = [];
  if (query) { sql += " WHERE c.name LIKE ? OR c.contact_email LIKE ?"; const like = `%${query}%`; binds.push(like, like); }
  sql += " ORDER BY c.name";
  const { results } = await db.prepare(sql).bind(...binds).all();
  const cards = [];
  for (const c of results || []) {
    const exp = await db.prepare(
      `SELECT COUNT(*) AS n FROM equipment e JOIN locations l ON l.id = e.location_id
       WHERE l.customer_id = ? AND (date(e.license_expires) <= date('now', '+90 days') OR date(e.warranty_expires) <= date('now', '+90 days'))`)
      .bind(c.id).first();
    const { results: prods } = await db.prepare(
      `SELECT p.key, p.name, cp.enabled AS enabled
       FROM products p LEFT JOIN customer_products cp ON cp.product = p.key AND cp.customer_id = ? AND cp.location_id IS NULL
       ORDER BY p.key`).bind(c.id).all();
    // Genius with no row is ON (grandfathered); everything else with
    // no row is off, matching productEnabled/geniusEnabled.
    const onPills = (prods || []).filter((p) => p.enabled === null || p.enabled === undefined ? p.key === "genius" : !!p.enabled).map((p) => `<span class="pill on">${esc(p.name)}</span>`).join(" ");
    const stats = [
      plural(c.locations, "location"), plural(c.logins, "login"), `${c.equipment} equipment`,
      c.open_tickets ? `<a href="/admin/tickets">${plural(c.open_tickets, "open ticket")}</a>` : "0 open tickets",
      exp.n ? `<span class="pill warn">${plural(exp.n, "expiry date")} need attention</span>` : "No expiry dates due",
    ].join(" · ");
    cards.push(`<div class="card"><div class="row between"><h3 style="margin:0">${esc(c.name)}</h3>
      <a class="btn small" href="/admin/customers/${c.id}">Manage</a></div>
      <p class="muted">${stats}</p>
      <p>${onPills || `<span class="muted">No services on yet</span>`}</p></div>`);
  }
  const body = `${adminNav("clients")}<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px"><h1 style="margin:0">Clients</h1><a class="btn small" href="/admin/customers/new">+ Add client</a></div>
    ${attention}
    <form method="get" class="row" style="margin:16px 0 4px">
      <span style="flex:1;min-width:200px"><input name="q" placeholder="Search clients by name or contact email" value="${esc(query)}"></span>
      <button class="btn small secondary" type="submit">Search</button>
      ${query ? `<a class="btn small secondary" href="/admin">Clear</a>` : ""}</form>
    ${query ? `<p class="muted">${(results || []).length} result${(results || []).length === 1 ? "" : "s"} for "${esc(query)}"</p>` : ""}
    ${cards.join("") || `<div class="card"><p class="muted">${query ? "No clients match that search." : "No clients yet. Add the first one."}</p></div>`}`;
  return page({ title: "Clients", user, body, flash: q(request).get("msg") || undefined, error: q(request).get("err") || undefined });
}

// ---------- Ticket inbox (every open ticket, newest activity first) ----------
export async function ticketsInboxPage(env, request, user) {
  const params = new URL(request.url).searchParams;
  const statusF = params.get("status") || "active";
  const custF = Number(params.get("customer") || 0);
  const STATUS_FILTERS = { active: "t.status != 'closed'", all: "1 = 1", open: "t.status = 'open'", in_progress: "t.status = 'in_progress'", waiting: "t.status = 'waiting'", closed: "t.status = 'closed'" };
  const where = [STATUS_FILTERS[statusF] || STATUS_FILTERS.active];
  const binds = [];
  if (custF) { where.push("c.id = ?"); binds.push(custF); }
  const { results } = await env.DB.prepare(
    `SELECT t.*, l.name AS loc_name, c.name AS cust_name, u.name AS author_name
     FROM tickets t JOIN locations l ON l.id = t.location_id JOIN customers c ON c.id = l.customer_id
     LEFT JOIN users u ON u.id = t.created_by
     WHERE ${where.join(" AND ")} ORDER BY (t.status = 'closed'), t.updated_at DESC LIMIT 200`).bind(...binds).all();
  const { results: custList } = await env.DB.prepare("SELECT id, name FROM customers ORDER BY name").all();
  const LABEL = { open: "Open", in_progress: "In progress", waiting: "Waiting", closed: "Closed" };
  const rows = (results || []).map((t) => `<tr><td><a href="/app/locations/${t.location_id}/tickets/${t.id}">${esc(t.title)}</a>
      <div class="muted">${esc(t.cust_name)} · ${esc(t.loc_name)}</div></td>
    <td><span class="pill">${esc(LABEL[t.status] || t.status)}</span></td><td>${esc(t.priority)}</td>
    <td>${esc(t.author_name || "")}</td><td>${esc(fmtDateUS(t.updated_at))}</td></tr>`).join("");
  const statusOpts = [["active", "Active (not closed)"], ["all", "All"], ["open", "Open"], ["in_progress", "In progress"], ["waiting", "Waiting"], ["closed", "Closed"]]
    .map(([v, l]) => `<option value="${v}" ${statusF === v ? "selected" : ""}>${l}</option>`).join("");
  const custOpts = `<option value="0">All clients</option>` + (custList || []).map((c) => `<option value="${c.id}" ${custF === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const body = `${adminNav("tickets")}<h1>Tickets</h1>
    <p class="muted">New tickets and client replies also come to you by email.</p>
    <form method="get" class="row" style="margin-bottom:14px;align-items:end">
      <span style="min-width:190px"><label>Status</label><select name="status">${statusOpts}</select></span>
      <span style="min-width:190px"><label>Client</label><select name="customer">${custOpts}</select></span>
      <button class="btn small secondary" type="submit">Filter</button></form>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Ticket</th><th>Status</th><th>Priority</th><th>Opened by</th><th>Last activity</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="muted">No tickets match that filter.</td></tr>`}</tbody></table></div></div>`;
  return page({ title: "Tickets", user, body });
}

// ---------- Activity (the audit log, readable) ----------
const ACTION_LABEL = {
  ticket_create: "Opened a ticket", ticket_status: "Changed a ticket status", equipment_add: "Added equipment",
  equipment_edit: "Edited equipment", equipment_delete: "Deleted equipment", equipment_merge: "Merged duplicate equipment", document_upload: "Uploaded a document", document_delete: "Deleted a document",
  quote_accept: "Accepted a quote", quote_create: "Created a quote", quote_send: "Sent a quote",
  quote_decline: "Declined a quote", quote_delete: "Deleted a quote",
  invoice_create: "Created an invoice", invoice_paid: "Marked an invoice paid", invoice_void: "Voided an invoice", stripe_error: "Stripe payment error", reminder_sent: "Sent a reminder", reminder_settings: "Changed reminder settings",
  product_request: "Requested a service", product_on: "Turned a product on", product_off: "Turned a product off",
  user_remove: "Removed a user", user_invite: "Invited a user", user_connect: "Connected a login to a client",
  user_update: "Updated a login's name",
  invite_accepted: "Accepted an invite", login: "Signed in", invite_resent_admin: "Resent an admin invite", invite_resent_public: "Resent an invite",
  customer_create: "Created a client", customer_update: "Updated client details", customer_delete: "Deleted a client",
  location_create: "Added a location", sync_site_map: "Mapped a sync site", sync_map: "Mapped a sync site",
  admin_create: "Created an admin", admin_disable: "Disabled an admin", admin_enable: "Enabled an admin",
  admin_remove: "Removed an admin", setup_super_admin: "Set up the Super Admin",
  super_admin_transfer_out: "Transferred the Super Admin role", super_admin_transfer_in: "Became Super Admin (transfer)",
  password_change: "Changed their password", password_reset: "Reset a password",
  mfa_enabled: "Turned on two-step verification", mfa_disabled: "Turned off two-step verification",
  mfa_setup_skipped: "Skipped two-step setup for now",
  signout_others: "Signed out other sessions", profile_update: "Updated their profile",
  alerts_mute: "Paused device alerts", alerts_unmute: "Resumed device alerts",
  monthly_report_send: "Sent the monthly Office IT report", isp_service_update: "Updated internet plan details",
  backup_record: "Recorded a backup result", backup_token: "Issued a backup collector token",
  wifi_save: "Saved a WiFi network", wifi_remove: "Removed a WiFi network",
};
export async function activityPage(env, request, user) {
  const { results } = await env.DB.prepare(
    `SELECT a.*, u.name AS actor_name, u.email AS actor_email FROM audit_log a
     LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.id DESC LIMIT 200`).all();
  const acts = results || [];
  // Resolve the On column to real names (a client, a location, a
  // person) instead of raw IDs; the ID format stays only as a
  // fallback for records that no longer exist.
  const nameMaps = {};
  const loadNames = async (entity, sql) => {
    const ids = [...new Set(acts.filter((a) => a.entity === entity && a.entity_id).map((a) => a.entity_id))];
    if (!ids.length) return;
    try {
      const { results: rs } = await env.DB.prepare(sql.replace("?", ids.map(() => "?").join(","))).bind(...ids).all();
      nameMaps[entity] = new Map((rs || []).map((r) => [r.id, r.label]));
    } catch { /* fall back to the ID form */ }
  };
  await loadNames("customer", "SELECT id, name AS label FROM customers WHERE id IN (?)");
  await loadNames("location", "SELECT id, name AS label FROM locations WHERE id IN (?)");
  await loadNames("user", "SELECT id, name AS label FROM users WHERE id IN (?)");
  await loadNames("quote", "SELECT id, title AS label FROM quotes WHERE id IN (?)");
  await loadNames("ticket", "SELECT id, title AS label FROM tickets WHERE id IN (?)");
  await loadNames("invoice", "SELECT id, ('Invoice INV-' || (1000 + id)) AS label FROM invoices WHERE id IN (?)");
  const prodRows = await env.DB.prepare("SELECT key, name FROM products").all().catch(() => null);
  const prodName = new Map(((prodRows && prodRows.results) || []).map((p) => [p.key, p.name]));
  const ENTITY_WORD = { customer: "Client", location: "Location", user: "User", quote: "Quote", invoice: "Invoice", ticket: "Ticket", document: "Document", sync: "Sync", equipment: "Equipment" };
  const onLabel = (a) => {
    if (!a.entity) return "";
    const name = nameMaps[a.entity] && a.entity_id ? nameMaps[a.entity].get(a.entity_id) : null;
    if (name) return esc(name);
    const word = ENTITY_WORD[a.entity] || (a.entity.charAt(0).toUpperCase() + a.entity.slice(1));
    return esc(word) + (a.entity_id ? " #" + a.entity_id : "");
  };
  const detailLabel = (a) => {
    const d = a.detail || "";
    if (!d) return "";
    if (prodName.has(d)) return esc(prodName.get(d));
    if (d.startsWith("unifi:")) return "UniFi site";
    if (d.startsWith("sophos:")) return "Sophos tenant";
    if (d.startsWith("atera:")) return "Atera customer";
    return esc(d);
  };
  const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
  const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
  const whenLabel = (ts) => {
    const dt = new Date(String(ts).replace(" ", "T") + "Z");
    if (isNaN(dt.getTime())) return esc(fmtDateUS(ts));
    return `${esc(dateFmt.format(dt))}<br><span class="muted">${esc(timeFmt.format(dt))}</span>`;
  };
  const rows = acts.map((a) => `<tr><td style="white-space:nowrap">${whenLabel(a.created_at)}</td>
    <td>${esc(a.actor_name || a.actor_email || "System")}</td>
    <td>${esc(ACTION_LABEL[a.action] || a.action.replace(/_/g, " "))}</td>
    <td>${onLabel(a)}</td><td>${detailLabel(a)}</td></tr>`).join("");
  const body = `${adminNav("activity")}<h1>Activity</h1>
    <p class="muted">The last 200 recorded actions across the portal: who did what, and when.</p>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>On</th><th>Detail</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="muted">No activity recorded yet.</td></tr>`}</tbody></table></div></div>`;
  return page({ title: "Activity", user, body });
}

// One location block on the create form. The address field carries the
// autocomplete (public/assets/address-lookup.js); city/state/ZIP share the
// block's data-loc container so the lookup fills the right block.
function locationBlock() {
  return `<div data-loc style="border-top:1px solid var(--line);padding-top:10px;margin-top:12px">
    <label>Location / practice name <span class="req">*</span></label><input name="loc_name[]" placeholder="Main office">
    <label>Street address <span class="req">*</span></label><input name="loc_address[]" data-address autocomplete="off" placeholder="Start typing, then pick the address">
    <label>Suite / Unit</label><input name="loc_suite[]" class="f-suite" placeholder="Suite 200 (optional)">
    <div class="row"><span style="flex:2"><label>City <span class="req">*</span></label><input name="loc_city[]" class="f-city"></span>
    <span style="flex:1"><label>State <span class="req">*</span></label><input name="loc_state[]" class="f-state"></span>
    <span style="flex:1"><label>ZIP <span class="req">*</span></label><input name="loc_zip[]" class="f-zip"></span></div>
    <p style="text-align:right;margin:8px 0 0"><button class="btn small secondary remove-location" type="button">Remove this location</button></p></div>`;
}

// One user-login block on step 4 of the wizard. Step-4 logins are always
// regular users; the organization's one main admin is set in step 1. The
// location select is populated by org-wizard.js from the location names
// typed in step 2; its values are the location blocks' indexes, mapped
// to real location ids on the server after the locations are created.
function loginBlock() {
  return `<div style="border-top:1px solid var(--line);padding-top:10px;margin-top:12px">
    <div class="row"><span style="flex:1"><label>First name <span class="req">*</span></label><input name="login_first[]"></span>
    <span style="flex:1"><label>Middle name</label><input name="login_middle[]"></span>
    <span style="flex:1"><label>Last name <span class="req">*</span></label><input name="login_last[]"></span></div>
    <div class="row"><span style="flex:1"><label>Email <span class="req">*</span></label><input name="login_email[]" type="email"></span></div>
    <label>Access</label><select name="login_location[]" class="login-loc">
      <option value="">All locations</option></select>
    <p style="margin-top:8px"><button type="button" class="btn small secondary remove-login">Remove this user</button></p></div>`;
}

// ---------- Create customer (4-step wizard) ----------
export async function newCustomerPage(env, request, user) {
  const { results: products } = await env.DB.prepare(
    "SELECT key, name, description FROM products ORDER BY key").all();
  const productRows = (products || []).map((p) => `
    <div style="border-top:1px solid var(--line);padding:10px 0">
      <label style="display:flex;gap:10px;align-items:flex-start;font-weight:600">
        <input type="checkbox" name="product_${esc(p.key)}" value="1" style="width:auto;margin-top:3px">
        <span>${esc(p.name)}<div class="muted" style="font-weight:400">${esc(p.description || "")}</div></span></label>
    </div>`).join("");
  const body = `${adminNav("clients")}<div class="card narrow" style="margin:0;max-width:600px"><h1>Add organization</h1>
    <div class="wiz-progress">
      <div class="wiz-track"><div class="wiz-fill" id="wizFill"></div></div>
      <div class="wiz-nodes">
        <div class="wiz-node" data-node="1"><span class="dot">1</span><span class="nlabel">Organization</span></div>
        <div class="wiz-node" data-node="2"><span class="dot">2</span><span class="nlabel">Locations</span></div>
        <div class="wiz-node" data-node="3"><span class="dot">3</span><span class="nlabel">Products</span></div>
        <div class="wiz-node" data-node="4"><span class="dot">4</span><span class="nlabel">User logins</span></div>
      </div>
    </div>
    <form method="post" action="/admin/customers" id="orgWizard">
      <section class="wstep" data-step="1">
        <label>Organization name <span class="req">*</span></label><input name="name" required>
        <p class="muted">The organization is the business that signs and pays. Each of its practices is a location in step 2.</p>
        <h3 style="margin:16px 0 4px">Client admin</h3>
        <p class="muted">The main admin for this organization. They get a login invite, see every location, and can manage the organization's team. Everyone added in step 4 is a regular user. An email can belong to only one organization.</p>
        <div class="row"><span style="flex:1"><label>First name <span class="req">*</span></label><input name="contact_first_name" required></span>
        <span style="flex:1"><label>Middle name</label><input name="contact_middle_name"></span>
        <span style="flex:1"><label>Last name <span class="req">*</span></label><input name="contact_last_name" required></span></div>
        <label>Client admin email <span class="req">*</span></label><input name="contact_email" type="email">
        <label>Phone <span class="req">*</span></label><input name="phone" data-phone inputmode="tel" autocomplete="tel">
        <p id="emailCheck" style="color:var(--bad)"></p>
      </section>
      <section class="wstep" data-step="2">
        <h3 style="margin:4px 0">Locations</h3>
        <p class="muted">At least one complete office location is required: name, street address, city, state, and ZIP. Additional locations are optional, and more can be added later on the organization page.</p>
        <div id="locationBlocks">${locationBlock()}</div>
        <template id="locationTemplate">${locationBlock()}</template>
        <p style="margin-top:12px"><button class="btn small secondary" type="button" id="addLocationBtn">Add another location</button></p>
        <p class="muted">Address suggestions come from ${env.GOOGLE_PLACES_API_KEY ? "Google Maps" : "OpenStreetMap"}.</p>
        <p id="locationCheck" style="color:var(--bad)"></p>
      </section>
      <section class="wstep" data-step="3">
        <h3 style="margin:4px 0">Products for this organization</h3>
        ${productRows}
      </section>
      <section class="wstep" data-step="4">
        <h3 style="margin:4px 0">Additional user logins (optional)</h3>
        <p class="muted">Additional users are optional. The main admin was set in step 1. Each person added here gets an invite email to set their password and finish sign-in. Leave blank to add logins later.</p>
        <div id="loginBlocks"></div>
        <template id="loginTemplate">${loginBlock()}</template>
        <p style="margin-top:12px"><button class="btn small secondary" type="button" id="addLoginBtn">+ Add user</button></p>
        <p id="loginCheck" style="color:var(--bad)"></p>
      </section>
      <p class="row" style="margin-top:20px">
        <button class="btn secondary" type="button" id="wizBack">Back</button>
        <button class="btn" type="button" id="wizNext">Next</button>
        <button class="btn" type="submit" id="wizCreate">Create organization</button>
      </p></form></div>
    <script src="/assets/address-lookup.js"></script>
    <script src="/assets/org-wizard.js"></script>
    <script src="/assets/phone-format.js"></script>`;
  return page({ title: "Add organization", user, body, flash: q(request).get("msg") || undefined, error: q(request).get("err") || undefined });
}

export async function checkCustomerEmail(env, request) {
  const email = String(new URL(request.url).searchParams.get("email") || "").trim().toLowerCase();
  const dup = await findCustomerByContactEmail(env.DB, email);
  const out = dup ? { exists: true, id: dup.id, name: dup.name } : { exists: false };
  // The customer admin email also becomes a login, so it is checked as
  // one too: a FlossByte account can never be a customer login, and a
  // login that already belongs to another organization cannot be reused.
  if (email) {
    const u = await env.DB.prepare("SELECT id, kind FROM users WHERE email = ?").bind(email).first();
    if (u && u.kind === "flossbyte") out.loginFlossbyte = true;
    if (u && u.kind === "customer") {
      const other = await env.DB.prepare(
        `SELECT c.id, c.name FROM user_access ua JOIN customers c ON c.id = ua.customer_id
         WHERE ua.user_id = ? LIMIT 1`).bind(u.id).first();
      if (other) { out.loginTaken = true; out.loginOrg = other.name; }
    }
  }
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
}

export async function createCustomerPost(env, request, user) {
  const f = await request.formData();
  const name = String(f.get("name") || "").trim();
  if (!name) return redirect("/admin/customers/new");
  // Identity rule: a contact email belongs to exactly one customer. A
  // match refuses creation outright (no "create anyway"). The name may
  // repeat freely and is never checked.
  const contactEmail = String(f.get("contact_email") || "").trim();
  // The customer admin email is required: it is the organization's main
  // admin login, and as the organization email it also anchors the
  // never-duplicate rule. Both are validated before anything is created,
  // so a refused admin email never leaves a half-built organization.
  if (!contactEmail) {
    return redirect("/admin/customers/new?err=" + encodeURIComponent(
      "Client admin email is required. It becomes the organization's main admin login."));
  }
  if (!isValidEmail(contactEmail)) {
    return redirect("/admin/customers/new?err=" + encodeURIComponent(
      "Enter a valid client admin email address."));
  }
  const dup = await findCustomerByContactEmail(env.DB, contactEmail);
  if (dup) {
    return redirect("/admin/customers/new?err=" + encodeURIComponent(
      `An organization with this admin email already exists. It matches ${dup.name} (organization ${dup.id}).`));
  }
  const adminUser = await env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(contactEmail.toLowerCase()).first();
  if (adminUser && adminUser.kind === "flossbyte") {
    return redirect("/admin/customers/new?err=" + encodeURIComponent(
      "That client admin email is a FlossByte account and cannot be a client login."));
  }
  if (adminUser && adminUser.kind === "customer") {
    const other = await env.DB.prepare(
      `SELECT c.id, c.name FROM user_access ua JOIN customers c ON c.id = ua.customer_id
       WHERE ua.user_id = ? LIMIT 1`).bind(adminUser.id).first();
    if (other) {
      return redirect("/admin/customers/new?err=" + encodeURIComponent(
        `That client admin email already belongs to ${other.name}. An email can belong to only one organization.`));
    }
  }
  const phone = normalizePhone(f.get("phone"));
  if (!phone) {
    return redirect("/admin/customers/new?err=" + encodeURIComponent(
      "A valid 10-digit phone number is required."));
  }
  // At least one complete office location is required. This is checked
  // before the organization is inserted, so a missing or incomplete
  // location never leaves a partially created organization behind.
  // Completely blank extra location blocks are ignored; a block with
  // anything filled in must have every field filled in.
  const names = f.getAll("loc_name[]");
  const addrs = f.getAll("loc_address[]");
  const cities = f.getAll("loc_city[]");
  const states = f.getAll("loc_state[]");
  const zips = f.getAll("loc_zip[]");
  const suites = f.getAll("loc_suite[]");
  if (!names.some((value) => String(value || "").trim())) {
    return redirect("/admin/customers/new?err=" + encodeURIComponent(
      "At least one office location is required."));
  }
  const locationFields = [
    ["name", "location / practice name", names], ["address", "street address", addrs],
    ["city", "city", cities], ["state", "state", states], ["zip", "ZIP", zips],
  ];
  const blockCount = Math.max(names.length, addrs.length, cities.length, states.length, zips.length);
  for (let i = 0; i < blockCount; i++) {
    const values = locationFields.map(([, , arr]) => String(arr[i] || "").trim());
    if (!values.some(Boolean)) continue;
    const missing = locationFields.filter((_, j) => !values[j]).map(([, label]) => label);
    if (missing.length) {
      return redirect("/admin/customers/new?err=" + encodeURIComponent(
        `Location ${i + 1} is incomplete: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required.`));
    }
  }
  const first = String(f.get("contact_first_name") || "").trim();
  const middle = String(f.get("contact_middle_name") || "").trim();
  const last = String(f.get("contact_last_name") || "").trim();
  if (!first || !last) {
    return redirect("/admin/customers/new?err=" + encodeURIComponent(
      "First name and last name are required."));
  }
  const contactName = [first, middle, last].filter(Boolean).join(" ");
  const res = await env.DB.prepare(
    `INSERT INTO customers (name, contact_name, contact_first_name, contact_middle_name, contact_last_name, contact_email, phone)
     VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(name, contactName, first, middle || null, last,
      contactEmail || null, phone).run();
  const customerId = res.meta.last_row_id;
  // Any number of location blocks may come back from the form; empty
  // blocks are skipped.
  // Location ids keyed by the block's index in the form, so step 4's
  // per-login location picks (which carry block indexes) resolve here.
  const locIdByIndex = {};
  for (let i = 0; i < names.length; i++) {
    const locName = String(names[i] || "").trim();
    if (!locName) continue;
    // suite is NOT NULL in the schema (migration 0006): bind the string,
    // "" when empty, never null, or this insert fails and kills creation.
    const lr = await env.DB.prepare(
      "INSERT INTO locations (customer_id, name, address, suite, city, state, zip) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(customerId, locName, String(addrs[i] || "").trim() || null,
        String(suites[i] || "").trim(),
        String(cities[i] || "").trim() || null, String(states[i] || "").trim() || null,
        String(zips[i] || "").trim() || null).run();
    locIdByIndex[i] = lr.meta.last_row_id;
  }
  // Step 3: product switches chosen in the wizard are written explicitly
  // for every product, so the organization's state is never ambiguous.
  const { results: allProducts } = await env.DB.prepare("SELECT key FROM products").all();
  for (const p of allProducts || []) {
    const enabled = String(f.get(`product_${p.key}`) || "") === "1" ? 1 : 0;
    await env.DB.prepare(
      "INSERT INTO customer_products (customer_id, location_id, product, enabled, plan_note) VALUES (?, NULL, ?, ?, ?)")
      .bind(customerId, p.key, enabled, null).run();
  }
  // If the wizard turned One-Time Project on, each office gets its
  // project record now, so the tracker exists from day one. (The
  // Products-tab toggle creates it via onOtpToggledOn; the wizard
  // writes product rows directly.) No activation email here: that
  // email belongs to toggle transitions, and the read paths converge
  // on the same ensure if this is ever missed.
  for (const idx of Object.keys(locIdByIndex)) {
    await ensureProjectForLocation(env.DB, customerId, locIdByIndex[idx]);
  }
  // The customer admin from step 1 becomes the organization's one main
  // admin: a customer_admin login with access to every location, flagged
  // is_main_admin. Pre-validation above guarantees the grant succeeds.
  const adminEmail = contactEmail.toLowerCase();
  let adminOutcome = "active";
  let invitesCreated = false;
  {
    let target = adminUser;
    const wasPending = !!target && target.status === "pending";
    if (!target) {
      const ur = await env.DB.prepare(
        "INSERT INTO users (email, name, kind, role, status) VALUES (?, ?, 'customer', 'customer_admin', 'invited')")
        .bind(adminEmail, contactName || adminEmail).run();
      target = { id: ur.meta.last_row_id, name: contactName || adminEmail, email: adminEmail, status: "invited" };
    } else {
      // A returning account (for example a removed login being made the
      // admin of a new organization) takes the admin role; a disabled
      // account is re-invited rather than left locked out.
      await env.DB.prepare("UPDATE users SET role = 'customer_admin' WHERE id = ?").bind(target.id).run();
      // The name typed in step 1 is the name of record for this login.
      // An older account under this email can carry a wrong or
      // placeholder name, and the invite email greets the stored name,
      // so the fresh typing wins.
      if (contactName && contactName !== target.name) {
        await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(contactName, target.id).run();
        target = { ...target, name: contactName };
      }
      if (target.status === "disabled") {
        await env.DB.prepare("UPDATE users SET status = 'invited' WHERE id = ?").bind(target.id).run();
        target = { ...target, status: "invited" };
      }
    }
    await grantUserAccess(env.DB, target.id, customerId, null, "admin");
    await env.DB.prepare("UPDATE user_access SET is_main_admin = 0 WHERE customer_id = ?").bind(customerId).run();
    await env.DB.prepare(
      "UPDATE user_access SET is_main_admin = 1 WHERE user_id = ? AND customer_id = ? AND location_id IS NULL")
      .bind(target.id, customerId).run();
    if (wasPending) {
      await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(target.id).run();
      await audit(env.DB, user.id, "user_connect", "user", target.id, adminEmail);
      adminOutcome = "connected";
    } else if (target.status === "invited") {
      const raw = await createAuthToken(env.DB, target.id, "invite", 7 * 24 * 60);
      const mail = inviteEmail(env, { name: target.name, link: `${origin(env)}/invite/${raw}` });
      await sendEmail(env, { to: adminEmail, template: "invite", ...mail });
      invitesCreated = true;
      await audit(env.DB, user.id, "user_invite", "user", target.id, adminEmail);
      adminOutcome = "invited";
    } else {
      adminOutcome = "active";
    }
  }
  // Step 4: user logins, always regular users. Each row follows the same
  // rules as a console invite: the one-email-one-organization rule is
  // enforced by grantUserAccess, a pending self-signup is connected in
  // place, and a FlossByte account can never become a customer login. A
  // refused login never blocks the organization itself; it is reported
  // in the summary. The main admin's own email is skipped here, step 1
  // already covers that person.
  const loginFirsts = f.getAll("login_first[]");
  const loginMiddles = f.getAll("login_middle[]");
  const loginLasts = f.getAll("login_last[]");
  const loginEmails = f.getAll("login_email[]");
  const loginLocs = f.getAll("login_location[]");
  const invited = [], connected = [], refused = [];
  let adminAlsoListed = false;
  for (let i = 0; i < loginEmails.length; i++) {
    const email = String(loginEmails[i] || "").trim().toLowerCase();
    const loginName = [loginFirsts[i], loginMiddles[i], loginLasts[i]]
      .map((v) => String(v || "").trim()).filter(Boolean).join(" ");
    // A completely untouched block is ignored. A block the admin started
    // filling in must be complete: email (marked required on the form)
    // plus first and last name. And whatever goes wrong with one login,
    // it lands in the summary as a refusal; it never fails the
    // organization itself.
    if (!email && !loginName) continue;
    if (!email) { refused.push(`${loginName} (email is required)`); continue; }
    if (!isValidEmail(email)) { refused.push(`${email} (invalid email address)`); continue; }
    if (!String(loginFirsts[i] || "").trim() || !String(loginLasts[i] || "").trim()) {
      refused.push(`${email} (first and last name are required)`); continue;
    }
    if (email === adminEmail) { adminAlsoListed = true; continue; }
    try {
    const scope = "user";
    const locPick = String(loginLocs[i] || "");
    const locationId = locPick === "" ? null : (locIdByIndex[Number(locPick)] ?? null);
    let target = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
    if (target && target.kind === "flossbyte") { refused.push(`${email} (a FlossByte account)`); continue; }
    const wasPending = !!target && target.status === "pending";
    if (!target) {
      const ur = await env.DB.prepare(
        "INSERT INTO users (email, name, kind, role, status) VALUES (?, ?, 'customer', ?, 'invited')")
        .bind(email, loginName || email, scope === "admin" ? "customer_admin" : "customer_user").run();
      target = { id: ur.meta.last_row_id, name: loginName || email, email, status: "invited" };
    } else {
      if (!wasPending) {
        await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?")
          .bind(scope === "admin" ? "customer_admin" : "customer_user", target.id).run();
      }
      // Same rule as step 1: the name typed here is the name of record
      // for this login and replaces whatever an older account carries.
      if (loginName && loginName !== target.name) {
        await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(loginName, target.id).run();
        target = { ...target, name: loginName };
      }
    }
    const grant = await grantUserAccess(env.DB, target.id, customerId, locationId, scope);
    if (!grant.ok) {
      const detail = grant.otherCustomer ? ` It belongs to ${grant.otherCustomer.name}.` : "";
      refused.push(`${email} (${grant.error}${detail})`);
      continue;
    }
    if (wasPending) {
      await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(target.id).run();
      await audit(env.DB, user.id, "user_connect", "user", target.id, email);
      connected.push(email);
    } else if (target.status === "active") {
      // Already has a working login and password, so there is nothing to
      // invite: the access is live immediately and the summary reports
      // them as connected, not invited.
      connected.push(email);
    } else {
      // New, invited, or disabled: a disabled login is re-invited, the
      // same handling the step-1 admin gets. Setting a password on the
      // invite reactivates the account; without this, a returning login
      // was counted as invited but no email ever went out.
      if (target.status === "disabled") {
        await env.DB.prepare("UPDATE users SET status = 'invited' WHERE id = ?").bind(target.id).run();
      }
      const raw = await createAuthToken(env.DB, target.id, "invite", 7 * 24 * 60);
      const mail = inviteEmail(env, { name: target.name, link: `${origin(env)}/invite/${raw}` });
      await sendEmail(env, { to: email, template: "invite", ...mail });
      invitesCreated = true;
      await audit(env.DB, user.id, "user_invite", "user", target.id, email);
      invited.push(email);
    }
    } catch {
      refused.push(`${email} (could not be added; add them from the organization page instead)`);
    }
  }
  await audit(env.DB, user.id, "customer_create", "customer", customerId, name);
  if (env.ADMIN_ALERT_EMAIL) {
    const mail = newCustomerNoticeEmail(env, { customerName: name, createdBy: user.name });
    await sendEmail(env, { to: env.ADMIN_ALERT_EMAIL, template: "admin_new_customer", ...mail });
  }
  // Summary style follows the big admin consoles (Google Workspace,
  // Microsoft 365): one headline, then invitation counts instead of a
  // sentence per person. The main admin is named because that account
  // anchors the organization; anyone who could not be added is named
  // because that needs the admin's attention. Details live in the
  // Logins table on the organization page and in the audit log.
  const parts = [`Organization "${name}" was created.`];
  const emailLive = !!env.RESEND_API_KEY;
  const inviteTotal = invited.length + (adminOutcome === "invited" ? 1 : 0);
  if (inviteTotal === 1 && adminOutcome === "invited") {
    parts.push(emailLive
      ? `Invitation sent to the main admin, ${adminEmail}. They set their own password from the link in that email.`
      : `Invitation created for the main admin, ${adminEmail}.`);
  } else if (inviteTotal > 0) {
    const base = emailLive
      ? `Invitations sent to ${inviteTotal} ${inviteTotal === 1 ? "person" : "people"}`
      : `Invitations created for ${inviteTotal} ${inviteTotal === 1 ? "person" : "people"}`;
    parts.push(adminOutcome === "invited" ? `${base}, including the main admin (${adminEmail}).` : `${base}.`);
    if (emailLive) parts.push("Each person sets their own password from the link in their email.");
  }
  if (adminOutcome === "connected") {
    parts.push(`The main admin (${adminEmail}) already had an account and was connected directly.`);
  } else if (adminOutcome === "active" && inviteTotal === 0) {
    parts.push(`The main admin (${adminEmail}) already has an active account.`);
  }
  if (adminAlsoListed) parts.push("The main admin also appeared in the step 4 logins, so that duplicate was skipped.");
  if (connected.length) parts.push(`Connected directly (already had accounts): ${connected.join(", ")}.`);
  if (refused.length) parts.push(`Not added: ${refused.join("; ")}.`);
  if (invitesCreated && !emailLive) {
    parts.push("Email delivery is not connected yet, so nothing has been emailed.");
  }
  return redirect(`/admin/customers/${customerId}?msg=` + encodeURIComponent(parts.join(" ")));
}

export async function updateCustomerPost(env, request, user, customerId) {
  const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  if (!c) return redirect("/admin/customers");
  const f = await request.formData();
  const name = String(f.get("name") || "").trim() || c.name;
  const first = String(f.get("contact_first_name") || "").trim();
  const middle = String(f.get("contact_middle_name") || "").trim();
  const last = String(f.get("contact_last_name") || "").trim();
  if (!first || !last) {
    return redirect(`/admin/customers/${customerId}?tab=organization&msg=` + encodeURIComponent(
      "First name and last name are required. Nothing was saved."));
  }
  const contactName = [first, middle, last].filter(Boolean).join(" ");
  // The client admin email is the practice's identity in the portal and
  // never changes after creation, so it is not read from the form at all.
  const phone = normalizePhone(f.get("phone"));
  if (!phone) {
    return redirect(`/admin/customers/${customerId}?tab=organization&msg=` + encodeURIComponent(
      "A valid 10-digit phone number is required. Nothing was saved."));
  }
  await env.DB.prepare(
    `UPDATE customers SET name = ?, contact_name = ?, contact_first_name = ?, contact_middle_name = ?,
     contact_last_name = ?, phone = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(name, contactName, first, middle || null, last, phone, customerId).run();
  await audit(env.DB, user.id, "customer_update", "customer", Number(customerId), name);
  return redirect(`/admin/customers/${customerId}?tab=organization&msg=` + encodeURIComponent("Organization saved."));
}

// ---------- Customer detail ----------
export async function customerPage(env, request, user, customerId) {
  const db = env.DB;
  const c = await db.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  if (!c) return withStatus(page({ title: "Not found", user, body: `<div class="card narrow"><h1>Not found</h1></div>` }), 404);
  const { results: locations } = await db.prepare("SELECT * FROM locations WHERE customer_id = ? ORDER BY name").bind(customerId).all();
  const { results: products } = await db.prepare(
    `SELECT p.key, p.name, p.description, cp.enabled, cp.plan_note FROM products p
     LEFT JOIN customer_products cp ON cp.product = p.key AND cp.customer_id = ? AND cp.location_id IS NULL ORDER BY p.key`)
    .bind(customerId).all();
  const { results: members } = await db.prepare(
    `SELECT DISTINCT u.id, u.name, u.email, u.status, u.role, ua.is_main_admin, u.last_login_at FROM user_access ua JOIN users u ON u.id = ua.user_id
     WHERE ua.customer_id = ? ORDER BY u.name`).bind(customerId).all();
  const otpRows = await db.prepare(
    "SELECT location_id, enabled FROM customer_products WHERE customer_id = ? AND product = 'one_time_project'")
    .bind(customerId).all().catch(() => ({ results: [] }));
  let otpOrgOn = 0; const otpLocMap = new Map();
  for (const r of otpRows.results || []) {
    if (r.location_id === null || r.location_id === undefined) otpOrgOn = r.enabled;
    else otpLocMap.set(Number(r.location_id), r.enabled);
  }
  const otpOnFor = (lid) => (otpLocMap.has(Number(lid)) ? otpLocMap.get(Number(lid)) : otpOrgOn) === 1;
  const locRows = (locations || []).map((l) => `<tr><td><a href="/app/locations/${l.id}">${esc(l.name)}</a>${otpOnFor(l.id) ? ` <a href="/app/locations/${l.id}/products/one_time_project">(project page)</a>` : ""}</td>
    <td>${esc([l.address, l.suite, l.city, l.state, l.zip].filter(Boolean).join(", "))}</td><td>${esc(l.status)}</td>
    <td><form method="post" action="/admin/locations/${l.id}/edit" class="row" data-loc>
      <input name="name" value="${esc(l.name)}" required style="max-width:170px">
      <input name="address" value="${esc(l.address || "")}" placeholder="Street address" data-address autocomplete="off" required style="max-width:200px">
      <input name="suite" value="${esc(l.suite || "")}" placeholder="Suite / Unit" class="f-suite" style="max-width:110px">
      <input name="city" value="${esc(l.city || "")}" placeholder="City" class="f-city" required style="max-width:120px">
      <input name="state" value="${esc(l.state || "")}" placeholder="State" class="f-state" required style="max-width:64px">
      <input name="zip" value="${esc(l.zip || "")}" placeholder="ZIP" class="f-zip" required style="max-width:84px">
      <button class="btn small" type="submit">Save</button> <button class="btn small secondary" type="button" data-cancel>Cancel</button></form></td></tr>`).join("");
  const prodRows = (products || []).map((p) => {
    // Genius has no row until someone sets one, and no row means ON
    // (it was live for everyone before it had a switch). Every other
    // product defaults off, as productEnabled does.
    const enabled = p.enabled === null || p.enabled === undefined
      ? (p.key === "genius" ? 1 : 0) : p.enabled;
    return `<tr><td><strong>${esc(p.name)}</strong><div class="muted">${esc(p.description || "")}</div></td>
      <td><span class="pill ${enabled ? "on" : "off"}">${enabled ? "On" : "Off"}</span></td>
      <td><form method="post" action="/admin/customers/${customerId}/products" class="row">
        <input type="hidden" name="product" value="${esc(p.key)}">
        <button class="btn small ${enabled ? "danger" : ""}" name="enabled" value="${enabled ? "0" : "1"}" type="submit">${enabled ? "Turn off" : "Turn on"}</button></form></td></tr>`;
  }).join("");
  // Office selector: the same chip switcher the customer Services
  // page uses (?office=id), with "All offices" as the first chip.
  // One selection shows at a time. All offices shows the org-wide
  // switches above; an office shows that office's switches with its
  // effective state, resolved exactly the way the portal resolves it
  // (the office's own row wins, then the All offices row, then the
  // product default). Each button posts to the same toggle endpoint
  // with the office's location_id, so every side effect (project
  // creation, activation email, Genius and Managed IT resolution) is
  // the existing one, and the toggle redirects back with the same
  // office still selected.
  const officeWanted = parseInt(new URL(request.url).searchParams.get("office") || "", 10);
  const selLoc = (locations || []).find((l) => l.id === officeWanted) || null;
  const officeSwitcher = (locations && locations.length)
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px"><span class="muted" style="font-weight:600">Office:</span><a class="btn small ${selLoc ? "secondary" : ""}" href="/admin/customers/${customerId}?tab=products" style="text-decoration:none">All offices</a>${(locations || []).map((l) => `<a class="btn small ${selLoc && l.id === selLoc.id ? "" : "secondary"}" href="/admin/customers/${customerId}?tab=products&office=${l.id}" style="text-decoration:none">${esc(l.name)}</a>`).join("")}</div>`
    : "";
  let selLocRows = "";
  if (selLoc) {
    const { results: ownRows } = await db.prepare(
      "SELECT product FROM customer_products WHERE customer_id = ? AND location_id = ?")
      .bind(customerId, selLoc.id).all().catch(() => ({ results: [] }));
    const ownSet = new Set((ownRows || []).map((r) => r.product));
    const rows = [];
    for (const p of products || []) {
      const on = p.key === "genius"
        ? await geniusEnabled(db, customerId, selLoc.id)
        : await productEnabled(db, customerId, selLoc.id, p.key);
      const ownRow = ownSet.has(p.key);
      rows.push(`<tr><td><strong>${esc(p.name)}</strong><div class="muted">${esc(p.description || "")}</div></td>
        <td><span class="pill ${on ? "on" : "off"}">${on ? "On" : "Off"}</span>${ownRow ? "" : `<div class="muted">From All offices</div>`}</td>
        <td><form method="post" action="/admin/customers/${customerId}/products" class="row">
          <input type="hidden" name="product" value="${esc(p.key)}">
          <input type="hidden" name="location_id" value="${selLoc.id}">
          <button class="btn small ${on ? "danger" : ""}" name="enabled" value="${on ? "0" : "1"}" type="submit">${on ? "Turn off" : "Turn on"}</button></form></td></tr>`);
    }
    selLocRows = rows.join("");
  }
  const memberRows = (members || []).map((m) => `<tr><td>${esc(m.name)}${m.is_main_admin ? ` <span class="pill on">Main admin</span>` : ""}</td><td>${esc(m.email)}</td>
    <td>${esc(m.role)}</td><td><span class="pill">${esc(m.status)}</span></td>
    <td>${m.last_login_at ? esc(fmtDateUS(String(m.last_login_at).slice(0, 10))) : `<span class="muted">Never</span>`}</td>
    <td><a class="btn small secondary" href="/admin/customers/${customerId}/users/${m.id}/edit">Edit</a>${m.status === "invited" ? ` <form method="post" action="/admin/customers/${customerId}/users/${m.id}/resend" style="display:inline"><button class="btn small secondary" type="submit">Resend invite</button></form>` : ""}</td></tr>`).join("");
  // Quotes and invoices (migration 0008). Best-effort reads: if the tables
  // are not there yet the org page must still render.
  const { results: quoteList } = await db.prepare(
    `SELECT q.*, COALESCE((SELECT SUM(ROUND(qi.qty * qi.unit_price_cents)) FROM quote_items qi WHERE qi.quote_id = q.id), 0) AS total_cents,
            COALESCE((SELECT SUM(amount_cents) FROM invoices WHERE quote_id = q.id AND status != 'void'), 0) AS invoiced_cents
     FROM quotes q WHERE q.customer_id = ? ORDER BY q.updated_at DESC`).bind(customerId).all().catch(() => ({ results: [] }));
  const { results: invoiceList } = await db.prepare(
    "SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC").bind(customerId).all().catch(() => ({ results: [] }));
  const planState = await getPlanState(db, customerId).catch(() => null);
  const planLine = planState
    ? `<p class="muted" style="margin:0 0 10px">Stripe plan: <b>${esc(planState.status || "")}</b> · ${fmtMoney(planState.amountCents)}/mo · subscription ${esc(planState.sub || "")}</p>`
    : "";
  const quoteRows = (quoteList || []).map((qt) => {
    const statusPill = qt.status === "accepted" ? `<span class="pill on">Accepted</span>`
      : qt.status === "sent" ? `<span class="pill">Sent</span>`
      : qt.status === "declined" ? `<span class="pill off">Declined</span>` : `<span class="pill">Draft</span>`;
    let actions = "";
    if (qt.status === "draft") {
      actions = `<form method="post" action="/admin/customers/${customerId}/quotes/${qt.id}/send" style="display:inline"><button class="btn small" type="submit">Send to customer</button></form>
        <form method="post" action="/admin/customers/${customerId}/quotes/${qt.id}/delete" style="display:inline"><button class="btn small danger" type="submit">Delete</button></form>`;
    } else if (qt.status === "sent") {
      actions = `<span class="muted">Waiting for the client</span> <form method="post" action="/admin/customers/${customerId}/quotes/${qt.id}/remind" style="display:inline"><button class="btn small secondary" type="submit">Send reminder</button></form>`;
    } else if (qt.status === "accepted") {
      actions = `<span class="muted">Accepted ${fmtDateUS(qt.accepted_at || "")}${qt.accepted_by ? " by " + esc(qt.accepted_by) : ""}. Invoiced ${fmtMoney(qt.invoiced_cents)} of ${fmtMoney(qt.total_cents)}.</span>`
        + (qt.invoiced_cents < qt.total_cents ? ` <form method="post" action="/admin/customers/${customerId}/quotes/${qt.id}/final" style="display:inline"><button class="btn small" type="submit">Invoice the rest</button></form>` : "");
    }
    const sowForm = `<form method="post" action="/admin/customers/${customerId}/quotes/${qt.id}/sow" enctype="multipart/form-data" style="display:inline"><input type="file" name="sow" accept="application/pdf,.pdf" required style="width:auto;display:inline;max-width:190px"><button class="btn small secondary" type="submit">${qt.sow_r2_key ? "Replace SOW" : "Attach SOW"}</button></form>`;
    const sowBlock = `<div style="margin-top:6px">${qt.sow_r2_key
      ? `<span class="muted">SOW: ${esc(qt.sow_name || "Statement of Work.pdf")}${qt.sow_accepted_at ? ` (accepted ${fmtDateUS(qt.sow_accepted_at)}${qt.sow_accepted_by ? " by " + esc(qt.sow_accepted_by) : ""})` : ""}</span> <form method="post" action="/admin/customers/${customerId}/quotes/${qt.id}/sow-remove" style="display:inline"><button class="btn small secondary" type="submit">Remove</button></form> ${sowForm}`
      : `<span class="muted">No SOW attached.</span> ${sowForm}`}</div>`;
    return `<tr><td>${esc(qt.title)}</td><td>${qt.kind === "plan" ? "Service plan" : "Project"}</td>
      <td class="num">${fmtMoney(qt.total_cents)}</td><td>${qt.deposit_percent ? qt.deposit_percent + "%" : "None"}</td>
      <td>${statusPill}</td><td>${actions}${sowBlock}</td></tr>`;
  }).join("");
  const invoiceRows = (invoiceList || []).map((inv) => {
    const actions = inv.status === "unpaid"
      ? `<form method="post" action="/admin/customers/${customerId}/invoices/${inv.id}/paid" class="row" style="gap:6px;display:inline-flex">
           <input name="method" placeholder="Method (card, check)" style="max-width:150px">
           <button class="btn small" type="submit">Mark paid</button></form>
         <form method="post" action="/admin/customers/${customerId}/invoices/${inv.id}/void" style="display:inline"><button class="btn small danger" type="submit">Void</button></form>
         <form method="post" action="/admin/customers/${customerId}/invoices/${inv.id}/remind" style="display:inline"><button class="btn small secondary" type="submit">Send reminder</button></form>
         ${inv.pay_url ? `<a class="btn small secondary" href="${esc(inv.pay_url)}" target="_blank" rel="noopener">Pay link</a>` : ""}`
      : inv.status === "paid" ? `<span class="muted">Paid ${fmtDateUS(inv.paid_at || "")}${inv.paid_method ? " (" + esc(inv.paid_method) + ")" : ""}</span>` : `<span class="muted">Void</span>`;
    return `<tr><td>INV-${1000 + inv.id}</td><td>${esc(inv.title)}</td>
      <td>${inv.kind === "deposit" ? "Deposit" : inv.kind === "final" ? "Final balance" : "Invoice"}</td>
      <td class="num">${fmtMoney(inv.amount_cents)}</td>
      <td><span class="pill ${inv.status === "paid" ? "on" : inv.status === "void" ? "off" : ""}">${esc(inv.status)}</span></td>
      <td>${esc(fmtDateUS(inv.due_date))}</td><td>${actions}</td></tr>`;
  }).join("");
  const itemRow = `<div class="row" data-item-row style="gap:8px;margin-top:6px;align-items:flex-end">
      <span style="flex:3;min-width:160px"><input name="item_desc" placeholder="Description"></span>
      <span style="flex:1;min-width:70px"><input name="item_qty" type="number" step="any" min="0" placeholder="Qty"></span>
      <span style="flex:1;min-width:90px"><input name="item_price" type="number" step="0.01" min="0" placeholder="Price $"></span>
      <span><button class="btn small secondary" type="button" data-remove-item>Remove</button></span></div>`;
  const tabParam = q(request).get("tab");
  const tab = ["organization", "locations", "products", "users", "billing", "manage"].includes(tabParam) ? tabParam : "organization";
  // Billing splits into Quotes and Invoices sub-tabs (Montek,
  // 2026-11-09): the same chip switcher as the Products office
  // selector, chosen with ?btab= so billing actions redirect back
  // to the sub-tab they were used from. Default is Quotes. The
  // Stripe plan line (planLine) is billing-wide: it renders above
  // the switcher and shows on both sub-tabs.
  const btabParam = q(request).get("btab");
  const btab = ["quotes", "invoices"].includes(btabParam) ? btabParam : "quotes";
  const billingSwitcher = `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px"><span class="muted" style="font-weight:600">Show:</span><a class="btn small ${btab === "quotes" ? "" : "secondary"}" href="/admin/customers/${customerId}?tab=billing&btab=quotes" style="text-decoration:none">Quotes</a><a class="btn small ${btab === "invoices" ? "" : "secondary"}" href="/admin/customers/${customerId}?tab=billing&btab=invoices" style="text-decoration:none">Invoices</a></div>`;
  // The New quote form: two line-item rows to start, more added with
  // the button (cloned from the template, the wizard's pattern), each
  // row removable down to one, and a live total that follows the
  // typing. The server still reads the same item_desc / item_qty /
  // item_price fields and ignores blank rows, so the initially
  // rendered rows also submit fine with no JavaScript at all. Once
  // the organization has quotes, the form folds behind a "+ New
  // quote" panel (the folded add-form pattern) instead of sitting
  // open under the list; with no quotes yet it starts open, under
  // the "Build the first one below" empty state.
  const newQuoteForm = `<form method="post" action="/admin/customers/${customerId}/quotes">
        <label>Quote title <span class="req">*</span></label><input name="title" required placeholder="For example: Network refresh, Phase 1">
        <div class="row"><span style="flex:1;min-width:160px"><label>Type</label>
          <select id="quoteKind" name="kind"><option value="project">One-time project</option><option value="plan">Service plan (MSP)</option></select></span>
          <span style="flex:1;min-width:120px"><label>Deposit % due on acceptance</label><input name="deposit_percent" type="number" min="0" max="100" step="1" value="0"></span></div>
        <label style="margin-top:10px">Line items</label>
        <div id="quoteItems">${itemRow.repeat(2)}</div>
        <template id="quoteItemTemplate">${itemRow}</template>
        <p style="margin-top:10px"><button class="btn small secondary" type="button" id="addQuoteItem">+ Add line item</button></p>
        <p style="margin-top:6px">Total: <strong id="quoteTotalLive">$0.00</strong></p>
        <label style="margin-top:12px">Terms shown on the quote</label>
        <textarea id="quoteTerms" name="terms" rows="3">${esc(PROJECT_TERMS)}</textarea>
        <p style="margin-top:12px"><button class="btn" type="submit">Save draft quote</button></p>
      </form>
      <p class="muted">Drafts are not visible to the client. When you send, the client gets an email and can review and accept in the portal. Accepting creates the deposit invoice automatically when a deposit is set.</p>
      <script>(function(){var k=document.getElementById('quoteKind'),t=document.getElementById('quoteTerms');if(k&&t){var T=${JSON.stringify({ project: PROJECT_TERMS, plan: PLAN_TERMS })};k.addEventListener('change',function(){if(t.value===T.project||t.value===T.plan){t.value=T[k.value]||t.value;}});}
      var box=document.getElementById('quoteItems'),add=document.getElementById('addQuoteItem'),tpl=document.getElementById('quoteItemTemplate'),tot=document.getElementById('quoteTotalLive');if(!box)return;
      function rows(){return box.querySelectorAll('[data-item-row]');}
      function sync(){var cents=0;rows().forEach(function(r){var q=parseFloat(r.querySelector('[name=item_qty]').value)||0;var p=parseFloat(r.querySelector('[name=item_price]').value)||0;cents+=Math.round(q*Math.round(p*100));});if(tot)tot.textContent='$'+(cents/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});var rs=rows();rs.forEach(function(r){var b=r.querySelector('[data-remove-item]');if(b)b.style.display=rs.length>1?'':'none';});}
      box.addEventListener('input',sync);
      box.addEventListener('click',function(e){var b=e.target.closest('[data-remove-item]');if(!b)return;var r=b.closest('[data-item-row]');if(r&&rows().length>1){r.remove();sync();}});
      if(add&&tpl)add.addEventListener('click',function(){box.appendChild(tpl.content.cloneNode(true));sync();});
      sync();})();</script>`;
  const hasQuotes = (quoteList || []).length > 0;
  const newQuoteBlock = hasQuotes
    ? `<details style="margin-top:22px"><summary class="btn small secondary" style="cursor:pointer;display:inline-block">+ New quote</summary><h3 style="margin-top:16px">New quote</h3>${newQuoteForm}</details>`
    : `<h3 style="margin-top:22px">New quote</h3>${newQuoteForm}`;
  const quotesSection = `<h3 style="margin-top:0">Quotes</h3>
      <div class="tscroll"><table class="stack"><thead><tr><th>Quote</th><th>Type</th><th class="num">Total</th><th>Deposit</th><th>Status</th><th></th></tr></thead>
      <tbody>${quoteRows || `<tr><td colspan="6" class="muted">No quotes yet. Build the first one below.</td></tr>`}</tbody></table></div>
      ${newQuoteBlock}`;
  const invoicesSection = `<h3 style="margin-top:0">Invoices</h3>
      <div class="tscroll"><table class="stack"><thead><tr><th>Number</th><th>Invoice</th><th>Type</th><th class="num">Amount</th><th>Status</th><th>Due</th><th></th></tr></thead>
      <tbody>${invoiceRows || `<tr><td colspan="7" class="muted">No invoices yet.</td></tr>`}</tbody></table></div>
      <h3 style="margin-top:22px">New invoice</h3>
      <form method="post" action="/admin/customers/${customerId}/invoices">
        <label>Title <span class="req">*</span></label><input name="title" required placeholder="For example: After-hours support, October">
        <div class="row"><span style="flex:1;min-width:120px"><label>Amount $ <span class="req">*</span></label><input name="amount" type="number" step="0.01" min="0" required></span>
        <span style="flex:1;min-width:140px"><label>Due date</label><input name="due_date" type="date"></span></div>
        <label>Payment link (optional)</label><input name="pay_url" type="url" placeholder="Paste a Stripe payment link and the customer gets a Pay button">
        <p style="margin-top:12px"><button class="btn" type="submit">Create invoice</button></p>
      </form>
      <p class="muted">Deposit invoices from accepted quotes appear here automatically. Work is scheduled once a deposit shows as paid.</p>`;
  // Getting started checklist: sits on the Organization tab until every
  // step is done or the admin dismisses it. Dismissal is a system_state
  // flag, so it needs no migration.
  const mainAdminRow = await db.prepare(
    `SELECT u.email, u.status FROM user_access ua JOIN users u ON u.id = ua.user_id
     WHERE ua.customer_id = ? AND ua.is_main_admin = 1`).bind(customerId).first().catch(() => null);
  const svcOn = await db.prepare(
    "SELECT COUNT(*) AS n FROM customer_products WHERE customer_id = ? AND location_id IS NULL AND enabled = 1").bind(customerId).first().catch(() => ({ n: 0 }));
  const equipN = await db.prepare(
    "SELECT COUNT(*) AS n FROM equipment e JOIN locations l ON l.id = e.location_id WHERE l.customer_id = ?").bind(customerId).first().catch(() => ({ n: 0 }));
  const billN = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotes WHERE customer_id = ? AND status != 'draft') +
            (SELECT COUNT(*) FROM invoices WHERE customer_id = ?) AS n`).bind(customerId, customerId).first().catch(() => ({ n: 0 }));
  const clDismissed = await db.prepare("SELECT value FROM system_state WHERE key = ?").bind(`checklist_dismissed_${customerId}`).first().catch(() => null);
  const firstLoc = (locations || [])[0];
  const clSteps = [
    { done: !!mainAdminRow && mainAdminRow.status === "active",
      label: "Main admin invite accepted",
      hint: mainAdminRow ? `Waiting on ${mainAdminRow.email} to set a password from the invite email.` : "No main admin on this organization yet.",
      link: `/admin/customers/${customerId}?tab=users`, linkText: "View logins" },
    { done: !!svcOn && svcOn.n > 0,
      label: "Services turned on",
      hint: "Nothing is on for this client yet. Managed IT, a one-time project, or another service.",
      link: `/admin/customers/${customerId}?tab=products`, linkText: "Open Products" },
    { done: !!equipN && equipN.n > 0,
      label: "Equipment tracked",
      hint: "No equipment yet. Add the firewall, switch, and workstations, or map a UniFi or Sophos sync.",
      link: firstLoc ? `/app/locations/${firstLoc.id}/equipment` : `/admin/customers/${customerId}?tab=locations`, linkText: "Add equipment" },
    { done: !!billN && billN.n > 0,
      label: "First quote or invoice sent",
      hint: "Nothing billed yet. Quotes and invoices live on the Billing tab.",
      link: `/admin/customers/${customerId}?tab=billing`, linkText: "Open Billing" },
  ];
  const clDone = clSteps.filter((s) => s.done).length;
  const checklist = (!clDismissed && clDone < clSteps.length) ? `<div class="card tab-panel${tab === "organization" ? " active" : ""}" data-panel="organization">
      <div class="row between"><h2 style="margin:0">Getting started</h2>
      <form method="post" action="/admin/customers/${customerId}/checklist-dismiss"><button class="btn small secondary" type="submit">Dismiss</button></form></div>
      <p class="muted" style="margin:6px 0 10px">${clDone} of ${clSteps.length} steps done</p>
      <div style="height:6px;background:#e7edf3;border-radius:3px;overflow:hidden;margin-bottom:8px"><div style="height:100%;width:${Math.round((clDone / clSteps.length) * 100)}%;background:var(--teal)"></div></div>
      ${clSteps.map((s) => `<div class="row" style="gap:10px;align-items:flex-start;padding:7px 0;border-top:1px solid var(--line)">
        <span style="flex:none;width:22px;height:22px;border-radius:50%;${s.done ? "background:var(--teal);color:#fff" : "border:2px solid #c3cedb"};display:flex;align-items:center;justify-content:center;margin-top:1px">${s.done ? icon("check") : ""}</span>
        <span style="flex:1"><strong${s.done ? ' style="color:var(--muted)"' : ""}>${esc(s.label)}</strong>
        ${s.done ? "" : `<div class="muted">${esc(s.hint)}</div>`}</span>
        ${s.done ? "" : `<a class="btn small secondary" href="${s.link}">${esc(s.linkText)}</a>`}</div>`).join("")}
    </div>` : "";
  const locOptions = (locations || []).map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("");
  const railBtn = (key, label, ic) => `<button type="button" class="tab-btn rail-item${tab === key ? " active" : ""}" data-tab="${key}">${icon(ic)}${label}</button>`;
  const body = `<div class="shell"><aside class="rail">
    <div class="rail-context"><div class="rc-t">${esc(c.name)}</div><div class="rc-s">Organization</div></div>
    <a class="rail-item" href="/admin">&larr; All clients</a>
    ${railBtn("organization", "Organization", "building")}${railBtn("locations", "Locations", "pin")}${railBtn("products", "Products", "box")}
    ${railBtn("users", "Users", "users")}${railBtn("billing", "Billing", "receipt")}${railBtn("manage", "Manage", "sliders")}
    </aside><div class="shell-main"><h1>${esc(c.name)}</h1>
    <p class="muted">${esc(c.contact_name || "")} ${esc(c.contact_email || "")} ${esc(c.phone || "")}</p>
    <noscript><style>.tab-panel{display:block}.rail{display:none}</style></noscript>
    ${checklist}
    <div class="card tab-panel${tab === "organization" ? " active" : ""}" data-panel="organization">
      <form method="post" action="/admin/customers/${customerId}/edit">
        <label>Organization name <span class="req">*</span></label><input name="name" value="${esc(c.name)}" required>
        <div class="row"><span style="flex:1"><label>First name <span class="req">*</span></label><input name="contact_first_name" value="${esc(c.contact_first_name || "")}" required></span>
        <span style="flex:1"><label>Middle name</label><input name="contact_middle_name" value="${esc(c.contact_middle_name || "")}"></span>
        <span style="flex:1"><label>Last name <span class="req">*</span></label><input name="contact_last_name" value="${esc(c.contact_last_name || "")}" required></span></div>
        <label>Client admin email</label><input name="contact_email" type="email" value="${esc(c.contact_email || "")}" readonly>
        <p class="muted" style="margin:4px 0 8px">This email can't be changed. It identifies the practice in the portal.</p>
        <label>Phone <span class="req">*</span></label><input name="phone" data-phone inputmode="tel" value="${esc(c.phone || "")}">
        <p style="margin-top:12px"><button class="btn small" type="submit">Save</button> <button class="btn small secondary" type="button" data-cancel>Cancel</button></p></form></div>
    <div class="card tab-panel${tab === "locations" ? " active" : ""}" data-panel="locations">
      <div class="tscroll"><table class="stack"><thead><tr><th>Name</th><th>Address</th><th>Status</th><th>Edit</th></tr></thead><tbody>${locRows || `<tr><td colspan="4" class="muted">No locations yet.</td></tr>`}</tbody></table></div>
      <p style="margin-top:14px"><a class="btn small secondary" href="/admin/customers/${customerId}/locations/new">+ Add location</a></p></div>
    <script src="/assets/address-lookup.js"></script>
    <script src="/assets/phone-format.js"></script>
    <div class="card tab-panel${tab === "products" ? " active" : ""}" data-panel="products">
      ${officeSwitcher}
      <h3 style="margin-top:0">${selLoc ? esc(selLoc.name) : "All offices"}</h3>
      <div class="tscroll"><table class="stack"><thead><tr><th>Product</th><th>State</th><th>Change</th></tr></thead><tbody>${selLoc ? selLocRows : prodRows}</tbody></table></div>
      ${selLoc ? "" : `<p class="muted">Offices follow the All offices setting unless you pick an office above and set it on its own.</p>`}
      <p class="muted">Changes apply right away. When a service is off, the client sees it as locked on their side, and their only option there is a button to ask you to turn it on.</p></div>
    <div class="card tab-panel${tab === "users" ? " active" : ""}" data-panel="users">
      <div class="tscroll"><table class="stack"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>${memberRows || `<tr><td colspan="6" class="muted">No logins yet.</td></tr>`}</tbody></table></div>
      <p style="margin-top:14px"><a class="btn small secondary" href="/admin/customers/${customerId}/users/new">+ Add user</a></p>
      <p class="muted">The invite email asks them to set a password and finish sign-in. Access starts only with this invite.</p></div>
    <div class="card tab-panel${tab === "billing" ? " active" : ""}" data-panel="billing">
      ${planLine}${billingSwitcher}
      ${btab === "quotes" ? quotesSection : invoicesSection}
    </div>
    <div class="card tab-panel${tab === "manage" ? " active" : ""}" data-panel="manage" style="border-color:#e5b4b0">
      <h3 style="color:var(--bad)">Delete organization</h3>
      <p class="muted">Deleting this organization permanently removes its locations, equipment, tickets, documents, and login access. This cannot be undone.</p>
      <p><a class="btn danger" href="/admin/customers/${customerId}/delete">Delete this organization</a></p></div>
    <script src="/assets/org-page.js"></script>`;
  return page({ title: c.name, user, body, flash: q(request).get("msg") || undefined, error: q(request).get("err") || undefined });
}

// ---------- Quotes and invoices (admin side) ----------
export async function quoteCreatePost(env, request, user, customerId) {
  const f = await request.formData();
  const title = String(f.get("title") || "").trim();
  if (!title) return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&err=` + encodeURIComponent("A quote needs a title."));
  const kind = String(f.get("kind") || "project") === "plan" ? "plan" : "project";
  const deposit = Math.max(0, Math.min(100, Math.round(Number(f.get("deposit_percent") || 0) || 0)));
  const terms = String(f.get("terms") || "").trim();
  const res = await env.DB.prepare(
    "INSERT INTO quotes (customer_id, title, kind, status, deposit_percent, terms, created_by) VALUES (?, ?, ?, 'draft', ?, ?, ?)")
    .bind(customerId, title, kind, deposit, terms || null, user.id).run();
  const quoteId = res.meta.last_row_id;
  const descs = f.getAll("item_desc"), qtys = f.getAll("item_qty"), prices = f.getAll("item_price");
  for (let i = 0; i < descs.length; i++) {
    const desc = String(descs[i] || "").trim();
    if (!desc) continue;
    const qty = Number(qtys[i]) > 0 ? Number(qtys[i]) : 1;
    await env.DB.prepare(
      "INSERT INTO quote_items (quote_id, description, qty, unit_price_cents, sort) VALUES (?, ?, ?, ?, ?)")
      .bind(quoteId, desc, qty, parseDollarsToCents(prices[i]), i).run();
  }
  await audit(env.DB, user.id, "quote_create", "quote", quoteId, title);
  return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&msg=` + encodeURIComponent("Draft quote saved. Send it when you are ready."));
}

export async function quoteActionPost(env, request, user, customerId, quoteId, action) {
  const db = env.DB;
  const quote = await db.prepare("SELECT * FROM quotes WHERE id = ? AND customer_id = ?").bind(quoteId, customerId).first();
  if (!quote) return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&err=` + encodeURIComponent("Quote not found."));
  if (action === "send") {
    if (quote.status !== "draft") return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&err=` + encodeURIComponent("Only a draft can be sent."));
    await db.prepare("UPDATE quotes SET status = 'sent', sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").bind(quoteId).run();
    await audit(db, user.id, "quote_send", "quote", quoteId, quote.title);
    const cust = await db.prepare("SELECT contact_name, contact_email FROM customers WHERE id = ?").bind(customerId).first();
    if (cust && cust.contact_email) {
      const mail = quoteSentEmail(env, {
        name: cust.contact_name || "there", quoteTitle: quote.title,
        link: `${origin(env)}/app/quotes/${quoteId}`,
      });
      await sendEmail(env, { to: cust.contact_email, template: "quote_sent", ...mail });
    }
    return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&msg=` + encodeURIComponent("Quote sent. The customer can review and accept it in the portal."));
  }
  if (action === "remind") {
    if (quote.status !== "sent") return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&err=` + encodeURIComponent("Only a sent quote can be reminded."));
    if (!await sendQuoteReminder(env, quote, false)) return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&err=` + encodeURIComponent("No email address on file for this customer."));
    await audit(db, user.id, "reminder_sent", "quote", quoteId, "Manual reminder");
    return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&msg=` + encodeURIComponent("Reminder sent to the customer."));
  }
  if (action === "delete") {
    if (quote.status !== "draft") return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&err=` + encodeURIComponent("Only a draft quote can be deleted."));
    await db.prepare("DELETE FROM quote_items WHERE quote_id = ?").bind(quoteId).run();
    await db.prepare("DELETE FROM quotes WHERE id = ?").bind(quoteId).run();
    await audit(db, user.id, "quote_delete", "quote", quoteId, quote.title);
    return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&msg=` + encodeURIComponent("Draft quote deleted."));
  }
  if (action === "final") {
    if (quote.status !== "accepted") return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&err=` + encodeURIComponent("The quote has to be accepted before the final invoice."));
    const totals = await db.prepare(
      `SELECT COALESCE((SELECT SUM(ROUND(qi.qty * qi.unit_price_cents)) FROM quote_items qi WHERE qi.quote_id = q.id), 0) AS total_cents,
              COALESCE((SELECT SUM(amount_cents) FROM invoices WHERE quote_id = q.id AND status != 'void'), 0) AS invoiced_cents,
              (SELECT COUNT(*) FROM invoices WHERE quote_id = q.id AND kind = 'deposit' AND status != 'void') AS deposits
       FROM quotes q WHERE q.id = ?`).bind(quoteId).first();
    const remaining = (totals ? totals.total_cents : 0) - (totals ? totals.invoiced_cents : 0);
    if (remaining <= 0) return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&err=` + encodeURIComponent("This quote is already fully invoiced."));
    const isFinal = totals && totals.deposits > 0;
    const finRes = await db.prepare(
      "INSERT INTO invoices (customer_id, quote_id, title, kind, amount_cents, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(customerId, quoteId, isFinal ? `${quote.title}: final balance` : quote.title, isFinal ? "final" : "standard", remaining, user.id).run();
    await audit(db, user.id, "invoice_create", "quote", quoteId, `${quote.title} balance ${remaining}`);
    const finInv = await db.prepare("SELECT * FROM invoices WHERE id = ?").bind(finRes.meta.last_row_id).first().catch(() => null);
    if (finInv) await sendInvoiceIssued(env, finInv).catch(() => {});
    return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&msg=` + encodeURIComponent("Invoice created for the remaining balance."));
  }
  return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes`);
}

// POST /admin/customers/:cid/quotes/:qid/sow — attach (or replace)
// the one Statement of Work PDF on a quote. Stored in R2 next to the
// documents; the customer sees it on the quote page, and accepting
// the quote accepts the SOW with it.
export async function quoteSowPost(env, request, user, customerId, quoteId) {
  const back = (q) => redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&${q}`);
  const quote = await env.DB.prepare("SELECT * FROM quotes WHERE id = ? AND customer_id = ?")
    .bind(quoteId, customerId).first();
  if (!quote) return back("err=" + encodeURIComponent("Quote not found."));
  const f = await request.formData();
  const file = f.get("sow");
  if (!file || !file.size) return back("err=" + encodeURIComponent("Choose a PDF file first."));
  const isPdf = /pdf$/i.test(file.type || "") || /\.pdf$/i.test(file.name || "");
  if (!isPdf) return back("err=" + encodeURIComponent("The SOW has to be a PDF."));
  if (file.size > 10 * 1024 * 1024) return back("err=" + encodeURIComponent("That file is over the 10 MB limit."));
  const key = `quotes/${quoteId}/sow-${Date.now()}.pdf`;
  if (env.DOCS) {
    if (quote.sow_r2_key) { try { await env.DOCS.delete(quote.sow_r2_key); } catch { /* replaced anyway */ } }
    await env.DOCS.put(key, file.stream(), { httpMetadata: { contentType: "application/pdf" } });
  }
  await env.DB.prepare("UPDATE quotes SET sow_r2_key = ?, sow_name = ?, sow_mime = 'application/pdf', sow_size = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(env.DOCS ? key : null, String(file.name || "Statement of Work.pdf"), file.size, quoteId).run();
  await audit(env.DB, user.id, "quote_sow_attach", "quote", quoteId, String(file.name || ""));
  return back("msg=" + encodeURIComponent("SOW attached to the quote."));
}

// POST /admin/customers/:cid/quotes/:qid/sow-remove
export async function quoteSowRemovePost(env, request, user, customerId, quoteId) {
  const quote = await env.DB.prepare("SELECT * FROM quotes WHERE id = ? AND customer_id = ?")
    .bind(quoteId, customerId).first();
  if (quote && quote.sow_r2_key && env.DOCS) { try { await env.DOCS.delete(quote.sow_r2_key); } catch { /* gone either way */ } }
  if (quote) {
    await env.DB.prepare(
      "UPDATE quotes SET sow_r2_key = NULL, sow_name = NULL, sow_mime = NULL, sow_size = NULL, sow_accepted_at = NULL, sow_accepted_by = NULL, updated_at = datetime('now') WHERE id = ?")
      .bind(quoteId).run();
    await audit(env.DB, user.id, "quote_sow_remove", "quote", quoteId, "");
  }
  return redirect(`/admin/customers/${customerId}?tab=billing&btab=quotes&msg=` + encodeURIComponent("SOW removed."));
}

export async function invoiceCreatePost(env, request, user, customerId) {
  const f = await request.formData();
  const title = String(f.get("title") || "").trim();
  const amount = parseDollarsToCents(f.get("amount"));
  if (!title || amount <= 0) return redirect(`/admin/customers/${customerId}?tab=billing&btab=invoices&err=` + encodeURIComponent("An invoice needs a title and an amount."));
  const due = String(f.get("due_date") || "").trim();
  const payUrl = String(f.get("pay_url") || "").trim();
  const res = await env.DB.prepare(
    "INSERT INTO invoices (customer_id, title, kind, amount_cents, due_date, pay_url, created_by) VALUES (?, ?, 'standard', ?, ?, ?, ?)")
    .bind(customerId, title, amount, due || null, /^https?:\/\//i.test(payUrl) ? payUrl : null, user.id).run();
  await audit(env.DB, user.id, "invoice_create", "invoice", res.meta.last_row_id, title);
  const newInv = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(res.meta.last_row_id).first().catch(() => null);
  if (newInv) await sendInvoiceIssued(env, newInv).catch(() => {});
  return redirect(`/admin/customers/${customerId}?tab=billing&btab=invoices&msg=` + encodeURIComponent("Invoice created."));
}

export async function invoiceActionPost(env, request, user, customerId, invoiceId, action) {
  const db = env.DB;
  const inv = await db.prepare("SELECT * FROM invoices WHERE id = ? AND customer_id = ?").bind(invoiceId, customerId).first();
  if (!inv) return redirect(`/admin/customers/${customerId}?tab=billing&btab=invoices&err=` + encodeURIComponent("Invoice not found."));
  if (action === "paid" && inv.status === "unpaid") {
    const f = await request.formData();
    const method = String(f.get("method") || "").trim();
    await db.prepare("UPDATE invoices SET status = 'paid', paid_at = datetime('now'), paid_method = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(method || null, invoiceId).run();
    await audit(db, user.id, "invoice_paid", "invoice", invoiceId, method || "");
    // The filed Documents copy flips to the paid version, and a
    // project invoice sends its payment stage email.
    const paidInv = await db.prepare("SELECT * FROM invoices WHERE id = ?").bind(invoiceId).first().catch(() => null);
    if (paidInv) await onInvoicePaid(env, paidInv);
    return redirect(`/admin/customers/${customerId}?tab=billing&btab=invoices&msg=` + encodeURIComponent("Invoice marked paid."));
  }
  if (action === "void" && inv.status === "unpaid") {
    await db.prepare("UPDATE invoices SET status = 'void', updated_at = datetime('now') WHERE id = ?").bind(invoiceId).run();
    await audit(db, user.id, "invoice_void", "invoice", invoiceId, inv.title);
    return redirect(`/admin/customers/${customerId}?tab=billing&btab=invoices&msg=` + encodeURIComponent("Invoice voided."));
  }
  if (action === "remind") {
    if (inv.status !== "unpaid") return redirect(`/admin/customers/${customerId}?tab=billing&btab=invoices&err=` + encodeURIComponent("Only an unpaid invoice can be reminded."));
    const today = new Date().toISOString().slice(0, 10);
    const late = inv.due_date ? Math.floor((Date.parse(today + "T00:00:00Z") - Date.parse(inv.due_date + "T00:00:00Z")) / 86400000) : -1;
    const kind = !inv.due_date || late < 0 ? "reminder" : late === 0 ? "due" : "overdue";
    if (!await sendInvoiceReminder(env, inv, kind, Math.max(late, 0))) return redirect(`/admin/customers/${customerId}?tab=billing&btab=invoices&err=` + encodeURIComponent("No email address on file for this customer."));
    await audit(env.DB, user.id, "reminder_sent", "invoice", invoiceId, "Manual reminder");
    return redirect(`/admin/customers/${customerId}?tab=billing&btab=invoices&msg=` + encodeURIComponent("Reminder sent to the customer."));
  }
  return redirect(`/admin/customers/${customerId}?tab=billing&btab=invoices`);
}

export async function addLocationPost(env, request, user, customerId) {
  const f = await request.formData();
  const name = String(f.get("name") || "").trim();
  const address = String(f.get("address") || "").trim();
  const city = String(f.get("city") || "").trim();
  const state = String(f.get("state") || "").trim();
  const zip = String(f.get("zip") || "").trim();
  const suite = String(f.get("suite") || "").trim();
  if (!name || !address || !city || !state || !zip) {
    return redirect(`/admin/customers/${customerId}?tab=locations&msg=` + encodeURIComponent(
      "Name, street address, city, state, and ZIP are all required for a location."));
  }
  await env.DB.prepare(
    "INSERT INTO locations (customer_id, name, address, suite, city, state, zip) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(customerId, name, address, suite, city, state, zip).run();
  await audit(env.DB, user.id, "location_create", "customer", Number(customerId), name);
  return redirect(`/admin/customers/${customerId}?tab=locations`);
}

export async function addLocationPage(env, request, user, customerId) {
  const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  if (!c) return redirect("/admin?err=" + encodeURIComponent("Organization not found."));
  const body = `${adminNav("")}
    <p><a href="/admin/customers/${customerId}?tab=locations">&larr; ${esc(c.name)}</a></p>
    <h1>Add location</h1>
    <div class="card"><form method="post" action="/admin/customers/${customerId}/locations" data-loc>
      <label>Location / practice name <span class="req">*</span></label><input name="name" required>
      <label>Street address <span class="req">*</span></label><input name="address" data-address autocomplete="off" placeholder="Start typing, then pick the address" required>
      <label>Suite / Unit</label><input name="suite" class="f-suite" placeholder="Suite 200 (optional)">
      <div class="row"><span style="flex:2"><label>City <span class="req">*</span></label><input name="city" class="f-city" required></span>
      <span style="flex:1"><label>State <span class="req">*</span></label><input name="state" class="f-state" required></span>
      <span style="flex:1"><label>ZIP <span class="req">*</span></label><input name="zip" class="f-zip" required></span></div>
      <p class="muted">Address suggestions come from ${env.GOOGLE_PLACES_API_KEY ? "Google Maps" : "OpenStreetMap"}.</p>
      <p class="row" style="margin-top:20px">
        <a class="btn secondary" href="/admin/customers/${customerId}?tab=locations">Cancel</a>
        <button class="btn" type="submit">Add location</button>
      </p></form></div>
    <script src="/assets/address-lookup.js"></script>`;
  return page({ title: "Add location", user, body, flash: q(request).get("msg") || undefined });
}

export async function addUserPage(env, request, user, customerId) {
  const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  if (!c) return redirect("/admin?err=" + encodeURIComponent("Organization not found."));
  const { results: locations } = await env.DB.prepare(
    "SELECT id, name FROM locations WHERE customer_id = ? ORDER BY name").bind(customerId).all();
  const locOptions = (locations || []).map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("");
  const body = `${adminNav("")}
    <p><a href="/admin/customers/${customerId}?tab=users">&larr; ${esc(c.name)}</a></p>
    <h1>Add user</h1>
    <div class="card"><form method="post" action="/admin/customers/${customerId}/users">
      <div class="row"><span style="flex:1"><label>First name <span class="req">*</span></label><input name="first_name" required></span>
      <span style="flex:1"><label>Middle name</label><input name="middle_name"></span>
      <span style="flex:1"><label>Last name <span class="req">*</span></label><input name="last_name" required></span></div>
      <label>Email <span class="req">*</span></label><input name="email" type="email" required>
      <div class="row"><span style="flex:1"><label>Access</label><select name="location_id">
        <option value="">All locations</option>${locOptions}</select></span>
      <span style="flex:1"><label>Scope</label><select name="scope">
        <option value="user">User</option><option value="admin">Location admin</option></select></span></div>
      <p class="muted">The invite email asks them to set a password and finish sign-in. Access starts only with this invite.</p>
      <p class="row" style="margin-top:20px">
        <a class="btn secondary" href="/admin/customers/${customerId}?tab=users">Cancel</a>
        <button class="btn" type="submit">Send invite</button>
      </p></form></div>`;
  return page({ title: "Add user", user, body, flash: q(request).get("msg") || undefined });
}

export async function editLocationPost(env, request, user, locationId) {
  const loc = await env.DB.prepare("SELECT * FROM locations WHERE id = ?").bind(locationId).first();
  if (!loc) return redirect("/admin");
  const f = await request.formData();
  const name = String(f.get("name") || "").trim();
  const address = String(f.get("address") || "").trim();
  const city = String(f.get("city") || "").trim();
  const state = String(f.get("state") || "").trim();
  const zip = String(f.get("zip") || "").trim();
  if (!name || !address || !city || !state || !zip) {
    return redirect(`/admin/customers/${loc.customer_id}?tab=locations&msg=` + encodeURIComponent(
      "Name, street address, city, state, and ZIP are all required for a location. Nothing was saved."));
  }
  const suite2 = String(f.get("suite") || "").trim();
  await env.DB.prepare(
    "UPDATE locations SET name = ?, address = ?, suite = ?, city = ?, state = ?, zip = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(name, address, suite2, city, state, zip, locationId).run();
  return redirect(`/admin/customers/${loc.customer_id}?tab=locations`);
}

export async function productTogglePost(env, request, user, customerId) {
  const f = await request.formData();
  const product = String(f.get("product") || "");
  const enabled = String(f.get("enabled") || "0") === "1" ? 1 : 0;
  const locationId = f.get("location_id") ? Number(f.get("location_id")) : null;
  const valid = await env.DB.prepare("SELECT key FROM products WHERE key = ?").bind(product).first();
  if (valid) {
    // One-Time Project turning on carries the flow with it (project
    // record, activation email); only a real off-to-on transition
    // counts, so re-saving an already-on switch does not re-email.
    const wasOn = product === "one_time_project"
      ? await productEnabled(env.DB, customerId, locationId, "one_time_project").catch(() => false)
      : false;
    // Manual upsert: SQLite treats NULL location_id as distinct in UNIQUE
    // indexes, so an ON CONFLICT clause would silently duplicate rows.
    const existing = await env.DB.prepare(
      `SELECT id FROM customer_products WHERE customer_id = ? AND product = ?
       AND ((location_id IS NULL AND ? IS NULL) OR location_id = ?)`)
      .bind(customerId, product, locationId, locationId).first();
    if (existing) {
      await env.DB.prepare(
        "UPDATE customer_products SET enabled = ?, plan_note = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(enabled, null, existing.id).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO customer_products (customer_id, location_id, product, enabled, plan_note) VALUES (?, ?, ?, ?, ?)")
        .bind(customerId, locationId, product, enabled, null).run();
    }
    await audit(env.DB, user.id, enabled ? "product_on" : "product_off", "customer", Number(customerId), product);
    if (product === "one_time_project" && enabled === 1 && !wasOn) {
      await onOtpToggledOn(env, Number(customerId), locationId, user.id);
    }
  }
  // Back to the Products tab with the same office still selected, so
  // a per-office toggle does not bounce the admin to All offices.
  return redirect(locationId
    ? `/admin/customers/${customerId}?tab=products&office=${locationId}`
    : `/admin/customers/${customerId}?tab=products`);
}

export async function inviteCustomerUserPost(env, request, user, customerId) {
  const f = await request.formData();
  const first = String(f.get("first_name") || "").trim();
  const middle = String(f.get("middle_name") || "").trim();
  const last = String(f.get("last_name") || "").trim();
  const name = [first, middle, last].filter(Boolean).join(" ");
  const email = String(f.get("email") || "").trim().toLowerCase();
  const locationId = f.get("location_id") ? Number(f.get("location_id")) : null;
  const scope = String(f.get("scope") || "user") === "admin" ? "admin" : "user";
  if (!first || !last || !isValidEmail(email)) {
    return redirect(`/admin/customers/${customerId}?tab=users&msg=` + encodeURIComponent(
      "Enter the person's first name, last name, and a valid email address."));
  }
  let target = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (!target) {
    const res = await env.DB.prepare(
      `INSERT INTO users (email, name, kind, role, status) VALUES (?, ?, 'customer', ?, 'invited')`)
      .bind(email, name, scope === "admin" ? "customer_admin" : "customer_user").run();
    target = { id: res.meta.last_row_id, name, email };
  } else if (target.kind === "customer") {
    // A returning login (for example someone removed from another
    // organization) takes the role of this new grant, never a leftover
    // role from before. Their old access was deleted at removal and is
    // not resurrected; the grant below is the only access they get.
    await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?")
      .bind(scope === "admin" ? "customer_admin" : "customer_user", target.id).run();
    // The name typed here is the name of record for this login and
    // replaces whatever an older account under this email carries.
    if (name && name !== target.name) {
      await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, target.id).run();
      target = { ...target, name };
    }
    // A disabled login goes back to invited, so the row shows as a
    // pending invite (and can be resent) until they set a password.
    if (target.status === "disabled") {
      await env.DB.prepare("UPDATE users SET status = 'invited' WHERE id = ?").bind(target.id).run();
    }
  }
  const grant = await grantUserAccess(env.DB, target.id, customerId, locationId, scope);
  if (!grant.ok) {
    // FlossByte admins may be told which organization holds the email.
    // Customer-facing flows never see the other organization's name.
    const detail = grant.otherCustomer ? ` It belongs to ${grant.otherCustomer.name}.` : "";
    return redirect(`/admin/customers/${customerId}?tab=users&msg=` + encodeURIComponent(grant.error + detail));
  }
  const raw = await createAuthToken(env.DB, target.id, "invite", 7 * 24 * 60);
  const mail = inviteEmail(env, { name: target.name, link: `${origin(env)}/invite/${raw}` });
  await sendEmail(env, { to: email, template: "invite", ...mail });
  await audit(env.DB, user.id, "user_invite", "user", target.id, email);
  return redirect(`/admin/customers/${customerId}?tab=users&msg=` + encodeURIComponent("Invite sent (or queued, if email is not configured yet)."));
}

export async function customerUserResendPost(env, request, user, customerId, targetId) {
  const access = await env.DB.prepare(
    "SELECT id FROM user_access WHERE user_id = ? AND customer_id = ?").bind(targetId, customerId).first();
  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(targetId).first();
  if (!access || !target || target.kind !== "customer" || target.status !== "invited") {
    return redirect(`/admin/customers/${customerId}?tab=users&msg=` + encodeURIComponent("That login cannot be re-invited. Only pending invites can be resent."));
  }
  await resendInviteEmail(env, target);
  await audit(env.DB, user.id, "invite_resent_admin", "user", target.id, target.email);
  return redirect(`/admin/customers/${customerId}?tab=users&msg=` + encodeURIComponent(`Invite resent to ${target.email}. The old link no longer works.`));
}

// ---------- Delete organization ----------
// Deleting an organization removes everything under it: locations,
// equipment, tickets (and their updates), documents (database rows and
// the R2 files), product settings, and logins' access. The people's
// accounts are not erased: anyone whose only access was this
// organization is disabled and signed out, with their history kept, the
// same treatment as a removal. Guarded by a type-the-name confirmation.
export async function deleteCustomerPage(env, request, user, customerId) {
  const db = env.DB;
  const c = await db.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  if (!c) return withStatus(page({ title: "Not found", user, body: `<div class="card narrow"><h1>Not found</h1></div>` }), 404);
  const one = async (sql) => (await db.prepare(sql).bind(customerId).first()).n;
  const locIds = "(SELECT id FROM locations WHERE customer_id = ?)";
  const counts = {
    locations: await one("SELECT COUNT(*) AS n FROM locations WHERE customer_id = ?"),
    logins: await one("SELECT COUNT(DISTINCT user_id) AS n FROM user_access WHERE customer_id = ?"),
    equipment: await one(`SELECT COUNT(*) AS n FROM equipment WHERE location_id IN ${locIds}`),
    tickets: await one(`SELECT COUNT(*) AS n FROM tickets WHERE location_id IN ${locIds}`),
    documents: await one(`SELECT COUNT(*) AS n FROM documents WHERE location_id IN ${locIds}`),
  };
  const errs = String(q(request).get("err") || "").split(",");
  const body = `${adminNav("")}<div class="card narrow" style="margin:0;max-width:560px">
    <h1 style="color:var(--bad)">Delete ${esc(c.name)}</h1>
    <p>This permanently deletes the organization and everything under it:</p>
    <ul>
      <li>${plural(counts.locations, "location")}</li>
      <li>${plural(counts.equipment, "equipment record")}</li>
      <li>${plural(counts.tickets, "ticket")} with their full history</li>
      <li>${plural(counts.documents, "document")}, including the stored files</li>
      <li>Product settings for this organization</li>
    </ul>
    <p>${counts.logins === 1 ? "The 1 login is" : `The ${counts.logins} logins are`} signed out immediately and lose access. Their accounts are disabled, not erased, so ticket history keeps its authors.</p>
    <p><strong>This cannot be undone.</strong></p>
    <form method="post" action="/admin/customers/${customerId}/delete" id="deleteOrgForm">
      <label>Type the organization (${esc(c.name)}) name to confirm <span class="req">*</span></label>
      <input name="confirm_name" id="confirmName" autocomplete="off" placeholder="${esc(c.name)}" ${errs.includes("name") ? 'class="field-error"' : ""}>
      <label class="confirm-box${errs.includes("box") ? " error" : ""}" id="confirmBox">
        <input type="checkbox" name="confirm" id="confirmCheck" value="yes">
        <span><span class="req">*</span> I understand this permanently deletes ${esc(c.name)} and everything under it.</span></label>
      <p class="row" style="margin-top:18px">
        <button class="btn danger" type="submit">Delete organization</button>
        <a class="btn secondary" href="/admin/customers/${customerId}">Cancel</a></p>
    </form></div>
    <script>
      (function () {
        var form = document.getElementById("deleteOrgForm");
        var box = document.getElementById("confirmBox");
        var check = document.getElementById("confirmCheck");
        var name = document.getElementById("confirmName");
        var expected = ${JSON.stringify(c.name)};
        check.addEventListener("change", function () { if (check.checked) box.classList.remove("error"); });
        name.addEventListener("input", function () { name.classList.remove("field-error"); });
        form.addEventListener("submit", function (e) {
          var bad = false;
          if (name.value.trim() !== expected) { name.classList.add("field-error"); bad = true; }
          if (!check.checked) { box.classList.add("error"); box.scrollIntoView({ block: "center" }); bad = true; }
          if (bad) e.preventDefault();
        });
      })();
    </script>`;
  return page({ title: "Delete organization", user, body, flash: q(request).get("err") ? undefined : (q(request).get("msg") || undefined), error: q(request).get("err") ? (q(request).get("msg") || undefined) : undefined });
}

export async function deleteCustomerPost(env, request, user, customerId) {
  const db = env.DB;
  const c = await db.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  if (!c) return redirect("/admin");
  const f = await request.formData();
  const nameBad = String(f.get("confirm_name") || "").trim() !== c.name;
  const boxBad = String(f.get("confirm") || "") !== "yes";
  if (nameBad || boxBad) {
    const err = [nameBad && "name", boxBad && "box"].filter(Boolean).join(",");
    return redirect(`/admin/customers/${customerId}/delete?err=${err}&msg=` +
      encodeURIComponent(`Confirmation did not match. Type "${c.name}" exactly as shown and tick the box.`));
  }
  const locIds = "(SELECT id FROM locations WHERE customer_id = ?)";
  const { results: docRows } = await db.prepare(
    `SELECT r2_key FROM documents WHERE location_id IN ${locIds} AND r2_key IS NOT NULL`).bind(customerId).all();
  const { results: memberRows } = await db.prepare(
    "SELECT DISTINCT user_id FROM user_access WHERE customer_id = ?").bind(customerId).all();
  const del = (sql) => db.prepare(sql).bind(customerId);
  await db.batch([
    del(`DELETE FROM ticket_updates WHERE ticket_id IN (SELECT id FROM tickets WHERE location_id IN ${locIds})`),
    del(`DELETE FROM tickets WHERE location_id IN ${locIds}`),
    del(`DELETE FROM ask_messages WHERE location_id IN ${locIds}`),
    del(`DELETE FROM documents WHERE location_id IN ${locIds}`),
    del(`DELETE FROM equipment WHERE location_id IN ${locIds}`),
    del("DELETE FROM invoices WHERE customer_id = ?"),
    del("DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE customer_id = ?)"),
    del("DELETE FROM quotes WHERE customer_id = ?"),
    del(`UPDATE sync_sites SET location_id = NULL WHERE location_id IN ${locIds}`),
    del("DELETE FROM customer_products WHERE customer_id = ?"),
    del("DELETE FROM user_access WHERE customer_id = ?"),
    del("DELETE FROM locations WHERE customer_id = ?"),
    del("DELETE FROM customers WHERE id = ?"),
  ]);
  // People whose only access was this organization are disabled and
  // signed out (accounts kept for history). Anyone with access elsewhere
  // (not possible under the one-organization rule, but checked anyway)
  // keeps their account untouched.
  for (const m of memberRows || []) {
    const remaining = await db.prepare("SELECT COUNT(*) AS n FROM user_access WHERE user_id = ?").bind(m.user_id).first();
    if (remaining && remaining.n === 0) {
      await db.prepare("UPDATE users SET status = 'disabled', updated_at = datetime('now') WHERE id = ? AND kind = 'customer'").bind(m.user_id).run();
      await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(m.user_id).run();
      await db.prepare("DELETE FROM auth_tokens WHERE user_id = ?").bind(m.user_id).run();
    }
  }
  if (env.DOCS) {
    for (const d of docRows || []) {
      try { await env.DOCS.delete(d.r2_key); } catch { /* file cleanup is best-effort; rows are already gone */ }
    }
  }
  await audit(db, user.id, "customer_delete", "customer", Number(customerId), c.name);
  return redirect("/admin?msg=" + encodeURIComponent(`Organization "${c.name}" was deleted.`));
}

// ---------- Edit a client login's name ----------
// Names can be corrected; the email is the login and never changes.
async function customerMember(db, customerId, targetId) {
  return db.prepare(
    `SELECT u.* FROM users u WHERE u.id = ? AND u.kind = 'customer'
     AND EXISTS (SELECT 1 FROM user_access ua WHERE ua.user_id = u.id AND ua.customer_id = ?)`).bind(targetId, customerId).first();
}

export async function userEditPage(env, request, user, customerId, targetId) {
  const target = await customerMember(env.DB, customerId, targetId);
  if (!target) return redirect(`/admin/customers/${customerId}?tab=users&err=` + encodeURIComponent("That login does not belong to this client."));
  const np = splitName(target.name);
  const body = `${adminNav("clients")}<div class="card narrow" style="margin:0;max-width:560px"><h1>Edit login</h1>
    <form method="post" action="/admin/customers/${customerId}/users/${target.id}/edit">
      <div class="row"><span style="flex:1"><label>First name <span class="req">*</span></label><input name="first_name" value="${esc(np.first)}" required></span>
      <span style="flex:1"><label>Middle name</label><input name="middle_name" value="${esc(np.middle)}"></span>
      <span style="flex:1"><label>Last name <span class="req">*</span></label><input name="last_name" value="${esc(np.last)}" required></span></div>
      <label>Email</label><input value="${esc(target.email)}" disabled>
      <p class="muted" style="margin:4px 0 0">The email is the login and can't be changed.</p>
      <label>Phone</label><input value="${esc(target.phone || "")}" disabled>
      <p class="muted" style="margin:4px 0 0">They can update their own phone under Account &amp; security.</p>
      <p style="margin-top:16px"><button class="btn" type="submit">Save name</button>
      <a class="btn secondary" href="/admin/customers/${customerId}?tab=users">Cancel</a></p>
    </form></div>`;
  return page({ title: "Edit login", user, body, error: q(request).get("err") || undefined });
}

export async function userEditPost(env, request, user, customerId, targetId) {
  const target = await customerMember(env.DB, customerId, targetId);
  if (!target) return redirect(`/admin/customers/${customerId}?tab=users&err=` + encodeURIComponent("That login does not belong to this client."));
  const f = await request.formData();
  const first = String(f.get("first_name") || "").trim();
  const middle = String(f.get("middle_name") || "").trim();
  const last = String(f.get("last_name") || "").trim();
  if (!first || !last) return redirect(`/admin/customers/${customerId}/users/${target.id}/edit?err=` + encodeURIComponent("First name and last name are required."));
  const name = joinName(first, middle, last);
  await env.DB.prepare("UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?").bind(name, target.id).run();
  await audit(env.DB, user.id, "user_update", "user", target.id, `client ${customerId}`);
  return redirect(`/admin/customers/${customerId}?tab=users&msg=` + encodeURIComponent(`${name}'s name is saved.`));
}

export async function checklistDismissPost(env, request, user, customerId) {
  await env.DB.prepare("INSERT INTO system_state (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
    .bind(`checklist_dismissed_${customerId}`).run();
  return redirect(`/admin/customers/${customerId}?tab=organization`);
}

// ---------- Admin accounts (Super Admin only) ----------
function notSuper(user) {
  return withStatus(page({ title: "Admins", user, body: `<div class="card narrow"><h1>Super Admin only</h1>
    <p class="muted">Only the Super Admin can manage admin accounts. Regular admins still run the full client console.</p></div>` }), 403);
}

export async function adminsPage(env, request, user) {
  if (!isSuperAdmin(user)) return notSuper(user);
  const { results } = await env.DB.prepare(
    "SELECT * FROM users WHERE kind = 'flossbyte' ORDER BY created_at").all();
  const rows = (results || []).map((a) => {
    const isSuper = a.role === "super_admin";
    const controls = isSuper || a.id === user.id
      ? `<span class="muted">Protected</span>`
      : a.status === "invited"
        ? `<form method="post" action="/admin/admins/${a.id}/resend" style="display:inline"><button class="btn small secondary" type="submit">Resend invite</button></form>
           <form method="post" action="/admin/admins/${a.id}/remove" style="display:inline"><button class="btn small secondary" type="submit">Remove</button></form>`
        : a.status === "disabled"
        ? `<form method="post" action="/admin/admins/${a.id}/enable" style="display:inline"><button class="btn small" type="submit">Re-enable</button></form>
           <form method="post" action="/admin/admins/${a.id}/remove" style="display:inline"><button class="btn small danger" type="submit">Remove</button></form>`
        : `<form method="post" action="/admin/admins/${a.id}/disable" style="display:inline"><button class="btn small danger" type="submit">Disable</button></form>
           <form method="post" action="/admin/admins/${a.id}/remove" style="display:inline"><button class="btn small secondary" type="submit">Remove</button></form>`;
    return `<tr><td>${esc(a.name)}</td><td>${esc(a.email)}</td>
      <td>${isSuper ? "Super Admin" : "Admin"}</td>
      <td><span class="pill ${a.status === "disabled" ? "off" : "on"}">${esc(a.status)}</span></td><td>${controls}</td></tr>`;
  }).join("");
  const body = `${adminNav("admins")}<h1>Admin accounts</h1>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>
    <div class="card"><h3>Create an admin</h3>
      <form method="post" action="/admin/admins" class="row" style="align-items:end">
        <span style="flex:1;min-width:120px"><label>First name <span class="req">*</span></label><input name="first_name" required></span>
        <span style="flex:1;min-width:120px"><label>Middle name</label><input name="middle_name"></span>
        <span style="flex:1;min-width:120px"><label>Last name <span class="req">*</span></label><input name="last_name" required></span>
        <span style="flex:1;min-width:200px"><label>Email <span class="req">*</span></label><input name="email" type="email" required></span>
        <button class="btn small" type="submit">Send admin invite</button></form>
      <p class="muted">New admins finish sign-in from the invite email, then set up two-step verification. The Super Admin account can never be disabled or removed, and no admin can disable their own account.</p></div>
    <div class="card"><h3>Transfer ownership</h3>
      <p class="muted">Hand the Super Admin role to another admin, for example when the business is sold. There is always exactly one Super Admin, and the transfer is recorded in the audit log. The new Super Admin needs an active admin account (invited and signed in at least once).</p>
      ${(() => {
        const eligible = (results || []).filter((a) => a.role === "admin" && a.status === "active" && a.id !== user.id);
        if (!eligible.length) return `<p class="muted">No admin can receive ownership yet. Create an admin above and have them finish sign-in first.</p>`;
        return eligible.map((a) => `<p><a class="btn small secondary" href="/admin/transfer/${a.id}">Transfer ownership to ${esc(a.name)}</a> <span class="muted">${esc(a.email)}</span></p>`).join("");
      })()}</div>`;
  return page({ title: "Admins", user, body, flash: q(request).get("msg") || undefined, error: q(request).get("err") || undefined });
}

// ---------- Device sync (UniFi and Sophos) ----------
// One mapping table per provider: a vendor site (UniFi site, Sophos
// tenant) is imported only after an admin maps it to a portal location.
async function siteMappingBlock(env, provider, heading, emptyNote) {
  try {
    const { results: sites } = await env.DB.prepare(
      `SELECT * FROM sync_sites WHERE provider = ? ORDER BY site_name`).bind(provider).all();
    if (!sites || !sites.length) return `<h3 style="margin-top:22px">${heading}</h3><p class="muted">${emptyNote}</p>`;
    const { results: locs } = await env.DB.prepare(
      `SELECT l.id, l.name AS loc_name, c.name AS cust_name FROM locations l
       JOIN customers c ON c.id = l.customer_id ORDER BY c.name, l.name`).all();
    const locOptions = (selected) => `<option value="">Not mapped</option>` + (locs || []).map((l) =>
      `<option value="${l.id}" ${l.id === selected ? "selected" : ""}>${esc(l.cust_name)}: ${esc(l.loc_name)}</option>`).join("");
    const siteRows = sites.map((s) => `<tr><td>${esc(s.site_name || s.site_id)}<div class="muted" style="font-size:12px">Site ID: ${esc(s.site_id)}</div></td>
      <td><form method="post" action="/admin/sync/map" class="row" style="gap:8px">
        <input type="hidden" name="provider" value="${provider}">
        <input type="hidden" name="site_id" value="${esc(s.site_id)}">
        <select name="location_id">${locOptions(s.location_id)}</select>
        <button class="btn small" type="submit">Save</button></form></td></tr>`).join("");
    return `<h3 style="margin-top:22px">${heading}</h3>
      <div class="tscroll"><table class="stack"><thead><tr><th>${provider === "unifi" ? "UniFi site" : provider === "atera" ? "Atera customer" : "Sophos tenant"}</th><th>Portal location</th></tr></thead><tbody>${siteRows}</tbody></table></div>`;
  } catch {
    return `<h3 style="margin-top:22px">${heading}</h3><p class="muted">The database update for device sync (migration 0007) has not been applied yet, so sites cannot be listed.</p>`;
  }
}

function lastRunHtml(last, unitLabel) {
  if (!last) return `<p class="muted" style="margin-top:12px">No sync has run yet.</p>`;
  // A provider that was never connected has nothing to timestamp:
  // show its state plainly instead of a "Last sync" line.
  if (!last.ok && /no .* (credentials|api key) .* saved/i.test(last.message || "")) {
    return `<p class="muted" style="margin-top:12px">${esc(last.message)}</p>`;
  }
  const srow = (label, val) => val != null && val !== ""
    ? `<div style="display:flex;justify-content:space-between;gap:14px;padding:6px 0;border-bottom:1px solid #EEF2F7"><span style="color:#45566E;font-weight:600">${label}</span><span style="text-align:right;font-weight:600">${val}</span></div>` : "";
  const SECTION_LABEL = {
    wans: "WAN connections", networks: "Networks", ssids: "WiFi broadcasts", fwPolicies: "Firewall rules",
    fwZones: "Firewall zones", aclRules: "Access rules", vpnServers: "VPN servers",
    vpnTunnels: "Site-to-site VPN", radiusProfiles: "RADIUS profiles", clients: "Connected devices", protect: "Cameras",
  };
  const checkVal = (v) => {
    const s = String(v);
    if (s.startsWith("ok")) { const n = s.slice(2).trim(); return { text: n ? `OK (${n})` : "OK", on: true }; }
    if (s === "400" || s === "404") return { text: "Not available on this console", on: false };
    return { text: `Error (${s})`, on: false };
  };
  const checks = last.sectionChecks
    ? `<p class="muted" style="margin:12px 0 6px">What each console answered:</p>
       <div style="display:flex;gap:6px;flex-wrap:wrap">${Object.entries(last.sectionChecks).map(([k, v]) => {
         const c = checkVal(v);
         return `<span class="pill ${c.on ? "on" : ""}">${esc(SECTION_LABEL[k] || k)}: ${esc(c.text)}</span>`;
       }).join("")}</div>` : "";
  const errs = [
    last.clientsError ? `Connected devices: ${esc(last.clientsError)}` : "",
    last.snapshotError ? `Snapshots: ${esc(last.snapshotError)}` : "",
    !last.ok && last.message ? esc(last.message) : "",
  ].filter(Boolean).map((e) => `<p style="color:#b91c1c;margin:8px 0 0">${e}</p>`).join("");
  return `<div style="margin-top:12px">
    <p class="muted" style="margin:0 0 4px">Last sync: ${esc(fmtDateUS(String(last.at).slice(0, 10)))} at ${esc(String(last.at).slice(11, 16))} UTC${last.ok && last.message ? ` · ${esc(last.message)}` : ""}</p>
    ${last.ok ? `${srow(unitLabel + " checked", last.sites != null ? last.sites : last.tenants)}
    ${srow("Devices seen", last.devices)}
    ${srow("Added", last.inserted)}
    ${srow("Updated", last.updated)}
    ${srow("Marked offline", last.offlined)}
    ${srow("Not imported (site not mapped)", last.unmappedDevices)}
    ${last.clientsSeen != null ? srow("Connected devices", `${last.clientsSeen} seen · ${last.clientsAdded || 0} added · ${last.clientsUpdated || 0} updated · ${last.clientsOfflined || 0} offline`) : ""}
    ${last.snapshots != null ? srow("Network snapshots updated", last.snapshots) : ""}
    ${last.patchAgents != null ? srow("Computers with patch state", last.patchAgents) : ""}
    ${last.installedAgents != null ? srow("Computers with installed-patch history", last.installedAgents) : ""}
    ${last.alerts != null ? srow("Open alerts mirrored", last.alerts) : ""}
    ${last.monDevices != null ? srow("Monitoring devices mirrored", last.monDevices) : ""}
    ${last.monError ? `<p style="color:#b91c1c;margin:8px 0 0">${esc(last.monError)}</p>` : ""}
    ${last.changesLogged ? srow("Changes logged", last.changesLogged) : ""}` : ""}
    ${errs}${checks}</div>`;
}

export async function syncPage(env, request, user) {
  const [lastUnifi, lastSophos, lastAtera, unifiMap, sophosMap, ateraMap] = await Promise.all([
    lastUnifiSync(env), lastSophosSync(env), lastAteraSync(env),
    siteMappingBlock(env, "unifi", "UniFi sites", "No UniFi sites discovered yet. Once the API key is saved, run a sync and every site on the account will appear here, ready to map to a location."),
    siteMappingBlock(env, "sophos", "Sophos tenants", "No Sophos tenants discovered yet. Once the API credentials are saved, run a sync and every tenant will appear here, ready to map to a location."),
    siteMappingBlock(env, "atera", "Atera customers", "No Atera customers discovered yet. Once the API key is saved, run a sync and every customer (split by site, when Atera names sites) will appear here, ready to map to a location."),
  ]);
  const mutedRow = await env.DB.prepare("SELECT value FROM system_state WHERE key = 'alerts_muted_until'").first().catch(() => null);
  const mutedUntil = mutedRow && mutedRow.value && new Date(mutedRow.value).getTime() > Date.now() ? mutedRow.value : "";
  const lastReportRow = await env.DB.prepare("SELECT value FROM system_state WHERE key = 'last_monthly_report'").first().catch(() => null);
  const remCfg = await getReminderSettings(env.DB);
  const lastReport = lastReportRow ? lastReportRow.value : "";
  const body = `${adminNav("sync")}<h1>Device sync</h1>
    <div class="card"><h3>UniFi</h3>
      <p class="muted">${env.UNIFI_API_KEY
        ? "An API key is saved, so the portal polls your UniFi account every 15 minutes and keeps each mapped location's equipment list current: access points, switches, and gateways, with model, firmware, and online status."
        : "Not connected yet. Create an API key in your UniFi account at unifi.ui.com, then save it in Cloudflare as the secret UNIFI_API_KEY. After that the portal polls UniFi every 15 minutes on its own."}</p>
      <form method="post" action="/admin/sync/run"><button class="btn" type="submit">Sync now</button></form>
      ${lastRunHtml(lastUnifi, "Sites")}</div>
    <div class="card"><h3>Sophos</h3>
      <p class="muted">${env.SOPHOS_CLIENT_ID && env.SOPHOS_CLIENT_SECRET
        ? "API credentials are saved, so the portal polls Sophos Central every 15 minutes and keeps each mapped location's equipment list current: firewalls with model, firmware, and license dates where Sophos ties them to the serial number, plus the protected computers and servers."
        : "Not connected yet. Create an API credential in Sophos Central (partner or tenant admin, API credentials), then save the two values in Cloudflare as the secrets SOPHOS_CLIENT_ID and SOPHOS_CLIENT_SECRET. After that the portal polls Sophos Central every 15 minutes on its own."}</p>
      <form method="post" action="/admin/sync/run-sophos"><button class="btn" type="submit">Sync now</button></form>
      ${lastRunHtml(lastSophos, "Tenants")}</div>
    <div class="card"><h3>Atera</h3>
      <p class="muted">${env.ATERA_API_KEY
        ? "An API key is saved, so the portal polls Atera on the same cycle and keeps each mapped location's computer records current: operating system, hardware, serial numbers, signed-in user, last reboot, waiting and installed Windows patches (refreshed hourly), and open Atera alerts. Monitoring devices registered in Atera (printers, NAS, UPS and the like) mirror into the same equipment lists. Atera tickets and business records (contracts, invoices, contacts) are not pulled; the portal keeps its own. Software lists are not in the Atera API; they arrive by the scheduled script instead."
        : "Not connected yet. In Atera, open Admin, then Data management, then API, and copy the API key. Save it in Cloudflare as the secret ATERA_API_KEY. After that the portal polls Atera on its own; you map each Atera customer to a location below."}</p>
      <form method="post" action="/admin/sync/run-atera"><button class="btn" type="submit">Sync now</button></form>
      ${lastRunHtml(lastAtera, "Customers")}</div>
    <div class="card"><h3>Which site is which office?</h3>
      <p class="muted">Devices are imported only after you map a site or tenant to a location. Devices from unmapped ones are counted in the sync summaries but never added.</p>
      ${unifiMap}${sophosMap}${ateraMap}</div>
    ${await dupCardHtml(env)}
    <div class="card"><h3>Alerts &amp; monthly report</h3>
      <p class="muted">When a key device (gateway, server, firewall) goes offline, or a whole office goes dark, the portal emails the FlossByte admins right after that check. ${mutedUntil
        ? `<b>Alerts are paused until ${esc(mutedUntil.slice(0, 16).replace("T", " "))} UTC.</b>`
        : "Alerts are on."}</p>
      <form method="post" action="/admin/sync/mute" class="row" style="gap:8px">
        <button class="btn small secondary" type="submit" name="hours" value="2">Pause alerts 2 hours</button>
        <button class="btn small secondary" type="submit" name="hours" value="24">Pause alerts 24 hours</button>
        ${mutedUntil ? `<button class="btn small" type="submit" name="hours" value="0">Resume alerts</button>` : ""}
      </form>
      <p class="muted" style="margin-top:16px">On the 1st of each month, every practice's main admin gets an Office IT report by email: internet uptime, what changed, tickets opened and closed, and what expires next.${lastReport ? ` Last sent for ${esc(lastReport)}.` : ""}</p>
      <form method="post" action="/admin/sync/report"><button class="btn small" type="submit">Send the report to all practices now</button></form>
    </div>
    <div class="card"><h3>Billing reminders</h3>
      <p class="muted">Quotes and invoices chase themselves by email. An invoice is also emailed the day it is created and again on its due date; the overdue reminders below are counted in days after the due date. Set any number to 0 to turn that one reminder off. Reminders stop on their own when a quote is answered or an invoice is paid.</p>
      <form method="post" action="/admin/sync/reminders">
        <div class="row" style="gap:16px;flex-wrap:wrap">
          <label>Quote follow-up 1<br><span class="row" style="gap:6px"><input type="number" name="quote1" min="0" max="90" value="${remCfg.quote1}" style="max-width:84px"><span class="muted">days after sending</span></span></label>
          <label>Quote follow-up 2<br><span class="row" style="gap:6px"><input type="number" name="quote2" min="0" max="90" value="${remCfg.quote2}" style="max-width:84px"><span class="muted">days after sending</span></span></label>
          <label>Overdue reminder 1<br><span class="row" style="gap:6px"><input type="number" name="od1" min="0" max="90" value="${remCfg.od1}" style="max-width:84px"><span class="muted">days past due</span></span></label>
          <label>Overdue reminder 2<br><span class="row" style="gap:6px"><input type="number" name="od2" min="0" max="90" value="${remCfg.od2}" style="max-width:84px"><span class="muted">days past due</span></span></label>
        </div>
        <p style="margin-top:14px"><button class="btn small" type="submit">Save reminder settings</button></p>
      </form>
    </div>`;
  return page({ title: "Device sync", user, body, flash: q(request).get("msg") || undefined, error: q(request).get("err") || undefined });
}

export async function syncMutePost(env, request, user) {
  const f = await request.formData();
  const hours = Number(f.get("hours") || 0);
  if (hours > 0) {
    const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO system_state (key, value) VALUES ('alerts_muted_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(until).run();
    await audit(env.DB, user.id, "alerts_mute", "sync", null, `${hours}h`);
    return redirect("/admin/sync?msg=" + encodeURIComponent(`Device alerts paused for ${hours} hours.`));
  }
  await env.DB.prepare("DELETE FROM system_state WHERE key = 'alerts_muted_until'").run();
  await audit(env.DB, user.id, "alerts_unmute", "sync", null, "");
  return redirect("/admin/sync?msg=" + encodeURIComponent("Device alerts are on."));
}

export async function syncReportPost(env, request, user) {
  const r = await sendMonthlyReports(env, true);
  await audit(env.DB, user.id, "monthly_report_send", "sync", null, `sent ${r.sent}`);
  return redirect("/admin/sync?msg=" + encodeURIComponent(`Monthly Office IT report sent to ${r.sent} practice inbox${r.sent === 1 ? "" : "es"}.`));
}

export async function syncRemindersPost(env, request, user) {
  const f = await request.formData();
  const num = (n) => {
    const v = parseInt(String(f.get(n) || ""), 10);
    return Number.isFinite(v) ? Math.min(90, Math.max(0, v)) : null;
  };
  const quote1 = num("quote1"), quote2 = num("quote2"), od1 = num("od1"), od2 = num("od2");
  if ([quote1, quote2, od1, od2].some((v) => v === null)) {
    return redirect("/admin/sync?err=" + encodeURIComponent("Reminder days have to be whole numbers between 0 and 90."));
  }
  if ((quote1 > 0 && quote2 > 0 && quote2 <= quote1) || (od1 > 0 && od2 > 0 && od2 <= od1)) {
    return redirect("/admin/sync?err=" + encodeURIComponent("The second reminder has to be later than the first, or 0 to turn it off."));
  }
  await env.DB.prepare(
    "INSERT INTO system_state (key, value) VALUES ('reminder_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify({ quote1, quote2, od1, od2 })).run();
  await audit(env.DB, user.id, "reminder_settings", "sync", null,
    `Quote follow-ups at ${quote1} and ${quote2} days; overdue at ${od1} and ${od2} days`);
  return redirect("/admin/sync?msg=" + encodeURIComponent("Reminder settings saved."));
}

// The monthly Office IT report: one email per practice, to its main
// admins, covering the last 30 days from the portal's own records.
// Runs on the 1st (cron) or on demand from the Device sync page.
export async function sendMonthlyReports(env, force) {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const markerRow = await env.DB.prepare("SELECT value FROM system_state WHERE key = 'last_monthly_report'").first().catch(() => null);
  if (!force && markerRow && markerRow.value === monthKey) return { sent: 0, skipped: true };
  const sinceIso = new Date(now.getTime() - 30 * 864e5).toISOString();
  const sinceDate = sinceIso.slice(0, 10);
  const in60 = new Date(now.getTime() + 60 * 864e5).toISOString().slice(0, 10);
  let sent = 0;
  const { results: orgs } = await env.DB.prepare("SELECT * FROM customers ORDER BY name").all();
  for (const org of orgs || []) {
    const { results: locs } = await env.DB.prepare("SELECT * FROM locations WHERE customer_id = ? ORDER BY name").bind(org.id).all();
    if (!locs || !locs.length) continue;
    const { results: admins } = await env.DB.prepare(
      `SELECT DISTINCT u.email FROM users u JOIN user_access ua ON ua.user_id = u.id
       WHERE ua.customer_id = ? AND u.role = 'customer_admin' AND u.status = 'active' AND u.email IS NOT NULL`).bind(org.id).all();
    const recipients = (admins || []).map((r) => r.email).filter(Boolean);
    if (!recipients.length) continue;
    const sections = [];
    const textParts = [];
    for (const loc of locs) {
      let uptimeLine = "";
      try {
        const snap = await env.DB.prepare("SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = 'internet_history'").bind(loc.id).first();
        const days = snap && snap.payload ? (JSON.parse(snap.payload).days || []).filter((d) => d && d.date >= sinceDate) : [];
        const ups = days.map((d) => d.uptimePct).filter((v) => v != null);
        if (ups.length) {
          const avg = ups.reduce((a, b) => a + b, 0) / ups.length;
          const downMin = days.reduce((a, d) => a + (d.downtimeMin || 0), 0);
          uptimeLine = `Internet uptime ${Math.round(avg * 10) / 10}% over the last ${days.length} days${downMin ? `, about ${downMin} minutes down in total` : ", no downtime recorded"}.`;
        }
      } catch { /* history is optional */ }
      const eq = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS onn FROM equipment WHERE location_id = ?").bind(loc.id).first().catch(() => null);
      let changeCount = 0;
      try {
        const snap = await env.DB.prepare("SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = 'changes'").bind(loc.id).first();
        const evs = snap && snap.payload ? (JSON.parse(snap.payload).events || []) : [];
        changeCount = evs.filter((e) => e && e.at && e.at >= sinceIso).length;
      } catch { /* changes are optional */ }
      const exp = await env.DB.prepare(
        `SELECT name, model, type, license_expires, warranty_expires FROM equipment WHERE location_id = ?
         AND ((license_expires IS NOT NULL AND license_expires BETWEEN ? AND ?) OR (warranty_expires IS NOT NULL AND warranty_expires BETWEEN ? AND ?))`)
        .bind(loc.id, sinceDate, in60, sinceDate, in60).all().catch(() => ({ results: [] }));
      const expLines = (exp.results || []).map((e) => {
        const d = [e.license_expires, e.warranty_expires].filter((x) => x && x >= sinceDate && x <= in60).sort()[0];
        return `${e.name || e.model || e.type || "Equipment"}: ${d === e.license_expires ? "license" : "warranty"} expires ${fmtDateUS(d)}`;
      });
      const lines = [
        uptimeLine,
        eq && eq.n ? `${eq.onn || 0} of ${eq.n} devices online right now.` : "",
        changeCount ? `${changeCount} change${changeCount === 1 ? "" : "s"} recorded on the network this month.` : "No network changes recorded this month.",
        ...expLines.map((x) => `Coming up: ${x}.`),
      ].filter(Boolean);
      sections.push(`<h3 style="margin:18px 0 6px">${esc(loc.name)}</h3><ul style="margin:0;padding-left:18px">${lines.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
      textParts.push(`${loc.name}\n${lines.map((x) => `- ${x}`).join("\n")}`);
    }
    const tickets = await env.DB.prepare(
      `SELECT SUM(CASE WHEN t.created_at >= ? THEN 1 ELSE 0 END) AS opened,
              SUM(CASE WHEN t.status = 'closed' AND t.updated_at >= ? THEN 1 ELSE 0 END) AS closed
       FROM tickets t JOIN locations l ON l.id = t.location_id WHERE l.customer_id = ?`)
      .bind(sinceIso, sinceIso, org.id).first().catch(() => null);
    const ticketLine = tickets && (tickets.opened || tickets.closed)
      ? `<p>Support tickets this month: ${tickets.opened || 0} opened, ${tickets.closed || 0} closed.</p>`
      : `<p>No support tickets this month.</p>`;
    const subject = `Your Office IT report — ${org.name}`;
    const html = wrap(subject, `<p>Here is your office technology summary for the last 30 days, from your FlossByte portal records.</p>${sections.join("")}${ticketLine}<p style="color:#5B6B82">Questions about anything here? Reply to this email or call FlossByte at (669) 237-2264.</p>`);
    const text = `Your Office IT report — ${org.name}\n\n${textParts.join("\n\n")}\n\n${tickets && (tickets.opened || tickets.closed) ? `Support tickets this month: ${tickets.opened || 0} opened, ${tickets.closed || 0} closed.` : "No support tickets this month."}`;
    for (const to of recipients) {
      await sendEmail(env, { to, template: "monthly_report", subject, html, text });
      sent++;
    }
  }
  await env.DB.prepare("INSERT INTO system_state (key, value) VALUES ('last_monthly_report', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(monthKey).run();
  return { sent, skipped: false };
}

export async function syncMapPost(env, request, user) {
  const f = await request.formData();
  const provider = ["sophos", "atera"].includes(String(f.get("provider") || "")) ? String(f.get("provider")) : "unifi";
  const siteId = String(f.get("site_id") || "");
  const locRaw = String(f.get("location_id") || "");
  if (siteId) {
    await env.DB.prepare(
      `INSERT INTO sync_sites (provider, site_id, location_id) VALUES (?, ?, ?)
       ON CONFLICT(provider, site_id) DO UPDATE SET location_id = excluded.location_id, updated_at = datetime('now')`)
      .bind(provider, siteId, locRaw ? Number(locRaw) : null).run();
    await audit(env.DB, user.id, "sync_site_map", "location", locRaw ? Number(locRaw) : null, `${provider}:${siteId}`);
  }
  return redirect("/admin/sync?msg=" + encodeURIComponent("Site mapping saved."));
}

export async function syncRunPost(env, request, user) {
  const s = await runUnifiSync(env);
  const text = s.ok
    ? `UniFi sync done. ${s.inserted} added, ${s.updated} updated, ${s.offlined} marked offline, ${s.unmappedDevices} not imported (site not mapped).`
    : `UniFi sync did not run: ${s.message}`;
  return redirect("/admin/sync?msg=" + encodeURIComponent(text));
}

export async function syncRunSophosPost(env, request, user) {
  const s = await runSophosSync(env);
  const text = s.ok
    ? `Sophos sync done. ${s.inserted} added, ${s.updated} updated, ${s.offlined} marked offline, ${s.unmappedDevices} not imported (tenant not mapped).`
    : `Sophos sync did not run: ${s.message}`;
  return redirect("/admin/sync?msg=" + encodeURIComponent(text));
}

// ---------- Possible duplicate equipment ----------
// The syncs join on vendor id, then MAC, then serial, then name. A
// device that shows up with none of those in common across systems (a
// laptop UniFi sees on its dock and Atera sees on WiFi, say) can still
// land as two rows. This review flags likely pairs per location so an
// admin can merge them into one record, or dismiss the pair as two
// genuinely different devices (dismissals are kept in system_state).
function dupNorm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function editDist(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}
function sourceLabel(s) {
  return s === "unifi" ? "UniFi" : s === "unifi-client" ? "UniFi connected device" : s === "sophos" ? "Sophos"
    : s === "atera" ? "Atera" : "Added by hand";
}
async function getDupDismissed(db) {
  try {
    const r = await db.prepare("SELECT value FROM system_state WHERE key = 'dup_dismissed'").first();
    const arr = r ? JSON.parse(r.value || "[]") : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
async function findDuplicatePairs(env) {
  const { results: rows } = await env.DB.prepare(
    `SELECT e.*, l.name AS loc_name, c.name AS cust_name FROM equipment e
     JOIN locations l ON l.id = e.location_id JOIN customers c ON c.id = l.customer_id
     ORDER BY e.location_id, e.id`).all();
  const dismissed = await getDupDismissed(env.DB);
  const byLoc = new Map();
  for (const r of rows || []) {
    if (!byLoc.has(r.location_id)) byLoc.set(r.location_id, []);
    byLoc.get(r.location_id).push(r);
  }
  const pairs = [];
  for (const list of byLoc.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const reasons = [];
        let score = 0;
        if (a.mac && b.mac && String(a.mac).toLowerCase() === String(b.mac).toLowerCase()) { reasons.push("Same MAC address"); score += 4; }
        if (a.serial && b.serial && String(a.serial).trim().toLowerCase() === String(b.serial).trim().toLowerCase()) { reasons.push("Same serial number"); score += 4; }
        if (a.ip_address && b.ip_address && String(a.ip_address).trim() === String(b.ip_address).trim()) { reasons.push("Same IP address"); score += 3; }
        const na = dupNorm(a.name), nb = dupNorm(b.name);
        if (na && na === nb && na.length >= 4) { reasons.push("Same name"); score += 3; }
        else if (na && nb && Math.min(na.length, nb.length) >= 6 && (na.startsWith(nb) || nb.startsWith(na))) { reasons.push("Very similar names"); score += 2; }
        else if (na && nb && Math.min(na.length, nb.length) >= 6 && editDist(na, nb) <= 2) { reasons.push("Very similar names"); score += 2; }
        // A monitoring device that matched nothing still gets a
        // human look when the office already has a record of the
        // same kind from another source: at a small office, two
        // printer (or NAS / UPS / camera) records usually means
        // the same box seen two ways.
        if ((a.source === "atera-device" || b.source === "atera-device") && a.source !== b.source
          && a.type === b.type && ["Printer", "NAS", "UPS", "Camera"].includes(a.type)) { reasons.push("Same kind of device"); score += 1; }
        if (!reasons.length) continue;
        // Name-only pairs from the SAME system are almost never one
        // device: phones, Sonos units and desk phones share a model
        // name across many boxes. Only hard evidence (same MAC,
        // serial or IP) or a cross-system match is worth a look.
        const hard = reasons.includes("Same MAC address") || reasons.includes("Same serial number") || reasons.includes("Same IP address");
        if (!hard && a.source === b.source) continue;
        const key = `${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;
        if (dismissed.has(key)) continue;
        pairs.push({ a, b, reasons, score, key });
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs.slice(0, 30);
}
function dupPairHtml(p) {
  const rec = (r, other) => `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid #EEF2F7">
      <div style="flex:1;min-width:220px"><a href="/app/locations/${r.location_id}/equipment/${r.id}" style="font-weight:700;color:inherit;text-decoration:none">${esc(r.name)}</a>
      <div class="muted" style="font-size:12.5px">${esc(sourceLabel(r.source))} · ${esc(r.type || "Device")}${r.mac ? ` · MAC ${esc(r.mac)}` : ""}${r.serial ? ` · Serial ${esc(r.serial)}` : ""}${r.ip_address ? ` · ${esc(r.ip_address)}` : ""} · ${esc(r.status)}</div></div>
      <form method="post" action="/admin/sync/merge" class="dup-act"><input type="hidden" name="keep" value="${r.id}"><input type="hidden" name="drop" value="${other.id}"><button class="btn small secondary" type="submit">Keep this record</button></form></div>`;
  return `<div class="duppair" style="border:1px solid #E3EAF2;border-radius:10px;padding:6px 14px 10px;margin:0 0 12px">
    <p style="margin:8px 0 2px"><b>${esc(p.a.cust_name)}: ${esc(p.a.loc_name)}</b> ${p.reasons.map((r) => `<span class="pill warn">${esc(r)}</span>`).join(" ")}</p>
    ${rec(p.a, p.b)}${rec(p.b, p.a)}
    <form method="post" action="/admin/sync/dup-dismiss" class="dup-act" style="margin-top:8px"><input type="hidden" name="a" value="${p.a.id}"><input type="hidden" name="b" value="${p.b.id}"><button class="btn small secondary" type="submit">Not the same device</button></form></div>`;
}
async function dupCardHtml(env) {
  try {
    const pairs = await findDuplicatePairs(env);
    return `<div class="card"><h3>Possible duplicates</h3>
      <p class="muted">Different systems sometimes report the same device in ways that cannot be matched automatically, a laptop on its dock versus on WiFi, for example. Keep one record and the other merges into it (best details from both, links and computer details re-pointed), or mark the pair as two different devices and it will not be flagged again.</p>
      ${pairs.length ? `<div id="dup-list">${pairs.map(dupPairHtml).join("")}</div>
  <script>
  (function(){
    var list = document.getElementById('dup-list');
    if (!list) return;
    list.addEventListener('submit', function(ev){
      var form = ev.target;
      if (!form.classList || !form.classList.contains('dup-act')) return;
      ev.preventDefault();
      var pair = form.closest ? form.closest('.duppair') : null;
      var btns = form.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
      fetch(form.action, { method: 'POST', body: new FormData(form), headers: { 'Accept': 'application/json' } })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (d && d.ok) {
            if (pair) {
              pair.style.transition = 'opacity .25s';
              pair.style.opacity = '0';
              setTimeout(function(){
                pair.remove();
                if (!list.querySelector('.duppair')) {
                  var p = document.createElement('p');
                  p.className = 'muted';
                  p.textContent = 'No possible duplicates right now.';
                  list.appendChild(p);
                }
              }, 260);
            }
          } else { form.submit(); }
        })
        .catch(function(){ form.submit(); });
    });
  })();
  </script>` : `<p class="muted">No possible duplicates right now.</p>`}</div>`;
  } catch {
    return `<div class="card"><h3>Possible duplicates</h3><p class="muted">The duplicate check could not run on this database yet.</p></div>`;
  }
}

export async function syncMergePost(env, request, user) {
  const wantsJson = (request.headers.get("Accept") || "").includes("application/json");
  const f = await request.formData();
  const keepId = Number(f.get("keep") || 0);
  const dropId = Number(f.get("drop") || 0);
  const back = (msg) => redirect("/admin/sync?msg=" + encodeURIComponent(msg));
  const done = (ok, msg) => wantsJson
    ? new Response(JSON.stringify({ ok, msg }), { status: ok ? 200 : 400, headers: { "Content-Type": "application/json" } })
    : back(msg);
  if (!keepId || !dropId || keepId === dropId) return done(false, "Those two records could not be merged.");
  const keep = await env.DB.prepare("SELECT * FROM equipment WHERE id = ?").bind(keepId).first();
  const drop = await env.DB.prepare("SELECT * FROM equipment WHERE id = ?").bind(dropId).first();
  if (!keep || !drop || keep.location_id !== drop.location_id) return done(false, "Those two records could not be merged.");
  const mergedName = await mergeEquipmentRows(env.DB, keep, drop, { actorId: user.id });
  return done(true, `Merged. "${drop.name}" is now part of "${mergedName}", one record with the best details from both.`);
}

export async function syncDupDismissPost(env, request, user) {
  const wantsJson = (request.headers.get("Accept") || "").includes("application/json");
  const f = await request.formData();
  const a = Number(f.get("a") || 0), b = Number(f.get("b") || 0);
  if (a && b) {
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    const set = await getDupDismissed(env.DB);
    set.add(key);
    await env.DB.prepare(
      "INSERT INTO system_state (key, value) VALUES ('dup_dismissed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(JSON.stringify([...set])).run();
  }
  if (wantsJson) return new Response(JSON.stringify({ ok: !!(a && b) }), { status: a && b ? 200 : 400, headers: { "Content-Type": "application/json" } });
  return redirect("/admin/sync?msg=" + encodeURIComponent("Marked as two different devices. That pair will not be flagged again."));
}

export async function syncRunAteraPost(env, request, user) {
  const s = await runAteraSync(env);
  const text = s.ok
    ? `Atera sync done. ${s.inserted} added, ${s.updated} updated, ${s.offlined} marked offline, ${s.unmappedDevices} not imported (customer not mapped).`
    : `Atera sync did not run: ${s.message}`;
  return redirect("/admin/sync?msg=" + encodeURIComponent(text));
}

// ---------- Ownership transfer (Super Admin only) ----------
async function eligibleTransferTarget(env, targetId) {
  const target = await env.DB.prepare(
    "SELECT * FROM users WHERE id = ? AND kind = 'flossbyte'").bind(targetId).first();
  if (!target || target.role !== "admin" || target.status !== "active") return null;
  return target;
}

export async function transferPage(env, request, user, targetId) {
  if (!isSuperAdmin(user)) return notSuper(user);
  const target = await eligibleTransferTarget(env, targetId);
  if (!target || Number(targetId) === user.id) {
    return redirect("/admin/admins?err=" + encodeURIComponent("That admin cannot receive ownership. They need an active admin account."));
  }
  const body = `${adminNav("admins")}<h1>Transfer ownership</h1>
    <div class="card narrow"><h3 style="margin-top:0">Make ${esc(target.name)} the Super Admin</h3>
      <p class="muted">${esc(target.name)} (${esc(target.email)}) gets full control of the portal, including managing admin accounts and transferring ownership again. Two-step verification stays mandatory for them; if they have not set it up, they will be asked at their next sign-in.</p>
      <form method="post" action="/admin/transfer/${target.id}">
        <label>Your password, to confirm this is you <span class="req">*</span></label>
        <input name="password" type="password" required autocomplete="current-password">
        <label style="margin-top:14px">What happens to your account</label>
        <label style="font-weight:normal"><input type="radio" name="after" value="admin" checked style="width:auto"> Keep me as a regular admin</label>
        <label style="font-weight:normal"><input type="radio" name="after" value="disable" style="width:auto"> Disable my account and sign me out everywhere</label>
        <label style="font-weight:normal;margin-top:12px"><input type="checkbox" name="confirm" value="yes" required style="width:auto"><span class="req">*</span> I understand this hands over full control of the portal.</label>
        <p style="margin-top:18px"><button class="btn danger" type="submit">Transfer ownership</button>
        <a class="btn secondary" href="/admin/admins">Cancel</a></p>
      </form></div>`;
  return page({ title: "Transfer ownership", user, body, flash: q(request).get("msg") || undefined, error: q(request).get("err") || undefined });
}

export async function transferPost(env, request, user, targetId) {
  if (!isSuperAdmin(user)) return notSuper(user);
  const back = (msg) => redirect(`/admin/transfer/${targetId}?err=` + encodeURIComponent(msg));
  const target = await eligibleTransferTarget(env, targetId);
  if (!target || Number(targetId) === user.id) {
    return redirect("/admin/admins?err=" + encodeURIComponent("That admin cannot receive ownership. They need an active admin account."));
  }
  const f = await request.formData();
  if (String(f.get("confirm") || "") !== "yes") return back("Tick the confirmation box to transfer ownership.");
  if (!(await verifyPassword(String(f.get("password") || ""), user.password_hash))) {
    return back("Your password does not match. Ownership was not transferred.");
  }
  const disableSelf = String(f.get("after") || "") === "disable";
  // One batch, so the portal never has zero or two Super Admins: the role
  // moves in a single transaction.
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").bind(target.id),
    disableSelf
      ? env.DB.prepare("UPDATE users SET role = 'admin', status = 'disabled' WHERE id = ?").bind(user.id)
      : env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(user.id),
  ]);
  await audit(env.DB, user.id, "super_admin_transfer_out", "user", target.id, `to ${target.email}`);
  await audit(env.DB, target.id, "super_admin_transfer_in", "user", user.id, `from ${user.email}`);
  const mail = ownershipTransferEmail(env, {
    fromName: user.name, fromEmail: user.email, toName: target.name, toEmail: target.email,
  });
  await sendEmail(env, { to: target.email, template: "ownership_transfer", ...mail });
  await sendEmail(env, { to: user.email, template: "ownership_transfer", ...mail });
  if (disableSelf) {
    await revokeAllSessions(env.DB, user.id);
    return redirect("/login?msg=" + encodeURIComponent(`Ownership transferred to ${target.name}. Your account is disabled.`));
  }
  return redirect("/admin?msg=" + encodeURIComponent(`Ownership transferred to ${target.name}. You are now a regular admin.`));
}

export async function createAdminPost(env, request, user) {
  if (!isSuperAdmin(user)) return notSuper(user);
  const f = await request.formData();
  const first = String(f.get("first_name") || "").trim();
  const middle = String(f.get("middle_name") || "").trim();
  const last = String(f.get("last_name") || "").trim();
  const name = [first, middle, last].filter(Boolean).join(" ");
  const email = String(f.get("email") || "").trim().toLowerCase();
  if (!first || !last || !isValidEmail(email)) {
    return redirect("/admin/admins?err=" + encodeURIComponent(
      "Enter the admin's first name, last name, and a valid email address."));
  }
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return redirect("/admin/admins?err=" + encodeURIComponent("That email already has a login."));
  const res = await env.DB.prepare(
    `INSERT INTO users (email, name, kind, role, status) VALUES (?, ?, 'flossbyte', 'admin', 'invited')`)
    .bind(email, name).run();
  const raw = await createAuthToken(env.DB, res.meta.last_row_id, "invite", 7 * 24 * 60);
  const mail = inviteEmail(env, { name, link: `${origin(env)}/invite/${raw}` });
  await sendEmail(env, { to: email, template: "invite", ...mail });
  await audit(env.DB, user.id, "admin_create", "user", res.meta.last_row_id, email);
  return redirect("/admin/admins?msg=" + encodeURIComponent("Admin invite sent."));
}

export async function adminActionPost(env, request, user, targetId, action) {
  if (!isSuperAdmin(user)) return notSuper(user);
  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND kind = 'flossbyte'").bind(targetId).first();
  if (!target) return redirect("/admin/admins");
  if (target.role === "super_admin") {
    return redirect("/admin/admins?err=" + encodeURIComponent("The Super Admin login can never be disabled or removed."));
  }
  if (Number(targetId) === user.id) {
    return redirect("/admin/admins?err=" + encodeURIComponent("You cannot disable or remove your own account."));
  }
  if (action === "resend") {
    if (target.status !== "invited") {
      return redirect("/admin/admins?err=" + encodeURIComponent("Only a pending invite can be resent."));
    }
    await resendInviteEmail(env, target);
    await audit(env.DB, user.id, "invite_resent_admin", "user", Number(targetId), target.email);
    return redirect("/admin/admins?msg=" + encodeURIComponent(`Invite resent to ${target.email}. The old link no longer works.`));
  }
  if (action === "disable") {
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(targetId).run();
    await revokeAllSessions(env.DB, Number(targetId));
    await audit(env.DB, user.id, "admin_disable", "user", Number(targetId), target.email);
  } else if (action === "enable") {
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(targetId).run();
    await audit(env.DB, user.id, "admin_enable", "user", Number(targetId), target.email);
  } else if (action === "remove") {
    await revokeAllSessions(env.DB, Number(targetId));
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(targetId).run();
    await audit(env.DB, user.id, "admin_remove", "user", Number(targetId), target.email);
  }
  return redirect("/admin/admins");
}

// ---------- Live chat inbox ----------
// The queue sorts by who has been waiting longest; the archive groups
// ended chats by organization, then office. Assignment is explicit
// (Take chat) or implicit on first reply, and is a plain column so a
// round robin can replace first-come claiming later.

function chatStatusPill(t) {
  if (t.status === "waiting") return `<span class="pill warn">Waiting</span>`;
  if (t.status === "active") return `<span class="pill on">Active</span>`;
  return `<span class="pill">Ended</span>`;
}

export async function chatsPage(env, request, user) {
  if (!(await chatReady(env.DB))) {
    const body = `${adminNav("chats")}<h1>Live chat</h1>
    <div class="card"><p>Live chat is not switched on yet. It needs one small database update (the chat tables) before the first chat can start.</p></div>`;
    return page({ title: "Live chat", user, body });
  }
  const { results } = await env.DB.prepare(
    `SELECT t.*, c.name AS customer_name, l.name AS location_name, u.name AS requester_name,
            (SELECT body FROM chat_messages WHERE thread_id = t.id AND sender_kind != 'system' ORDER BY id DESC LIMIT 1) AS last_body
     FROM chat_threads t
     JOIN customers c ON c.id = t.customer_id
     JOIN locations l ON l.id = t.location_id
     JOIN users u ON u.id = t.user_id
     ORDER BY t.id DESC`).all();
  const threads = results || [];
  const active = threads.filter((t) => t.status !== "ended")
    .sort((a, b) => (a.status === b.status ? String(a.started_at).localeCompare(String(b.started_at)) : a.status === "waiting" ? -1 : 1));
  const ended = threads.filter((t) => t.status === "ended").slice(0, 60);
  const row = (t) => `<tr>
      <td><a href="/admin/chats/${t.id}"><strong>${esc(t.requester_name)}</strong></a><br><span class="muted">${esc(t.customer_name)} · ${esc(t.location_name)}</span></td>
      <td>${chatStatusPill(t)}${t.assigned_admin_id ? `<br><span class="muted">${t.assigned_admin_id === user.id ? "Yours" : "Taken"}</span>` : ""}</td>
      <td class="muted">${esc(String(t.last_body || "").slice(0, 90))}</td>
      <td class="muted">${t.status === "waiting" ? `waiting ${relTimeChat(t.started_at)}` : `started ${relTimeChat(t.started_at)}`}</td></tr>`;
  let archiveHtml = "";
  if (ended.length) {
    const byOrg = new Map();
    for (const t of ended) {
      const key = t.customer_name;
      if (!byOrg.has(key)) byOrg.set(key, []);
      byOrg.get(key).push(t);
    }
    archiveHtml = [...byOrg.entries()].map(([org, list]) => {
      const byOffice = new Map();
      for (const t of list) {
        if (!byOffice.has(t.location_name)) byOffice.set(t.location_name, []);
        byOffice.get(t.location_name).push(t);
      }
      return `<h3 style="margin:18px 0 4px">${esc(org)}</h3>` + [...byOffice.entries()].map(([office, rows]) =>
        `<p class="muted" style="margin:8px 0 2px"><strong>${esc(office)}</strong></p>` +
        rows.map((t) => `<div style="padding:6px 0;border-bottom:1px solid var(--line)">
          <a href="/admin/chats/${t.id}">${esc(t.requester_name)}</a>
          <span class="muted">· ${fmtDateUS(String(t.started_at).slice(0, 10))} · ended ${esc(t.ended_by || "")}${t.ticket_id ? ` · <a href="/admin/tickets">ticket #${t.ticket_id}</a>` : ""}</span></div>`).join("")
      ).join("");
    }).join("");
  }
  const body = `${adminNav("chats")}<h1>Live chat</h1>
  <div class="card"><h3 style="margin-top:0">Active chats</h3>
  ${active.length ? `<div class="tscroll"><table class="stack"><thead><tr><th>Person</th><th>Status</th><th>Last message</th><th>When</th></tr></thead><tbody>${active.map(row).join("")}</tbody></table></div>` : `<p class="muted">No live chats right now. New chats appear here the moment a client starts one, and you get an email alert too.</p>`}</div>
  <div class="card"><h3 style="margin-top:0">Archive</h3>
  ${ended.length ? archiveHtml : `<p class="muted">No ended chats yet. Ended chats are kept here, grouped by practice and office.</p>`}</div>`;
  return page({ title: "Live chat", user, body });
}

export async function chatThreadPage(env, request, user, threadId) {
  const t = await getThread(env.DB, threadId).catch(() => null);
  if (!t) return page({ title: "Live chat", user, body: `${adminNav("chats")}<h1>Live chat</h1><div class="banner error">That chat was not found.</div>` });
  const msgs = await threadMessages(env.DB, threadId, 0);
  const lastId = msgs.length ? msgs[msgs.length - 1].id : 0;
  const ended = t.status === "ended";
  const mine = t.assigned_admin_id === user.id;
  const actions = ended ? `<p class="muted">This chat has ended${t.ended_by ? ` (by ${esc(t.ended_by)})` : ""}. It is read-only.</p>
      ${t.ticket_id ? `<p><a class="btn small secondary" href="/admin/tickets">View the ticket from this chat</a></p>`
        : `<form method="post" action="/admin/chats/${t.id}/ticket"><button class="btn small secondary" type="submit">Convert to ticket</button></form>`}`
    : `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      ${!mine ? `<form method="post" action="/admin/chats/${t.id}/take"><button class="btn small" type="submit">${t.assigned_admin_id ? "Take over this chat" : "Take this chat"}</button></form>` : ""}
      ${t.ticket_id ? "" : `<form method="post" action="/admin/chats/${t.id}/ticket"><button class="btn small secondary" type="submit">Convert to ticket</button></form>`}
      <form method="post" action="/admin/chats/${t.id}/end" onsubmit="return confirm('End this chat? The transcript stays in the archive.')"><button class="btn small secondary" type="submit">End chat</button></form></div>
      <form id="chat-reply-form" class="gcomposer" method="post" action="/admin/chats/${t.id}/message" style="margin-top:12px">
        <input id="chat-reply-input" name="body" placeholder="Reply as FlossByte Support..." required autocomplete="off">
        <button id="chat-send-btn" class="sendbtn" type="submit" aria-label="Send reply"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg></button></form>`;
  const body = `${adminNav("chats")}
  <p><a href="/admin/chats">← Live chat</a></p>
  <h1>${esc(t.requester_name)} · ${esc(t.location_name)}</h1>
  <p class="muted">${esc(t.customer_name)} · started ${relTimeChat(t.started_at)} · ${chatStatusPill(t)}${t.admin_name ? ` · with ${esc(t.admin_name)}` : ""}</p>
  ${briefHtml(t.genius_context)}
  <div class="card">
    <div class="chat" id="chat-msgs">${renderChatMessages(msgs, true)}</div>
    <div id="chat-typing" class="typing-row" hidden></div>
    ${actions}
  </div>
  ${ended ? "" : `<script>
  (function(){
    var last = ${lastId}, box = document.getElementById('chat-msgs');
    function sAbove(node){
      var bar = document.querySelector('.gcomposer');
      var reserve = bar ? bar.offsetHeight + 30 : 110;
      var r = node.getBoundingClientRect();
      var target = window.pageYOffset + r.bottom - (window.innerHeight - reserve);
      if (target > window.pageYOffset) window.scrollTo(0, target);
    }
    function tick(){
      fetch('/admin/chats/${t.id}/poll?after=' + last, { headers: { 'Accept': 'application/json' } })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (!d || !d.ok) return;
          if (d.status === 'ended') { location.reload(); return; }
          var appended = null;
          var gotCust = false;
          (d.messages || []).forEach(function(m){
            last = Math.max(last, m.id);
            if (m.kind === 'customer') gotCust = true;
            var div = document.createElement('div');
            if (m.kind === 'system') { div.className = 'muted'; div.style.cssText = 'text-align:center;font-size:12.5px;margin:10px 0'; div.textContent = '— ' + m.body + ' —'; }
            else { div.className = 'msg ' + (m.kind === 'customer' ? 'q' : 'a'); div.textContent = m.body; }
            box.appendChild(div);
            appended = div;
          });
          if (appended) sAbove(appended);
          var tw = document.getElementById('chat-typing');
          if (tw) {
            if (d.typing && !gotCust) {
              tw.hidden = false;
              tw.textContent = '';
              var sp = document.createElement('span');
              sp.textContent = d.typing + ' is typing ';
              tw.appendChild(sp);
              for (var di = 0; di < 3; di++) { var dt = document.createElement('span'); dt.className = 'gdot'; tw.appendChild(dt); }
            } else { tw.hidden = true; }
          }
        }).catch(function(){});
    }
    setInterval(tick, 4000);
    var form = document.getElementById('chat-reply-form');
    if (form) {
      var inp = document.getElementById('chat-reply-input');
      var btn = document.getElementById('chat-send-btn');
      form.addEventListener('submit', function(ev){
        ev.preventDefault();
        var body = inp.value.trim();
        if (!body) return;
        inp.disabled = true; btn.disabled = true;
        var fd = new FormData();
        fd.append('body', body);
        fetch('/admin/chats/${t.id}/api', { method: 'POST', body: fd, headers: { 'Accept': 'application/json' } })
          .then(function(r){ return r.json(); })
          .then(function(d){
            inp.disabled = false; btn.disabled = false;
            if (d && d.ok) { inp.value = ''; inp.focus(); tick(); }
            else { form.submit(); }
          })
          .catch(function(){ inp.disabled = false; btn.disabled = false; form.submit(); });
      });
      var lastPing = 0;
      inp.addEventListener('input', function(){
        var now = Date.now();
        if (!inp.value.trim() || now - lastPing < 2500) return;
        lastPing = now;
        fetch('/admin/chats/${t.id}/typing', { method: 'POST', headers: { 'Accept': 'application/json' } }).catch(function(){});
      });
    }
  })();
  </script>`}`;
  return page({ title: "Live chat", user, body });
}

export async function chatTakePost(env, request, user, threadId) {
  const t = await getThread(env.DB, threadId);
  if (!t || t.status === "ended") return redirect("/admin/chats");
  await env.DB.prepare("UPDATE chat_threads SET assigned_admin_id = ?, status = 'active' WHERE id = ?").bind(user.id, threadId).run();
  await env.DB.prepare("INSERT INTO chat_messages (thread_id, sender_kind, sender_user_id, body) VALUES (?, 'system', NULL, ?)")
    .bind(threadId, `${user.name} from FlossByte joined the chat.`).run();
  return redirect(`/admin/chats/${threadId}`);
}

// Shared by the classic form post and the in-place API: claims an
// unassigned chat, activates a waiting one, stores the reply, and
// emails the customer on the first FlossByte reply in the thread.
async function postAdminChatMessage(env, user, t, body) {
  const hadAdminMsg = await env.DB.prepare(
    "SELECT id FROM chat_messages WHERE thread_id = ? AND sender_kind = 'flossbyte' LIMIT 1").bind(t.id).first();
  if (!t.assigned_admin_id) {
    await env.DB.prepare("UPDATE chat_threads SET assigned_admin_id = ?, status = 'active' WHERE id = ?").bind(user.id, t.id).run();
    await env.DB.prepare("INSERT INTO chat_messages (thread_id, sender_kind, sender_user_id, body) VALUES (?, 'system', NULL, ?)")
      .bind(t.id, `${user.name} from FlossByte joined the chat.`).run();
  } else if (t.status === "waiting") {
    await env.DB.prepare("UPDATE chat_threads SET status = 'active' WHERE id = ?").bind(t.id).run();
  }
  const id = await addChatMessage(env.DB, t.id, "flossbyte", user.id, body);
  await clearTyping(env.DB, t.id, "flossbyte");
  if (!hadAdminMsg) await notifyCustomerReply(env, t, user);
  return id;
}

export async function chatAdminMessagePost(env, request, user, threadId) {
  const t = await getThread(env.DB, threadId);
  if (!t || t.status === "ended") return redirect("/admin/chats");
  const f = await request.formData();
  const body = String(f.get("body") || "").trim().slice(0, 2000);
  if (body) await postAdminChatMessage(env, user, t, body);
  return redirect(`/admin/chats/${threadId}`);
}

// In-place reply (the Genius pattern): no page reload; the client
// clears the bar, then polls once so the new message (and any system
// line from claiming the chat) lands in the stream in order.
export async function chatAdminApiPost(env, request, user, threadId) {
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const t = await getThread(env.DB, threadId).catch(() => null);
  if (!t) return json({ ok: false }, 404);
  if (t.status === "ended") return json({ ok: false, error: "ended" }, 409);
  const f = await request.formData();
  const body = String(f.get("body") || "").trim().slice(0, 2000);
  if (!body) return json({ ok: false }, 400);
  const id = await postAdminChatMessage(env, user, t, body);
  return json({ ok: true, id });
}

export async function chatAdminEndPost(env, request, user, threadId) {
  const t = await getThread(env.DB, threadId);
  if (!t || t.status === "ended") return redirect("/admin/chats");
  await endChat(env.DB, t, "flossbyte");
  await audit(env.DB, user.id, "chat_end", "location", t.location_id, `Live chat ${threadId} ended by FlossByte`);
  return redirect("/admin/chats");
}

export async function chatTicketPost(env, request, user, threadId) {
  const t = await getThread(env.DB, threadId);
  if (!t || t.ticket_id) return redirect(`/admin/chats/${threadId}`);
  const msgs = await threadMessages(env.DB, threadId, 0);
  const transcript = msgs.filter((m) => m.sender_kind !== "system")
    .map((m) => `${m.sender_kind === "customer" ? (m.sender_name || "Customer") : "FlossByte"}: ${m.body}`).join("\n");
  const title = `Live chat with ${t.requester_name} (${t.location_name})`;
  const res = await env.DB.prepare("INSERT INTO tickets (location_id, title, priority, created_by) VALUES (?, ?, 'normal', ?)")
    .bind(t.location_id, title, t.user_id).run();
  const tid = res.meta.last_row_id;
  await env.DB.prepare("INSERT INTO ticket_updates (ticket_id, author_id, body) VALUES (?, ?, ?)")
    .bind(tid, user.id, `Converted from live chat ${threadId} by ${user.name}.\n\n${transcript || "(no messages)"}`).run();
  await env.DB.prepare("UPDATE chat_threads SET ticket_id = ? WHERE id = ?").bind(tid, threadId).run();
  await audit(env.DB, user.id, "ticket_create", "ticket", tid, "Created from live chat");
  return redirect(`/admin/chats/${threadId}`);
}

export async function chatAdminPoll(env, request, user, threadId) {
  const t = await getThread(env.DB, threadId).catch(() => null);
  if (!t) return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { "Content-Type": "application/json" } });
  const after = Number(new URL(request.url).searchParams.get("after") || 0);
  const msgs = await threadMessages(env.DB, threadId, after);
  return new Response(JSON.stringify({
    ok: true, status: t.status,
    typing: t.status === "ended" ? null : await getTyping(env.DB, threadId, "customer"),
    messages: msgs.map((m) => ({ id: m.id, kind: m.sender_kind, body: m.body })),
  }), { headers: { "Content-Type": "application/json" } });
}

export async function chatAdminTypingPost(env, request, user, threadId) {
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const t = await getThread(env.DB, threadId).catch(() => null);
  if (!t || t.status === "ended") return json({ ok: false }, 404);
  await setTyping(env.DB, threadId, "flossbyte", user.name);
  return json({ ok: true });
}
