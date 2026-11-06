// Sophos Central sync. Uses one Sophos Central API credential (partner
// credentials cover every client tenant at once; a single-tenant
// credential also works) saved as the SOPHOS_CLIENT_ID and
// SOPHOS_CLIENT_SECRET secrets. Mirrors each tenant's firewalls and
// protected computers/servers into the equipment table for the portal
// location the tenant is mapped to on the Device sync page.
//
// Same rules as the UniFi sync (src/unifi.js): match by vendor device
// id, then MAC, then serial; hand-entered rows that match are claimed,
// never duplicated; devices that vanish from the API are marked
// offline, never deleted. Runs hourly on the Worker cron and on demand;
// every run's outcome is recorded in system_state for the sync page.
// Firewall license dates are attached when the Licensing API ties a
// license to the firewall's serial number.

import { normMac } from "./unifi.js";

function idBase(env) { return env.SOPHOS_ID_BASE || "https://id.sophos.com"; }
function apiBase(env) { return env.SOPHOS_API_BASE || "https://api.central.sophos.com"; }

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

export async function lastSophosSync(env) {
  const raw = await getState(env.DB, "sophos_last_sync");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function getToken(env) {
  const resp = await fetch(`${idBase(env)}/api/v2/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.SOPHOS_CLIENT_ID,
      client_secret: env.SOPHOS_CLIENT_SECRET,
      scope: "token",
    }),
  });
  if (!resp.ok) throw new Error(`Sophos sign-in answered ${resp.status}. Check the API credentials.`);
  const data = await resp.json();
  if (!data.access_token) throw new Error("Sophos sign-in returned no access token.");
  return data.access_token;
}

async function apiGet(env, token, url, tenantId) {
  const headers = { "Authorization": `Bearer ${token}`, "Accept": "application/json" };
  if (tenantId) headers["X-Tenant-ID"] = tenantId;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`Sophos API answered ${resp.status} for ${url.split("?")[0]}`);
  return resp.json();
}

function pickItems(resp) {
  if (Array.isArray(resp)) return resp;
  if (resp && Array.isArray(resp.items)) return resp.items;
  if (resp && Array.isArray(resp.data)) return resp.data;
  return [];
}

// Sophos lists paginate with a pageFromKey cursor. A small account fits
// on one page; follow at most a few pages so a bad cursor can't loop.
async function listAll(env, token, baseUrl, tenantId) {
  const out = [];
  let url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "pageSize=100";
  for (let page = 0; page < 10; page++) {
    const resp = await apiGet(env, token, url, tenantId);
    out.push(...pickItems(resp));
    const nextKey = resp && resp.pages && resp.pages.next && resp.pages.next.pageFromKey;
    if (!nextKey) break;
    url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "pageSize=100&pageFromKey=" + encodeURIComponent(nextKey);
  }
  return out;
}

function firewallStatus(fw) {
  const s = fw.status;
  if (s && typeof s === "object") {
    if (s.connected === false) return "offline";
    if (typeof s.state === "string") return s.state.toLowerCase() === "connected" ? "online" : "offline";
    return "online";
  }
  if (typeof s === "string") return s.toLowerCase() === "connected" || s.toLowerCase() === "online" ? "online" : "offline";
  return "online";
}

function endpointStatus(ep) {
  const seen = ep.lastSeenAt ? Date.parse(ep.lastSeenAt) : NaN;
  if (!Number.isNaN(seen)) return Date.now() - seen < 7 * 24 * 3600 * 1000 ? "online" : "offline";
  const health = ep.health && (ep.health.overall || ep.health.status);
  return health ? "online" : "online";
}

export async function runSophosSync(env) {
  const summary = {
    at: new Date().toISOString(), ok: false, message: "",
    tenants: 0, devices: 0, inserted: 0, updated: 0, claimed: 0,
    offlined: 0, unmappedDevices: 0,
  };
  const finish = async () => { await setState(env.DB, "sophos_last_sync", JSON.stringify(summary)); return summary; };
  try {
    if (!env.SOPHOS_CLIENT_ID || !env.SOPHOS_CLIENT_SECRET) {
      summary.message = "No Sophos API credentials are saved yet.";
      return finish();
    }
    try {
      await env.DB.prepare("SELECT id FROM sync_sites LIMIT 1").all();
    } catch {
      summary.message = "Database update needed first: migration 0007 has not been applied.";
      return finish();
    }
    const token = await getToken(env);
    const me = await apiGet(env, token, `${apiBase(env)}/whoami/v1`);
    const apiHost = me.apiHost || apiBase(env);

    // Partner credentials see every tenant; tenant credentials see one.
    let tenants = [];
    if (me.idType === "partner" || me.idType === "organization") {
      const list = await listAll(env, token, `${apiHost}/partner/v1/tenants`);
      tenants = list.map((t) => ({ id: String(t.id), name: String(t.name || t.id) }));
    } else {
      tenants = [{ id: String(me.id), name: "Sophos tenant" }];
    }
    for (const t of tenants) {
      await env.DB.prepare(
        `INSERT INTO sync_sites (provider, site_id, site_name) VALUES ('sophos', ?, ?)
         ON CONFLICT(provider, site_id) DO UPDATE SET site_name = excluded.site_name, updated_at = datetime('now')`)
        .bind(t.id, t.name).run();
    }
    summary.tenants = tenants.length;

    const { results: mapRows } = await env.DB.prepare(
      "SELECT site_id, location_id FROM sync_sites WHERE provider = 'sophos' AND location_id IS NOT NULL").all();
    const locationByTenant = {};
    for (const r of mapRows || []) locationByTenant[r.site_id] = r.location_id;
    const seenByLocation = {};
    for (const locId of Object.values(locationByTenant)) seenByLocation[locId] = new Set();

    const upsert = async (locationId, device) => {
      let row = await env.DB.prepare(
        "SELECT * FROM equipment WHERE source = 'sophos' AND external_id = ?").bind(device.externalId).first();
      if (!row && device.mac) {
        row = await env.DB.prepare(
          "SELECT * FROM equipment WHERE location_id = ? AND mac = ?").bind(locationId, device.mac).first();
      }
      if (!row && device.serial) {
        row = await env.DB.prepare(
          "SELECT * FROM equipment WHERE location_id = ? AND serial = ?").bind(locationId, device.serial).first();
      }
      if (row) {
        if (row.source !== "sophos") summary.claimed++;
        await env.DB.prepare(
          `UPDATE equipment SET location_id = ?, vendor = 'Sophos', type = ?, model = ?, name = ?,
             serial = COALESCE(?, serial), status = ?, firmware = ?, mac = ?,
             license_expires = COALESCE(?, license_expires), source = 'sophos',
             external_id = ?, last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
          .bind(locationId, device.type, device.model, device.name, device.serial,
            device.status, device.firmware, device.mac, device.licenseExpires,
            device.externalId, row.id).run();
        summary.updated++;
        seenByLocation[locationId].add(row.id);
      } else {
        const ins = await env.DB.prepare(
          `INSERT INTO equipment (location_id, vendor, type, model, serial, status, firmware, license_expires, name, mac, source, external_id, last_seen_at)
           VALUES (?, 'Sophos', ?, ?, ?, ?, ?, ?, ?, ?, 'sophos', ?, datetime('now'))`)
          .bind(locationId, device.type, device.model, device.serial, device.status,
            device.firmware, device.licenseExpires, device.name, device.mac,
            device.externalId).run();
        summary.inserted++;
        seenByLocation[locationId].add(ins.meta.last_row_id);
      }
    };

    for (const t of tenants) {
      // Best effort per list: one failing list must not sink the others.
      let firewalls = [], endpoints = [], licenses = [];
      try { firewalls = await listAll(env, token, `${apiHost}/firewall/v1/firewalls`, t.id); } catch { /* recorded below via counts */ }
      try { endpoints = await listAll(env, token, `${apiHost}/endpoint/v1/endpoints`, t.id); } catch { /* same */ }
      try { licenses = await listAll(env, token, `${apiHost}/licenses/v1/licenses`, t.id); } catch { /* licenses are decoration, never fatal */ }
      summary.devices += firewalls.length + endpoints.length;

      const expiryBySerial = {};
      for (const lic of licenses) {
        const serial = lic.serialNumber || lic.serial || (lic.device && lic.device.serialNumber);
        const expiry = lic.validUntil || lic.expiration || lic.expiresAt || lic.endDate;
        if (serial && expiry) expiryBySerial[String(serial)] = String(expiry).slice(0, 10);
      }

      const locationId = locationByTenant[t.id];
      if (!locationId) {
        summary.unmappedDevices += firewalls.length + endpoints.length;
        continue;
      }
      for (const fw of firewalls) {
        const serial = fw.serialNumber ? String(fw.serialNumber) : null;
        await upsert(locationId, {
          externalId: String(fw.id || serial || ""),
          name: fw.name ? String(fw.name) : null,
          type: "Firewall",
          model: fw.modelName || fw.model ? String(fw.modelName || fw.model) : null,
          serial,
          status: firewallStatus(fw),
          firmware: fw.firmwareVersion ? String(fw.firmwareVersion) : null,
          mac: normMac(fw.macAddress),
          licenseExpires: serial ? (expiryBySerial[serial] || null) : null,
        });
      }
      for (const ep of endpoints) {
        const macs = Array.isArray(ep.macAddresses) ? ep.macAddresses : [];
        await upsert(locationId, {
          externalId: String(ep.id || ""),
          name: ep.hostname ? String(ep.hostname) : null,
          type: String(ep.type || "").toLowerCase() === "server" ? "Server" : "Computer",
          model: ep.os && ep.os.name ? String(ep.os.name) : null,
          serial: ep.serialNumber ? String(ep.serialNumber) : null,
          status: endpointStatus(ep),
          firmware: null,
          mac: macs.length ? normMac(macs[0]) : null,
          licenseExpires: null,
        });
      }
    }

    for (const [locId, seen] of Object.entries(seenByLocation)) {
      const { results: rows } = await env.DB.prepare(
        "SELECT id FROM equipment WHERE location_id = ? AND source = 'sophos' AND status != 'offline'")
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
