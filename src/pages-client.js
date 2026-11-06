// Client-facing portal pages. Every handler re-checks access to the location
// on the server; nothing here trusts ids from the browser.
import { page, redirect, esc, icon, fmtDateUS, withStatus } from "./layout.js";
import {
  canAccessLocation, locationScope, getLocation, productEnabled, productStates,
  expiringItems, audit, accessibleLocationIds, customerAdminOrg, orgMembers,
  removeUserFromCustomer,
} from "./access.js";
import { sendEmail, quoteAcceptedNoticeEmail, ticketCreatedNoticeEmail, ticketReplyNoticeEmail, productRequestEmail } from "./email.js";
import { splitName, joinName } from "./auth.js";

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
  return withStatus(page({ title: "Portal", user, body }), code);
}

// App shell openers (see adminNav in pages-admin.js): left rail on
// desktop, swipeable chip bar on phones; the layout CSS owns the switch.
function locNav(loc, active) {
  const base = `/app/locations/${loc.id}`;
  const item = (key, href, label, ic) =>
    `<a class="rail-item${active === key ? " active" : ""}" href="${href}">${icon(ic)}${label}</a>`;
  return `<div class="shell"><aside class="rail">
    <div class="rail-context"><div class="rc-t">${esc(loc.name)}</div><div class="rc-s">${esc(loc.customer_name)}</div></div>
    ${item("overview", base, "Overview", "grid")}${item("equipment", base + "/equipment", "Equipment", "monitor")}
    ${item("topology", base + "/topology", "Topology", "topology")}
    ${item("network", base + "/network", "Network", "activity")}
    ${item("tickets", base + "/tickets", "Tickets", "ticket")}${item("documents", base + "/documents", "Documents", "folder")}
    ${item("ask", base + "/ask", "Ask", "chat")}
    <div class="rail-sep"></div>
    ${item("billing", "/app/billing", "Billing", "receipt")}
    <a class="rail-item" href="${REMOTE_URL}" target="_blank" rel="noopener">${icon("headset")}Remote Support</a></aside><div class="shell-main">`;
}

function orgRail(user, active, orgName) {
  const item = (key, href, label, ic) =>
    `<a class="rail-item${active === key ? " active" : ""}" href="${href}">${icon(ic)}${label}</a>`;
  // Account administration (services, team) sits in its own labeled
  // group, and only the organization's admins see it at all; everyday
  // items (practices, billing) stay above it.
  const account = user.role === "customer_admin"
    ? `<div class="rail-label">Account</div>${item("services", "/app/services", "Services", "shield")}${item("team", "/app/team", "Team", "users")}`
    : "";
  return `<div class="shell"><aside class="rail">
    <div class="rail-context"><div class="rc-t">${esc(orgName || "My Portal")}</div><div class="rc-s">Client portal</div></div>
    ${item("practices", "/app", "Your practices", "home")}${item("billing", "/app/billing", "Billing", "receipt")}
    ${account}</aside><div class="shell-main">`;
}

function lockedTile(user, loc, productName, productKey) {
  const body = `${locNav(loc, "")}<div class="card"><h2>${esc(productName)}</h2>
    <p><span class="pill off">Not included</span></p>
    <p class="muted">This service is not turned on for your practice.</p>
    ${productKey ? requestForm(loc, productKey) : ""}</div>`;
  return page({ title: productName, user, body });
}

// One-click "ask FlossByte for this service" — emails the FlossByte team.
function requestForm(loc, productKey) {
  return `<form method="post" action="/app/locations/${loc.id}/request-product" style="margin-top:12px">
    <input type="hidden" name="product" value="${esc(productKey)}">
    <button class="btn small" type="submit">Request this service</button></form>`;
}

// Alert the FlossByte team: the configured alert address when set,
// otherwise every active FlossByte admin's inbox.
async function alertFlossByte(env, template, mail) {
  let targets = [];
  if (env.ADMIN_ALERT_EMAIL) targets = [env.ADMIN_ALERT_EMAIL];
  else {
    const { results } = await env.DB.prepare("SELECT email FROM users WHERE kind = 'flossbyte' AND status = 'active'").all();
    targets = (results || []).map((r) => r.email);
  }
  for (const to of targets) { try { await sendEmail(env, { to, template, ...mail }); } catch (e) { /* email never blocks the action */ } }
}

export async function productRequestPost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const f = await request.formData();
  const key = String(f.get("product") || "");
  const prod = await env.DB.prepare("SELECT * FROM products WHERE key = ?").bind(key).first();
  if (prod) {
    await audit(env.DB, user.id, "product_request", "location", locationId, prod.name);
    const mail = productRequestEmail(env, {
      customerName: loc.customer_name, locationName: loc.name, productName: prod.name,
      requestedBy: user.name, link: `${orgOrigin(env)}/admin/customers/${loc.customer_id}`,
    });
    await alertFlossByte(env, "product_request", mail);
  }
  return redirect("/app/services?msg=" + encodeURIComponent("Request sent. FlossByte will be in touch about it."));
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
      <span class="d">${esc(loc.customer_name)}${loc.city ? ", " + esc(loc.city) : ""}</span></a>`);
  }
  if (user.role === "customer_admin") {
    cards.push(`<a class="tile" href="/app/services"><span class="t">Services</span>
      <span class="d">What each practice has with FlossByte, and requesting a service you do not have yet.</span></a>`);
    cards.push(`<a class="tile" href="/app/team"><span class="t">Team</span>
      <span class="d">People with a login for your organization, and removing people who left.</span></a>`);
  }
  cards.push(`<a class="tile" href="/app/billing"><span class="t">Billing</span>
    <span class="d">Quotes waiting for your review, and invoices with payment status.</span></a>`);
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
  const expiringHtml = expiring.length
    ? `<div class="notice"><strong>Needs attention, next 90 days</strong><ul style="margin:8px 0 0;padding-left:18px">
        ${expiring.map((e) => {
          const kind = e.license_expires && (!e.warranty_expires || e.license_expires <= e.warranty_expires) ? "License" : "Warranty";
          const date = kind === "License" ? e.license_expires : e.warranty_expires;
          const days = daysUntil(date);
          return `<li>${esc(e.vendor || "")} ${esc(e.model || e.type || "Equipment")}: ${kind.toLowerCase()} expires ${esc(fmtDateUS(date))} (${days < 0 ? "expired" : days + " days"})</li>`;
        }).join("")}</ul></div>` : "";
  const quickLinks = [
    `<a href="/app/billing">Billing</a>${billing && billing.sent_quotes ? ` (${billing.sent_quotes} quote${billing.sent_quotes > 1 ? "s" : ""} waiting for you)` : ""}${billing && billing.unpaid_invoices ? ` (${billing.unpaid_invoices} unpaid invoice${billing.unpaid_invoices > 1 ? "s" : ""})` : ""}`,
    user.role === "customer_admin" ? `<a href="/app/services">Services</a>` : "",
    user.role === "customer_admin" ? `<a href="/app/team">Manage your team</a>` : "",
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");
  const body = `${locNav(loc, "overview")}<h1>${esc(loc.name)}</h1>
    <p class="muted" style="margin:-6px 0 16px">${quickLinks}</p>
    ${expiringHtml}
    <div class="grid">
      <a class="tile" href="/app/locations/${locationId}/equipment"><span class="tile-n">${counts.equipment}</span><span class="d">Equipment on record</span></a>
      <a class="tile" href="/app/locations/${locationId}/tickets"><span class="tile-n">${counts.open_tickets}</span><span class="d">Open tickets</span></a>
      <a class="tile" href="/app/locations/${locationId}/documents"><span class="tile-n">${counts.documents}</span><span class="d">Documents</span></a>
      <a class="tile" href="${REMOTE_URL}" target="_blank" rel="noopener"><span class="t">Remote Support</span><span class="d">Start a session: download the app, then read us the 9-digit code it shows.</span></a>
    </div>`;
  const msg = new URL(request.url).searchParams.get("msg");
  return page({ title: loc.name, user, body, flash: msg || undefined });
}

// ---------- Services (Account section, customer_admin only) ----------
// What the organization has with FlossByte, per location, and where an
// admin asks for a service the practice does not have yet. Kept off the
// everyday location pages on purpose: this is account administration.
export async function servicesPage(env, request, user) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const db = env.DB;
  const cust = await db.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const { results: locs } = await db.prepare("SELECT * FROM locations WHERE customer_id = ? ORDER BY id").bind(org).all();
  const cards = [];
  for (const loc of locs || []) {
    const states = await productStates(db, org, loc.id);
    const rowsHtml = states.map((p) => `<tr><td><strong>${esc(p.name)}</strong>
        <div class="muted">${esc(p.description || "")}</div></td>
      <td>${p.enabled ? `<span class="pill on">On</span>` : `<span class="pill off">Not included</span>`}</td>
      <td>${p.enabled ? "" : requestForm(loc, p.key)}</td></tr>`).join("");
    cards.push(`<div class="card"><h2 style="margin-top:0">${esc(loc.name)}</h2>
      <div class="tscroll"><table class="stack"><thead><tr><th>Service</th><th>Status</th><th></th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div></div>`);
  }
  const body = `${orgRail(user, "services", cust ? cust.name : "My Portal")}<h1>Services</h1>
    <p class="muted">What your organization has with FlossByte, office by office. Only your organization's admins see this page. To change a service that is on, contact FlossByte.</p>
    ${cards.join("") || `<div class="card"><p class="muted">No offices yet.</p></div>`}`;
  const qp = new URL(request.url).searchParams;
  return page({ title: "Services", user, body, flash: qp.get("msg") || undefined, error: qp.get("err") || undefined });
}

// ---------- Team (customer_admin only) ----------
export async function teamPage(env, request, user) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const members = await orgMembers(env.DB, org);
  const rows = members.map((m) => {
    const isSelf = m.id === user.id;
    const action = m.status === "disabled"
      ? `<span class="muted">Removed</span>`
      : `<a class="btn small secondary" href="/app/team/${m.id}/edit">Edit</a>${isSelf ? "" : ` <a class="btn small danger" href="/app/team/${m.id}/remove">Remove</a>`}`;
    return `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td>
      <td>${m.role === "customer_admin" ? "Admin" : "User"}</td>
      <td>${esc(m.locations_label || "")}</td>
      <td><span class="pill ${m.status === "disabled" ? "off" : "on"}">${esc(m.status)}</span></td>
      <td>${action}</td></tr>`;
  }).join("");
  const body = `${orgRail(user, "team", cust ? cust.name : "My Portal")}<h1>Team</h1>
    <p class="muted">People with a login for ${esc(cust ? cust.name : "your organization")}. Use Edit to fix someone's name; an email address can't be changed once a login is created. Removing someone signs them out right away and takes away everything they could see here. Tickets and documents they created stay on record.</p>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Sees</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="muted">No logins yet.</td></tr>`}</tbody></table></div></div>`;
  const msg = new URL(request.url).searchParams.get("msg");
  return page({ title: "Team", user, body, flash: msg || undefined, error: new URL(request.url).searchParams.get("err") || undefined });
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
  if (!result.ok) return redirect("/app/team?err=" + encodeURIComponent(result.error));
  return redirect("/app/team?msg=" + encodeURIComponent(`${result.target.name} was removed.`));
}

export async function teamEditPage(env, request, user, targetId) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const members = await orgMembers(env.DB, org);
  const target = members.find((m) => m.id === Number(targetId));
  if (!target || target.status === "disabled") return denied(user, 404);
  const np = splitName(target.name);
  const body = `<div class="card narrow"><h1>Edit name</h1>
    <form method="post" action="/app/team/${target.id}/edit">
      <div class="row"><span style="flex:1"><label>First name <span class="req">*</span></label><input name="first_name" value="${esc(np.first)}" required></span>
      <span style="flex:1"><label>Middle name</label><input name="middle_name" value="${esc(np.middle)}"></span>
      <span style="flex:1"><label>Last name <span class="req">*</span></label><input name="last_name" value="${esc(np.last)}" required></span></div>
      <label>Email</label><input value="${esc(target.email)}" disabled>
      <p class="muted" style="margin:4px 0 0">The email is their login and can't be changed.</p>
      <p style="margin-top:16px"><button class="btn" type="submit">Save name</button>
      <a class="btn secondary" href="/app/team">Cancel</a></p>
    </form></div>`;
  return page({ title: "Edit name", user, body, error: new URL(request.url).searchParams.get("err") || undefined });
}

export async function teamEditPost(env, request, user, targetId) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const members = await orgMembers(env.DB, org);
  const target = members.find((m) => m.id === Number(targetId));
  if (!target || target.status === "disabled") return denied(user, 404);
  const f = await request.formData();
  const first = String(f.get("first_name") || "").trim();
  const middle = String(f.get("middle_name") || "").trim();
  const last = String(f.get("last_name") || "").trim();
  if (!first || !last) return redirect(`/app/team/${target.id}/edit?err=` + encodeURIComponent("First name and last name are required."));
  const name = joinName(first, middle, last);
  await env.DB.prepare("UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?").bind(name, target.id).run();
  await audit(env.DB, user.id, "user_update", "user", target.id, `client ${org}`);
  return redirect("/app/team?msg=" + encodeURIComponent(`${name}'s name is saved.`));
}

// ---------- Product status / locked page ----------
export async function productPage(env, request, user, locationId, productKey) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const prod = await env.DB.prepare("SELECT * FROM products WHERE key = ?").bind(productKey).first();
  if (!prod) return denied(user, 404);
  const on = await productEnabled(env.DB, loc.customer_id, locationId, productKey);
  if (!on) return lockedTile(user, loc, prod.name, prod.key);
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
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Equipment", "managed_it");
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
    const pill = exp && days <= 90 ? `<span class="pill warn">${esc(fmtDateUS(exp))}</span>` : esc(fmtDateUS(exp));
    const modelCell = e.name ? (e.model ? `${e.name} (${e.model})` : e.name) : (e.model || "");
    const statusPill = e.status === "online" ? `<span class="pill on">Online</span>`
      : e.status === "offline" ? `<span class="pill off">Offline</span>` : `<span class="pill">${esc(e.status)}</span>`;
    return `<tr><td>${esc(e.vendor || "")}</td><td>${esc(e.type || "")}</td><td>${esc(modelCell)}</td>
      <td>${esc(e.serial || "")}</td><td>${statusPill}</td><td>${esc(e.firmware || "")}</td><td>${pill}</td>${canEdit ? `<td><a href="/app/locations/${locationId}/equipment/${e.id}/edit">Edit</a></td>` : ""}</tr>`;
  }).join("");
  const addForm = canEdit ? `<div class="card"><h3>Add equipment</h3>
    <form method="post" action="/app/locations/${locationId}/equipment" class="row" style="align-items:end">
      <span style="flex:1;min-width:130px"><label>Vendor</label><input name="vendor" list="eq-vendors" placeholder="Sophos, UniFi, SonicWall">${datalist("eq-vendors", EQ_VENDORS)}</span>
      <span style="flex:1;min-width:110px"><label>Type</label><input name="type" list="eq-types" placeholder="Firewall">${datalist("eq-types", EQ_TYPES)}</span>
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
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Vendor</th><th>Type</th><th>Model</th><th>Serial</th><th>Status</th><th>Firmware</th><th>Next expiry</th>${canEdit ? "<th></th>" : ""}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${canEdit ? 8 : 7}" class="muted">No equipment recorded yet.</td></tr>`}</tbody></table></div></div>${addForm}`;
  return page({ title: "Equipment", user, body });
}

// ---------- Topology ----------
// The office network drawn as a tree from the equipment record: each
// row points at the device it hangs off of (parent_mac, filled by the
// UniFi sync), so the gateway sits at the top, switches and access
// points branch under it, and endpoints hang under those. Rows with no
// known parent (hand-entered gear, other vendors) list as roots.
export async function topologyPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Topology", "managed_it");
  let hasParent = false;
  try {
    const cols = await env.DB.prepare("PRAGMA table_info(equipment)").all();
    hasParent = (cols.results || []).some((c) => c.name === "parent_mac");
  } catch { hasParent = false; }
  if (!hasParent) {
    const body = `${locNav(loc, "topology")}<h1>Network topology</h1>
      <div class="card"><p style="margin:0">The topology view needs the latest portal database update before it can draw. Once that update is in, this page builds itself from the hourly sync, with no setup here.</p></div>`;
    return page({ title: "Topology", user, body });
  }
  const { results } = await env.DB.prepare("SELECT * FROM equipment WHERE location_id = ?").bind(locationId).all();
  const all = results || [];
  if (!all.length) {
    const body = `${locNav(loc, "topology")}<h1>Network topology</h1>
      <div class="card"><p class="muted" style="margin:0">No equipment recorded yet, so there is nothing to draw. Synced network gear appears here as a tree once it is on the <a href="/app/locations/${locationId}/equipment">Equipment</a> list.</p></div>`;
    return page({ title: "Topology", user, body });
  }
  const label = (e) => e.name ? (e.model ? `${e.name} (${e.model})` : e.name) : (e.model || e.type || "Equipment");
  const byMac = new Map();
  for (const e of all) if (e.mac) byMac.set(e.mac, e);
  const kids = new Map();
  const roots = [];
  for (const e of all) {
    const p = e.parent_mac && e.parent_mac !== e.mac ? byMac.get(e.parent_mac) : null;
    if (p) { if (!kids.has(p.id)) kids.set(p.id, []); kids.get(p.id).push(e); }
    else roots.push(e);
  }
  const rank = (e) => e.type === "Gateway" ? 0 : e.type === "Firewall" ? 1 : e.type === "Switch" ? 2
    : e.type === "Access point" ? 3 : e.type === "Controller" ? 4 : e.type === "Recorder" ? 5
    : e.source === "unifi-client" ? 8 : 6;
  const byRank = (a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b));
  roots.sort(byRank);
  for (const list of kids.values()) list.sort(byRank);
  const seen = new Set();
  const nodeHtml = (e, depth) => {
    if (seen.has(e.id) || depth > 8) return "";
    seen.add(e.id);
    const children = (kids.get(e.id) || []).map((c) => nodeHtml(c, depth + 1)).join("");
    return `<li><span class="topo-node${e.status === "offline" ? " off" : ""}${depth === 0 ? " root" : ""}"><span class="topo-dot"></span><span class="topo-name">${esc(label(e))}</span><span class="topo-meta">${esc(e.type || "")}</span></span>${children ? `<ul>${children}</ul>` : ""}</li>`;
  };
  let tree = roots.map((e) => nodeHtml(e, 0)).join("");
  const leftovers = all.filter((e) => !seen.has(e.id));
  if (leftovers.length) {
    tree += leftovers.map((e) => `<li><span class="topo-node${e.status === "offline" ? " off" : ""}"><span class="topo-dot"></span><span class="topo-name">${esc(label(e))}</span><span class="topo-meta">${esc(e.type || "")}</span></span></li>`).join("");
  }
  const online = all.filter((e) => e.status === "online").length;
  const body = `${locNav(loc, "topology")}<h1>Network topology</h1>
    <p class="muted" style="margin-top:0">${all.length} devices on record, ${online} online. Drawn from the equipment record and refreshed by the hourly sync. Gear behind a non-UniFi switch shows under the gateway, because UniFi cannot see through it.</p>
    <div class="card"><div class="topo"><ul>${tree}</ul></div></div>`;
  return page({ title: "Topology", user, body });
}

// The Network page renders the snapshots the UniFi sync stores per
// location (migration 0011): internet health from ISP metrics, the
// office's network/WiFi/firewall/VPN settings, per-device health, and
// Protect cameras where a console runs Protect. Everything shown is a
// read; the page itself changes nothing.
export async function networkPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Network", "managed_it");
  let hasTable = false;
  try {
    hasTable = !!(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'network_snapshots'").first());
  } catch { hasTable = false; }
  if (!hasTable) {
    const body = `${locNav(loc, "network")}<h1>Network</h1>
      <div class="card"><p style="margin:0">The Network page needs the latest portal database update before it can fill in. Once that update is in, this page builds itself from the hourly sync, with no setup here.</p></div>`;
    return page({ title: "Network", user, body });
  }
  const { results } = await env.DB.prepare(
    "SELECT kind, payload, captured_at FROM network_snapshots WHERE location_id = ?").bind(locationId).all();
  const snaps = {};
  let captured = "";
  for (const r of results || []) {
    try { snaps[r.kind] = JSON.parse(r.payload || "{}"); } catch { snaps[r.kind] = {}; }
    if (r.captured_at && r.captured_at > captured) captured = r.captured_at;
  }
  if (!Object.keys(snaps).length) {
    const body = `${locNav(loc, "network")}<h1>Network</h1>
      <div class="card"><p class="muted" style="margin:0">No network data captured yet. For UniFi offices, the hourly sync fills this page in: internet health, network and WiFi settings, firewall and VPN setup, device health, and cameras where UniFi Protect is running.</p></div>`;
    return page({ title: "Network", user, body });
  }
  const n0 = (v) => (typeof v === "number" && Number.isFinite(v)) ? Math.round(v).toLocaleString("en-US") : "—";
  const n1 = (v) => (typeof v === "number" && Number.isFinite(v)) ? v.toFixed(1) : "—";
  const pct = (v) => (typeof v === "number" && Number.isFinite(v)) ? `${Math.round(v)}%` : "—";
  const uptimeFmt = (sec) => {
    if (typeof sec !== "number" || !(sec > 0)) return "—";
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
  const onPill = (on) => on === false ? `<span class="pill off">Off</span>` : `<span class="pill on">On</span>`;
  const statePill = (s) => {
    const t = String(s || "");
    if (!t) return "";
    const bad = /off|down|disconn|fail/i.test(t), good = /on|up|connect|active|established/i.test(t);
    return ` <span class="pill${bad ? " off" : good ? " on" : ""}">${esc(t)}</span>`;
  };
  const table = (head, rows) => rows.length
    ? `<div class="tscroll"><table class="stack"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : "";
  const cards = [];
  const inet = snaps.internet || {};
  const isp = inet.isp || null;
  const wanRows = (inet.wans || []).map((w) => `<tr><td>${esc(w.name || "WAN")}</td><td>${esc(w.ipAddress || w.ip || "")}</td><td>${esc(w.type || "")}${statePill(w.state || w.status)}</td></tr>`);
  if (isp || wanRows.length) {
    const stats = isp ? `<div class="statgrid">
      <div class="stat"><b>${n0(isp.avgLatencyMs)} ms</b><span>Average latency</span></div>
      <div class="stat"><b>${n0(isp.maxLatencyMs)} ms</b><span>Peak latency</span></div>
      <div class="stat"><b>${n1(isp.packetLossPct)}%</b><span>Packet loss</span></div>
      <div class="stat"><b>${n1(isp.uptimePct)}%</b><span>Uptime, last ${isp.hours || 24} hours</span></div>
      <div class="stat"><b>${n1((isp.downtimeSec || 0) / 60)} min</b><span>Downtime, last ${isp.hours || 24} hours</span></div>
      <div class="stat"><b>${n1(isp.downMbps)} Mbps</b><span>Average download</span></div>
      <div class="stat"><b>${n1(isp.upMbps)} Mbps</b><span>Average upload</span></div>
    </div>` : "";
    cards.push(`<div class="card"><h2 style="margin-top:0">Internet</h2>
      ${isp && isp.ispName ? `<p class="muted" style="margin-top:0">Provider: ${esc(isp.ispName)}</p>` : ""}
      ${stats}${table(["Interface", "IP address", "Status"], wanRows)}</div>`);
  }
  const statRows = ((snaps.device_stats || {}).devices || []).map((d) => `<tr><td>${esc(d.name || d.mac || "Device")}</td><td>${uptimeFmt(d.uptimeSec)}</td><td>${pct(d.cpu)}</td><td>${pct(d.mem)}</td><td>${typeof d.load1 === "number" ? d.load1.toFixed(2) : "—"}</td></tr>`);
  if (statRows.length) cards.push(`<div class="card"><h2 style="margin-top:0">Device health</h2>${table(["Device", "Uptime", "CPU", "Memory", "Load"], statRows)}</div>`);
  const cfg = snaps.config || {};
  const netRows = (cfg.networks || []).map((n) => `<tr><td>${esc(n.name || "Network")}${n.default ? ` <span class="pill">Default</span>` : ""}</td><td>${n.vlanId != null ? "VLAN " + esc(String(n.vlanId)) : "—"}</td><td>${onPill(n.enabled)}</td></tr>`);
  const ssidRows = (cfg.ssids || []).map((s) => `<tr><td>${esc(s.name || s.ssid || "WiFi network")}</td><td>${esc(s.security || "—")}</td><td>${onPill(s.enabled)}</td></tr>`);
  if (netRows.length || ssidRows.length) {
    cards.push(`<div class="card"><h2 style="margin-top:0">Networks and WiFi</h2>
      ${netRows.length ? `<h3>Networks</h3>${table(["Name", "VLAN", "Status"], netRows)}` : ""}
      ${ssidRows.length ? `<h3>WiFi networks</h3>${table(["Name", "Security", "Status"], ssidRows)}` : ""}</div>`);
  }
  const polRows = (cfg.firewallPolicies || []).map((p) => `<tr><td>${esc(p.name || "Policy")}</td><td>${esc(p.action || "")}</td><td>${onPill(p.enabled)}</td></tr>`);
  const srvRows = (cfg.vpnServers || []).map((v) => `<tr><td>${esc(v.name || "VPN server")}</td><td>${esc(v.type || "")}</td><td>${onPill(v.enabled)}</td></tr>`);
  const tunRows = (cfg.vpnTunnels || []).map((v) => `<tr><td>${esc(v.name || "Tunnel")}</td><td>${esc(v.type || "")}${statePill(v.state || v.status)}</td><td>${onPill(v.enabled)}</td></tr>`);
  if (polRows.length || srvRows.length || tunRows.length || (cfg.firewallZones || []).length || (cfg.aclRules || []).length || (cfg.radiusProfiles || []).length) {
    cards.push(`<div class="card"><h2 style="margin-top:0">Firewall and VPN</h2>
      ${(cfg.firewallZones || []).length ? `<p style="margin-top:0">Zones: ${(cfg.firewallZones || []).map((z) => `<span class="pill">${esc(z.name || "Zone")}</span>`).join(" ")}</p>` : ""}
      ${polRows.length ? `<h3>Firewall policies</h3>${table(["Policy", "Action", "Status"], polRows)}` : ""}
      ${(cfg.aclRules || []).length ? `<p class="muted">${(cfg.aclRules || []).length} switch access rules in place.</p>` : ""}
      ${srvRows.length ? `<h3>VPN servers</h3>${table(["Server", "Type", "Status"], srvRows)}` : ""}
      ${tunRows.length ? `<h3>Site-to-site tunnels</h3>${table(["Tunnel", "Type", "Status"], tunRows)}` : ""}
      ${(cfg.radiusProfiles || []).length ? `<p class="muted">RADIUS profiles: ${(cfg.radiusProfiles || []).map((r) => esc(r.name || "")).filter(Boolean).join(", ")}</p>` : ""}</div>`);
  }
  const camRows = ((snaps.protect || {}).cameras || []).map((c) => `<tr><td>${esc(c.name || "Camera")}</td><td>${esc(c.model || "")}</td><td>${esc(c.state || c.status || "")}</td></tr>`);
  if (camRows.length) cards.push(`<div class="card"><h2 style="margin-top:0">Cameras</h2>${table(["Camera", "Model", "State"], camRows)}</div>`);
  const changeEvents = ((snaps.changes || {}).events || []).slice(0, 15);
  if (changeEvents.length) {
    cards.push(`<div class="card"><h2 style="margin-top:0">Recent changes</h2>${changeEvents.map((e) => `<p style="margin:4px 0"><span class="muted">${esc(fmtDateUS(String(e.at || "").slice(0, 10)))}</span> · ${esc(e.text || "")}</p>`).join("")}</div>`);
  }
  const capLine = captured ? `<p class="muted" style="margin-top:0">Captured ${esc(fmtDateUS(captured.slice(0, 10)))} at ${esc(captured.slice(11, 16))} UTC by the hourly sync. Read-only: nothing on this page can change the office's network.</p>` : "";
  const body = `${locNav(loc, "network")}<h1>Network</h1>${capLine}${cards.join("")}`;
  return page({ title: "Network", user, body });
}

export async function equipmentPost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Equipment", "managed_it");
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

const EQ_VENDORS = ["UniFi", "Sophos", "SonicWall", "Dell", "HP", "Lenovo", "Apple", "Cisco", "NETGEAR", "Microsoft", "Other"];
const EQ_TYPES = ["Firewall", "Switch", "Access point", "Gateway", "Controller", "Computer", "Server", "Printer", "Camera", "Phone system", "NAS", "Recorder", "Other"];
function datalist(id, values) {
  return `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}"></option>`).join("")}</datalist>`;
}

async function loadEquipment(env, user, locationId, equipmentId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return { error: denied(user, error) };
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return { error: lockedTile(user, loc, "Equipment", "managed_it") };
  const scope = await locationScope(env.DB, user, locationId);
  if (!(user.kind === "flossbyte" || scope === "admin")) return { error: denied(user, 403) };
  const row = await env.DB.prepare("SELECT * FROM equipment WHERE id = ? AND location_id = ?").bind(equipmentId, locationId).first();
  if (!row) return { error: denied(user, 404) };
  return { loc, row };
}

export async function equipmentEditPage(env, request, user, locationId, equipmentId) {
  const { loc, row, error } = await loadEquipment(env, user, locationId, equipmentId);
  if (error) return error;
  const synced = row.source && row.source !== "manual";
  const fields = synced
    ? `<p class="muted">This device syncs from ${row.source === "unifi" ? "UniFi" : row.source === "sophos" ? "Sophos" : "its vendor"} automatically, so its name, model, serial, and status update from the source. You can still set expiry dates and notes here.</p>
       <label>Vendor</label><input value="${esc(row.vendor || "")}" disabled>
       <label>Type</label><input value="${esc(row.type || "")}" disabled>
       <label>Model</label><input value="${esc(row.name ? (row.model ? row.name + " (" + row.model + ")" : row.name) : (row.model || ""))}" disabled>
       <label>Serial</label><input value="${esc(row.serial || "")}" disabled>`
    : `<label>Vendor</label><input name="vendor" list="eq-vendors" value="${esc(row.vendor || "")}">${datalist("eq-vendors", EQ_VENDORS)}
       <label>Type</label><input name="type" list="eq-types" value="${esc(row.type || "")}">${datalist("eq-types", EQ_TYPES)}
       <label>Name</label><input name="name" value="${esc(row.name || "")}">
       <label>Model</label><input name="model" value="${esc(row.model || "")}">
       <label>Serial</label><input name="serial" value="${esc(row.serial || "")}">
       <label>Status</label><select name="status">${["online", "offline", "unknown"].map((s) => `<option ${row.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
       <label>Firmware</label><input name="firmware" value="${esc(row.firmware || "")}">`;
  const body = `${locNav(loc, "equipment")}<p><a href="/app/locations/${locationId}/equipment">&larr; Equipment</a></p>
    <div class="card"><h2>Edit equipment</h2>
    <form method="post" action="/app/locations/${locationId}/equipment/${row.id}/edit">
      ${fields}
      <label>License expires</label><input name="license_expires" type="date" value="${esc(row.license_expires || "")}">
      <label>Warranty expires</label><input name="warranty_expires" type="date" value="${esc(row.warranty_expires || "")}">
      <label>Notes</label><textarea name="notes">${esc(row.notes || "")}</textarea>
      <p style="margin-top:16px"><button class="btn" type="submit">Save changes</button></p></form></div>
    ${synced ? "" : `<div class="card"><h3>Remove this equipment</h3>
      <p class="muted">For gear that was replaced or taken out of service. This deletes the record.</p>
      <form method="post" action="/app/locations/${locationId}/equipment/${row.id}/delete">
        <label style="font-weight:400"><input type="checkbox" name="confirm" value="yes" style="width:auto;margin-right:8px">Yes, delete this equipment record</label>
        <p style="margin-top:12px"><button class="btn danger" type="submit">Delete equipment</button></p></form></div>`}`;
  const q2 = new URL(request.url).searchParams;
  return page({ title: "Edit equipment", user, body, flash: q2.get("msg") || undefined, error: q2.get("err") || undefined });
}

export async function equipmentEditPost(env, request, user, locationId, equipmentId) {
  const { row, error } = await loadEquipment(env, user, locationId, equipmentId);
  if (error) return error;
  const f = await request.formData();
  const synced = row.source && row.source !== "manual";
  if (synced) {
    await env.DB.prepare("UPDATE equipment SET license_expires = ?, warranty_expires = ?, notes = ? WHERE id = ?")
      .bind(f.get("license_expires") || null, f.get("warranty_expires") || null, f.get("notes") || null, equipmentId).run();
  } else {
    await env.DB.prepare(`UPDATE equipment SET vendor = ?, type = ?, name = ?, model = ?, serial = ?, status = ?, firmware = ?,
      license_expires = ?, warranty_expires = ?, notes = ? WHERE id = ?`)
      .bind(f.get("vendor") || null, f.get("type") || null, f.get("name") || null, f.get("model") || null,
        f.get("serial") || null, String(f.get("status") || "online"), f.get("firmware") || null,
        f.get("license_expires") || null, f.get("warranty_expires") || null, f.get("notes") || null, equipmentId).run();
  }
  await audit(env.DB, user.id, "equipment_edit", "equipment", Number(equipmentId), row.model || row.name || "");
  return redirect(`/app/locations/${locationId}/equipment`);
}

export async function equipmentDeletePost(env, request, user, locationId, equipmentId) {
  const { row, error } = await loadEquipment(env, user, locationId, equipmentId);
  if (error) return error;
  if (row.source && row.source !== "manual") return redirect(`/app/locations/${locationId}/equipment`);
  const f = await request.formData();
  if (String(f.get("confirm") || "") !== "yes") return redirect(`/app/locations/${locationId}/equipment/${equipmentId}/edit?err=` + encodeURIComponent("Tick the confirmation box to delete this equipment."));
  await env.DB.prepare("DELETE FROM equipment WHERE id = ?").bind(equipmentId).run();
  await audit(env.DB, user.id, "equipment_delete", "equipment", Number(equipmentId), row.model || row.name || "");
  return redirect(`/app/locations/${locationId}/equipment`);
}

// ---------- Tickets ----------
const STATUS_LABEL = { open: "Open", in_progress: "In progress", waiting: "Waiting", closed: "Closed" };

export async function ticketsPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Tickets", "managed_it");
  const { results } = await env.DB.prepare(
    "SELECT * FROM tickets WHERE location_id = ? ORDER BY (status = 'closed'), updated_at DESC").bind(locationId).all();
  const rows = (results || []).map((t) => `<tr><td><a href="/app/locations/${locationId}/tickets/${t.id}">${esc(t.title)}</a></td>
    <td><span class="pill">${esc(STATUS_LABEL[t.status] || t.status)}</span></td><td>${esc(t.priority)}</td><td>${esc(fmtDateUS(t.created_at))}</td></tr>`).join("");
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
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Tickets", "managed_it");
  const f = await request.formData();
  const res = await env.DB.prepare(
    "INSERT INTO tickets (location_id, title, priority, created_by) VALUES (?, ?, ?, ?)")
    .bind(locationId, String(f.get("title") || "Support request"), String(f.get("priority") || "normal"), user.id).run();
  const tid = res.meta.last_row_id;
  const detail = String(f.get("body") || "").trim();
  if (detail) await env.DB.prepare("INSERT INTO ticket_updates (ticket_id, author_id, body) VALUES (?, ?, ?)").bind(tid, user.id, detail).run();
  await audit(env.DB, user.id, "ticket_create", "ticket", tid, null);
  if (user.kind === "customer") {
    const mail = ticketCreatedNoticeEmail(env, {
      customerName: loc.customer_name, locationName: loc.name,
      title: String(f.get("title") || "Support request"), priority: String(f.get("priority") || "normal"),
      authorName: user.name, link: `${orgOrigin(env)}/app/locations/${locationId}/tickets/${tid}`,
    });
    await alertFlossByte(env, "ticket_created", mail);
  }
  return redirect(`/app/locations/${locationId}/tickets/${tid}`);
}

export async function ticketDetailPage(env, request, user, locationId, ticketId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Tickets", "managed_it");
  const t = await env.DB.prepare("SELECT * FROM tickets WHERE id = ? AND location_id = ?").bind(ticketId, locationId).first();
  if (!t) return denied(user, 404);
  const { results } = await env.DB.prepare(
    `SELECT tu.*, u.name AS author_name FROM ticket_updates tu LEFT JOIN users u ON u.id = tu.author_id
     WHERE tu.ticket_id = ? ORDER BY tu.created_at`).bind(ticketId).all();
  const thread = (results || []).map((u) => `<div style="border-bottom:1px solid var(--line);padding:10px 0">
    <div class="muted">${esc(u.author_name || "User")} · ${esc(fmtDateUS(u.created_at))} ${esc(u.created_at.slice(11, 16))}</div><p style="margin:4px 0">${esc(u.body)}</p></div>`).join("");
  const scope = await locationScope(env.DB, user, locationId);
  const canManage = user.kind === "flossbyte" || scope === "admin";
  const manage = canManage ? `<form method="post" action="/app/locations/${locationId}/tickets/${ticketId}/status" class="row" style="margin-top:14px">
      <span style="min-width:170px"><select name="status">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${t.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></span>
      <span style="min-width:140px"><select name="priority">${["low", "normal", "high", "urgent"].map((p) => `<option ${t.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select></span>
      <button class="btn small secondary" type="submit">Update status</button></form>` : "";
  const body = `${locNav(loc, "tickets")}<h1>${esc(t.title)}</h1>
    <p><span class="pill">${esc(STATUS_LABEL[t.status] || t.status)}</span> <span class="muted">Priority: ${esc(t.priority)} · opened ${esc(fmtDateUS(t.created_at))}</span></p>
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
  const t = await env.DB.prepare("SELECT * FROM tickets WHERE id = ? AND location_id = ?").bind(ticketId, locationId).first();
  if (!t) return denied(user, 404);
  const f = await request.formData();
  const bodyText = String(f.get("body") || "").trim();
  if (bodyText) {
    await env.DB.prepare("INSERT INTO ticket_updates (ticket_id, author_id, body) VALUES (?, ?, ?)").bind(ticketId, user.id, bodyText).run();
    await env.DB.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").bind(ticketId).run();
    const link = `${orgOrigin(env)}/app/locations/${locationId}/tickets/${ticketId}`;
    if (user.kind === "customer") {
      const mail = ticketReplyNoticeEmail(env, {
        heading: "A customer replied to a ticket", customerName: loc.customer_name, locationName: loc.name,
        title: t.title, authorName: user.name, link, toCustomer: false,
      });
      await alertFlossByte(env, "ticket_reply", mail);
    } else if (user.kind === "flossbyte" && t.created_by && t.created_by !== user.id) {
      const creator = await env.DB.prepare("SELECT email, kind FROM users WHERE id = ?").bind(t.created_by).first();
      if (creator && creator.kind === "customer") {
        const mail = ticketReplyNoticeEmail(env, {
          heading: "FlossByte replied to your ticket", customerName: loc.customer_name, locationName: loc.name,
          title: t.title, authorName: user.name, link, toCustomer: true,
        });
        try { await sendEmail(env, { to: creator.email, template: "ticket_reply_customer", ...mail }); } catch (e) { /* never block */ }
      }
    }
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
    <td>${esc(d.uploader || "")}</td><td>${esc(fmtDateUS(d.created_at))}</td></tr>`).join("");
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
  if (!doc) return denied(user, 404);
  if (!(await canAccessLocation(env.DB, user, doc.location_id))) return denied(user, 403);
  if (!doc.r2_key || !env.DOCS) return denied(user, 404);
  const obj = await env.DOCS.get(doc.r2_key);
  if (!obj) return denied(user, 404);
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
      parts.push("Expiring in the next 90 days:\n" + items.map((e) =>
        `• ${e.vendor || ""} ${e.model || e.type || "equipment"} (license ${e.license_expires ? fmtDateUS(e.license_expires) : "n/a"}, warranty ${e.warranty_expires ? fmtDateUS(e.warranty_expires) : "n/a"})`).join("\n"));
    } else parts.push("Nothing on record expires in the next 90 days.");
  }
  // Network snapshots (UniFi): internet health, settings, device
  // health, cameras and the change history. Skipped silently when no
  // snapshot has been captured for this location yet.
  let snaps = null;
  try {
    const { results: srows } = await db.prepare("SELECT kind, payload FROM network_snapshots WHERE location_id = ?").bind(locationId).all();
    if (srows && srows.length) {
      snaps = {};
      for (const r of srows) { try { snaps[r.kind] = JSON.parse(r.payload || "{}"); } catch { snaps[r.kind] = {}; } }
    }
  } catch { snaps = null; }
  if (snaps) {
    const inet = snaps.internet || {};
    if (/internet|isp|latency|packet loss|downtime|broadband|provider/.test(q) && (inet.isp || (inet.wans || []).length)) {
      const lines = [];
      if (inet.isp) {
        const i = inet.isp;
        lines.push(`• Provider: ${i.ispName || "not recorded"}`);
        if (i.uptimePct != null) lines.push(`• Uptime over the last ${i.hours || 24} hours: ${Number(i.uptimePct).toFixed(1)}% (downtime ${Math.round((i.downtimeSec || 0) / 60)} min)`);
        if (i.avgLatencyMs != null) lines.push(`• Latency: ${Math.round(i.avgLatencyMs)} ms average, ${Math.round(i.maxLatencyMs || 0)} ms peak`);
        if (i.downMbps != null) lines.push(`• Speed: ${Number(i.downMbps).toFixed(1)} Mbps down, ${Number(i.upMbps || 0).toFixed(1)} Mbps up on average`);
      }
      for (const w of inet.wans || []) lines.push(`• ${w.name || "WAN"}: ${w.ipAddress || w.ip || "no IP recorded"}${w.state || w.status ? ` (${w.state || w.status})` : ""}`);
      if (lines.length) parts.push("Internet:\n" + lines.join("\n"));
    }
    const cfg = snaps.config || {};
    if (/wi-?fi|ssid|wireless/.test(q) && (cfg.ssids || []).length) {
      parts.push("WiFi networks:\n" + cfg.ssids.map((s) => `• ${s.name || s.ssid} (${s.security || "security not recorded"}, ${s.enabled === false ? "off" : "on"})`).join("\n"));
    }
    if (/vpn|tunnel/.test(q) && ((cfg.vpnTunnels || []).length || (cfg.vpnServers || []).length)) {
      const lines = [
        ...(cfg.vpnTunnels || []).map((t) => `• Tunnel ${t.name} (${t.type || ""}${t.state || t.status ? `, ${t.state || t.status}` : ""})`),
        ...(cfg.vpnServers || []).map((v) => `• Server ${v.name} (${v.type || ""}, ${v.enabled === false ? "off" : "on"})`),
      ];
      parts.push("VPN:\n" + lines.join("\n"));
    }
    if (/firewall|vlan/.test(q) && ((cfg.networks || []).length || (cfg.firewallPolicies || []).length)) {
      const lines = [
        ...(cfg.networks || []).map((n) => `• Network ${n.name}${n.vlanId != null ? ` (VLAN ${n.vlanId})` : ""}, ${n.enabled === false ? "off" : "on"}`),
        ...(cfg.firewallPolicies || []).map((p) => `• Policy ${p.name} (${p.action || ""}, ${p.enabled === false ? "off" : "on"})`),
      ];
      if (lines.length) parts.push("Networks and firewall:\n" + lines.join("\n"));
    }
    if (/camera|protect/.test(q) && ((snaps.protect || {}).cameras || []).length) {
      parts.push("Cameras:\n" + snaps.protect.cameras.map((c) => `• ${c.name} (${c.model || ""}, ${c.state || c.status || ""})`).join("\n"));
    }
    if (/changed|changes|recently|last week/.test(q) && ((snaps.changes || {}).events || []).length) {
      parts.push("Recent changes:\n" + snaps.changes.events.slice(0, 8).map((e) => `• ${String(e.at || "").slice(0, 10)}: ${e.text}`).join("\n"));
    }
    if (/device health|cpu|memory|health of/.test(q) && ((snaps.device_stats || {}).devices || []).length) {
      parts.push("Device health:\n" + snaps.device_stats.devices.slice(0, 10).map((d) => `• ${d.name || d.mac}: CPU ${d.cpu != null ? Math.round(d.cpu) + "%" : "n/a"}, memory ${d.mem != null ? Math.round(d.mem) + "%" : "n/a"}`).join("\n"));
    }
  }
  // "What is X connected to?" answered from the topology parents.
  if (/connected to|plugged into|uplink/.test(q)) {
    try {
      const cols = await db.prepare("PRAGMA table_info(equipment)").all();
      if ((cols.results || []).some((c) => c.name === "parent_mac")) {
        const { results: alleq } = await db.prepare("SELECT name, type, mac, parent_mac FROM equipment WHERE location_id = ? AND mac IS NOT NULL").bind(locationId).all();
        const byMac = new Map((alleq || []).map((e) => [e.mac, e]));
        const qwords = tokenize(question);
        const hits = (alleq || []).filter((e) => e.parent_mac && qwords.some((w) => String(e.name || "").toLowerCase().includes(w)));
        if (hits.length) {
          parts.push("Connections:\n" + hits.slice(0, 6).map((e) => {
            const p = byMac.get(e.parent_mac);
            return `• ${e.name} connects through ${p ? (p.name || p.type || "a network device") : "the gateway"}`;
          }).join("\n"));
        }
      }
    } catch { /* topology parents not available yet */ }
  }
  const words = tokenize(question);
  if (words.length) {
    const like = words.map(() => "(vendor LIKE ? OR type LIKE ? OR model LIKE ? OR serial LIKE ? OR status LIKE ? OR notes LIKE ?)").join(" OR ");
    const binds = [locationId];
    for (const w of words) { const l = `%${w}%`; binds.push(l, l, l, l, l, l); }
    const { results: eq } = await db.prepare(`SELECT * FROM equipment WHERE location_id = ? AND (${like}) LIMIT 8`).bind(...binds).all();
    if (eq && eq.length) {
      parts.push("Equipment on record:\n" + eq.map((e) =>
        `• ${e.vendor || ""} ${e.model || e.type || ""} (serial ${e.serial || "n/a"}, status ${e.status}, firmware ${e.firmware || "n/a"})`).join("\n"));
    }
    const tLike = words.map(() => "title LIKE ?").join(" OR ");
    const tBinds = [locationId, ...words.map((w) => `%${w}%`)];
    const { results: tk } = await db.prepare(`SELECT * FROM tickets WHERE location_id = ? AND (${tLike}) LIMIT 5`).bind(...tBinds).all();
    if (tk && tk.length) {
      parts.push("Tickets on record:\n" + tk.map((t) => `• "${t.title}" (${STATUS_LABEL[t.status] || t.status}, ${t.priority})`).join("\n"));
    }
    const dLike = words.map(() => "name LIKE ?").join(" OR ");
    const dBinds = [locationId, ...words.map((w) => `%${w}%`)];
    const { results: dc } = await db.prepare(`SELECT * FROM documents WHERE location_id = ? AND (${dLike}) LIMIT 5`).bind(...dBinds).all();
    if (dc && dc.length) {
      parts.push("Documents on record: " + dc.map((d) => d.name).join(", ") + ".");
    }
  }
  if (!parts.length) {
    return "That is not in your portal records yet, so I cannot answer it from your data. Ask about equipment, license or warranty expiry dates, your internet, WiFi, VPN, cameras, recent network changes, tickets, or documents, or open a ticket and we will look into it.";
  }
  return parts.join("\n") + "\n(Answered from your own portal records only.)";
}

export async function askPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const { results } = await env.DB.prepare(
    "SELECT * FROM ask_messages WHERE location_id = ? ORDER BY created_at DESC LIMIT 10").bind(locationId).all();
  const history = (results || []).reverse().map((m) => `<div class="msg q">${esc(m.question)}</div>
    <div class="msg a">${esc(m.answer)}</div>`).join("");
  const body = `${locNav(loc, "ask")}<h1>Ask</h1>
    <div class="card"><p class="muted">Ask about your own equipment, expiry dates, internet, WiFi, VPN, cameras, recent network changes, tickets, and documents. Answers come only from what is recorded for this practice.</p>
    <form method="post" action="/app/locations/${locationId}/ask">
      <input name="question" placeholder="What is expiring in the next 90 days?" required>
      <p style="margin-top:12px"><button class="btn" type="submit">Ask</button></p></form>
    ${history ? `<div class="chat">${history}</div>` : ""}</div>`;
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

async function quotesSection(env, org) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM quotes WHERE customer_id = ? AND status IN ('sent','accepted','declined') ORDER BY updated_at DESC").bind(org).all();
  const rows = [];
  for (const qt of results || []) {
    const { total } = await loadQuote(env.DB, qt.id, org);
    rows.push(`<tr><td><a href="/app/quotes/${qt.id}">${esc(qt.title)}</a></td>
      <td>${qt.kind === "plan" ? "Service plan" : "Project"}</td><td class="num">${fmtMoney(total)}</td>
      <td><span class="pill ${qt.status === "accepted" ? "on" : qt.status === "declined" ? "off" : ""}">${esc(QUOTE_STATUS[qt.status] || qt.status)}</span></td>
      <td>${esc(fmtDateUS((qt.sent_at || qt.created_at || "")))}</td></tr>`);
  }
  return `
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Quote</th><th>Type</th><th class="num">Total</th><th>Status</th><th>Sent</th></tr></thead>
    <tbody>${rows.join("") || `<tr><td colspan="5" class="muted">No quotes yet. When FlossByte sends you one, it shows up here for review and acceptance.</td></tr>`}</tbody></table></div></div>`;
}

export async function quoteViewPage(env, request, user, quoteId) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  const loaded = await loadQuote(env.DB, quoteId, org);
  if (!loaded || loaded.quote.status === "draft") return denied(user, 404);
  const { quote, items, total } = loaded;
  const deposit = Math.round(total * (quote.deposit_percent || 0) / 100);
  const itemRows = items.map((i) => `<tr><td>${esc(i.description)}</td><td class="num">${esc(String(i.qty))}</td>
    <td class="num">${fmtMoney(i.unit_price_cents)}</td><td class="num">${fmtMoney(Math.round(i.qty * i.unit_price_cents))}</td></tr>`).join("");
  let statusBlock = "";
  if (quote.status === "accepted") {
    statusBlock = `<div class="notice"><strong>Accepted</strong> by ${esc(quote.accepted_by || "")} on ${esc(fmtDateUS((quote.accepted_at || "")))}.
      ${deposit > 0 ? `The deposit invoice is on your <a href="/app/billing">Billing</a> page.` : ""}</div>`;
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
    statusBlock = `<div class="card"><p class="muted">This quote is waiting for your practice's admin to review and accept it.</p></div>`;
  }
  const body = `${orgRail(user, "billing", "My Portal")}<p><a href="/app/billing">&larr; Billing</a></p><h1>${esc(quote.title)}</h1>
    <p class="muted">${quote.kind === "plan" ? "Service plan" : "Project"} quote from FlossByte. Total <strong>${fmtMoney(total)}</strong>${deposit > 0 ? `, with a ${quote.deposit_percent}% deposit of <strong>${fmtMoney(deposit)}</strong> due on acceptance and ${fmtMoney(total - deposit)} after that.` : "."}</p>
    <p><button class="btn small secondary" type="button" onclick="window.print()">Print / save as PDF</button></p>
    ${statusBlock}
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
    <tbody>${itemRows}</tbody></table></div></div>
    ${quote.terms ? `<div class="card"><h3>Terms</h3><div style="white-space:pre-wrap">${esc(quote.terms)}</div></div>` : ""}`;
  const msg = new URL(request.url).searchParams.get("msg");
  return page({ title: quote.title, user, body, flash: msg || undefined, error: new URL(request.url).searchParams.get("err") || undefined });
}

export async function quoteAcceptPost(env, request, user, quoteId) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  if (user.role !== "customer_admin") return denied(user, 403);
  const loaded = await loadQuote(env.DB, quoteId, org);
  if (!loaded || loaded.quote.status !== "sent") return redirect("/app/billing");
  const f = await request.formData();
  const signer = String(f.get("signer_name") || "").trim();
  if (String(f.get("agree") || "") !== "yes" || !signer) {
    return redirect(`/app/quotes/${quoteId}?err=` + encodeURIComponent("Type your full name and check the agreement box to accept."));
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
    invoiceNote = " The deposit invoice is on your Billing page; work is scheduled once it is paid.";
  }
  await audit(env.DB, user.id, "quote_accept", "quote", quoteId, `signed by ${signer}`);
  {
    const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
    const mail = quoteAcceptedNoticeEmail(env, {
      customerName: cust ? cust.name : "A customer", quoteTitle: quote.title, acceptedBy: signer, total: fmtMoney(total),
    });
    await alertFlossByte(env, "quote_accepted", mail);
  }
  return redirect(`/app/quotes/${quoteId}?msg=` + encodeURIComponent("Quote accepted. Thank you." + invoiceNote));
}

export async function quoteDeclinePost(env, request, user, quoteId) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  if (user.role !== "customer_admin") return denied(user, 403);
  const loaded = await loadQuote(env.DB, quoteId, org);
  if (!loaded || loaded.quote.status !== "sent") return redirect("/app/billing");
  await env.DB.prepare(
    "UPDATE quotes SET status = 'declined', updated_at = datetime('now') WHERE id = ?").bind(quoteId).run();
  await audit(env.DB, user.id, "quote_decline", "quote", quoteId, null);
  return redirect("/app/billing?msg=" + encodeURIComponent("Quote declined."));
}

async function invoicesSection(env, org) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM invoices WHERE customer_id = ? AND status != 'void' ORDER BY created_at DESC").bind(org).all();
  const rows = (results || []).map((inv) => {
    const pay = inv.status === "unpaid" && inv.pay_url
      ? `<a class="btn small" href="${esc(inv.pay_url)}" target="_blank" rel="noopener">Pay</a>`
      : inv.status === "unpaid" ? `<span class="muted">FlossByte will email a payment link.</span>` : "";
    const note = inv.kind === "deposit"
      ? (inv.status === "unpaid" ? `<div class="muted">Work is scheduled once this deposit is paid.</div>` : `<div class="muted">Deposit received.</div>`) : "";
    return `<tr><td><a href="/app/invoices/${inv.id}">INV-${1000 + inv.id}</a></td><td>${esc(inv.title)}${note}</td>
      <td>${esc(INVOICE_KIND[inv.kind] || "Invoice")}</td><td class="num">${fmtMoney(inv.amount_cents)}</td>
      <td><span class="pill ${inv.status === "paid" ? "on" : ""}">${inv.status === "paid" ? "Paid" : "Unpaid"}</span>${inv.status === "paid" && inv.paid_at ? `<div class="muted">${esc(fmtDateUS(inv.paid_at))}</div>` : ""}</td>
      <td>${esc(fmtDateUS(inv.due_date))}</td><td>${pay}</td></tr>`;
  }).join("");
  return `
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Number</th><th>Invoice</th><th>Type</th><th class="num">Amount</th><th>Status</th><th>Due</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="muted">No invoices yet.</td></tr>`}</tbody></table></div></div>`;
}

export async function invoiceViewPage(env, request, user, invoiceId) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE id = ? AND customer_id = ?").bind(invoiceId, org).first();
  if (!inv) return denied(user, 404);
  const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const pay = inv.status === "unpaid" && inv.pay_url
    ? `<p style="margin-top:16px"><a class="btn" href="${esc(inv.pay_url)}" target="_blank" rel="noopener">Pay ${fmtMoney(inv.amount_cents)}</a></p>`
    : inv.status === "unpaid" ? `<p class="muted" style="margin-top:16px">FlossByte will email a payment link for this invoice. Questions: call (669) 237-2264.</p>` : "";
  const body = `${orgRail(user, "billing", cust ? cust.name : "My Portal")}<p><a href="/app/billing">&larr; Billing</a></p>
    <h1>INV-${1000 + inv.id}</h1>
    <p class="muted">${esc(inv.title)}</p>
    <p><button class="btn small secondary" type="button" onclick="window.print()">Print / save as PDF</button></p>
    <div class="card"><div class="tscroll"><table>
      <tbody>
      <tr><td class="muted">Billed to</td><td>${esc(cust ? cust.name : "")}</td></tr>
      <tr><td class="muted">Type</td><td>${esc(INVOICE_KIND[inv.kind] || "Invoice")}</td></tr>
      <tr><td class="muted">Amount</td><td><strong>${fmtMoney(inv.amount_cents)}</strong></td></tr>
      <tr><td class="muted">Status</td><td><span class="pill ${inv.status === "paid" ? "on" : ""}">${inv.status === "paid" ? "Paid" : inv.status === "void" ? "Void" : "Unpaid"}</span>${inv.status === "paid" && inv.paid_at ? ` ${esc(fmtDateUS(inv.paid_at))}${inv.paid_method ? " by " + esc(inv.paid_method) : ""}` : ""}</td></tr>
      ${inv.due_date ? `<tr><td class="muted">Due</td><td>${esc(fmtDateUS(inv.due_date))}</td></tr>` : ""}
      </tbody></table></div>${pay}</div>`;
  return page({ title: `INV-${1000 + inv.id}`, user, body });
}

export async function billingPage(env, request, user) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const quotesHtml = await quotesSection(env, org);
  const invoicesHtml = await invoicesSection(env, org);
  const body = `${orgRail(user, "billing", cust ? cust.name : "My Portal")}<h1>Billing</h1>
    <h2>Quotes</h2>${quotesHtml}
    <h2 style="margin-top:26px">Invoices</h2>${invoicesHtml}`;
  const msg = new URL(request.url).searchParams.get("msg");
  return page({ title: "Billing", user, body, flash: msg || undefined, error: new URL(request.url).searchParams.get("err") || undefined });
}
