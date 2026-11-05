// Tenant isolation helpers. Every customer-data query in the portal goes
// through these functions: a customer login can only reach locations granted
// in user_access. FlossByte logins (kind = 'flossbyte') reach everything.
import { revokeAllSessions } from "./auth.js";

export function isFlossByte(user) { return user && user.kind === "flossbyte"; }
export function isSuperAdmin(user) { return user && user.role === "super_admin"; }

// ----- Identity rules (Montek, 2026-11-05) -----
// 1. Customer contact email is a hard identity: no two customers may share
//    one (case-insensitive, trimmed). Customer NAME may repeat freely.
// 2. One user, one organization: a customer user may hold user_access rows
//    under exactly one customer. Migration 0002 adds database backstops
//    (unique index + triggers); the checks here run first so people see a
//    friendly error instead of a constraint failure.

export const CROSS_ORG_ERROR =
  "This email already belongs to another organization and cannot be added here.";

// Existing customer whose contact email matches `email`, or null.
export async function findCustomerByContactEmail(db, email) {
  const normalized = String(email || "").trim();
  if (!normalized) return null;
  return db.prepare(
    "SELECT id, name, contact_email FROM customers WHERE LOWER(TRIM(contact_email)) = LOWER(?)")
    .bind(normalized).first();
}

// The one path that grants a customer login access to a customer. Every
// caller (FlossByte admin invites, pending-account connect, and any future
// customer-admin user management) must go through here so the one-org rule
// is enforced in a single place. Grants access without duplicates: SQLite
// treats NULL location_id as distinct in UNIQUE indexes, so existence is
// checked explicitly. FlossByte logins hold no user_access and are
// unaffected. Returns { ok: true } or { ok: false, error, otherCustomer }.
export async function grantUserAccess(db, userId, customerId, locationId, scope) {
  const target = await db.prepare("SELECT kind FROM users WHERE id = ?").bind(userId).first();
  if (target && target.kind !== "flossbyte") {
    const other = await db.prepare(
      `SELECT c.id, c.name FROM user_access ua JOIN customers c ON c.id = ua.customer_id
       WHERE ua.user_id = ? AND ua.customer_id != ? LIMIT 1`)
      .bind(userId, customerId).first();
    if (other) return { ok: false, error: CROSS_ORG_ERROR, otherCustomer: other };
  }
  const existing = await db.prepare(
    `SELECT id FROM user_access WHERE user_id = ? AND customer_id = ?
     AND ((location_id IS NULL AND ? IS NULL) OR location_id = ?)`)
    .bind(userId, customerId, locationId, locationId).first();
  if (existing) {
    await db.prepare("UPDATE user_access SET scope = ? WHERE id = ?").bind(scope, existing.id).run();
    return { ok: true };
  }
  await db.prepare(
    "INSERT INTO user_access (user_id, customer_id, location_id, scope) VALUES (?, ?, ?, ?)")
    .bind(userId, customerId, locationId, scope).run();
  return { ok: true };
}

// The customer this user administers, or null. A customer admin is a
// customer login with role 'customer_admin'; the one-org rule means all of
// their user_access rows sit under a single customer.
export async function customerAdminOrg(db, user) {
  if (!user || user.kind !== "customer" || user.role !== "customer_admin") return null;
  const row = await db.prepare("SELECT customer_id FROM user_access WHERE user_id = ? LIMIT 1")
    .bind(user.id).first();
  return row ? row.customer_id : null;
}

// Users who belong to a customer through user_access, one entry per user,
// each with the names of the locations their rows cover (a row with no
// location means every location of the customer).
export async function orgMembers(db, customerId) {
  const { results } = await db.prepare(
    `SELECT DISTINCT u.id, u.name, u.email, u.role, u.status FROM user_access ua
     JOIN users u ON u.id = ua.user_id WHERE ua.customer_id = ? ORDER BY u.name`)
    .bind(customerId).all();
  const members = [];
  for (const u of results || []) {
    const { results: rows } = await db.prepare(
      `SELECT ua.location_id, l.name AS location_name FROM user_access ua
       LEFT JOIN locations l ON l.id = ua.location_id WHERE ua.user_id = ? AND ua.customer_id = ?`)
      .bind(u.id, customerId).all();
    const allLocations = (rows || []).some((r) => r.location_id === null);
    members.push({
      ...u,
      all_locations: allLocations,
      locations_label: allLocations ? "All locations"
        : (rows || []).map((r) => r.location_name).filter(Boolean).join(", "),
    });
  }
  return members;
}

// Removes a user from a customer, for when a staff member leaves. The only
// caller-facing removal path, so every surface (the Team page today, any
// future one) inherits the same server-checked guards:
//   - the actor must be a customer_admin of THIS customer
//   - the target must belong to the same customer (never another org,
//     never a FlossByte login)
//   - nobody can remove their own login
//   - the organization's last remaining customer_admin cannot be removed
// Removal deletes the user's access rows for the customer, disables the
// login, and revokes its sessions right away. The user row itself is kept
// (disabled, not deleted), so tickets, ticket updates, and documents they
// created stay on record. With no access left, the freed email can later
// be invited to a different organization and reactivates cleanly.
// Returns { ok: true, target } or { ok: false, error }.
export async function removeUserFromCustomer(db, actor, targetUserId, customerId) {
  const NOT_MEMBER = "That user is not part of your organization.";
  const org = await customerAdminOrg(db, actor);
  if (org === null || Number(org) !== Number(customerId)) {
    return { ok: false, error: "Only an admin of this organization can remove its users." };
  }
  if (Number(targetUserId) === Number(actor.id)) {
    return { ok: false, error: "You cannot remove your own login." };
  }
  const target = await db.prepare("SELECT id, name, email, kind, role, status FROM users WHERE id = ?")
    .bind(targetUserId).first();
  if (!target || target.kind !== "customer") return { ok: false, error: NOT_MEMBER };
  const member = await db.prepare(
    "SELECT id FROM user_access WHERE user_id = ? AND customer_id = ? LIMIT 1")
    .bind(targetUserId, customerId).first();
  if (!member) return { ok: false, error: NOT_MEMBER };
  if (target.role === "customer_admin") {
    const remaining = await db.prepare(
      `SELECT COUNT(*) AS n FROM users u JOIN user_access ua ON ua.user_id = u.id
       WHERE ua.customer_id = ? AND u.role = 'customer_admin' AND u.status != 'disabled' AND u.id != ?`)
      .bind(customerId, targetUserId).first();
    if (!remaining || remaining.n === 0) {
      return { ok: false, error: "You cannot remove the last admin of your organization." };
    }
  }
  await db.prepare("DELETE FROM user_access WHERE user_id = ? AND customer_id = ?")
    .bind(targetUserId, customerId).run();
  await db.prepare("UPDATE users SET status = 'disabled', updated_at = datetime('now') WHERE id = ?")
    .bind(targetUserId).run();
  await revokeAllSessions(db, Number(targetUserId));
  await audit(db, actor.id, "user_remove", "user", Number(targetUserId), `customer ${customerId}`);
  return { ok: true, target };
}

export async function getUserAccess(db, user) {
  if (!user) return [];
  if (isFlossByte(user)) return [{ customer_id: null, location_id: null, scope: "owner" }];
  const { results } = await db.prepare(
    "SELECT customer_id, location_id, scope FROM user_access WHERE user_id = ?")
    .bind(user.id).all();
  return results || [];
}

// Set of location ids the user may see, or null for FlossByte (all).
export async function accessibleLocationIds(db, user) {
  if (!user) return new Set();
  if (isFlossByte(user)) return null;
  const rows = await getUserAccess(db, user);
  const ids = new Set();
  for (const row of rows) {
    if (row.location_id) { ids.add(row.location_id); continue; }
    const { results } = await db.prepare("SELECT id FROM locations WHERE customer_id = ?")
      .bind(row.customer_id).all();
    for (const loc of results || []) ids.add(loc.id);
  }
  return ids;
}

export async function canAccessLocation(db, user, locationId) {
  const ids = await accessibleLocationIds(db, user);
  if (ids === null) return true;
  return ids.has(Number(locationId));
}

// Scope string for a location ('admin', 'user') from user_access, used to
// decide who may add equipment or close tickets. FlossByte returns 'owner'.
export async function locationScope(db, user, locationId) {
  if (!user) return null;
  if (isFlossByte(user)) return "owner";
  const loc = await db.prepare("SELECT customer_id FROM locations WHERE id = ?")
    .bind(locationId).first();
  if (!loc) return null;
  const row = await db.prepare(
    `SELECT scope FROM user_access WHERE user_id = ? AND customer_id = ?
     AND (location_id IS NULL OR location_id = ?) ORDER BY location_id DESC LIMIT 1`)
    .bind(user.id, loc.customer_id, locationId).first();
  return row ? row.scope : null;
}

export async function getLocation(db, locationId) {
  return db.prepare(
    `SELECT l.*, c.name AS customer_name FROM locations l
     JOIN customers c ON c.id = l.customer_id WHERE l.id = ?`)
    .bind(locationId).first();
}

// Product state for a customer/location. A location row overrides the
// customer row. Managed IT defaults on for new customers; everything else
// defaults off until an admin turns it on.
export async function productEnabled(db, customerId, locationId, productKey) {
  if (locationId) {
    const loc = await db.prepare(
      "SELECT enabled FROM customer_products WHERE customer_id = ? AND location_id = ? AND product = ?")
      .bind(customerId, locationId, productKey).first();
    if (loc) return !!loc.enabled;
  }
  const cust = await db.prepare(
    "SELECT enabled FROM customer_products WHERE customer_id = ? AND location_id IS NULL AND product = ?")
    .bind(customerId, productKey).first();
  if (cust) return !!cust.enabled;
  return productKey === "managed_it";
}

export async function productStates(db, customerId, locationId) {
  const { results } = await db.prepare("SELECT key, name, description FROM products ORDER BY key").all();
  const states = [];
  for (const p of results || []) {
    const enabled = await productEnabled(db, customerId, locationId, p.key);
    let note = null;
    const row = await db.prepare(
      `SELECT plan_note FROM customer_products WHERE customer_id = ? AND product = ?
       AND (location_id = ? OR location_id IS NULL) ORDER BY location_id DESC LIMIT 1`)
      .bind(customerId, p.key, locationId || 0).first();
    if (row) note = row.plan_note;
    states.push({ ...p, enabled, plan_note: note });
  }
  return states;
}

// Equipment at a location whose warranty or license expires within `days`
// (or already expired), soonest first.
export async function expiringItems(db, locationId, days = 90) {
  const { results } = await db.prepare(
    `SELECT *, MIN(COALESCE(warranty_expires, '9999'), COALESCE(license_expires, '9999')) AS next_expiry
     FROM equipment WHERE location_id = ?
     AND (warranty_expires IS NOT NULL OR license_expires IS NOT NULL)
     AND (date(warranty_expires) <= date('now', '+' || ? || ' days')
          OR date(license_expires) <= date('now', '+' || ? || ' days'))
     ORDER BY next_expiry ASC`)
    .bind(locationId, days, days).all();
  return results || [];
}

export async function audit(db, actorUserId, action, entity, entityId, detail) {
  try {
    await db.prepare(
      "INSERT INTO audit_log (actor_user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)")
      .bind(actorUserId || null, action, entity || null, entityId || null, detail || null).run();
  } catch { /* audit must never break the request */ }
}
