// Equipment identity: merging two records for one physical device,
// and the automatic reconciliation that keeps it merged.
//
// One device, one record, each system the authority for its own
// facts. Atera knows the computer (OS, patches, serial), UniFi knows
// the network view (presence, IP, uplink). The two systems often see
// the same PC through different network cards: UniFi reports the
// dock's MAC address, Atera reports the PC's own, so the MAC-based
// match misses and two records are born. The durable identity links
// (links.js) remember every identity a merged record has ever had;
// this module adds the self-healing pass on top: after every sync,
// records from different systems that share a name AND a current IP
// address in the same office are the same device, and are merged.
import { loadLinks, saveLinks, recordLink, macKey, srcKey } from "./links.js";
import { audit } from "./access.js";

export function tsOf(v) {
  if (!v) return 0;
  let s = String(v).replace(" ", "T");
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

// Readable device name for comparison: UniFi's stored names may still
// carry the " xx:xx" MAC fragment on older rows.
export function normDeviceName(name) {
  return String(name || "")
    .replace(/ [0-9a-f]{2}:[0-9a-f]{2}$/i, "")
    .trim().toLowerCase().replace(/\s+/g, " ");
}

// Merge drop into keep with field authority (each fact from the
// record that knows it best), fix up everything that pointed at the
// dropped record, remember both identities as links, and delete the
// dropped row. Shared by the manual merge on the Device sync page and
// the automatic reconciliation below.
export async function mergeEquipmentRows(db, keep, drop, opts = {}) {
  const take = (k, d) => (k !== null && k !== undefined && k !== "" ? k : d);
  // Ownership: a hand-added keeper adopts the synced record's identity,
  // so that sync keeps maintaining the merged row instead of the two
  // halves drifting apart again.
  let source = keep.source, externalId = keep.external_id;
  if ((!keep.source || keep.source === "manual") && drop.source && drop.source !== "manual") {
    source = drop.source; externalId = drop.external_id;
  }
  const status = keep.status === "online" || drop.status !== "online" ? keep.status : drop.status;
  // Field authority: a UniFi-style name carrying its MAC suffix loses
  // to the clean name; a generic "Connected device" type loses to a
  // specific one; the address and last-seen come from whichever
  // record was seen most recently.
  const junkName = (n) => / [0-9a-f]{2}:[0-9a-f]{2}$/i.test(String(n || ""));
  const name = junkName(keep.name) && drop.name && !junkName(drop.name) ? drop.name : keep.name;
  const type = keep.type === "Connected device" && drop.type && drop.type !== "Connected device" ? drop.type : take(keep.type, drop.type);
  const dropFresher = tsOf(drop.last_seen_at) > tsOf(keep.last_seen_at);
  const ip = (dropFresher ? drop.ip_address : keep.ip_address) || take(keep.ip_address, drop.ip_address);
  const lastSeen = dropFresher ? drop.last_seen_at : keep.last_seen_at;
  await db.prepare(
    `UPDATE equipment SET name = ?, vendor = ?, type = ?, model = ?, serial = ?, mac = ?, firmware = ?,
       ip_address = ?, ip_mode = ?, license_expires = ?, warranty_expires = ?, notes = ?,
       parent_mac = ?, source = ?, external_id = ?, status = ?, last_seen_at = ?,
       updated_at = datetime('now') WHERE id = ?`)
    .bind(name, take(keep.vendor, drop.vendor), type, take(keep.model, drop.model),
      take(keep.serial, drop.serial), take(keep.mac, drop.mac), take(keep.firmware, drop.firmware),
      ip, take(keep.ip_mode, drop.ip_mode),
      take(keep.license_expires, drop.license_expires), take(keep.warranty_expires, drop.warranty_expires),
      take(keep.notes, drop.notes), take(keep.parent_mac, drop.parent_mac), source, externalId, status,
      lastSeen, keep.id).run();
  // Anything plugged into the dropped record now hangs off the keeper.
  const keepMac = take(keep.mac, drop.mac);
  if (keepMac && drop.mac && String(keepMac).toLowerCase() !== String(drop.mac).toLowerCase()) {
    await db.prepare("UPDATE equipment SET parent_mac = ? WHERE location_id = ? AND parent_mac = ?")
      .bind(keepMac, keep.location_id, drop.mac).run();
  }
  // Snapshot fix-ups: display-name renames move across, and Atera
  // computer details that pointed at the dropped row point at the keeper.
  try {
    const snap = await db.prepare("SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = 'device_names'").bind(keep.location_id).first();
    if (snap && snap.payload) {
      const renames = JSON.parse(snap.payload || "{}");
      const dropKey = drop.external_id || drop.mac;
      const keepKey = externalId || keepMac;
      if (dropKey && renames[dropKey] && keepKey && !renames[keepKey]) {
        renames[keepKey] = renames[dropKey];
        delete renames[dropKey];
        await db.prepare(
          `INSERT INTO network_snapshots (location_id, kind, payload) VALUES (?, 'device_names', ?)
           ON CONFLICT(location_id, kind) DO UPDATE SET payload = excluded.payload, captured_at = datetime('now')`)
          .bind(keep.location_id, JSON.stringify(renames)).run();
      }
    }
  } catch { /* renames are cosmetic; never block a merge */ }
  try {
    const snap = await db.prepare("SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = 'atera_agent'").bind(keep.location_id).first();
    if (snap && snap.payload) {
      const data = JSON.parse(snap.payload || "{}");
      let changed = false;
      for (const entry of Object.values(data.byAgent || {})) {
        if (entry && entry.equipmentId === drop.id) { entry.equipmentId = keep.id; changed = true; }
      }
      if (changed) {
        await db.prepare(
          `INSERT INTO network_snapshots (location_id, kind, payload) VALUES (?, 'atera_agent', ?)
           ON CONFLICT(location_id, kind) DO UPDATE SET payload = excluded.payload, captured_at = datetime('now')`)
          .bind(keep.location_id, JSON.stringify(data)).run();
      }
    }
  } catch { /* detail re-points on the next sync anyway */ }
  // Durable identity links: every identity either record was known by
  // (each sync's id, each NIC's MAC) now points at the keeper, so the
  // dropped record's own sync finds the keeper on its next run instead
  // of recreating the duplicate this merge just removed.
  try {
    const links = await loadLinks(db, keep.location_id);
    recordLink(links, keep.id, [
      srcKey(keep.source, keep.external_id), macKey(keep.mac),
      srcKey(drop.source, drop.external_id), macKey(drop.mac),
      srcKey(source, externalId), macKey(keepMac),
    ]);
    await saveLinks(db, keep.location_id, links);
  } catch { /* links accelerate matching; the cascades still work without them */ }
  await db.prepare("DELETE FROM equipment WHERE id = ?").bind(drop.id).run();
  await audit(db, opts.actorId || null, "equipment_merge", "location", keep.location_id,
    opts.detail || `Kept #${keep.id} (${keep.name}); merged in #${drop.id} (${drop.name})`);
  return name;
}

function sideOf(source) {
  if (source === "atera" || source === "atera-device") return "agent";
  if (source === "unifi" || source === "unifi-client" || source === "sophos") return "network";
  if (!source || source === "manual") return "manual";
  return "other";
}

const GEAR_TYPES = ["Gateway", "Firewall", "Switch", "Access point", "Controller", "Recorder"];

function keeperScore(r) {
  let s = r.source === "atera" ? 100 : r.source === "atera-device" ? 80 : r.source === "manual" ? 10 : 50;
  if (r.serial) s += 5;
  if (r.model) s += 3;
  return s;
}

async function dismissedKeys(db) {
  try {
    const row = await db.prepare("SELECT value FROM system_state WHERE key = 'dup_dismissed'").first();
    return new Set(JSON.parse((row && row.value) || "[]"));
  } catch { return new Set(); }
}

// The self-healing pass. Two records in one office, owned by
// different systems, carrying the same readable name and the same
// current IP address, are one device seen two ways (the classic case:
// UniFi sees the dock's MAC, Atera the PC's own). Merge them with
// full field authority and record the identity links, so the split
// cannot reopen. Pairs a human dismissed as "not the same device" are
// never touched, conflicting serials are never merged, and network
// gear never merges into a computer.
export async function reconcileDuplicates(env) {
  const db = env.DB;
  const dismissed = await dismissedKeys(db);
  const { results: locs } = await db.prepare(
    "SELECT DISTINCT location_id FROM equipment").all().catch(() => ({ results: [] }));
  let merged = 0;
  for (const loc of locs || []) {
    if (merged >= 20) break;
    const locationId = loc.location_id;
    const { results: rows } = await db.prepare(
      "SELECT * FROM equipment WHERE location_id = ? ORDER BY id").bind(locationId).all().catch(() => ({ results: [] }));
    const list = rows || [];
    const consumed = new Set();
    for (let i = 0; i < list.length; i++) {
      if (merged >= 20) break;
      const a = list[i];
      if (consumed.has(a.id)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (consumed.has(b.id)) continue;
        if (sideOf(a.source) === sideOf(b.source)) continue;
        const key = `${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;
        if (dismissed.has(key)) continue;
        const na = normDeviceName(a.name), nb = normDeviceName(b.name);
        if (!na || na !== nb || na.length < 3) continue;
        if (!a.ip_address || !b.ip_address) continue;
        if (String(a.ip_address).trim() !== String(b.ip_address).trim()) continue;
        if (a.serial && b.serial && String(a.serial).trim().toLowerCase() !== String(b.serial).trim().toLowerCase()) continue;
        const aGear = GEAR_TYPES.includes(a.type), bGear = GEAR_TYPES.includes(b.type);
        if (aGear !== bGear) continue;
        const keep = keeperScore(a) >= keeperScore(b) ? a : b;
        const drop = keep === a ? b : a;
        await mergeEquipmentRows(db, keep, drop, {
          actorId: null,
          detail: `Automatic merge: ${drop.name} (${drop.source}) into ${keep.name} (${keep.source}); same name and IP address ${keep.ip_address || drop.ip_address}`,
        });
        consumed.add(a.id); consumed.add(b.id);
        merged++;
        break;
      }
    }
  }
  return merged;
}
