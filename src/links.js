// Durable device identity links: one physical device can be known to
// each sync under a different identity (Atera sees an agent id and one
// NIC's MAC, UniFi sees another NIC, Sophos a serial). The match
// cascades in each sync are good first contact, but they are guesses
// re-made every run; when a name and IP both change, the guess fails
// and a duplicate is born. Links are the memory: once any sync (or a
// human merging duplicates) establishes that source identity X is
// equipment row N, every later run resolves X to N directly.
// Stored per location as a network_snapshots row, kind 'device_links',
// payload { byKey: { "atera:9001": 12, "mac:e470b8c18761": 12, ... } }.
const KIND = "device_links";

export function macKey(mac) {
  if (!mac) return null;
  const hex = String(mac).toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex ? "mac:" + hex : null;
}

export function srcKey(source, externalId) {
  return source && externalId ? source + ":" + String(externalId) : null;
}

export async function loadLinks(db, locationId) {
  const map = new Map();
  try {
    const row = await db.prepare(
      "SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = ?")
      .bind(locationId, KIND).first();
    if (row && row.payload) {
      const obj = JSON.parse(row.payload);
      for (const [k, v] of Object.entries(obj.byKey || {})) {
        if (v) map.set(k, Number(v));
      }
    }
  } catch { /* snapshots table predates migration 0011 in some envs */ }
  return map;
}

export async function saveLinks(db, locationId, map) {
  const byKey = {};
  for (const [k, v] of map) byKey[k] = v;
  await db.prepare(
    `INSERT INTO network_snapshots (location_id, kind, payload, captured_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(location_id, kind) DO UPDATE SET payload = excluded.payload, captured_at = datetime('now')`)
    .bind(locationId, KIND, JSON.stringify({ byKey })).run();
}

export function resolveLink(map, keys) {
  for (const k of keys) {
    if (k && map.has(k)) return map.get(k);
  }
  return null;
}

export function recordLink(map, equipmentId, keys) {
  let changed = false;
  for (const k of keys) {
    if (k && map.get(k) !== equipmentId) { map.set(k, equipmentId); changed = true; }
  }
  return changed;
}

// Fetch the linked row, scoped to the location (a stale link to a row
// that was deleted or moved resolves to nothing, never a wrong row).
export async function linkedRow(db, locationId, map, keys) {
  const id = resolveLink(map, keys);
  if (!id) return null;
  const row = await db.prepare(
    "SELECT * FROM equipment WHERE id = ? AND location_id = ?").bind(id, locationId).first();
  return row || null;
}
