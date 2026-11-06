// Client-facing portal pages. Every handler re-checks access to the location
// on the server; nothing here trusts ids from the browser.
import { page, redirect, esc } from "./layout.js";
import {
  canAccessLocation, locationScope, getLocation, productEnabled, productStates,
  expiringItems, audit, accessibleLocationIds, customerAdminOrg, orgMembers,
  removeUserFromCustomer,
} from "./access.js";
import { sendEmail, quoteAcceptedNoticeEmail } from "./email.js";

function orgOrigin(env) { return env.APP_ORIGIN || "https://portal.flossbyte.com"; }

const REMOTE_URL = "https://flossbyte.com/remote";

function fmtDate(d) { return d || ""; }
function fmtMoney(cents) {
  return "$" + (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Equipment and Tickets serve both paying lanes: a Managed IT plan, or a
// one-time project (the portal is the project's record, and the ticket
// door stays open for the next job).
async function laneOn(db, customerId, locationId) {
  return (await productEnabled(db, customerId, locationId, "managed_it")) ||
         (await productEnabled(db, customerId, locationId, "one_time_project"));
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const ms = new Date(dateStr + "T00:00:00Z").getTime() - Date.now();
  return Math.ceil(ms / 86400000);
}

async function guard(env, user, locationId) {
  const loc = await getLocation(env.DB, locationId);
  if (!loc) return { error: 404 };
  if (!(await canAccessLocation(env.DB, user, locationId))) return { error: 403 };
  return { loc };
}

function denied(user, code) {
  const body = `<div class="card narrow"><h1>${code === 404 ? "Not found" : "No access"}</h1>
    <p class="muted">${code === 404 ? "That page does not exist." : "This login does not have access to that practice."}</p></div>`;
  return page({ title: "Portal", user, body });
}

// App shell openers (see adminNav in pages-admin.js): left rail on
// desktop, swipeable chip bar on phones; the layout CSS owns the switch.
function locNav(loc, active) {
  const base = `/app/locations/${loc.id}`;
  const item = (key, href, label) =>
    `<a class="rail-item${active === key ? " active" : ""}" href="${href}">${label}</a>`;
  return `<div class="shell"><aside class="rail">
    <div class="rail-context"><div class="rc-t">${esc(loc.name)}</div><div class="rc-s">${esc(loc.customer_name)}</div></div>
    ${item("overview", base, "Overview")}${item("equipment", base + "/equipment", "Equipment")}
    ${item("tickets", base + "/tickets", "Tickets")}${item("documents", base + "/documents", "Documents")}
    ${item("ask", base + "/ask", "Ask")}
    <div class="rail-sep"></div>
    ${item("quotes", "/app/quotes", "Quotes")}${item("invoices", "/app/invoices", "Invoices")}
    <a class="rail-item" href="${REMOTE_URL}" target="_blank" rel="noopener">Remote Support</a></aside><div class="shell-main">`;
}

function orgRail(user, active, orgName) {
  const item = (key, href, label) =>
    `<a class="rail-item${active === key ? " active" : ""}" href="${href}">${label}</a>`;
  return `<div class="shell"><aside class="rail">
    <div class="rail-context"><div class="rc-t">${esc(orgName || "My Portal")}</div><div class="rc-s">Client portal</div></div>
    ${item("practices", "/app", "Your practices")}${item("quotes", "/app/quotes", "Quotes")}
    ${item("invoices", "/app/invoices", "Invoices")}
    ${user.role === "customer_admin" ? item("team", "/app/team", "Team") : ""}</aside><div class="shell-main">`;
}

function lockedTile(user, loc, productName) {
  const body = `${locNav(loc, "")}<div class="card"><h2>${esc(productName)}</h2>
    <p><span class="pill off">Not included</span></p>
    <p class="muted">This service is not turned on for your practice. Ask FlossByte if you want it added.</p></div>`;
  return page({ title: productName, user, body });
}

// ---------- Entry: /app ----------
export async function appHome(env, request, user) {
  if (user.kind === "flossbyte") return redirect("/admin");
  const ids = await accessibleLocationIds(env.DB, user);
  if (!ids || ids.size === 0) {
    const body = `<div class="card narrow"><h1>Account created</h1>
      <p>Your login is ready. FlossByte still needs to connect it to your practice, and this screen is all you can see until that happens.</p>
      <p class="muted">Once connected, your equipment, tickets, and documents show up here. If this takes more than a business day, call us at (669) 237-2264.</p></div>`;
    return page({ title: "Waiting", user, body });
  }
  if (ids.size === 1) return redirect(`/app/locations/${[...ids][0]}`);
  const cards = [];
  for (const id of ids) {
    const loc = await getLocation(env.DB, id);
    if (loc) cards.push(`<a class="tile" href="/app/locations/${id}"><span class="t">${esc(loc.name)}</span>
      <span class="d">${esc(loc.customer_name)}${loc.city ? " , " + esc(loc.city) : ""}</span></a>`);
  }
  if (user.role === "customer_admin") {
    cards.push(`<a class="tile" href="/app/team"><span class="t">Team</span>
      <span class="d">People with a login for your organization, and removing people who left.</span></a>`);
  }
  cards.push(`<a class="tile" href="/app/quotes"><span class="t">Quotes</span>
    <span class="d">Quotes from FlossByte waiting for your review and acceptance.</span></a>`);
  cards.push(`<a class="tile" href="/app/invoices"><span class="t">Invoices</span>
    <span class="d">Deposit, project, and service invoices, with payment status.</span></a>`);
  const body = `${orgRail(user, "practices", "My Portal")}<h1>Your practices</h1><div class="grid">${cards.join("")}</div>`;
  return page({ title: "My Portal", user, body });
}

// ---------- Location overview ----------
export async function locationOverview(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const db = env.DB;
  const counts = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM equipment WHERE location_id = ?) AS equipment,
            (SELECT COUNT(*) FROM tickets WHERE location_id = ? AND status != 'closed') AS open_tickets,
            (SELECT COUNT(*) FROM documents WHERE location_id = ?) AS documents`)
    .bind(locationId, locationId, locationId).first();
  const managedOn = await laneOn(db, loc.customer_id, locationId);
  const expiring = managedOn ? await expiringItems(db, locationId, 90) : [];
  // Billing counts are best-effort: before migration 0008 the tables do
  // not exist and the overview must still render.
  const billing = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotes WHERE customer_id = ? AND status = 'sent') AS sent_quotes,
            (SELECT COUNT(*) FROM invoices WHERE customer_id = ? AND status = 'unpaid') AS unpaid_invoices`)
    .bind(loc.customer_id, loc.customer_id).first().catch(() => null);
  const states = await productStates(db, loc.customer_id, locationId);
  const expiringHtml = expiring.length
    ? `<div class="notice"><strong>Needs attention, next 90 days</strong><ul style="margin:8px 0 0;padding-left:18px">
        ${expiring.map((e) => {
          const kind = e.license_expires && (!e.warranty_expires || e.license_expires <= e.warranty_expires) ? "License" : "Warranty";
          const date = kind === "License" ? e.license_expires : e.warranty_expires;
          const days = daysUntil(date);
          return `<li>${esc(e.vendor || "")} ${esc(e.model || e.type || "Equipment")}: ${kind.toLowerCase()} expires ${esc(date)} (${days < 0 ? "expired" : days + " days"})</li>`;
        }).join("")}</ul></div>` : "";
  const tiles = states.map((p) => p.enabled
    ? `<a class="tile" href="/app/locations/${locationId}/products/${p.key}"><span class="t">${esc(p.name)}</span><span class="d"><span class="pill on">On</span> ${esc(p.description || "")}</span></a>`
    : `<a class="tile" href="/app/locations/${locationId}/products/${p.key}"><span class="t">${esc(p.name)}</span><span class="d"><span class="pill off">Not included</span> Ask FlossByte about adding it.</span></a>`).join("");
  const body = `${locNav(loc, "overview")}${user.role === "customer_admin"
    ? `<p style="margin:-6px 0 14px"><a href="/app/team">Manage your team</a></p>` : ""}
    <p style="margin:-6px 0 14px"><a href="/app/quotes">Quotes</a>${billing && billing.sent_quotes ? ` (${billing.sent_quotes} waiting for you)` : ""} · <a href="/app/invoices">Invoices</a>${billing && billing.unpaid_invoices ? ` (${billing.unpaid_invoices} unpaid)` : ""}</p><h1>${esc(loc.name)}</h1>
    ${expiringHtml}
    <div class="grid">
      <div class="tile"><span class="t">${counts.equipment}</span><span class="d">Pieces of equipment on record</span></div>
      <div class="tile"><span class="t">${counts.open_tickets}</span><span class="d">Open tickets</span></div>
      <div class="tile"><span class="t">${counts.documents}</span><span class="d">Documents</span></div>
      <a class="tile" href="${REMOTE_URL}" target="_blank" rel="noopener"><span class="t">Remote Support</span><span class="d">Start a session: download the app, then read us the 9-digit code it shows.</span></a>
    </div>
    <h2 style="margin-top:28px">Your services</h2><div class="grid">${tiles}</div>`;
  return page({ title: loc.name, user, body });
}

// ---------- Team (customer_admin only) ----------
export async function teamPage(env, request, user) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const members = await orgMembers(env.DB, org);
  const rows = members.map((m) => {
    const isSelf = m.id === user.id;
    const action = isSelf
      ? `<span class="muted">You</span>`
      : m.status === "disabled"
        ? `<span class="muted">Removed</span>`
        : `<a class="btn small danger" href="/app/team/${m.id}/remove">Remove</a>`;
    return `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td>
      <td>${m.role === "customer_admin" ? "Admin" : "User"}</td>
      <td>${esc(m.locations_label || "")}</td>
      <td><span class="pill ${m.status === "disabled" ? "off" : "on"}">${esc(m.status)}</span></td>
      <td>${action}</td></tr>`;
  }).join("");
  const body = `${orgRail(user, "team", cust ? cust.name : "My Portal")}<h1>Team</h1>
    <p class="muted">People with a login for ${esc(cust ? cust.name : "your organization")}. Removing someone signs them out right away and takes away everything they could see here. Tickets and documents they created stay on record.</p>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Sees</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="muted">No logins yet.</td></tr>`}</tbody></table></div></div>`;
  const msg = new URL(request.url).searchParams.get("msg");
  return page({ title: "Team", user, body, flash: msg || undefined });
}

export async function teamRemoveConfirmPage(env, request, user, targetId) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const members = await orgMembers(env.DB, org);
  const target = members.find((m) => m.id === Number(targetId));
  if (!target || target.status === "disabled") return denied(user, 404);
  const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const body = `<div class="card narrow"><h1>Remove ${esc(target.name)}?</h1>
    <p>${esc(target.name)} (${esc(target.email)}) will be signed out and will no longer see anything for ${esc(cust ? cust.name : "your organization")}.</p>
    <p class="muted">Tickets and documents they created stay on record. If they ever need access again, FlossByte can invite them fresh.</p>
    <form method="post" action="/app/team/${target.id}/remove" class="row">
      <button class="btn danger" type="submit">Remove this user</button>
      <a class="btn secondary" href="/app/team">Cancel</a></form></div>`;
  return page({ title: "Remove user", user, body });
}

export async function teamRemovePost(env, request, user, targetId) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const result = await removeUserFromCustomer(env.DB, user, targetId, org);
  if (!result.ok) return redirect("/app/team?msg=" + encodeURIComponent(result.error));
  return redirect("/app/team?msg=" + encodeURIComponent(`${result.target.name} was removed.`));
}

// ---------- Product status / locked page ----------
export async function productPage(env, request, user, locationId, productKey) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const prod = await env.DB.prepare("SELECT * FROM products WHERE key = ?").bind(productKey).first();
  if (!prod) return denied(user, 404);
  const on = await productEnabled(env.DB, loc.customer_id, locationId, productKey);
  if (!on) return lockedTile(user, loc, prod.name);
  if (productKey === "managed_it") return redirect(`/app/locations/${locationId}/equipment`);
  const states = await productStates(env.DB, loc.customer_id, locationId);
  const state = states.find((s) => s.key === productKey);
  const body = `${locNav(loc, "")}<div class="card"><h2>${esc(prod.name)}</h2>
    <p><span class="pill on">On for this practice</span></p>
    <p class="muted">${esc(prod.description || "")}</p>
    <p class="muted">Work for this service shows up here as it gets scheduled. Questions: call (669) 237-2264.</p></div>`;
  return page({ title: prod.name, user, body });
}

// ---------- Equipment ----------
export async function equipmentPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Equipment");
  const q = new URL(request.url).searchParams;
  const search = (q.get("q") || "").trim();
  const vendor = (q.get("vendor") || "").trim();
  let sql = "SELECT * FROM equipment WHERE location_id = ?";
  const binds = [locationId];
  if (search) { sql += " AND (vendor LIKE ? OR model LIKE ? OR type LIKE ? OR serial LIKE ?)"; const like = `%${search}%`; binds.push(like, like, like, like); }
  if (vendor) { sql += " AND vendor = ?"; binds.push(vendor); }
  sql += " ORDER BY vendor, model";
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  const vendors = [...new Set((await env.DB.prepare("SELECT DISTINCT vendor FROM equipment WHERE location_id = ? AND vendor IS NOT NULL").bind(locationId).all()).results.map((r) => r.vendor))];
  const scope = await locationScope(env.DB, user, locationId);
  const canEdit = user.kind === "flossbyte" || scope === "admin";
  const rows = (results || []).map((e) => {
    const exp = [e.license_expires, e.warranty_expires].filter(Boolean).sort()[0];
    const days = daysUntil(exp);
    const pill = exp && days <= 90 ? `<span class="pill warn">${esc(exp)}</span>` : esc(exp || "");
    const modelCell = e.name ? (e.model ? `${e.name} (${e.model})` : e.name) : (e.model || "");
    return `<tr><td>${esc(e.vendor || "")}</td><td>${esc(e.type || "")}</td><td>${esc(modelCell)}</td>
      <td>${esc(e.serial || "")}</td><td>${esc(e.status)}</td><td>${esc(e.firmware || "")}</td><td>${pill}</td></tr>`;
  }).join("");
  const addForm = canEdit ? `<div class="card"><h3>Add equipment</h3>
    <form method="post" action="/app/locations/${locationId}/equipment" class="row" style="align-items:end">
      <span style="flex:1;min-width:130px"><label>Vendor</label><input name="vendor" placeholder="Sophos, UniFi, SonicWall"></span>
      <span style="flex:1;min-width:110px"><label>Type</label><input name="type" placeholder="Firewall"></span>
      <span style="flex:1;min-width:130px"><label>Model</label><input name="model"></span>
      <span style="flex:1;min-width:130px"><label>Serial</label><input name="serial"></span>
      <span style="flex:1;min-width:110px"><label>Status</label><select name="status"><option>online</option><option>offline</option><option>unknown</option></select></span>
      <span style="flex:1;min-width:130px"><label>Firmware</label><input name="firmware"></span>
      <span style="flex:1;min-width:150px"><label>License expires</label><input name="license_expires" type="date"></span>
      <span style="flex:1;min-width:150px"><label>Warranty expires</label><input name="warranty_expires" type="date"></span>
      <button class="btn small" type="submit">Add</button></form></div>` : "";
  const body = `${locNav(loc, "equipment")}<h1>Equipment</h1>
    <form method="get" class="row" style="margin-bottom:14px">
      <span style="flex:2;min-width:180px"><input name="q" placeholder="Search model, serial, type" value="${esc(search)}"></span>
      <span style="flex:1;min-width:140px"><select name="vendor"><option value="">All vendors</option>
        ${vendors.map((v) => `<option ${v === vendor ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></span>
      <button class="btn small secondary" type="submit">Filter</button></form>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Vendor</th><th>Type</th><th>Model</th><th>Serial</th><th>Status</th><th>Firmware</th><th>Next expiry</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="muted">No equipment recorded yet.</td></tr>`}</tbody></table></div></div>${addForm}`;
  return page({ title: "Equipment", user, body });
}

export async function equipmentPost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Equipment");
  const scope = await locationScope(env.DB, user, locationId);
  if (!(user.kind === "flossbyte" || scope === "admin")) return denied(user, 403);
  const f = await request.formData();
  await env.DB.prepare(
    `INSERT INTO equipment (location_id, vendor, type, model, serial, status, firmware, warranty_expires, license_expires, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(locationId, f.get("vendor") || null, f.get("type") || null, f.get("model") || null,
      f.get("serial") || null, String(f.get("status") || "online"), f.get("firmware") || null,
      f.get("warranty_expires") || null, f.get("license_expires") || null, f.get("notes") || null).run();
  await audit(env.DB, user.id, "equipment_add", "location", locationId, String(f.get("model") || ""));
  return redirect(`/app/locations/${locationId}/equipment`);
}

// ---------- Tickets ----------
const STATUS_LABEL = { open: "Open", in_progress: "In progress", waiting: "Waiting", closed: "Closed" };

export async function ticketsPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Tickets");
  const { results } = await env.DB.prepare(
    "SELECT * FROM tickets WHERE location_id = ? ORDER BY (status = 'closed'), updated_at DESC").bind(locationId).all();
  const rows = (results || []).map((t) => `<tr><td><a href="/app/locations/${locationId}/tickets/${t.id}">${esc(t.title)}</a></td>
    <td><span class="pill">${esc(STATUS_LABEL[t.status] || t.status)}</span></td><td>${esc(t.priority)}</td><td>${esc(t.created_at.slice(0, 10))}</td></tr>`).join("");
  const body = `${locNav(loc, "tickets")}<h1>Tickets</h1>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Title</th><th>Status</th><th>Priority</th><th>Opened</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="muted">No tickets yet.</td></tr>`}</tbody></table></div></div>
    <div class="card"><h3>Open a ticket</h3>
      <form method="post" action="/app/locations/${locationId}/tickets">
        <label>What is going on? <span class="req">*</span></label><input name="title" required>
        <label>Details</label><textarea name="body"></textarea>
        <label>Priority</label><select name="priority"><option>low</option><option selected>normal</option><option>high</option><option>urgent</option></select>
        <p style="margin-top:14px"><button class="btn" type="submit">Open ticket</button></p></form></div>`;
  return page({ title: "Tickets", user, body });
}

export async function ticketCreatePost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Tickets");
  const f = await request.formData();
  const res = await env.DB.prepare(
    "INSERT INTO tickets (location_id, title, priority, created_by) VALUES (?, ?, ?, ?)")
    .bind(locationId, String(f.get("title") || "Support request"), String(f.get("priority") || "normal"), user.id).run();
  const tid = res.meta.last_row_id;
  const detail = String(f.get("body") || "").trim();
  if (detail) await env.DB.prepare("INSERT INTO ticket_updates (ticket_id, author_id, body) VALUES (?, ?, ?)").bind(tid, user.id, detail).run();
  await audit(env.DB, user.id, "ticket_create", "ticket", tid, null);
  return redirect(`/app/locations/${locationId}/tickets/${tid}`);
}

export async function ticketDetailPage(env, request, user, locationId, ticketId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Tickets");
  const t = await env.DB.prepare("SELECT * FROM tickets WHERE id = ? AND location_id = ?").bind(ticketId, locationId).first();
  if (!t) return denied(user, 404);
  const { results } = await env.DB.prepare(
    `SELECT tu.*, u.name AS author_name FROM ticket_updates tu LEFT JOIN users u ON u.id = tu.author_id
     WHERE tu.ticket_id = ? ORDER BY tu.created_at`).bind(ticketId).all();
  const thread = (results || []).map((u) => `<div style="border-bottom:1px solid var(--line);padding:10px 0">
    <div class="muted">${esc(u.author_name || "User")} , ${esc(u.created_at.slice(0, 16))}</div><p style="margin:4px 0">${esc(u.body)}</p></div>`).join("");
  const scope = await locationScope(env.DB, user, locationId);
  const canManage = user.kind === "flossbyte" || scope === "admin";
  const manage = canManage ? `<form method="post" action="/app/locations/${locationId}/tickets/${ticketId}/status" class="row" style="margin-top:14px">
      <span style="min-width:170px"><select name="status">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${t.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></span>
      <span style="min-width:140px"><select name="priority">${["low", "normal", "high", "urgent"].map((p) => `<option ${t.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select></span>
      <button class="btn small secondary" type="submit">Update status</button></form>` : "";
  const body = `${locNav(loc, "tickets")}<h1>${esc(t.title)}</h1>
    <p><span class="pill">${esc(STATUS_LABEL[t.status] || t.status)}</span> <span class="muted">Priority: ${esc(t.priority)} , opened ${esc(t.created_at.slice(0, 10))}</span></p>
    <div class="card">${thread || `<p class="muted">No updates yet.</p>`}
      <form method="post" action="/app/locations/${locationId}/tickets/${ticketId}/update">
        <label>Add an update <span class="req">*</span></label><textarea name="body" required></textarea>
        <p style="margin-top:10px"><button class="btn" type="submit">Post update</button></p></form>
      ${manage}</div>`;
  return page({ title: t.title, user, body });
}

export async function ticketUpdatePost(env, request, user, locationId, ticketId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const t = await env.DB.prepare("SELECT id FROM tickets WHERE id = ? AND location_id = ?").bind(ticketId, locationId).first();
  if (!t) return denied(user, 404);
  const f = await request.formData();
  const bodyText = String(f.get("body") || "").trim();
  if (bodyText) {
    await env.DB.prepare("INSERT INTO ticket_updates (ticket_id, author_id, body) VALUES (?, ?, ?)").bind(ticketId, user.id, bodyText).run();
    await env.DB.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").bind(ticketId).run();
  }
  return redirect(`/app/locations/${locationId}/tickets/${ticketId}`);
}

export async function ticketStatusPost(env, request, user, locationId, ticketId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const scope = await locationScope(env.DB, user, locationId);
  if (!(user.kind === "flossbyte" || scope === "admin")) return denied(user, 403);
  const f = await request.formData();
  const status = String(f.get("status") || "open");
  const priority = String(f.get("priority") || "normal");
  if (STATUS_LABEL[status]) {
    await env.DB.prepare("UPDATE tickets SET status = ?, priority = ?, updated_at = datetime('now') WHERE id = ? AND location_id = ?")
      .bind(status, priority, ticketId, locationId).run();
    await audit(env.DB, user.id, "ticket_status", "ticket", Number(ticketId), status);
  }
  return redirect(`/app/locations/${locationId}/tickets/${ticketId}`);
}

// ---------- Documents ----------
export async function documentsPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const { results } = await env.DB.prepare(
    `SELECT d.*, u.name AS uploader FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE d.location_id = ? ORDER BY d.created_at DESC`).bind(locationId).all();
  const rows = (results || []).map((d) => `<tr><td>${d.r2_key ? `<a href="/app/documents/${d.id}/view" target="_blank" rel="noopener">${esc(d.name)}</a>` : esc(d.name)}</td>
    <td>${esc(d.mime || "")}</td><td>${d.size ? Math.round(d.size / 1024) + " KB" : ""}</td>
    <td>${esc(d.uploader || "")}</td><td>${esc(d.created_at.slice(0, 10))}</td></tr>`).join("");
  const body = `${locNav(loc, "documents")}<h1>Documents</h1>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Uploaded by</th><th>Date</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="muted">No documents yet.</td></tr>`}</tbody></table></div></div>
    <div class="card"><h3>Upload a document</h3>
      <form method="post" action="/app/locations/${locationId}/documents" enctype="multipart/form-data">
        <label>File <span class="req">*</span></label><input type="file" name="file" required>
        <p style="margin-top:12px"><button class="btn" type="submit">Upload</button></p></form>
      <p class="muted">Keep patient information out of the portal. This space is for IT documents: network notes, invoices, warranty paperwork.</p></div>`;
  return page({ title: "Documents", user, body });
}

export async function documentUploadPost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string" || file.size === 0) return redirect(`/app/locations/${locationId}/documents`);
  if (file.size > 10 * 1024 * 1024) {
    return page({ title: "Upload", user, body: `<div class="card narrow"><h1>File too large</h1><p class="muted">Keep uploads under 10 MB.</p></div>` });
  }
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
  const key = `locations/${locationId}/${Date.now()}-${safeName}`;
  if (env.DOCS) await env.DOCS.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
  const res = await env.DB.prepare(
    "INSERT INTO documents (location_id, name, r2_key, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(locationId, file.name, env.DOCS ? key : null, file.type || null, file.size, user.id).run();
  await audit(env.DB, user.id, "document_upload", "document", res.meta.last_row_id, file.name);
  return redirect(`/app/locations/${locationId}/documents`);
}

export async function documentView(env, request, user, documentId) {
  const doc = await env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(documentId).first();
  if (!doc) return new Response("Not found", { status: 404 });
  if (!(await canAccessLocation(env.DB, user, doc.location_id))) return new Response("Forbidden", { status: 403 });
  if (!doc.r2_key || !env.DOCS) return new Response("File not stored", { status: 404 });
  const obj = await env.DOCS.get(doc.r2_key);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": doc.mime || "application/octet-stream",
      "Content-Disposition": `inline; filename="${doc.name.replace(/"/g, "")}"`,
    },
  });
}

// ---------- Ask (answers only from this location's own records) ----------
function tokenize(text) {
  return [...new Set(String(text).toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !["what", "when", "which", "have", "does", "the", "and", "for", "our", "any"].includes(w)))];
}

export async function askAnswer(db, locationId, question) {
  const q = question.toLowerCase();
  const parts = [];
  const wantsExpiry = /expir|warrant|license|renew/.test(q);
  if (wantsExpiry) {
    const items = await expiringItems(db, locationId, 90);
    if (items.length) {
      parts.push("Expiring in the next 90 days: " + items.map((e) =>
        `${e.vendor || ""} ${e.model || e.type || "equipment"} (license ${e.license_expires || "n/a"}, warranty ${e.warranty_expires || "n/a"})`).join("; ") + ".");
    } else parts.push("Nothing on record expires in the next 90 days.");
  }
  const words = tokenize(question);
  if (words.length) {
    const like = words.map(() => "(vendor LIKE ? OR type LIKE ? OR model LIKE ? OR serial LIKE ? OR status LIKE ? OR notes LIKE ?)").join(" OR ");
    const binds = [locationId];
    for (const w of words) { const l = `%${w}%`; binds.push(l, l, l, l, l, l); }
    const { results: eq } = await db.prepare(`SELECT * FROM equipment WHERE location_id = ? AND (${like}) LIMIT 8`).bind(...binds).all();
    if (eq && eq.length) {
      parts.push("Equipment on record: " + eq.map((e) =>
        `${e.vendor || ""} ${e.model || e.type || ""} (serial ${e.serial || "n/a"}, status ${e.status}, firmware ${e.firmware || "n/a"})`).join("; ") + ".");
    }
    const tLike = words.map(() => "title LIKE ?").join(" OR ");
    const tBinds = [locationId, ...words.map((w) => `%${w}%`)];
    const { results: tk } = await db.prepare(`SELECT * FROM tickets WHERE location_id = ? AND (${tLike}) LIMIT 5`).bind(...tBinds).all();
    if (tk && tk.length) {
      parts.push("Tickets on record: " + tk.map((t) => `"${t.title}" (${t.status}, ${t.priority})`).join("; ") + ".");
    }
    const dLike = words.map(() => "name LIKE ?").join(" OR ");
    const dBinds = [locationId, ...words.map((w) => `%${w}%`)];
    const { results: dc } = await db.prepare(`SELECT * FROM documents WHERE location_id = ? AND (${dLike}) LIMIT 5`).bind(...dBinds).all();
    if (dc && dc.length) {
      parts.push("Documents on record: " + dc.map((d) => d.name).join(", ") + ".");
    }
  }
  if (!parts.length) {
    return "That is not in your portal records yet, so I cannot answer it from your data. Ask about equipment, license or warranty expiry dates, tickets, or documents, or open a ticket and we will look into it.";
  }
  return parts.join(" ") + " (Answered from your own portal records only.)";
}

export async function askPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const { results } = await env.DB.prepare(
    "SELECT * FROM ask_messages WHERE location_id = ? ORDER BY created_at DESC LIMIT 10").bind(locationId).all();
  const history = (results || []).reverse().map((m) => `<div style="border-bottom:1px solid var(--line);padding:10px 0">
    <p style="margin:2px 0"><strong>You:</strong> ${esc(m.question)}</p>
    <p style="margin:2px 0" class="muted"><strong>Ask:</strong> ${esc(m.answer)}</p></div>`).join("");
  const body = `${locNav(loc, "ask")}<h1>Ask</h1>
    <div class="card"><p class="muted">Ask about your own equipment, expiry dates, tickets, and documents. Answers come only from what is recorded for this practice.</p>
    <form method="post" action="/app/locations/${locationId}/ask">
      <input name="question" placeholder="What is expiring in the next 90 days?" required>
      <p style="margin-top:12px"><button class="btn" type="submit">Ask</button></p></form>
    ${history}</div>`;
  return page({ title: "Ask", user, body });
}

export async function askPost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const f = await request.formData();
  const question = String(f.get("question") || "").trim();
  if (question) {
    const answer = await askAnswer(env.DB, locationId, question);
    await env.DB.prepare("INSERT INTO ask_messages (location_id, user_id, question, answer) VALUES (?, ?, ?, ?)")
      .bind(locationId, user.id, question, answer).run();
  }
  return redirect(`/app/locations/${locationId}/ask`);
}

// ---------- Quotes and invoices (organization level) ----------
// A login belongs to exactly one organization, so any accessible
// location identifies the org. Quotes are visible once sent; only a
// customer admin can accept or decline, and accepting creates the
// deposit invoice on the spot when the quote asks for one.
async function clientOrgId(env, user) {
  const ids = await accessibleLocationIds(env.DB, user);
  if (!ids || ids.size === 0) return null;
  const loc = await getLocation(env.DB, [...ids][0]);
  return loc ? loc.customer_id : null;
}

async function loadQuote(db, quoteId, customerId) {
  const quote = await db.prepare("SELECT * FROM quotes WHERE id = ? AND customer_id = ?").bind(quoteId, customerId).first();
  if (!quote) return null;
  const { results: items } = await db.prepare(
    "SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort, id").bind(quoteId).all();
  const total = (items || []).reduce((s, i) => s + Math.round(i.qty * i.unit_price_cents), 0);
  return { quote, items: items || [], total };
}

const QUOTE_STATUS = { sent: "Waiting for you", accepted: "Accepted", declined: "Declined" };
const INVOICE_KIND = { deposit: "Deposit", final: "Final balance", standard: "Invoice" };

export async function quotesPage(env, request, user) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  const { results } = await env.DB.prepare(
    "SELECT * FROM quotes WHERE customer_id = ? AND status IN ('sent','accepted','declined') ORDER BY updated_at DESC").bind(org).all();
  const rows = [];
  for (const qt of results || []) {
    const { total } = await loadQuote(env.DB, qt.id, org);
    rows.push(`<tr><td><a href="/app/quotes/${qt.id}">${esc(qt.title)}</a></td>
      <td>${qt.kind === "plan" ? "Service plan" : "Project"}</td><td>${fmtMoney(total)}</td>
      <td><span class="pill ${qt.status === "accepted" ? "on" : qt.status === "declined" ? "off" : ""}">${esc(QUOTE_STATUS[qt.status] || qt.status)}</span></td>
      <td>${esc((qt.sent_at || qt.created_at || "").slice(0, 10))}</td></tr>`);
  }
  const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const body = `${orgRail(user, "quotes", cust ? cust.name : "My Portal")}<h1>Quotes</h1>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Quote</th><th>Type</th><th>Total</th><th>Status</th><th>Sent</th></tr></thead>
    <tbody>${rows.join("") || `<tr><td colspan="5" class="muted">No quotes yet. When FlossByte sends you one, it shows up here for review and acceptance.</td></tr>`}</tbody></table></div></div>`;
  const msg = new URL(request.url).searchParams.get("msg");
  return page({ title: "Quotes", user, body, flash: msg || undefined });
}

export async function quoteViewPage(env, request, user, quoteId) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  const loaded = await loadQuote(env.DB, quoteId, org);
  if (!loaded || loaded.quote.status === "draft") return denied(user, 404);
  const { quote, items, total } = loaded;
  const deposit = Math.round(total * (quote.deposit_percent || 0) / 100);
  const itemRows = items.map((i) => `<tr><td>${esc(i.description)}</td><td>${esc(String(i.qty))}</td>
    <td>${fmtMoney(i.unit_price_cents)}</td><td>${fmtMoney(Math.round(i.qty * i.unit_price_cents))}</td></tr>`).join("");
  let statusBlock = "";
  if (quote.status === "accepted") {
    statusBlock = `<div class="notice"><strong>Accepted</strong> by ${esc(quote.accepted_by || "")} on ${esc((quote.accepted_at || "").slice(0, 10))}.
      ${deposit > 0 ? `The deposit invoice is on your <a href="/app/invoices">Invoices</a> page.` : ""}</div>`;
  } else if (quote.status === "declined") {
    statusBlock = `<div class="notice">This quote was declined. If that was a mistake, call FlossByte at (669) 237-2264.</div>`;
  } else if (user.role === "customer_admin") {
    statusBlock = `<div class="card"><h3>Accept this quote</h3>
      <form method="post" action="/app/quotes/${quote.id}/accept">
        <label>Your full name <span class="req">*</span></label><input name="signer_name" required>
        <p><label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="agree" value="yes" required style="width:auto;margin-top:4px">
        <span>I agree to the terms below and accept this quote for our organization.</span></label></p>
        <button class="btn" type="submit">Accept quote</button></form>
      <form method="post" action="/app/quotes/${quote.id}/decline" style="margin-top:10px">
        <button class="btn small secondary" type="submit">Decline</button></form></div>`;
  } else {
    statusBlock = `<div class="card"><p class="muted">This quote is waiting for your organization's admin to review and accept it.</p></div>`;
  }
  const body = `${orgRail(user, "quotes", "My Portal")}<p><a href="/app/quotes">&larr; Quotes</a></p><h1>${esc(quote.title)}</h1>
    <p class="muted">${quote.kind === "plan" ? "Service plan" : "Project"} quote from FlossByte. Total <strong>${fmtMoney(total)}</strong>${deposit > 0 ? `, with a ${quote.deposit_percent}% deposit of <strong>${fmtMoney(deposit)}</strong> due on acceptance and ${fmtMoney(total - deposit)} after that.` : "."}</p>
    ${statusBlock}
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Description</th><th>Qty</th><th>Price</th><th>Amount</th></tr></thead>
    <tbody>${itemRows}</tbody></table></div></div>
    ${quote.terms ? `<div class="card"><h3>Terms</h3><div style="white-space:pre-wrap">${esc(quote.terms)}</div></div>` : ""}`;
  const msg = new URL(request.url).searchParams.get("msg");
  return page({ title: quote.title, user, body, flash: msg || undefined });
}

export async function quoteAcceptPost(env, request, user, quoteId) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  if (user.role !== "customer_admin") return denied(user, 403);
  const loaded = await loadQuote(env.DB, quoteId, org);
  if (!loaded || loaded.quote.status !== "sent") return redirect("/app/quotes");
  const f = await request.formData();
  const signer = String(f.get("signer_name") || "").trim();
  if (String(f.get("agree") || "") !== "yes" || !signer) {
    return redirect(`/app/quotes/${quoteId}?msg=` + encodeURIComponent("Type your full name and check the agreement box to accept."));
  }
  const { quote, total } = loaded;
  await env.DB.prepare(
    "UPDATE quotes SET status = 'accepted', accepted_at = datetime('now'), accepted_by = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(signer, quoteId).run();
  const deposit = Math.round(total * (quote.deposit_percent || 0) / 100);
  let invoiceNote = "";
  if (deposit > 0) {
    await env.DB.prepare(
      "INSERT INTO invoices (customer_id, quote_id, title, kind, amount_cents, created_by) VALUES (?, ?, ?, 'deposit', ?, ?)")
      .bind(org, quoteId, `${quote.title}: deposit (${quote.deposit_percent}%)`, deposit, user.id).run();
    invoiceNote = " The deposit invoice is on your Invoices page; work is scheduled once it is paid.";
  }
  await audit(env.DB, user.id, "quote_accept", "quote", quoteId, `signed by ${signer}`);
  if (env.ADMIN_ALERT_EMAIL) {
    const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
    const mail = quoteAcceptedNoticeEmail(env, {
      customerName: cust ? cust.name : "A customer", quoteTitle: quote.title, acceptedBy: signer, total: fmtMoney(total),
    });
    await sendEmail(env, { to: env.ADMIN_ALERT_EMAIL, template: "quote_accepted", ...mail });
  }
  return redirect(`/app/quotes/${quoteId}?msg=` + encodeURIComponent("Quote accepted. Thank you." + invoiceNote));
}

export async function quoteDeclinePost(env, request, user, quoteId) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  if (user.role !== "customer_admin") return denied(user, 403);
  const loaded = await loadQuote(env.DB, quoteId, org);
  if (!loaded || loaded.quote.status !== "sent") return redirect("/app/quotes");
  await env.DB.prepare(
    "UPDATE quotes SET status = 'declined', updated_at = datetime('now') WHERE id = ?").bind(quoteId).run();
  await audit(env.DB, user.id, "quote_decline", "quote", quoteId, null);
  return redirect("/app/quotes?msg=" + encodeURIComponent("Quote declined."));
}

export async function invoicesPage(env, request, user) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  const { results } = await env.DB.prepare(
    "SELECT * FROM invoices WHERE customer_id = ? AND status != 'void' ORDER BY created_at DESC").bind(org).all();
  const rows = (results || []).map((inv) => {
    const pay = inv.status === "unpaid" && inv.pay_url
      ? `<a class="btn small" href="${esc(inv.pay_url)}" target="_blank" rel="noopener">Pay</a>` : "";
    const note = inv.kind === "deposit"
      ? (inv.status === "unpaid" ? `<div class="muted">Work is scheduled once this deposit is paid.</div>` : `<div class="muted">Deposit received.</div>`) : "";
    return `<tr><td>INV-${1000 + inv.id}</td><td>${esc(inv.title)}${note}</td>
      <td>${esc(INVOICE_KIND[inv.kind] || "Invoice")}</td><td>${fmtMoney(inv.amount_cents)}</td>
      <td><span class="pill ${inv.status === "paid" ? "on" : ""}">${inv.status === "paid" ? "Paid" : "Unpaid"}</span>${inv.status === "paid" && inv.paid_at ? `<div class="muted">${esc(inv.paid_at.slice(0, 10))}</div>` : ""}</td>
      <td>${esc(inv.due_date || "")}</td><td>${pay}</td></tr>`;
  }).join("");
  const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const body = `${orgRail(user, "invoices", cust ? cust.name : "My Portal")}<h1>Invoices</h1>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Number</th><th>Invoice</th><th>Type</th><th>Amount</th><th>Status</th><th>Due</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="muted">No invoices yet.</td></tr>`}</tbody></table></div></div>`;
  const msg = new URL(request.url).searchParams.get("msg");
  return page({ title: "Invoices", user, body, flash: msg || undefined });
}
