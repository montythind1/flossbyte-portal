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

import { sendEmail, wrap } from "./email.js";
import { loadLinks, saveLinks, linkedRow, recordLink, macKey, srcKey } from "./links.js";

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

// The per-console Network API, reached through the Site Manager cloud
// connector with the same API key, serves what the account-level API
// cannot: the site's connected devices (PCs, phones, printers) and the
// wiring between everything (each client and device names the UniFi
// device it hangs off of, which is what the topology view draws).
// Resolves the console's local site, then reads its device list (for
// uuid -> MAC translation and device parents) and its client list.
// Returns { clients, uuidToMac, deviceParent } or null when the console
// cannot be reached either way the connector path is spelled.
async function fetchSiteLocal(env, hostId, consoleMac) {
  const bases = [
    `/v1/connector/consoles/${hostId}/network/integration/v1`,
    `/v1/connector/consoles/${hostId}/proxy/network/integration/v1`,
  ];
  for (const base of bases) {
    try {
      const localSites = pickArray(await fetchApi(env, `${base}/sites`), "sites");
      if (!localSites.length) continue;
      const local = localSites.find((s) => String(s.internalReference || "").toLowerCase() === "default") || localSites[0];
      const uuid = String(local.id || "");
      if (!uuid) continue;
      const paged = async (path) => {
        const out = [];
        let offset = 0;
        for (let page = 0; page < 10; page++) {
          const resp = await fetchApi(env, `${base}/sites/${uuid}/${path}?limit=200&offset=${offset}`);
          const batch = pickArray(resp, path);
          out.push(...batch);
          const total = Number(resp && resp.totalCount);
          offset += batch.length;
          if (!batch.length || (Number.isFinite(total) && offset >= total)) break;
        }
        return out;
      };
      const localDevices = await paged("devices");
      const uuidToMac = {};
      const ipByMac = {};
      for (const d of localDevices) {
        const m = normMac(d.macAddress || d.mac);
        if (d.id && m) uuidToMac[String(d.id)] = m;
        if (m && d.ipAddress) ipByMac[m] = String(d.ipAddress);
      }
      // Each local device's parent: its own uplink when the console will
      // say (a details read per device), otherwise the console itself,
      // which is where small-office gear hangs in practice.
      const deviceParent = {};
      for (const d of localDevices) {
        const m = normMac(d.macAddress || d.mac);
        if (!m) continue;
        if (consoleMac && m === consoleMac) { deviceParent[m] = null; continue; }
        let parent = consoleMac || null;
        try {
          const resp = await fetchApi(env, `${base}/sites/${uuid}/devices/${d.id}`);
          const det = resp && resp.data && typeof resp.data === "object" && !Array.isArray(resp.data) ? resp.data : resp;
          const up = (det && det.uplink) || {};
          const upId = up.deviceId || up.id || up.uplinkDeviceId || (det && det.uplinkDeviceId);
          const upMac = normMac(up.macAddress || up.mac);
          if (upId && uuidToMac[String(upId)] && uuidToMac[String(upId)] !== m) parent = uuidToMac[String(upId)];
          else if (upMac && upMac !== m) parent = upMac;
        } catch { /* keep the console fallback */ }
        deviceParent[m] = parent;
      }
      const clients = await paged("clients");
      // Everything else the console will tell us, each section read on
      // its own so one missing endpoint never sinks the others. Items
      // are trimmed to display fields; the full rule trees stay in
      // UniFi where they belong.
      const pick = (items, fields) => (Array.isArray(items) ? items : []).slice(0, 200).map((it) => {
        const o = {};
        for (const f of fields) if (it && it[f] !== undefined && it[f] !== null) o[f] = it[f];
        return o;
      });
      // Per-section read results, kept for diagnosis: consoles whose
      // Network app predates an integration endpoint answer 404 for it,
      // and the sync summary should say so instead of failing silently.
      const sectionStatus = {};
      const noteStatus = (key, items, err) => {
        if (err) {
          const m = /answered (\d{3})/.exec(String(err && err.message || ""));
          sectionStatus[key] = m ? m[1] : "error";
        } else {
          sectionStatus[key] = `ok ${Array.isArray(items) ? items.length : 0}`;
        }
      };
      const section = async (key, path, fields) => {
        try { const items = pick(await paged(path), fields); noteStatus(key, items, null); return items; }
        catch (err) { noteStatus(key, null, err); return null; }
      };
      const wans = await section("wans", "wans", ["name", "ipAddress", "ip", "state", "status", "type"]);
      const networks = await section("networks", "networks", ["name", "vlanId", "enabled", "default", "management"]);
      let ssids = null;
      try {
        const rawSsids = await paged("wifi/broadcasts");
        ssids = pick(rawSsids, ["name", "ssid", "enabled"]).map((s, i) => {
          const r = rawSsids[i] || {};
          const sec = r.security || (r.securityConfiguration && (r.securityConfiguration.type || r.securityConfiguration.mode)) || r.encryption;
          // Personal (PSK) security configurations carry the passphrase
          // in the API; keep it when a console provides it so the office
          // can see its own WiFi password in the portal.
          const pass = (r.securityConfiguration && r.securityConfiguration.passphrase) || r.passphrase || null;
          const out = sec ? { ...s, security: String(sec) } : { ...s };
          if (pass) out.pass = String(pass);
          return out;
        });
        noteStatus("ssids", ssids, null);
      } catch (err) { ssids = null; noteStatus("ssids", null, err); }
      const fwPolicies = await section("fwPolicies", "firewall/policies", ["name", "action", "enabled"]);
      const fwZones = await section("fwZones", "firewall/zones", ["name"]);
      const aclRules = await section("aclRules", "acl-rules", ["name", "action", "enabled"]);
      const vpnServers = await section("vpnServers", "vpn/servers", ["name", "type", "enabled"]);
      const vpnTunnels = await section("vpnTunnels", "vpn/site-to-site-tunnels", ["name", "type", "enabled", "state", "status"]);
      const radiusProfiles = await section("radiusProfiles", "radius/profiles", ["name"]);
      // Latest statistics for each adopted device (uptime, CPU, memory).
      const deviceStats = [];
      for (const d of localDevices.slice(0, 25)) {
        if (!d.id) continue;
        try {
          const st = await fetchApi(env, `${base}/sites/${uuid}/devices/${d.id}/statistics/latest`);
          const s = st && typeof st === "object"
            ? (st.uptimeSec !== undefined || st.cpuUtilizationPct !== undefined ? st : (st.data && typeof st.data === "object" ? st.data : null))
            : null;
          if (s) deviceStats.push({
            mac: d.macAddress || "", name: d.name || d.model || "",
            cpu: typeof s.cpuUtilizationPct === "number" ? s.cpuUtilizationPct : null,
            mem: typeof s.memoryUtilizationPct === "number" ? s.memoryUtilizationPct : null,
            uptimeSec: typeof s.uptimeSec === "number" ? s.uptimeSec : null,
            load1: typeof s.loadAverage1Min === "number" ? s.loadAverage1Min : null,
          });
        } catch { /* one device's statistics are optional */ }
      }
      // Protect probe: only consoles actually running Protect answer.
      let protect = null;
      for (const pbase of [`/v1/connector/consoles/${hostId}/protect/integration/v1`, `/v1/connector/consoles/${hostId}/proxy/protect/integration/v1`]) {
        try {
          await fetchApi(env, `${pbase}/meta/info`);
          const cams = await fetchApi(env, `${pbase}/cameras`);
          protect = { cameras: pick(pickArray(cams, "cameras"), ["name", "model", "state", "status"]) };
          break;
        } catch { protect = null; }
      }
      return { clients, uuidToMac, deviceParent, ipByMac, sectionStatus, sections: { wans, networks, ssids, fwPolicies, fwZones, aclRules, vpnServers, vpnTunnels, radiusProfiles, deviceStats, protect } };
    } catch { /* try the other connector path spelling */ }
  }
  return null;
}

export function normMac(value) {
  const hex = String(value || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return null;
  return hex.match(/../g).join(":");
}

function deviceType(d) {
  const t = String(d.type || "").toLowerCase();
  if (TYPE_LABELS[t]) return TYPE_LABELS[t];
  // The Site Manager API has no type field; the model shortname carries it.
  const sn = String(d.shortname || "").toLowerCase();
  if (sn.startsWith("ucg") || sn.startsWith("udm") || sn.startsWith("udr") || sn.startsWith("uxg") || sn.startsWith("ugw")) return "Gateway";
  // Access points: UAP* shortnames, the U6*/U7* WiFi generations (U6 Pro,
  // U7LR for the AC LR, ...), and legacy AC model names.
  if (sn.startsWith("uap") || sn.startsWith("u6") || sn.startsWith("u7")) return "Access point";
  const mdl = String(d.model || "");
  if (/^(U6|U7)\b/.test(mdl) || /^AC\s/.test(mdl)) return "Access point";
  if (sn.startsWith("usw")) return "Switch";
  if (sn.startsWith("unvr")) return "Recorder";
  if (sn.startsWith("uck") || sn.startsWith("ucck")) return "Controller";
  if (sn.startsWith("uvc")) return "Camera";
  if (t.startsWith("uap")) return "Access point";
  if (t.startsWith("usw")) return "Switch";
  if (d.productLine === "protect") return "Camera";
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

async function alertRecipients(env) {
  if (env.ADMIN_ALERT_EMAIL) return [env.ADMIN_ALERT_EMAIL];
  try {
    const { results } = await env.DB.prepare(
      "SELECT email FROM users WHERE kind = 'flossbyte' AND status = 'active' AND email IS NOT NULL").all();
    return (results || []).map((r) => r.email).filter(Boolean);
  } catch { return []; }
}

async function alertsMuted(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM system_state WHERE key = 'alerts_muted_until'").first();
    return !!(row && row.value && new Date(row.value).getTime() > Date.now());
  } catch { return false; }
}

export async function runUnifiSync(env) {
  const summary = {
    at: new Date().toISOString(), ok: false, message: "",
    sites: 0, devices: 0, inserted: 0, updated: 0, claimed: 0,
    offlined: 0, unmappedDevices: 0,
    clientsSeen: 0, clientsAdded: 0, clientsUpdated: 0, clientsOfflined: 0,
  };
  const finish = async () => { await setState(env.DB, "unifi_last_sync", JSON.stringify(summary)); return summary; };
  let preState = {};
  let locMeta = {};
  try {
    if (!env.UNIFI_API_KEY) { summary.message = "No UniFi API key is saved yet."; return finish(); }
    try {
      await env.DB.prepare("SELECT id FROM sync_sites LIMIT 1").all();
    } catch {
      summary.message = "Database update needed first: migration 0007 has not been applied.";
      return finish();
    }
    // Hosts are fetched first: on real accounts a site often carries no
    // friendly name of its own (its API "name" is just the site id), and
    // the name the admin recognizes is the console's reported name, the
    // same one unifi.ui.com shows. The hosts list is reused below for
    // the grouped-devices fallback.
    let hosts = [];
    try { hosts = pickArray(await fetchApi(env, "/v1/hosts"), "hosts"); } catch { hosts = []; }
    const hostNameById = {};
    for (const h of hosts) {
      const hn = h && h.reportedState && h.reportedState.name ? String(h.reportedState.name)
        : h && h.name ? String(h.name) : "";
      if (h && h.id && hn) hostNameById[String(h.id)] = hn;
    }
    // Discover the account's sites and remember them for the mapping page.
    const sites = pickArray(await fetchApi(env, "/v1/sites"), "sites");
    const hostToSites = {};
    const hostIdBySite = {};
    for (const s of sites) {
      const siteId = String(s.id || s.siteId || "");
      if (!siteId) continue;
      if (s.hostId) hostIdBySite[siteId] = String(s.hostId);
      const rawName = String(s.desc || s.name || "");
      const hostName = s.hostId ? hostNameById[String(s.hostId)] : "";
      const siteName = rawName && rawName !== siteId ? rawName : hostName || rawName || siteId;
      await env.DB.prepare(
        `INSERT INTO sync_sites (provider, site_id, site_name) VALUES ('unifi', ?, ?)
         ON CONFLICT(provider, site_id) DO UPDATE SET site_name = excluded.site_name, updated_at = datetime('now')`)
        .bind(siteId, siteName).run();
      if (s.hostId) (hostToSites[String(s.hostId)] ||= []).push(siteId);
    }
    summary.sites = sites.length;

    // The devices endpoint answers with one entry per HOST, each carrying
    // its own devices array (per Ubiquiti's OpenAPI spec); flatten those
    // groups, keeping the group hostId on every device so the device can
    // be attributed to a site. A flat device list is accepted too, and
    // the response envelope's nextToken is followed for large accounts.
    let devices = [];
    let nextToken = null;
    for (let page = 0; page < 5; page++) {
      const resp = await fetchApi(env, "/v1/devices" + (nextToken ? `?nextToken=${encodeURIComponent(nextToken)}` : ""));
      for (const g of pickArray(resp, "devices")) {
        if (g && Array.isArray(g.devices)) {
          for (const d of g.devices) devices.push({ ...d, hostId: d.hostId || g.hostId || g.id });
        } else if (g && (g.mac || g.id)) {
          devices.push(g);
        }
      }
      nextToken = resp && typeof resp.nextToken === "string" && resp.nextToken ? resp.nextToken : null;
      if (!nextToken) break;
    }
    if (!devices.length) {
      // Some accounts expose devices grouped under their hosts instead.
      for (const h of hosts) {
        for (const d of h.devices || []) devices.push({ ...d, hostId: d.hostId || h.id });
      }
    }
    summary.devices = devices.length;

    // ISP metrics (account level; hourly metrics are retained 30 days):
    // aggregate the last 24 hours per site for the internet-health
    // snapshot. Purely an enhancement; failure skips the section.
    const ispBySite = {};
    try {
      const resp = await fetchApi(env, "/v1/isp-metrics/1h?duration=7d");
      for (const entry of pickArray(resp, "metrics")) {
        if (!entry || !entry.siteId || !Array.isArray(entry.periods) || !entry.periods.length) continue;
        const periods = entry.periods.slice(-24);
        const metrics = periods.map((p) => (p.data && p.data.wan) || {});
        const avg = (k) => {
          const vals = metrics.map((w) => Number(w[k])).filter((v) => Number.isFinite(v));
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        };
        ispBySite[String(entry.siteId)] = {
          ispName: (metrics[metrics.length - 1] || {}).ispName || null,
          hours: periods.length,
          avgLatencyMs: avg("avgLatency"),
          maxLatencyMs: Math.max(0, ...metrics.map((w) => Number(w.maxLatency) || 0)),
          packetLossPct: avg("packetLoss"),
          uptimePct: avg("uptime"),
          downtimeSec: metrics.reduce((a, w) => a + (Number(w.downtime) || 0), 0),
          downMbps: avg("download_kbps") != null ? avg("download_kbps") / 1000 : null,
          upMbps: avg("upload_kbps") != null ? avg("upload_kbps") / 1000 : null,
        };
      }
    } catch { /* ISP metrics are an enhancement */ }

    const { results: mapRows } = await env.DB.prepare(
      "SELECT site_id, location_id FROM sync_sites WHERE provider = 'unifi' AND location_id IS NOT NULL").all();
    const locationBySite = {};
    for (const r of mapRows || []) locationBySite[r.site_id] = r.location_id;

    // Pre-run equipment state per mapped location, so after the run
    // the sync can tell what went offline (alert emails) and what is
    // brand new (change-history events). (Declared before the try so
    // the post-run alert pass can read them.)
    preState = {};
    locMeta = {};
    try {
      for (const locId of [...new Set(Object.values(locationBySite))]) {
        const { results: rows } = await env.DB.prepare(
          "SELECT source, external_id, mac, name, type, status FROM equipment WHERE location_id = ?").bind(locId).all();
        const m = new Map();
        for (const r of rows || []) { const k = r.external_id || r.mac; if (k) m.set(k, r); }
        preState[locId] = m;
        const meta = await env.DB.prepare(
          "SELECT l.name AS loc_name, c.name AS cust_name FROM locations l JOIN customers c ON c.id = l.customer_id WHERE l.id = ?").bind(locId).first();
        if (meta) locMeta[locId] = meta;
      }
    } catch { /* alerts are an enhancement; the sync proceeds without */ }

    // Topology parents (migration 0010) are written only when the
    // column exists, so this sync keeps working before it is applied.
    let hasParent = true;
    try { await env.DB.prepare("SELECT parent_mac FROM equipment LIMIT 1").all(); } catch { hasParent = false; }
    let hasIp = true;
    try { await env.DB.prepare("SELECT ip_address FROM equipment LIMIT 1").all(); } catch { hasIp = false; }
    // Snapshots (migration 0011) are stored only when the table exists,
    // so this sync keeps working before it is applied.
    let hasSnapshots = true;
    try { await env.DB.prepare("SELECT id FROM network_snapshots LIMIT 1").all(); } catch { hasSnapshots = false; }

    // Each console's own MAC, per site, from the Site Manager device
    // list: the anchor the topology parents hang off of.
    const consoleMacBySite = {};
    for (const d of devices) {
      if (!d.isConsole || !d.hostId) continue;
      const cands = hostToSites[String(d.hostId)] || [];
      if (cands.length === 1) {
        const m = normMac(d.mac);
        if (m) consoleMacBySite[cands[0]] = m;
      }
    }
    // One read of each mapped site's console-local API up front: the
    // device phase takes its topology parents from it and the client
    // phase below takes the connected devices.
    const siteLocal = {};
    for (const [siteId] of Object.entries(locationBySite)) {
      const hostId = hostIdBySite[siteId];
      siteLocal[siteId] = hostId ? await fetchSiteLocal(env, hostId, consoleMacBySite[siteId] || null) : null;
      if (!siteLocal[siteId]) summary.clientsError = "One or more consoles could not be read for connected devices.";
    }
    // Merge the per-console section results into the run summary, so
    // the Device sync page shows which reads each console answered.
    const mergedChecks = {};
    for (const local of Object.values(siteLocal)) {
      if (!local || !local.sectionStatus) continue;
      for (const [k, v] of Object.entries(local.sectionStatus)) {
        const ok = v.startsWith("ok");
        if (!mergedChecks[k]) mergedChecks[k] = v;
        else {
          const curOk = mergedChecks[k].startsWith("ok");
          if (ok && curOk) mergedChecks[k] = "ok"; // counts differ per site; fine
          else if (ok && !curOk) mergedChecks[k] = `partial (${mergedChecks[k]})`;
          else if (!ok && curOk) mergedChecks[k] = `partial (${v})`;
          else if (mergedChecks[k] !== v && !mergedChecks[k].startsWith("partial")) mergedChecks[k] = "mixed errors";
        }
      }
    }
    if (Object.keys(mergedChecks).length) summary.sectionChecks = mergedChecks;

    const seenByLocation = {};
    for (const locId of Object.values(locationBySite)) seenByLocation[locId] = new Set();
    // Durable identity links (src/links.js), shared with the other syncs.
    const linksByLocation = new Map();
    const linksDirty = new Set();
    const linksFor = async (locId) => {
      if (!linksByLocation.has(locId)) linksByLocation.set(locId, await loadLinks(env.DB, locId));
      return linksByLocation.get(locId);
    };

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
      const links = await linksFor(locationId);
      let row = await linkedRow(env.DB, locationId, links, [srcKey("unifi", externalId), macKey(mac)]);
      if (!row) row = await env.DB.prepare(
        "SELECT * FROM equipment WHERE source = 'unifi' AND external_id = ?").bind(externalId).first();
      if (!row && mac) {
        row = await env.DB.prepare(
          "SELECT * FROM equipment WHERE location_id = ? AND mac = ?").bind(locationId, mac).first();
      }
      if (!row && fields.serial) {
        row = await env.DB.prepare(
          "SELECT * FROM equipment WHERE location_id = ? AND serial = ?").bind(locationId, fields.serial).first();
      }
      const local = siteId ? siteLocal[String(siteId)] : null;
      const parentMac = hasParent && local && mac ? (local.deviceParent[mac] ?? null) : null;
      // The console's own device list carries each box's LAN address;
      // store it when this run actually read it (never erase a known
      // address with an unread console's silence).
      const ipVal = hasIp && local && mac ? (local.ipByMac && local.ipByMac[mac]) || null : null;
      if (row && row.source && row.source !== "unifi" && row.source !== "manual") {
        // Another sync owns this record: contribute network facts only
        // (presence, address, uplink), never rename, retype, or steal it.
        const fbinds = [fields.status];
        let fsql = "UPDATE equipment SET status = ?";
        if (ipVal) { fsql += ", ip_address = ?"; fbinds.push(ipVal); }
        if (hasParent) { fsql += ", parent_mac = COALESCE(?, parent_mac)"; fbinds.push(parentMac); }
        fsql += ", last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?";
        fbinds.push(row.id);
        await env.DB.prepare(fsql).bind(...fbinds).run();
        summary.updated++;
        seenByLocation[locationId].add(row.id);
        if (recordLink(links, row.id, [srcKey("unifi", externalId), macKey(mac)])) linksDirty.add(locationId);
      } else if (row) {
        if (row.source !== "unifi") summary.claimed++;
        const binds = [locationId, fields.type, fields.model, fields.name, fields.serial,
          fields.status, fields.firmware, mac, externalId];
        let sql = `UPDATE equipment SET location_id = ?, vendor = 'UniFi', type = ?, model = ?, name = ?,
          serial = COALESCE(?, serial), status = ?, firmware = ?, mac = ?, source = 'unifi', external_id = ?`;
        if (ipVal) { sql += ", ip_address = ?"; binds.push(ipVal); }
        if (hasParent) { sql += ", parent_mac = COALESCE(?, parent_mac)"; binds.push(parentMac); }
        sql += ", last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?";
        binds.push(row.id);
        await env.DB.prepare(sql).bind(...binds).run();
        summary.updated++;
        seenByLocation[locationId].add(row.id);
        if (recordLink(links, row.id, [srcKey("unifi", externalId), macKey(mac)])) linksDirty.add(locationId);
      } else {
        const cols = ["location_id", "vendor", "type", "model", "serial", "status", "firmware", "name", "mac", "source", "external_id"];
        const vals = ["?", "'UniFi'", "?", "?", "?", "?", "?", "?", "?", "'unifi'", "?"];
        const binds = [locationId, fields.type, fields.model, fields.serial, fields.status,
          fields.firmware, fields.name, mac, externalId];
        if (ipVal) { cols.push("ip_address"); vals.push("?"); binds.push(ipVal); }
        if (hasParent) { cols.push("parent_mac"); vals.push("?"); binds.push(parentMac); }
        cols.push("last_seen_at"); vals.push("datetime('now')");
        const ins = await env.DB.prepare(
          `INSERT INTO equipment (${cols.join(", ")}) VALUES (${vals.join(", ")})`).bind(...binds).run();
        summary.inserted++;
        seenByLocation[locationId].add(ins.meta.last_row_id);
        if (recordLink(links, ins.meta.last_row_id, [srcKey("unifi", externalId), macKey(mac)])) linksDirty.add(locationId);
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

    // Connected devices: the endpoints on each mapped site's network,
    // pulled per console through the cloud connector. Only WIRED and
    // WIRELESS clients are imported; VPN and Teleport entries are remote
    // connections, not devices at the office. This phase never fails the
    // device sync: a console that cannot be read is noted in the summary
    // and its known endpoints are left untouched.
    try {
      const seenClientsByLocation = {};
      const readLocations = new Set();
      for (const [siteId, locationId] of Object.entries(locationBySite)) {
        const local = siteLocal[siteId];
        if (!local) continue;
        readLocations.add(locationId);
        if (!seenClientsByLocation[locationId]) seenClientsByLocation[locationId] = new Set();
        const seen = seenClientsByLocation[locationId];
        for (const c of local.clients) {
          const kind = String(c.type || "").toUpperCase();
          if (kind !== "WIRED" && kind !== "WIRELESS") continue;
          const mac = normMac(c.macAddress || c.mac);
          if (!mac) continue;
          summary.clientsSeen++;
          const externalId = "client:" + mac.replace(/:/g, "");
          const name = c.name ? String(c.name) : mac;
          const parentMac = hasParent
            ? (c.uplinkDeviceId && local.uuidToMac[String(c.uplinkDeviceId)]) || consoleMacBySite[siteId] || null
            : null;
          const links = await linksFor(locationId);
          let row = await linkedRow(env.DB, locationId, links, [srcKey("unifi", externalId), macKey(mac)]);
          if (!row) row = await env.DB.prepare(
            "SELECT * FROM equipment WHERE source = 'unifi-client' AND external_id = ?").bind(externalId).first();
          if (!row) {
            row = await env.DB.prepare(
              "SELECT * FROM equipment WHERE location_id = ? AND mac = ?").bind(locationId, mac).first();
          }
          const clientIp = hasIp ? (c.ipAddress || c.ip || null) : null;
          if (row && row.source && row.source !== "unifi-client" && row.source !== "manual" && row.location_id === locationId) {
            // Another sync owns this record: contribute network facts
            // only (presence, address, uplink), never rename or steal.
            const fbinds = [];
            let fsql = "UPDATE equipment SET status = 'online'";
            if (clientIp) { fsql += ", ip_address = ?"; fbinds.push(String(clientIp)); }
            if (hasParent) { fsql += ", parent_mac = COALESCE(?, parent_mac)"; fbinds.push(parentMac); }
            fsql += ", last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?";
            fbinds.push(row.id);
            await env.DB.prepare(fsql).bind(...fbinds).run();
            summary.clientsUpdated++;
            seen.add(row.id);
            if (recordLink(links, row.id, [srcKey("unifi", externalId), macKey(mac)])) linksDirty.add(locationId);
          } else if (row) {
            const binds = [locationId, name, mac, externalId];
            let sql = `UPDATE equipment SET location_id = ?, vendor = 'UniFi', type = 'Connected device', name = ?,
              status = 'online', mac = ?, source = 'unifi-client', external_id = ?`;
            if (clientIp) { sql += ", ip_address = ?"; binds.push(String(clientIp)); }
            if (hasParent) { sql += ", parent_mac = COALESCE(?, parent_mac)"; binds.push(parentMac); }
            sql += ", last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?";
            binds.push(row.id);
            await env.DB.prepare(sql).bind(...binds).run();
            summary.clientsUpdated++;
            seen.add(row.id);
            if (recordLink(links, row.id, [srcKey("unifi", externalId), macKey(mac)])) linksDirty.add(locationId);
          } else {
            const cols = ["location_id", "vendor", "type", "model", "serial", "status", "firmware", "name", "mac", "source", "external_id"];
            const vals = ["?", "'UniFi'", "'Connected device'", "NULL", "NULL", "'online'", "NULL", "?", "?", "'unifi-client'", "?"];
            const binds = [locationId, name, mac, externalId];
            if (clientIp) { cols.push("ip_address"); vals.push("?"); binds.push(String(clientIp)); }
            if (hasParent) { cols.push("parent_mac"); vals.push("?"); binds.push(parentMac); }
            cols.push("last_seen_at"); vals.push("datetime('now')");
            const ins = await env.DB.prepare(
              `INSERT INTO equipment (${cols.join(", ")}) VALUES (${vals.join(", ")})`).bind(...binds).run();
            summary.clientsAdded++;
            seen.add(ins.meta.last_row_id);
            if (recordLink(links, ins.meta.last_row_id, [srcKey("unifi", externalId), macKey(mac)])) linksDirty.add(locationId);
          }
        }
      }
      // A connected device that no longer appears has been disconnected
      // or removed: flag it offline, never delete it. Only locations
      // whose console answered this run take part.
      for (const locId of readLocations) {
        const seen = seenClientsByLocation[locId] || new Set();
        const { results: rows } = await env.DB.prepare(
          "SELECT id FROM equipment WHERE location_id = ? AND source = 'unifi-client' AND status != 'offline'")
          .bind(locId).all();
        for (const r of rows || []) {
          if (!seen.has(r.id)) {
            await env.DB.prepare(
              "UPDATE equipment SET status = 'offline', updated_at = datetime('now') WHERE id = ?").bind(r.id).run();
            summary.clientsOfflined++;
          }
        }
      }
    } catch (err) {
      summary.clientsError = String(err && err.message || err);
    }
    // Persist any identity links learned this run.
    for (const locId of linksDirty) {
      try { await saveLinks(env.DB, locId, linksByLocation.get(locId)); } catch { /* best effort */ }
    }
    // Network snapshots (migration 0011): store the latest reads per
    // mapped location for the Network page. A section that failed to
    // read this run keeps its previous snapshot untouched.
    if (hasSnapshots) {
      try {
        for (const [siteId, locationId] of Object.entries(locationBySite)) {
          const local = siteLocal[siteId];
          const writes = [];
          const isp = ispBySite[siteId] || null;
          const wans = local && local.sections ? local.sections.wans : null;
          if (isp || wans) writes.push(["internet", { isp, wans: wans || [] }]);
          if (local && local.sections) {
            const s = local.sections;
            if (s.networks || s.ssids || s.fwPolicies || s.fwZones || s.vpnServers || s.vpnTunnels) {
              writes.push(["config", {
                networks: s.networks || [], ssids: s.ssids || [],
                firewallPolicies: s.fwPolicies || [], firewallZones: s.fwZones || [],
                aclRules: s.aclRules || [], vpnServers: s.vpnServers || [],
                vpnTunnels: s.vpnTunnels || [], radiusProfiles: s.radiusProfiles || [],
              }]);
            }
            if (s.deviceStats && s.deviceStats.length) writes.push(["device_stats", { devices: s.deviceStats }]);
            if (s.protect) writes.push(["protect", s.protect]);
          }
          // Change history: diff the new reads against what is stored
          // and keep a running event list inside a 'changes' snapshot
          // (no extra table needed). The first capture is a baseline
          // and logs nothing. Structural changes only (settings and
          // membership), never metric noise.
          if (writes.length) {
            try {
              const prev = {};
              const { results: prevRows } = await env.DB.prepare(
                "SELECT kind, payload FROM network_snapshots WHERE location_id = ?").bind(locationId).all();
              for (const r of prevRows || []) { try { prev[r.kind] = JSON.parse(r.payload || "{}"); } catch { prev[r.kind] = {}; } }
              const hadBaseline = Object.keys(prev).some((k) => k !== "changes");
              const events = [];
              const nameSet = (arr) => new Set((arr || []).map((x) => String(x.name || x.ssid || "")).filter(Boolean));
              const diffList = (oldArr, newArr, label) => {
                const o = nameSet(oldArr), n = nameSet(newArr);
                for (const name of n) if (!o.has(name)) events.push(`${label} added: ${name}`);
                for (const name of o) if (!n.has(name)) events.push(`${label} removed: ${name}`);
              };
              const newByKind = {};
              for (const [kind, payload] of writes) newByKind[kind] = payload;
              if (hadBaseline) {
                if (newByKind.config) {
                  const oc = prev.config || {}, nc = newByKind.config;
                  diffList(oc.networks, nc.networks, "Network");
                  diffList(oc.ssids, nc.ssids, "WiFi network");
                  diffList(oc.firewallPolicies, nc.firewallPolicies, "Firewall policy");
                  diffList(oc.vpnServers, nc.vpnServers, "VPN server");
                  diffList(oc.vpnTunnels, nc.vpnTunnels, "VPN tunnel");
                  diffList(oc.firewallZones, nc.firewallZones, "Firewall zone");
                  const oldSsid = {};
                  for (const s of oc.ssids || []) oldSsid[s.name || s.ssid] = s;
                  for (const s of nc.ssids || []) {
                    const o = oldSsid[s.name || s.ssid];
                    if (o && (o.security || "") !== (s.security || "")) events.push(`WiFi security changed for ${s.name || s.ssid}: ${o.security || "none"} to ${s.security || "none"}`);
                    // Password changes are logged, never with the value;
                    // the snapshot itself carries the new password.
                    if (o && o.pass && s.pass && o.pass !== s.pass) events.push(`WiFi password changed for ${s.name || s.ssid}`);
                    else if (o && !o.pass && s.pass) events.push(`WiFi password is now on record for ${s.name || s.ssid}`);
                  }
                  const oldTun = {};
                  for (const t of oc.vpnTunnels || []) oldTun[t.name] = t;
                  for (const t of nc.vpnTunnels || []) {
                    const o = oldTun[t.name];
                    const os = o && (o.state || o.status), ns = t.state || t.status;
                    if (o && ns && os !== ns) events.push(`VPN tunnel ${t.name} is now ${ns}`);
                  }
                }
                if (newByKind.internet) {
                  const oi = prev.internet || {}, ni = newByKind.internet;
                  if (oi.isp && ni.isp && oi.isp.ispName && ni.isp.ispName && oi.isp.ispName !== ni.isp.ispName) events.push(`Internet provider changed: ${oi.isp.ispName} to ${ni.isp.ispName}`);
                  diffList(oi.wans, ni.wans, "WAN interface");
                }
                if (newByKind.protect) diffList((prev.protect || {}).cameras, newByKind.protect.cameras, "Camera");
                if (newByKind.device_stats) diffList((prev.device_stats || {}).devices, newByKind.device_stats.devices, "Device tracked");
              }
              if (events.length) {
                const nowIso = new Date().toISOString();
                const oldEvents = prev.changes && Array.isArray(prev.changes.events) ? prev.changes.events : [];
                writes.push(["changes", { events: [...events.map((text) => ({ at: nowIso, text })), ...oldEvents].slice(0, 60) }]);
                summary.changesLogged = (summary.changesLogged || 0) + events.length;
              }
              // Internet history: one entry per day (the rolling
              // 24-hour aggregate at capture time), kept 31 days, so
              // the WiFi & Internet page can chart a month of uptime.
              if (newByKind.internet && newByKind.internet.isp) {
                const ispH = newByKind.internet.isp;
                const days = ((prev.internet_history || {}).days || []).filter((d) => d && d.date);
                const today = new Date().toISOString().slice(0, 10);
                const entry = {
                  date: today,
                  uptimePct: ispH.uptimePct != null ? ispH.uptimePct : null,
                  downtimeMin: ispH.downtimeSec != null ? Math.round(ispH.downtimeSec / 60) : null,
                  downMbps: ispH.downMbps != null ? Math.round(ispH.downMbps) : null,
                  upMbps: ispH.upMbps != null ? Math.round(ispH.upMbps) : null,
                };
                const merged = [...days.filter((d) => d.date !== today), entry]
                  .sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-31);
                writes.push(["internet_history", { days: merged }]);
              }
            } catch { /* change logging never breaks the sync */ }
          }
          for (const [kind, payload] of writes) {
            await env.DB.prepare(
              `INSERT INTO network_snapshots (location_id, kind, payload, captured_at) VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(location_id, kind) DO UPDATE SET payload = excluded.payload, captured_at = datetime('now')`)
              .bind(locationId, kind, JSON.stringify(payload)).run();
            summary.snapshots = (summary.snapshots || 0) + 1;
          }
        }
      } catch (err) {
        summary.snapshotError = String(err && err.message || err);
      }
    }
    summary.ok = true;
    summary.message = "Sync complete.";
  } catch (err) {
    summary.message = String(err && err.message || err);
  }
  // Offline alert emails + new-device change events, from the
  // pre-run/post-run equipment diff. Best-effort throughout: alerting
  // must never break or fail the sync itself, and only runs after a
  // sync that completed cleanly.
  if (summary.ok) { try {
    const muted = await alertsMuted(env);
    const recipients = muted ? [] : await alertRecipients(env);
    let alertsSent = 0, newDevices = 0;
    const isKeyDevice = (r) => r.source === "unifi" || /server|firewall|gateway/i.test(`${r.type || ""} ${r.name || ""}`);
    for (const locId of Object.keys(preState)) {
      const pre = preState[locId];
      const { results: postRows } = await env.DB.prepare(
        "SELECT source, external_id, mac, name, type, status FROM equipment WHERE location_id = ?").bind(Number(locId)).all();
      const post = new Map();
      for (const r of postRows || []) { const k = r.external_id || r.mac; if (k) post.set(k, r); }
      let snapOk = true;
      try { await env.DB.prepare("SELECT id FROM network_snapshots LIMIT 1").all(); } catch { snapOk = false; }
      if (snapOk && pre.size) {
        const fresh = [];
        for (const [k, r] of post) if (!pre.has(k)) fresh.push(r.name || r.type || "Device");
        if (fresh.length) {
          newDevices += fresh.length;
          try {
            const snap = await env.DB.prepare(
              "SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = 'changes'").bind(Number(locId)).first();
            const old = snap && snap.payload ? (JSON.parse(snap.payload).events || []) : [];
            const nowIso = new Date().toISOString();
            const evs = fresh.slice(0, 5).map((n) => ({ at: nowIso, text: `New device joined the network: ${n}` }));
            await env.DB.prepare(
              `INSERT INTO network_snapshots (location_id, kind, payload, captured_at) VALUES (?, 'changes', ?, datetime('now'))
               ON CONFLICT(location_id, kind) DO UPDATE SET payload = excluded.payload, captured_at = datetime('now')`)
              .bind(Number(locId), JSON.stringify({ events: [...evs, ...old].slice(0, 60) })).run();
          } catch { /* event logging is best-effort */ }
        }
      }
      const wentOffline = [];
      let preOnline = 0;
      for (const [k, r] of pre) {
        if (r.status === "offline") continue;
        preOnline++;
        const now = post.get(k);
        if (now && now.status === "offline") wentOffline.push(now);
      }
      if (!wentOffline.length || muted || !recipients.length) continue;
      const meta = locMeta[locId] || {};
      const locName = meta.loc_name || "An office";
      const where = meta.cust_name ? `${locName} (${meta.cust_name})` : locName;
      const siteDown = preOnline >= 3 && wentOffline.length === preOnline;
      const mails = [];
      if (siteDown) {
        mails.push({
          subject: `Portal alert: ${locName} appears to be down`,
          text: `Every device at ${where} went offline in the latest check (${preOnline} devices). This usually means the internet connection or power is out at the office. The portal keeps checking every 15 minutes.`,
        });
      } else {
        for (const d of wentOffline.filter(isKeyDevice).slice(0, 3)) {
          mails.push({
            subject: `Portal alert: ${d.name || d.type || "A device"} is offline at ${locName}`,
            text: `${d.name || d.type || "A device"} at ${where} was online and is now offline as of the latest check. The portal keeps checking every 15 minutes.`,
          });
        }
      }
      for (const mail of mails) {
        const html = wrap(mail.subject, `<p>${mail.text}</p><p style="color:#5B6B82">Sent by FlossByte Portal device monitoring. You can pause these alerts from the Device sync page.</p>`);
        for (const to of recipients) {
          await sendEmail(env, { to, template: "device_alert", subject: mail.subject, html, text: mail.text });
          alertsSent++;
        }
      }
    }
    if (alertsSent) summary.alertsSent = alertsSent;
    if (newDevices) summary.newDevices = newDevices;
  } catch { /* alerting never breaks the sync */ } }
  return finish();
}
