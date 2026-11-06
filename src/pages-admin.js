// FlossByte admin console: clients, locations, product switches, logins,
// pending signups, and (Super Admin only) admin account management.
import { page, redirect, esc } from "./layout.js";
import { createAuthToken, revokeAllSessions, verifyPassword } from "./auth.js";
import { audit, isSuperAdmin, grantUserAccess, findCustomerByContactEmail, isValidEmail } from "./access.js";
import { sendEmail, inviteEmail, newCustomerNoticeEmail, ownershipTransferEmail } from "./email.js";
import { resendInviteEmail } from "./pages-public.js";

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
      `SELECT p.key, p.name, COALESCE(cp.enabled, 0) AS enabled
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
    ${cards.join("") || `<div class="card"><p class="muted">No organizations yet. Add the first one.</p></div>`}`;
  return page({ title: "Clients", user, body, flash: q(request).get("msg") || undefined });
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

// US phone numbers are stored in exactly one format: (AAA) BBB-CCCC.
// Anything that reduces to 10 digits (an optional leading country-code
// 1 is dropped) is accepted and reformatted; anything else is invalid.
export function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
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
  const body = `${adminNav("new")}<div class="card narrow" style="margin:0;max-width:600px"><h1>Add organization</h1>
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
        <h3 style="margin:16px 0 4px">Customer admin</h3>
        <p class="muted">The main admin for this organization. They get a login invite, see every location, and can manage the organization's team. Everyone added in step 4 is a regular user. An email can belong to only one organization.</p>
        <div class="row"><span style="flex:1"><label>First name <span class="req">*</span></label><input name="contact_first_name" required></span>
        <span style="flex:1"><label>Middle name</label><input name="contact_middle_name"></span>
        <span style="flex:1"><label>Last name <span class="req">*</span></label><input name="contact_last_name" required></span></div>
        <label>Customer admin email <span class="req">*</span></label><input name="contact_email" type="email">
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
  return page({ title: "Add organization", user, body, flash: q(request).get("msg") || undefined });
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
    return redirect("/admin/customers/new?msg=" + encodeURIComponent(
      "Customer admin email is required. It becomes the organization's main admin login."));
  }
  if (!isValidEmail(contactEmail)) {
    return redirect("/admin/customers/new?msg=" + encodeURIComponent(
      "Enter a valid customer admin email address."));
  }
  const dup = await findCustomerByContactEmail(env.DB, contactEmail);
  if (dup) {
    return redirect("/admin/customers/new?msg=" + encodeURIComponent(
      `An organization with this admin email already exists. It matches ${dup.name} (organization ${dup.id}).`));
  }
  const adminUser = await env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(contactEmail.toLowerCase()).first();
  if (adminUser && adminUser.kind === "flossbyte") {
    return redirect("/admin/customers/new?msg=" + encodeURIComponent(
      "That customer admin email is a FlossByte account and cannot be a customer login."));
  }
  if (adminUser && adminUser.kind === "customer") {
    const other = await env.DB.prepare(
      `SELECT c.id, c.name FROM user_access ua JOIN customers c ON c.id = ua.customer_id
       WHERE ua.user_id = ? LIMIT 1`).bind(adminUser.id).first();
    if (other) {
      return redirect("/admin/customers/new?msg=" + encodeURIComponent(
        `That customer admin email already belongs to ${other.name}. An email can belong to only one organization.`));
    }
  }
  const phone = normalizePhone(f.get("phone"));
  if (!phone) {
    return redirect("/admin/customers/new?msg=" + encodeURIComponent(
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
    return redirect("/admin/customers/new?msg=" + encodeURIComponent(
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
      return redirect("/admin/customers/new?msg=" + encodeURIComponent(
        `Location ${i + 1} is incomplete: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required.`));
    }
  }
  const first = String(f.get("contact_first_name") || "").trim();
  const middle = String(f.get("contact_middle_name") || "").trim();
  const last = String(f.get("contact_last_name") || "").trim();
  if (!first || !last) {
    return redirect("/admin/customers/new?msg=" + encodeURIComponent(
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
    } else if (!wasPending) {
      await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?")
        .bind(scope === "admin" ? "customer_admin" : "customer_user", target.id).run();
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
      ? `Invitation sent to the main admin, ${adminEmail}.`
      : `Invitation created for the main admin, ${adminEmail}.`);
  } else if (inviteTotal > 0) {
    const base = emailLive
      ? `Invitations sent to ${inviteTotal} ${inviteTotal === 1 ? "user" : "users"}`
      : `Invitations created for ${inviteTotal} ${inviteTotal === 1 ? "user" : "users"}`;
    parts.push(adminOutcome === "invited" ? `${base}, including the main admin (${adminEmail}).` : `${base}.`);
  }
  if (adminOutcome === "connected") {
    parts.push(`The main admin (${adminEmail}) already had an account and was connected directly, no invite needed.`);
  } else if (adminOutcome === "active" && inviteTotal === 0) {
    parts.push(`The main admin (${adminEmail}) already has an active account, no invite needed.`);
  }
  if (adminAlsoListed) parts.push("The main admin was also listed under user logins in step 4, so that entry was skipped.");
  if (connected.length) parts.push(`Already had accounts, connected directly: ${connected.join(", ")}.`);
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
  const contactEmail = String(f.get("contact_email") || "").trim();
  if (!isValidEmail(contactEmail)) {
    return redirect(`/admin/customers/${customerId}?tab=organization&msg=` + encodeURIComponent(
      "Enter a valid customer admin email address. Nothing was saved."));
  }
  // The one-email-per-organization rule binds edits too: the new email may
  // not belong to a different organization.
  const dup = await findCustomerByContactEmail(env.DB, contactEmail);
  if (dup && dup.id !== Number(customerId)) {
    return redirect(`/admin/customers/${customerId}?tab=organization&msg=` + encodeURIComponent(
      `That contact email already belongs to ${dup.name} (organization ${dup.id}).`));
  }
  const phone = normalizePhone(f.get("phone"));
  if (!phone) {
    return redirect(`/admin/customers/${customerId}?tab=organization&msg=` + encodeURIComponent(
      "A valid 10-digit phone number is required. Nothing was saved."));
  }
  await env.DB.prepare(
    `UPDATE customers SET name = ?, contact_name = ?, contact_first_name = ?, contact_middle_name = ?,
     contact_last_name = ?, contact_email = ?, phone = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(name, contactName, first, middle || null, last,
      contactEmail || null, phone, customerId).run();
  await audit(env.DB, user.id, "customer_update", "customer", Number(customerId), name);
  return redirect(`/admin/customers/${customerId}?tab=organization&msg=` + encodeURIComponent("Organization saved."));
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
    `SELECT DISTINCT u.id, u.name, u.email, u.status, u.role, ua.is_main_admin FROM user_access ua JOIN users u ON u.id = ua.user_id
     WHERE ua.customer_id = ? ORDER BY u.name`).bind(customerId).all();
  const locRows = (locations || []).map((l) => `<tr><td><a href="/app/locations/${l.id}">${esc(l.name)}</a></td>
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
    const enabled = p.enabled === null || p.enabled === undefined ? 0 : p.enabled;
    return `<tr><td><strong>${esc(p.name)}</strong><div class="muted">${esc(p.description || "")}</div></td>
      <td><span class="pill ${enabled ? "on" : "off"}">${enabled ? "On" : "Off"}</span></td>
      <td><form method="post" action="/admin/customers/${customerId}/products" class="row">
        <input type="hidden" name="product" value="${esc(p.key)}">
        <button class="btn small ${enabled ? "danger" : ""}" name="enabled" value="${enabled ? "0" : "1"}" type="submit">${enabled ? "Turn off" : "Turn on"}</button></form></td></tr>`;
  }).join("");
  const memberRows = (members || []).map((m) => `<tr><td>${esc(m.name)}${m.is_main_admin ? ` <span class="pill on">Main admin</span>` : ""}</td><td>${esc(m.email)}</td>
    <td>${esc(m.role)}</td><td><span class="pill">${esc(m.status)}</span></td>
    <td>${m.status === "invited" ? `<form method="post" action="/admin/customers/${customerId}/users/${m.id}/resend" style="display:inline"><button class="btn small secondary" type="submit">Resend invite</button></form>` : ""}</td></tr>`).join("");
  const tabParam = q(request).get("tab");
  const tab = ["organization", "locations", "products", "users", "manage"].includes(tabParam) ? tabParam : "organization";
  const locOptions = (locations || []).map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("");
  const body = `${adminNav("")}<h1>${esc(c.name)}</h1>
    <p class="muted">${esc(c.contact_name || "")} ${esc(c.contact_email || "")} ${esc(c.phone || "")}</p>
    <div class="tabbar">
      <button type="button" class="tab-btn${tab === "organization" ? " active" : ""}" data-tab="organization">Organization</button>
      <button type="button" class="tab-btn${tab === "locations" ? " active" : ""}" data-tab="locations">Locations</button>
      <button type="button" class="tab-btn${tab === "products" ? " active" : ""}" data-tab="products">Products</button>
      <button type="button" class="tab-btn${tab === "users" ? " active" : ""}" data-tab="users">Users</button>
      <button type="button" class="tab-btn${tab === "manage" ? " active" : ""}" data-tab="manage">Manage</button>
    </div>
    <noscript><style>.tab-panel{display:block}.tabbar{display:none}</style></noscript>
    <div class="card tab-panel${tab === "organization" ? " active" : ""}" data-panel="organization">
      <form method="post" action="/admin/customers/${customerId}/edit">
        <label>Organization name <span class="req">*</span></label><input name="name" value="${esc(c.name)}" required>
        <div class="row"><span style="flex:1"><label>First name <span class="req">*</span></label><input name="contact_first_name" value="${esc(c.contact_first_name || "")}" required></span>
        <span style="flex:1"><label>Middle name</label><input name="contact_middle_name" value="${esc(c.contact_middle_name || "")}"></span>
        <span style="flex:1"><label>Last name <span class="req">*</span></label><input name="contact_last_name" value="${esc(c.contact_last_name || "")}" required></span></div>
        <label>Customer admin email <span class="req">*</span></label><input name="contact_email" type="email" value="${esc(c.contact_email || "")}" required>
        <label>Phone <span class="req">*</span></label><input name="phone" data-phone inputmode="tel" value="${esc(c.phone || "")}">
        <p style="margin-top:12px"><button class="btn small" type="submit">Save</button> <button class="btn small secondary" type="button" data-cancel>Cancel</button></p></form></div>
    <div class="card tab-panel${tab === "locations" ? " active" : ""}" data-panel="locations">
      <div class="tscroll"><table class="stack"><thead><tr><th>Name</th><th>Address</th><th>Status</th><th>Edit</th></tr></thead><tbody>${locRows || `<tr><td colspan="4" class="muted">No locations yet.</td></tr>`}</tbody></table></div>
      <p style="margin-top:14px"><a class="btn small secondary" href="/admin/customers/${customerId}/locations/new">+ Add location</a></p></div>
    <script src="/assets/address-lookup.js"></script>
    <script src="/assets/phone-format.js"></script>
    <div class="card tab-panel${tab === "products" ? " active" : ""}" data-panel="products">
      <div class="tscroll"><table class="stack"><thead><tr><th>Product</th><th>State</th><th>Change</th></tr></thead><tbody>${prodRows}</tbody></table></div>
      <p class="muted">Switches are enforced on the server. Off means the client sees a locked tile and their data requests for that service are refused.</p></div>
    <div class="card tab-panel${tab === "users" ? " active" : ""}" data-panel="users">
      <div class="tscroll"><table class="stack"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${memberRows || `<tr><td colspan="5" class="muted">No logins yet.</td></tr>`}</tbody></table></div>
      <p style="margin-top:14px"><a class="btn small secondary" href="/admin/customers/${customerId}/users/new">+ Add user</a></p>
      <p class="muted">The invite email asks them to set a password and finish sign-in. Access starts only with this invite.</p></div>
    <div class="card tab-panel${tab === "manage" ? " active" : ""}" data-panel="manage" style="border-color:#e5b4b0">
      <h3 style="color:var(--bad)">Delete organization</h3>
      <p class="muted">Deleting this organization permanently removes its locations, equipment, tickets, documents, and login access. This cannot be undone.</p>
      <p><a class="btn danger" href="/admin/customers/${customerId}/delete">Delete this organization</a></p></div>
    <script src="/assets/org-page.js"></script>`;
  return page({ title: c.name, user, body, flash: q(request).get("msg") || undefined });
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
  if (!c) return redirect("/admin?msg=" + encodeURIComponent("Organization not found."));
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
  if (!c) return redirect("/admin?msg=" + encodeURIComponent("Organization not found."));
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
  }
  return redirect(`/admin/customers/${customerId}?tab=products`);
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
  if (!c) return page({ title: "Not found", user, body: `<div class="card narrow"><h1>Not found</h1></div>` });
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
      <li>${counts.locations} location(s)</li>
      <li>${counts.equipment} equipment record(s)</li>
      <li>${counts.tickets} ticket(s) with their full history</li>
      <li>${counts.documents} document(s), including the stored files</li>
      <li>Product settings for this organization</li>
    </ul>
    <p>The ${counts.logins} login(s) lose access immediately and are signed out. Their accounts are disabled, not erased, so ticket history keeps its authors.</p>
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
  return page({ title: "Delete organization", user, body, flash: q(request).get("msg") || undefined });
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
        <span style="flex:1;min-width:200px"><label>Connect to location (or customer-wide by picking any of its locations, then scope) <span class="req">*</span></label>
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
        <label>Your password, to confirm this is you <span class="req">*</span></label>
        <input name="password" type="password" required autocomplete="current-password">
        <label style="margin-top:14px">What happens to your account</label>
        <label style="font-weight:normal"><input type="radio" name="after" value="admin" checked style="width:auto"> Keep me as a regular admin</label>
        <label style="font-weight:normal"><input type="radio" name="after" value="disable" style="width:auto"> Disable my account and sign me out everywhere</label>
        <label style="font-weight:normal;margin-top:12px"><input type="checkbox" name="confirm" value="yes" required style="width:auto"><span class="req">*</span> I understand this hands over full control of the portal.</label>
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
  const first = String(f.get("first_name") || "").trim();
  const middle = String(f.get("middle_name") || "").trim();
  const last = String(f.get("last_name") || "").trim();
  const name = [first, middle, last].filter(Boolean).join(" ");
  const email = String(f.get("email") || "").trim().toLowerCase();
  if (!first || !last || !isValidEmail(email)) {
    return redirect("/admin/admins?msg=" + encodeURIComponent(
      "Enter the admin's first name, last name, and a valid email address."));
  }
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
  if (action === "resend") {
    if (target.status !== "invited") {
      return redirect("/admin/admins?msg=" + encodeURIComponent("Only a pending invite can be resent."));
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
