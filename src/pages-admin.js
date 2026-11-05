// FlossByte admin console: clients, locations, product switches, logins,
// pending signups, and (Super Admin only) admin account management.
import { page, redirect, esc } from "./layout.js";
import { createAuthToken, revokeAllSessions, verifyPassword } from "./auth.js";
import { audit, isSuperAdmin, grantUserAccess, findCustomerByContactEmail } from "./access.js";
import { sendEmail, inviteEmail, newCustomerNoticeEmail, ownershipTransferEmail } from "./email.js";

function origin(env) { return env.APP_ORIGIN || "https://portal.flossbyte.com"; }
function q(request) { return new URL(request.url).searchParams; }

function adminNav(active) {
  const link = (key, href, label) =>
    `<a href="${href}" ${active === key ? 'style="color:#0A1628;font-weight:700"' : ""}>${label}</a>`;
  return `<nav class="row" style="gap:18px;margin-bottom:18px">
    ${link("clients", "/admin", "Clients")}${link("new", "/admin/customers/new", "Add customer")}
    ${link("pending", "/admin/pending", "Pending accounts")}${link("admins", "/admin/admins", "Admins")}</nav>`;
}

// ---------- Clients list ----------
export async function clientsPage(env, request, user) {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT c.*,
      (SELECT COUNT(*) FROM locations WHERE customer_id = c.id) AS locations,
      (SELECT COUNT(*) FROM user_access WHERE customer_id = c.id) AS logins,
      (SELECT COUNT(*) FROM equipment e JOIN locations l ON l.id = e.location_id WHERE l.customer_id = c.id) AS equipment,
      (SELECT COUNT(*) FROM tickets t JOIN locations l ON l.id = t.location_id WHERE l.customer_id = c.id AND t.status != 'closed') AS open_tickets
     FROM customers c ORDER BY c.name`).all();
  const pending = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").first();
  const cards = [];
  for (const c of results || []) {
    const exp = await db.prepare(
      `SELECT COUNT(*) AS n FROM equipment e JOIN locations l ON l.id = e.location_id
       WHERE l.customer_id = ? AND (date(e.license_expires) <= date('now', '+90 days') OR date(e.warranty_expires) <= date('now', '+90 days'))`)
      .bind(c.id).first();
    const { results: prods } = await db.prepare(
      `SELECT p.key, p.name, COALESCE(cp.enabled, CASE WHEN p.key = 'managed_it' THEN 1 ELSE 0 END) AS enabled
       FROM products p LEFT JOIN customer_products cp ON cp.product = p.key AND cp.customer_id = ? AND cp.location_id IS NULL
       ORDER BY p.key`).bind(c.id).all();
    const prodPills = (prods || []).map((p) => `<span class="pill ${p.enabled ? "on" : "off"}">${esc(p.name)} ${p.enabled ? "on" : "off"}</span>`).join(" ");
    cards.push(`<div class="card"><div class="row between"><h3 style="margin:0">${esc(c.name)}</h3>
      <a class="btn small" href="/admin/customers/${c.id}">Manage</a></div>
      <p class="muted">${c.locations} location(s) , ${c.logins} login(s) , ${c.equipment} equipment , ${c.open_tickets} open ticket(s) , ${exp.n} expiring in 90 days</p>
      <p>${prodPills}</p></div>`);
  }
  const body = `${adminNav("clients")}<h1>Clients</h1>
    ${pending && pending.n ? `<div class="notice"><strong>${pending.n} account(s)</strong> waiting to be connected. See Pending accounts.</div>` : ""}
    ${cards.join("") || `<div class="card"><p class="muted">No customers yet. Add the first one.</p></div>`}`;
  return page({ title: "Clients", user, body, flash: q(request).get("msg") || undefined });
}

// ---------- Create customer ----------
export function newCustomerPage(env, request, user) {
  const body = `${adminNav("new")}<div class="card narrow" style="margin:0"><h1>Add customer</h1>
    <form method="post" action="/admin/customers">
      <label>Customer / organization name</label><input name="name" required>
      <label>Main contact name</label><input name="contact_name">
      <label>Main contact email</label><input name="contact_email" type="email">
      <label>Phone</label><input name="phone">
      <label>First location name</label><input name="location_name" placeholder="Main office">
      <label>Notes</label><textarea name="notes"></textarea>
      <p style="margin-top:16px"><button class="btn" type="submit">Add customer</button></p></form></div>`;
  return page({ title: "Add customer", user, body, flash: q(request).get("msg") || undefined });
}

export async function createCustomerPost(env, request, user) {
  const f = await request.formData();
  const name = String(f.get("name") || "").trim();
  if (!name) return redirect("/admin/customers/new");
  // Identity rule: a contact email belongs to exactly one customer. A
  // match refuses creation outright (no "create anyway"). The name may
  // repeat freely and is never checked.
  const contactEmail = String(f.get("contact_email") || "").trim();
  const dup = await findCustomerByContactEmail(env.DB, contactEmail);
  if (dup) {
    return redirect("/admin/customers/new?msg=" + encodeURIComponent(
      `A customer with this contact email already exists. It matches ${dup.name} (customer ${dup.id}).`));
  }
  const res = await env.DB.prepare(
    "INSERT INTO customers (name, contact_name, contact_email, phone, notes) VALUES (?, ?, ?, ?, ?)")
    .bind(name, f.get("contact_name") || null, contactEmail || null, f.get("phone") || null, f.get("notes") || null).run();
  const customerId = res.meta.last_row_id;
  const locName = String(f.get("location_name") || "").trim();
  if (locName) {
    await env.DB.prepare("INSERT INTO locations (customer_id, name) VALUES (?, ?)").bind(customerId, locName).run();
  }
  await audit(env.DB, user.id, "customer_create", "customer", customerId, name);
  if (env.ADMIN_ALERT_EMAIL) {
    const mail = newCustomerNoticeEmail(env, { customerName: name, createdBy: user.name });
    await sendEmail(env, { to: env.ADMIN_ALERT_EMAIL, template: "admin_new_customer", ...mail });
  }
  return redirect(`/admin/customers/${customerId}?msg=` + encodeURIComponent("Customer added."));
}

// ---------- Customer detail ----------
export async function customerPage(env, request, user, customerId) {
  const db = env.DB;
  const c = await db.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  if (!c) return page({ title: "Not found", user, body: `<div class="card narrow"><h1>Not found</h1></div>` });
  const { results: locations } = await db.prepare("SELECT * FROM locations WHERE customer_id = ? ORDER BY name").bind(customerId).all();
  const { results: products } = await db.prepare(
    `SELECT p.key, p.name, p.description, cp.enabled, cp.plan_note FROM products p
     LEFT JOIN customer_products cp ON cp.product = p.key AND cp.customer_id = ? AND cp.location_id IS NULL ORDER BY p.key`)
    .bind(customerId).all();
  const { results: members } = await db.prepare(
    `SELECT DISTINCT u.id, u.name, u.email, u.status, u.role FROM user_access ua JOIN users u ON u.id = ua.user_id
     WHERE ua.customer_id = ? ORDER BY u.name`).bind(customerId).all();
  const locRows = (locations || []).map((l) => `<tr><td><a href="/app/locations/${l.id}">${esc(l.name)}</a></td>
    <td>${esc([l.city, l.state].filter(Boolean).join(", "))}</td><td>${esc(l.status)}</td>
    <td><form method="post" action="/admin/locations/${l.id}/edit" class="row">
      <input name="name" value="${esc(l.name)}" style="max-width:180px">
      <input name="city" value="${esc(l.city || "")}" placeholder="City" style="max-width:130px">
      <input name="state" value="${esc(l.state || "")}" placeholder="State" style="max-width:70px">
      <button class="btn small secondary" type="submit">Save</button></form></td></tr>`).join("");
  const prodRows = (products || []).map((p) => {
    const enabled = p.enabled === null || p.enabled === undefined ? (p.key === "managed_it" ? 1 : 0) : p.enabled;
    return `<tr><td><strong>${esc(p.name)}</strong><div class="muted">${esc(p.description || "")}</div></td>
      <td><span class="pill ${enabled ? "on" : "off"}">${enabled ? "On" : "Off"}</span></td>
      <td><form method="post" action="/admin/customers/${customerId}/products" class="row">
        <input type="hidden" name="product" value="${esc(p.key)}">
        <input name="plan_note" value="${esc(p.plan_note || "")}" placeholder="Plan note" style="max-width:220px">
        <button class="btn small ${enabled ? "danger" : ""}" name="enabled" value="${enabled ? "0" : "1"}" type="submit">${enabled ? "Turn off" : "Turn on"}</button></form></td></tr>`;
  }).join("");
  const memberRows = (members || []).map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td>
    <td>${esc(m.role)}</td><td><span class="pill">${esc(m.status)}</span></td></tr>`).join("");
  const locOptions = (locations || []).map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("");
  const body = `${adminNav("")}<h1>${esc(c.name)}</h1>
    <p class="muted">${esc(c.contact_name || "")} ${esc(c.contact_email || "")} ${esc(c.phone || "")}</p>
    <div class="card"><h3>Locations</h3>
      <table><thead><tr><th>Name</th><th>City</th><th>Status</th><th>Edit</th></tr></thead><tbody>${locRows || `<tr><td colspan="4" class="muted">No locations yet.</td></tr>`}</tbody></table>
      <form method="post" action="/admin/customers/${customerId}/locations" class="row" style="margin-top:14px">
        <input name="name" placeholder="New location name" required style="max-width:260px">
        <input name="city" placeholder="City" style="max-width:150px">
        <button class="btn small" type="submit">Add location</button></form></div>
    <div class="card"><h3>Products</h3>
      <table><thead><tr><th>Product</th><th>State</th><th>Change</th></tr></thead><tbody>${prodRows}</tbody></table>
      <p class="muted">Switches are enforced on the server. Off means the client sees a locked tile and their data requests for that service are refused.</p></div>
    <div class="card"><h3>Logins for this customer</h3>
      <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>${memberRows || `<tr><td colspan="4" class="muted">No logins yet.</td></tr>`}</tbody></table>
      <h4>Invite a login</h4>
      <form method="post" action="/admin/customers/${customerId}/users" class="row" style="align-items:end">
        <span style="flex:1;min-width:160px"><label>Name</label><input name="name" required></span>
        <span style="flex:1;min-width:200px"><label>Email</label><input name="email" type="email" required></span>
        <span style="flex:1;min-width:150px"><label>Access</label><select name="location_id">
          <option value="">All locations</option>${locOptions}</select></span>
        <span style="flex:1;min-width:150px"><label>Scope</label><select name="scope">
          <option value="user">User</option><option value="admin">Location admin</option></select></span>
        <button class="btn small" type="submit">Send invite</button></form>
      <p class="muted">The invite email asks them to set a password and finish sign-in. Access starts only with this invite.</p></div>`;
  return page({ title: c.name, user, body, flash: q(request).get("msg") || undefined });
}

export async function addLocationPost(env, request, user, customerId) {
  const f = await request.formData();
  const name = String(f.get("name") || "").trim();
  if (name) {
    await env.DB.prepare("INSERT INTO locations (customer_id, name, city) VALUES (?, ?, ?)")
      .bind(customerId, name, f.get("city") || null).run();
    await audit(env.DB, user.id, "location_create", "customer", Number(customerId), name);
  }
  return redirect(`/admin/customers/${customerId}`);
}

export async function editLocationPost(env, request, user, locationId) {
  const loc = await env.DB.prepare("SELECT * FROM locations WHERE id = ?").bind(locationId).first();
  if (!loc) return redirect("/admin");
  const f = await request.formData();
  await env.DB.prepare("UPDATE locations SET name = ?, city = ?, state = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(String(f.get("name") || loc.name), f.get("city") || null, f.get("state") || null, locationId).run();
  return redirect(`/admin/customers/${loc.customer_id}`);
}

export async function productTogglePost(env, request, user, customerId) {
  const f = await request.formData();
  const product = String(f.get("product") || "");
  const enabled = String(f.get("enabled") || "0") === "1" ? 1 : 0;
  const note = f.get("plan_note") || null;
  const locationId = f.get("location_id") ? Number(f.get("location_id")) : null;
  const valid = await env.DB.prepare("SELECT key FROM products WHERE key = ?").bind(product).first();
  if (valid) {
    // Manual upsert: SQLite treats NULL location_id as distinct in UNIQUE
    // indexes, so an ON CONFLICT clause would silently duplicate rows.
    const existing = await env.DB.prepare(
      `SELECT id FROM customer_products WHERE customer_id = ? AND product = ?
       AND ((location_id IS NULL AND ? IS NULL) OR location_id = ?)`)
      .bind(customerId, product, locationId, locationId).first();
    if (existing) {
      await env.DB.prepare(
        "UPDATE customer_products SET enabled = ?, plan_note = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(enabled, note, existing.id).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO customer_products (customer_id, location_id, product, enabled, plan_note) VALUES (?, ?, ?, ?, ?)")
        .bind(customerId, locationId, product, enabled, note).run();
    }
    await audit(env.DB, user.id, enabled ? "product_on" : "product_off", "customer", Number(customerId), product);
  }
  return redirect(`/admin/customers/${customerId}`);
}

export async function inviteCustomerUserPost(env, request, user, customerId) {
  const f = await request.formData();
  const name = String(f.get("name") || "").trim();
  const email = String(f.get("email") || "").trim().toLowerCase();
  const locationId = f.get("location_id") ? Number(f.get("location_id")) : null;
  const scope = String(f.get("scope") || "user") === "admin" ? "admin" : "user";
  if (!name || !email) return redirect(`/admin/customers/${customerId}`);
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
  }
  const grant = await grantUserAccess(env.DB, target.id, customerId, locationId, scope);
  if (!grant.ok) {
    // FlossByte admins may be told which organization holds the email.
    // Customer-facing flows never see the other organization's name.
    const detail = grant.otherCustomer ? ` It belongs to ${grant.otherCustomer.name}.` : "";
    return redirect(`/admin/customers/${customerId}?msg=` + encodeURIComponent(grant.error + detail));
  }
  const raw = await createAuthToken(env.DB, target.id, "invite", 7 * 24 * 60);
  const mail = inviteEmail(env, { name: target.name, link: `${origin(env)}/invite/${raw}` });
  await sendEmail(env, { to: email, template: "invite", ...mail });
  await audit(env.DB, user.id, "user_invite", "user", target.id, email);
  return redirect(`/admin/customers/${customerId}?msg=` + encodeURIComponent("Invite sent (or queued, if email is not configured yet)."));
}

// ---------- Pending accounts ----------
export async function pendingPage(env, request, user) {
  const { results: pending } = await env.DB.prepare(
    "SELECT * FROM users WHERE status = 'pending' ORDER BY created_at").all();
  const { results: customers } = await env.DB.prepare("SELECT id, name FROM customers ORDER BY name").all();
  const rows = [];
  for (const p of pending || []) {
    const { results: locs } = await env.DB.prepare("SELECT id, name, customer_id FROM locations ORDER BY name").all();
    rows.push(`<div class="card"><div class="row between"><div><strong>${esc(p.name)}</strong>
      <div class="muted">${esc(p.email)} , signed up ${esc(p.created_at.slice(0, 10))}</div></div></div>
      <form method="post" action="/admin/pending/${p.id}/connect" class="row" style="margin-top:10px;align-items:end">
        <span style="flex:1;min-width:200px"><label>Connect to location (or customer-wide by picking any of its locations, then scope)</label>
        <select name="location_id" required>${(locs || []).map((l) => {
          const cust = (customers || []).find((c) => c.id === l.customer_id);
          return `<option value="${l.id}">${esc(cust ? cust.name + " , " : "")}${esc(l.name)}</option>`;
        }).join("")}</select></span>
        <span style="min-width:150px"><label>Scope</label><select name="scope"><option value="user">User</option><option value="admin">Location admin</option></select></span>
        <span style="min-width:170px"><label>Reach</label><select name="reach"><option value="location">This location only</option><option value="customer">All locations of that customer</option></select></span>
        <button class="btn small" type="submit">Connect</button></form></div>`);
  }
  const body = `${adminNav("pending")}<h1>Pending accounts</h1>
    <p class="muted">These people created their own login. They see nothing until you connect them here.</p>
    ${rows.join("") || `<div class="card"><p class="muted">No pending accounts.</p></div>`}`;
  return page({ title: "Pending accounts", user, body, flash: q(request).get("msg") || undefined });
}

export async function pendingConnectPost(env, request, user, pendingUserId) {
  const target = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND status = 'pending'").bind(pendingUserId).first();
  if (!target) return redirect("/admin/pending");
  const f = await request.formData();
  const locationId = Number(f.get("location_id"));
  const loc = await env.DB.prepare("SELECT * FROM locations WHERE id = ?").bind(locationId).first();
  if (!loc) return redirect("/admin/pending");
  const scope = String(f.get("scope") || "user") === "admin" ? "admin" : "user";
  const reachAll = String(f.get("reach") || "location") === "customer";
  const grant = await grantUserAccess(env.DB, target.id, loc.customer_id, reachAll ? null : locationId, scope);
  if (!grant.ok) {
    const detail = grant.otherCustomer ? ` It belongs to ${grant.otherCustomer.name}.` : "";
    return redirect("/admin/pending?msg=" + encodeURIComponent(grant.error + detail));
  }
  await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(target.id).run();
  await audit(env.DB, user.id, "pending_connected", "user", target.id, `customer ${loc.customer_id}`);
  return redirect("/admin/pending");
}

// ---------- Admin accounts (Super Admin only) ----------
function notSuper(user) {
  return page({ title: "Admins", user, body: `<div class="card narrow"><h1>Super Admin only</h1>
    <p class="muted">Only the Super Admin can manage admin accounts. Regular admins still run the full client console.</p></div>` });
}

export async function adminsPage(env, request, user) {
  if (!isSuperAdmin(user)) return notSuper(user);
  const { results } = await env.DB.prepare(
    "SELECT * FROM users WHERE kind = 'flossbyte' ORDER BY created_at").all();
  const rows = (results || []).map((a) => {
    const isSuper = a.role === "super_admin";
    const controls = isSuper || a.id === user.id
      ? `<span class="muted">Protected</span>`
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
    <div class="card" style="padding:8px 14px"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div class="card"><h3>Create an admin</h3>
      <form method="post" action="/admin/admins" class="row" style="align-items:end">
        <span style="flex:1;min-width:160px"><label>Name</label><input name="name" required></span>
        <span style="flex:1;min-width:200px"><label>Email</label><input name="email" type="email" required></span>
        <button class="btn small" type="submit">Send admin invite</button></form>
      <p class="muted">New admins finish sign-in from the invite email, then set up two-step verification. The Super Admin account can never be disabled or removed, and no admin can disable their own account.</p></div>
    <div class="card"><h3>Transfer ownership</h3>
      <p class="muted">Hand the Super Admin role to another admin, for example when the business is sold. There is always exactly one Super Admin, and the transfer is recorded in the audit log. The new Super Admin needs an active admin account (invited and signed in at least once).</p>
      ${(() => {
        const eligible = (results || []).filter((a) => a.role === "admin" && a.status === "active" && a.id !== user.id);
        if (!eligible.length) return `<p class="muted">No admin can receive ownership yet. Create an admin above and have them finish sign-in first.</p>`;
        return eligible.map((a) => `<p><a class="btn small secondary" href="/admin/transfer/${a.id}">Transfer ownership to ${esc(a.name)}</a> <span class="muted">${esc(a.email)}</span></p>`).join("");
      })()}</div>`;
  return page({ title: "Admins", user, body, flash: q(request).get("msg") || undefined });
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
    return redirect("/admin/admins?msg=" + encodeURIComponent("That admin cannot receive ownership. They need an active admin account."));
  }
  const body = `${adminNav("admins")}<h1>Transfer ownership</h1>
    <div class="card narrow"><h3 style="margin-top:0">Make ${esc(target.name)} the Super Admin</h3>
      <p class="muted">${esc(target.name)} (${esc(target.email)}) gets full control of the portal, including managing admin accounts and transferring ownership again. Two-step verification stays mandatory for them; if they have not set it up, they will be asked at their next sign-in.</p>
      <form method="post" action="/admin/transfer/${target.id}">
        <label>Your password, to confirm this is you</label>
        <input name="password" type="password" required autocomplete="current-password">
        <label style="margin-top:14px">What happens to your account</label>
        <label style="font-weight:normal"><input type="radio" name="after" value="admin" checked style="width:auto"> Keep me as a regular admin</label>
        <label style="font-weight:normal"><input type="radio" name="after" value="disable" style="width:auto"> Disable my account and sign me out everywhere</label>
        <label style="font-weight:normal;margin-top:12px"><input type="checkbox" name="confirm" value="yes" required style="width:auto"> I understand this hands over full control of the portal.</label>
        <p style="margin-top:18px"><button class="btn danger" type="submit">Transfer ownership</button>
        <a class="btn secondary" href="/admin/admins">Cancel</a></p>
      </form></div>`;
  return page({ title: "Transfer ownership", user, body, flash: q(request).get("msg") || undefined });
}

export async function transferPost(env, request, user, targetId) {
  if (!isSuperAdmin(user)) return notSuper(user);
  const back = (msg) => redirect(`/admin/transfer/${targetId}?msg=` + encodeURIComponent(msg));
  const target = await eligibleTransferTarget(env, targetId);
  if (!target || Number(targetId) === user.id) {
    return redirect("/admin/admins?msg=" + encodeURIComponent("That admin cannot receive ownership. They need an active admin account."));
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
  const name = String(f.get("name") || "").trim();
  const email = String(f.get("email") || "").trim().toLowerCase();
  if (!name || !email) return redirect("/admin/admins");
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return redirect("/admin/admins?msg=" + encodeURIComponent("That email already has a login."));
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
    return redirect("/admin/admins?msg=" + encodeURIComponent("The Super Admin login can never be disabled or removed."));
  }
  if (Number(targetId) === user.id) {
    return redirect("/admin/admins?msg=" + encodeURIComponent("You cannot disable or remove your own account."));
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
