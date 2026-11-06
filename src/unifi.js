// UniFi device sync. Polls Ubiquiti's Site Manager API (api.ui.com) with
// one account-level API key (the UNIFI_API_KEY secret) and mirrors the
// devices into the equipment table for every UniFi site a FlossByte admin
// has mapped to a portal location on the Device sync page.
//
// Matching, in order: the vendor device id, then MAC address inside the
// location, then serial number inside the location. A hand-entered row
// that matches is claimed (source becomes 'unifi') and kept current;
// manual rows are otherwise never touched. A synced device that stops
// appearing in the API is marked offline, never deleted. Runs hourly on
// the Worker cron and on demand from the Device sync page; the outcome
// of every run is recorded in system_state for that page to show.

const TYPE_LABELS = {
  uap: "Access point", usw: "Switch", ugw: "Gateway", uxg: "Gateway",
  udm: "Gateway", udr: "Gateway", uck: "Controller", ucck: "Controller",
  unvr: "Recorder", unvrpro: "Recorder", uaphd: "Access point",
};

function apiBase(env) { return env.UNIFI_API_BASE || "https://api.ui.com"; }

async function fetchApi(env, path) {
  const resp = await fetch(apiBase(env) + path, {
    headers: { "X-API-KEY": env.UNIFI_API_KEY, "Accept": "application/json" },
  });
  if (!resp.ok) throw new Error(`UniFi API answered ${resp.status} for ${path}`);
  return resp.json();
}

function pickArray(resp, key) {
  if (Array.isArray(resp)) return resp;
  if (resp && Array.isArray(resp.data)) return resp.data;
  if (resp && key && Array.isArray(resp[key])) return resp[key];
  return [];
}

export function normMac(value) {
  const hex = String(value || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return null;
  return hex.match(/../g).join(":");
}

function deviceType(d) {
  const t = String(d.type || "").toLowerCase();
  if (TYPE_LABELS[t]) return TYPE_LABELS[t];
  if (t.startsWith("uap")) return "Access point";
  if (t.startsWith("usw")) return "Switch";
  return d.type ? String(d.type) : "Network device";
}

function deviceStatus(d) {
  if (typeof d.status === "string") {
    const s = d.status.toLowerCase();
    return s === "offline" || s === "disconnected" || s === "down" ? "offline" : "online";
  }
  if (d.state != null) return Number(d.state) === 1 ? "online" : "offline";
  return "online";
}

async function getState(db, key) {
  try {
    const row = await db.prepare("SELECT value FROM system_state WHERE key = ?").bind(key).first();
    return row ? row.value : null;
  } catch { return null; }
}

async function setState(db, key, value) {
  try {
    await db.prepare(
      "INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, value).run();
  } catch { /* recording the run must never break the sync */ }
}

export async function lastUnifiSync(env) {
  const raw = await getState(env.DB, "unifi_last_sync");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function runUnifiSync(env) {
  const summary = {
    at: new Date().toISOString(), ok: false, message: "",
    sites: 0, devices: 0, inserted: 0, updated: 0, claimed: 0,
    offlined: 0, unmappedDevices: 0,
  };
  const finish = async () => { await setState(env.DB, "unifi_last_sync", JSON.stringify(summary)); return summary; };
  try {
    if (!env.UNIFI_API_KEY) { summary.message = "No UniFi API key is saved yet."; return finish(); }
    try {
      await env.DB.prepare("SELECT id FROM sync_sites LIMIT 1").all();
    } catch {
      summary.message = "Database update needed first: migration 0007 has not been applied.";
      return finish();
    }
    // Discover the account's sites and remember them for the mapping page.
    const sites = pickArray(await fetchApi(env, "/v1/sites"), "sites");
    const hostToSites = {};
    for (const s of sites) {
      const siteId = String(s.id || s.siteId || "");
      if (!siteId) continue;
      const siteName = String(s.desc || s.name || siteId);
      await env.DB.prepare(
        `INSERT INTO sync_sites (provider, site_id, site_name) VALUES ('unifi', ?, ?)
         ON CONFLICT(provider, site_id) DO UPDATE SET site_name = excluded.site_name, updated_at = datetime('now')`)
        .bind(siteId, siteName).run();
      if (s.hostId) (hostToSites[String(s.hostId)] ||= []).push(siteId);
    }
    summary.sites = sites.length;

    let devices = pickArray(await fetchApi(env, "/v1/devices"), "devices");
    if (!devices.length) {
      // Some accounts expose devices grouped under their hosts instead.
      const hosts = pickArray(await fetchApi(env, "/v1/hosts"), "hosts");
      for (const h of hosts) {
        for (const d of h.devices || []) devices.push({ ...d, hostId: d.hostId || h.id });
      }
    }
    summary.devices = devices.length;

    const { results: mapRows } = await env.DB.prepare(
      "SELECT site_id, location_id FROM sync_sites WHERE provider = 'unifi' AND location_id IS NOT NULL").all();
    const locationBySite = {};
    for (const r of mapRows || []) locationBySite[r.site_id] = r.location_id;

    const seenByLocation = {};
    for (const locId of Object.values(locationBySite)) seenByLocation[locId] = new Set();

    for (const d of devices) {
      let siteId = d.siteId || d.site_id || (d.site && d.site.id) || null;
      if (!siteId && d.hostId) {
        const candidates = hostToSites[String(d.hostId)] || [];
        if (candidates.length === 1) siteId = candidates[0];
      }
      const locationId = siteId ? locationBySite[String(siteId)] : null;
      const mac = normMac(d.mac);
      const externalId = String(d.id || d.deviceId || mac || "");
      if (!locationId || !externalId) { summary.unmappedDevices++; continue; }
      const fields = {
        name: d.name ? String(d.name) : null,
        type: deviceType(d),
        model: d.model ? String(d.model) : null,
        serial: d.serial ? String(d.serial) : null,
        status: deviceStatus(d),
        firmware: d.version || d.firmware ? String(d.version || d.firmware) : null,
      };
      let row = await env.DB.prepare(
        "SELECT * FROM equipment WHERE source = 'unifi' AND external_id = ?").bind(externalId).first();
      if (!row && mac) {
        row = await env.DB.prepare(
          "SELECT * FROM equipment WHERE location_id = ? AND mac = ?").bind(locationId, mac).first();
      }
      if (!row && fields.serial) {
        row = await env.DB.prepare(
          "SELECT * FROM equipment WHERE location_id = ? AND serial = ?").bind(locationId, fields.serial).first();
      }
      if (row) {
        if (row.source !== "unifi") summary.claimed++;
        await env.DB.prepare(
          `UPDATE equipment SET location_id = ?, vendor = 'UniFi', type = ?, model = ?, name = ?,
             serial = COALESCE(?, serial), status = ?, firmware = ?, mac = ?, source = 'unifi',
             external_id = ?, last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
          .bind(locationId, fields.type, fields.model, fields.name, fields.serial,
            fields.status, fields.firmware, mac, externalId, row.id).run();
        summary.updated++;
        seenByLocation[locationId].add(row.id);
      } else {
        const ins = await env.DB.prepare(
          `INSERT INTO equipment (location_id, vendor, type, model, serial, status, firmware, name, mac, source, external_id, last_seen_at)
           VALUES (?, 'UniFi', ?, ?, ?, ?, ?, ?, ?, 'unifi', ?, datetime('now'))`)
          .bind(locationId, fields.type, fields.model, fields.serial, fields.status,
            fields.firmware, fields.name, mac, externalId).run();
        summary.inserted++;
        seenByLocation[locationId].add(ins.meta.last_row_id);
      }
    }

    // A synced device that no longer appears has been removed or
    // unadopted: flag it offline so the gap is visible, never delete it.
    for (const [locId, seen] of Object.entries(seenByLocation)) {
      const { results: rows } = await env.DB.prepare(
        "SELECT id FROM equipment WHERE location_id = ? AND source = 'unifi' AND status != 'offline'")
        .bind(Number(locId)).all();
      for (const r of rows || []) {
        if (!seen.has(r.id)) {
          await env.DB.prepare(
            "UPDATE equipment SET status = 'offline', updated_at = datetime('now') WHERE id = ?").bind(r.id).run();
          summary.offlined++;
        }
      }
    }
    summary.ok = true;
    summary.message = "Sync complete.";
  } catch (err) {
    summary.message = String(err && err.message || err);
  }
  return finish();
}
