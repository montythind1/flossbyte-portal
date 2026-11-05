// Tenant isolation helpers. Every customer-data query in the portal goes
// through these functions: a customer login can only reach locations granted
// in user_access. FlossByte logins (kind = 'flossbyte') reach everything.

export function isFlossByte(user) { return user && user.kind === "flossbyte"; }
export function isSuperAdmin(user) { return user && user.role === "super_admin"; }

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
