// Atera API sync (v3, one account-wide API key saved as the
// ATERA_API_KEY secret). Mirrors each mapped customer's agents
// (workstations and servers) into the equipment table, and stores the
// per-computer detail Atera knows (OS, hardware, signed-in user, last
// reboot, waiting patches, open alerts) in network_snapshots so the
// device pages and Ask can use it.
//
// Mapping unit in sync_sites (provider 'atera'): "cust:<CustomerID>",
// or "cust:<CustomerID>:site:<site key>" when the customer's agents
// carry site names, so a two-office customer can map each office
// separately - the same map-first rule as UniFi and Sophos: nothing
// imports until an admin maps it.
//
// The join is careful about duplicates: an agent matches an existing
// equipment row by Atera id, then MAC, then serial, then name. A row
// another sync owns (a UniFi connected device, say) is enriched in
// place but never stolen - its source and external id stay its own.
// Rows this sync created are marked offline when their agent vanishes,
// never deleted. Patch state is heavy (one call per agent), so it
// refreshes at most once an hour even though the sync runs more often.

import { normMac } from "./unifi.js";
import { loadLinks, saveLinks, linkedRow, recordLink, macKey, srcKey } from "./links.js";

function apiBase(env) { return env.ATERA_API_BASE || "https://app.atera.com"; }

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

export async function lastAteraSync(env) {
  const raw = await getState(env.DB, "atera_last_sync");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function apiGet(env, path) {
  const resp = await fetch(`${apiBase(env)}${path}`, {
    headers: { "X-API-KEY": env.ATERA_API_KEY, "Accept": "application/json" },
  });
  if (!resp.ok) throw new Error(`Atera answered ${resp.status} for ${path.split("?")[0]}.`);
  return resp.json();
}

// List endpoints answer with a bare array or an envelope; accept both
// and follow pages of 100 (capped) until a short page comes back.
async function listAll(env, path) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await apiGet(env, `${path}${sep}page=${page}&itemsInPage=100`);
    const items = Array.isArray(data) ? data : (data.items || data.data || []);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

function pick(obj, ...names) {
  for (const n of names) {
    const v = obj ? obj[n] : undefined;
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === "string") return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

// Atera dates arrive as ISO strings or .NET /Date(ms)/ payloads.
function isoDate(v) {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/\/Date\((\d+)\)\//);
  if (m) return new Date(Number(m[1])).toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Atera's field names drift between API generations (LastSeen vs
// LastContactTime, MachineName vs AgentName), so after the exact
// candidates, fall back to any key that looks like the concept.
function pickFuzzy(obj, pattern) {
  if (!obj) return null;
  for (const k of Object.keys(obj)) {
    if (pattern.test(k)) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
  }
  return null;
}

function agentShape(a) {
  const siteName = pick(a, "SiteName", "FolderName");
  const siteId = pick(a, "SiteID", "SiteId", "FolderID");
  const osType = String(pick(a, "OSType", "OsType") || "");
  const os = [pick(a, "OSVersion", "OperatingSystem", "OS"), pick(a, "OSBuild", "BuildNumber") ? `build ${pick(a, "OSBuild", "BuildNumber")}` : null]
    .filter(Boolean).join(" · ") || osType || null;
  return {
    agentId: pick(a, "AgentID", "AgentId", "ID"),
    guid: pick(a, "DeviceGuid", "DeviceGUID", "Guid"),
    customerId: pick(a, "CustomerID", "CustomerId"),
    customerName: pick(a, "CustomerName"),
    siteKey: siteId != null ? String(siteId) : (siteName ? String(siteName).toLowerCase().replace(/[^a-z0-9]+/g, "-") : null),
    siteName: siteName ? String(siteName) : null,
    name: String(pick(a, "MachineName", "DeviceName", "AgentName", "HostName", "ComputerName", "Name") || pickFuzzy(a, /^(machine|host|computer|device|agent)name$/i) || "Computer"),
    online: a.Online === true || a.Online === 1 || String(a.Online).toLowerCase() === "online" || String(a.Online).toLowerCase() === "true",
    lastSeen: isoDate(pick(a, "LastSeen", "LastSeenDate", "LastConnectionTime") || pickFuzzy(a, /^last.*(seen|contact|online|activity|checkin)/i)),
    type: /server/i.test(osType) || /server/i.test(os || "") ? "Server" : "Computer",
    os,
    mac: normMac(asList(pick(a, "MacAddresses", "MacAddress", "MACAddress", "Mac"))[0] || ""),
    macs: [...new Set(asList(pick(a, "MacAddresses", "MacAddress", "MACAddress", "Mac")).map((m) => normMac(m)).filter(Boolean))],
    ip: asList(pick(a, "IPAddresses", "IpAddresses", "IPAddress"))[0] || null,
    serial: pick(a, "SerialNumber", "Serial"),
    model: [pick(a, "SystemManufacturer", "Manufacturer", "Vendor"), pick(a, "SystemModel", "Model")].filter(Boolean).join(" ") || null,
    cpu: pick(a, "Processor", "CPU", "Cpu"),
    // Atera reports memory in MB (16165 means ~16 GB); a value that
    // small in GB would be a very strange machine, so convert.
    memoryGb: (() => { const m = pick(a, "Memory", "RAM", "RamGB"); const n = Number(m); if (!Number.isFinite(n) || n <= 0) return null; const gb = n > 200 ? n / 1024 : n; return Math.round(gb * 10) / 10; })(),
    // Atera sometimes appends "(Since: Nov 6, 2026 5:50:55 PM)" to
    // the signed-in user; the portal shows the person, not the note.
    user: (() => { const u = pick(a, "CurrentLoggedUser", "CurrentUser", "LoggedUser") || pickFuzzy(a, /(logged|current).*(user|in)/i); return u ? String(u).replace(/\s*\(since:[^)]*\)\s*$/i, "").trim() : u; })(),
    lastReboot: isoDate(pick(a, "LastRebootTime", "LastReboot", "LastBootTime") || pickFuzzy(a, /^last.*(reboot|boot|restart)/i)),
  };
}

// Monitoring devices: gear that cannot run an agent (printers, NAS,
// UPS, CBCT...), watched by an agent PC on the same network. Atera
// serves them at GET /api/v3/devices; field names vary by device kind
// (SNMP / TCP / HTTP / Generic), so extraction stays tolerant.
function deviceShape(d) {
  const siteName = pick(d, "SiteName", "FolderName");
  const siteId = pick(d, "SiteID", "SiteId", "FolderID");
  const rawType = String(pick(d, "DeviceType", "Type", "MonitorType", "DeviceClass") || d.__kind || "");
  const type = /printer/i.test(rawType) ? "Printer"
    : /nas|storage/i.test(rawType) ? "NAS"
    : /ups|battery/i.test(rawType) ? "UPS"
    : /switch/i.test(rawType) ? "Switch"
    : /router|gateway|firewall/i.test(rawType) ? "Router"
    : /phone|voip/i.test(rawType) ? "Phone"
    : /camera/i.test(rawType) ? "Camera"
    : rawType ? rawType.charAt(0).toUpperCase() + rawType.slice(1) : "Monitored device";
  const st = String(pick(d, "Status", "State", "AvailabilityStatus") || "");
  const ipRaw = asList(pick(d, "IPAddresses", "IpAddresses", "IPAddress", "IP", "Address"))[0] || null;
  return {
    id: pick(d, "DeviceID", "DeviceId", "ID", "DeviceGuid", "Guid"),
    customerId: pick(d, "CustomerID", "CustomerId"),
    customerName: pick(d, "CustomerName"),
    siteKey: siteId != null ? String(siteId) : (siteName ? String(siteName).toLowerCase().replace(/[^a-z0-9]+/g, "-") : null),
    siteName: siteName ? String(siteName) : null,
    name: String(pick(d, "DeviceName", "Name", "HostName", "MachineName") || pickFuzzy(d, /(device|host|machine)name$/i) || "Monitored device"),
    type,
    online: d.Online === true || d.Online === 1 || /online|up|available|connected|active/i.test(st),
    lastSeen: isoDate(pick(d, "LastSeen", "LastSeenDate") || pickFuzzy(d, /^last.*(seen|contact|check)/i)),
    mac: normMac(asList(pick(d, "MacAddresses", "MacAddress", "MACAddress", "Mac"))[0] || ""),
    macs: [...new Set(asList(pick(d, "MacAddresses", "MacAddress", "MACAddress", "Mac")).map((m) => normMac(m)).filter(Boolean))],
    ip: ipRaw && /^\d{1,3}(\.\d{1,3}){3}$/.test(String(ipRaw)) ? String(ipRaw) : null,
  };
}

function groupKey(agent) {
  return agent.siteKey ? `cust:${agent.customerId}:site:${agent.siteKey}` : `cust:${agent.customerId}`;
}

async function saveSnapshot(db, locationId, kind, payload) {
  await db.prepare(
    `INSERT INTO network_snapshots (location_id, kind, payload, captured_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(location_id, kind) DO UPDATE SET payload = excluded.payload, captured_at = datetime('now')`)
    .bind(locationId, kind, JSON.stringify(payload)).run();
}

export async function runAteraSync(env) {
  const db = env.DB;
  const summary = {
    at: new Date().toISOString(), ok: false, message: "",
    sites: 0, devices: 0, inserted: 0, updated: 0, offlined: 0,
    unmappedDevices: 0, patchAgents: 0, alerts: 0,
    monDevices: 0, monUnmapped: 0, installedAgents: 0,
  };
  const finish = async (msg) => {
    summary.message = msg;
    await setState(db, "atera_last_sync", JSON.stringify(summary));
    return summary;
  };
  if (!env.ATERA_API_KEY) return finish("No Atera API key is saved yet.");

  let agents;
  try {
    agents = (await listAll(env, "/api/v3/agents")).map(agentShape).filter((a) => a.agentId != null && a.customerId != null);
  } catch (e) {
    return finish(e.message || "Atera could not be reached.");
  }
  summary.devices = agents.length;

  // Group agents by mapping unit and register the groups for mapping.
  const groups = new Map();
  for (const a of agents) {
    const key = groupKey(a);
    if (!groups.has(key)) groups.set(key, { key, name: [a.customerName, a.siteName].filter(Boolean).join(" · ") || key, agents: [], devices: [] });
    groups.get(key).agents.push(a);
  }
  // Monitoring devices join the same mapping units; a customer with
  // devices but no agents still gets a group so it can be mapped.
  // The devices endpoint rejects the paged call shape the other lists
  // accept (HTTP 400 in production), so ask plainly, then fall back
  // to the per-kind lists. An empty answer from a working list is a
  // fine result (nothing registered); only total failure is an error.
  try {
    let rawDevices = [];
    let anyOk = false;
    try {
      const data = await apiGet(env, "/api/v3/devices");
      rawDevices = Array.isArray(data) ? data : (data.items || data.data || []);
      anyOk = true;
      summary.monSource = "devices";
    } catch { /* try the per-kind lists */ }
    if (!anyOk) {
      const kinds = [["generic", "Generic"], ["snmpdevices", "SNMP"], ["httpdevices", "HTTP"], ["tcp", "TCP"]];
      for (const [seg, label] of kinds) {
        try {
          const data = await apiGet(env, `/api/v3/devices/${seg}`);
          const items = Array.isArray(data) ? data : (data.items || data.data || []);
          anyOk = true;
          summary.monSource = "per-kind lists";
          for (const it of items) { it.__kind = label; rawDevices.push(it); }
        } catch { /* one kind failing must not sink the rest */ }
      }
    }
    if (!anyOk) throw new Error("no device list answered");
    const monDevices = rawDevices.map(deviceShape).filter((d) => d.id != null && d.customerId != null);
    for (const d of monDevices) {
      const key = groupKey(d);
      if (!groups.has(key)) groups.set(key, { key, name: [d.customerName, d.siteName].filter(Boolean).join(" · ") || key, agents: [], devices: [] });
      groups.get(key).devices.push(d);
    }
  } catch { summary.monError = "Monitoring devices could not be read this run."; }
  summary.sites = groups.size;
  for (const g of groups.values()) {
    try {
      await db.prepare(
        `INSERT INTO sync_sites (provider, site_id, site_name) VALUES ('atera', ?, ?)
         ON CONFLICT(provider, site_id) DO UPDATE SET site_name = excluded.site_name`)
        .bind(g.key, g.name).run();
    } catch { /* sync_sites arrives with migration 0007; skip quietly */ }
  }
  const { results: mapRows } = await db.prepare(
    "SELECT site_id, location_id FROM sync_sites WHERE provider = 'atera' AND location_id IS NOT NULL").all().catch(() => ({ results: [] }));
  const mapping = new Map((mapRows || []).map((r) => [r.site_id, r.location_id]));

  // Patch state refreshes at most hourly; the marker is global.
  const lastPatchRaw = await getState(db, "atera_patches_at");
  const patchDue = !lastPatchRaw || (Date.now() - new Date(lastPatchRaw).getTime() > 50 * 60 * 1000);
  const patchCacheRaw = await getState(db, "atera_patch_cache");
  const patchCache = patchCacheRaw ? (JSON.parse(patchCacheRaw) || {}) : {};
  let patchCacheDirty = false;

  const seenByLocation = new Map(); // locationId -> Set(equipmentIds)
  const detailByLocation = new Map(); // locationId -> {byAgent: {}}
  // Durable identity links (src/links.js): once an agent is matched to
  // a record, later runs resolve it directly instead of re-guessing.
  const linksByLocation = new Map();
  const linksDirty = new Set();
  const linksFor = async (locationId) => {
    if (!linksByLocation.has(locationId)) linksByLocation.set(locationId, await loadLinks(db, locationId));
    return linksByLocation.get(locationId);
  };

  for (const g of groups.values()) {
    const locationId = mapping.get(g.key);
    if (!locationId) { summary.unmappedDevices += g.agents.length; continue; }
    if (!seenByLocation.has(locationId)) { seenByLocation.set(locationId, new Set()); detailByLocation.set(locationId, {}); }
    const seen = seenByLocation.get(locationId);
    const detail = detailByLocation.get(locationId);
    const links = await linksFor(locationId);

    for (const a of g.agents) {
      const status = a.online ? "online" : "offline";
      // Match: durable link first, then Atera id, MAC, serial, name.
      // A machine can report several MAC addresses (one per network
      // card, dock, or virtual adapter); every one of them is tried,
      // here and in the identity links, since another sync may know
      // the machine by any of them.
      const aMacs = a.macs && a.macs.length ? a.macs : (a.mac ? [a.mac] : []);
      let row = await linkedRow(db, locationId, links, [srcKey("atera", String(a.agentId)), ...aMacs.map(macKey)]);
      if (!row) row = await db.prepare(
        "SELECT * FROM equipment WHERE location_id = ? AND source = 'atera' AND external_id = ?")
        .bind(locationId, String(a.agentId)).first();
      if (!row) { for (const m of aMacs) { row = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND mac = ? ORDER BY id LIMIT 1").bind(locationId, m).first(); if (row) break; } }
      if (!row && a.serial) row = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND serial = ? ORDER BY id LIMIT 1").bind(locationId, String(a.serial)).first();
      if (!row) row = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND LOWER(name) = LOWER(?) ORDER BY id LIMIT 1").bind(locationId, a.name).first();
      // UniFi client rows carry a MAC suffix in their stored name
      // ("Front2 c3:54"), so also match the name as a prefix.
      if (!row) row = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND LOWER(name) LIKE LOWER(?) || ' %' ORDER BY id LIMIT 1").bind(locationId, a.name).first();
      // Last resort: the record already sitting at this agent's IP in
      // this office (never a row another Atera agent owns).
      if (!row && a.ip) {
        const byIp = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND ip_address = ? ORDER BY id LIMIT 1").bind(locationId, a.ip).first();
        if (byIp && !(byIp.source === "atera" && byIp.external_id && String(byIp.external_id) !== String(a.agentId))) row = byIp;
      }

      let equipmentId;
      if (row) {
        equipmentId = row.id;
        const owned = row.source === "atera";
        await db.prepare(
          `UPDATE equipment SET status = ?, last_seen_at = COALESCE(?, last_seen_at),
             mac = COALESCE(mac, ?), serial = COALESCE(serial, ?), ip_address = COALESCE(?, ip_address),
             model = COALESCE(?, model), updated_at = datetime('now') WHERE id = ?`)
          .bind(status, a.lastSeen, a.mac || null, a.serial ? String(a.serial) : null, a.ip, a.model, row.id).run();
        if (owned) {
          await db.prepare("UPDATE equipment SET name = ?, type = ? WHERE id = ?").bind(a.name, a.type, row.id).run();
        } else {
          // A UniFi-style name carrying its MAC suffix ("Front2 c3:54")
          // gives way to this agent's clean name for the same machine,
          // so the record reads the friendly way everywhere.
          const base = String(row.name || "").replace(/ [0-9a-f]{2}:[0-9a-f]{2}$/i, "");
          if (base && base !== row.name && base.toLowerCase() === String(a.name).toLowerCase()) {
            await db.prepare("UPDATE equipment SET name = ? WHERE id = ?").bind(a.name, row.id).run();
          }
        }
        summary.updated++;
      } else {
        const ins = await db.prepare(
          `INSERT INTO equipment (location_id, vendor, type, model, serial, status, name, mac, ip_address, source, external_id, last_seen_at)
           VALUES (?, 'Atera', ?, ?, ?, ?, ?, ?, ?, 'atera', ?, ?)`)
          .bind(locationId, a.type, a.model, a.serial ? String(a.serial) : null, status,
            a.name, a.mac || null, a.ip, String(a.agentId), a.lastSeen).run();
        equipmentId = ins.meta.last_row_id;
        summary.inserted++;
      }
      seen.add(equipmentId);
      if (recordLink(links, equipmentId, [srcKey("atera", String(a.agentId)), ...aMacs.map(macKey)])) linksDirty.add(locationId);

      // Patches: from the hourly refresh when due, else the cache.
      let patches = patchCache[String(a.agentId)] || null;
      if (patchDue && a.guid) {
        try {
          const list = await listAll(env, `/api/v3/agents/${encodeURIComponent(a.guid)}/available-patches`);
          patches = {
            count: list.length,
            titles: list.slice(0, 8).map((p) => String(pick(p, "Title", "Name", "KB", "Description") || "Update")).filter(Boolean),
            at: new Date().toISOString(),
          };
          // Installed patch history rides the same hourly pass; its
          // own failure must not lose the waiting list above. The
          // endpoint spelling is tried both ways; success is counted
          // in the summary so a silent failure stays visible.
          try {
            let done = null;
            try { done = await listAll(env, `/api/v3/agents/${encodeURIComponent(a.guid)}/installed-patches`); }
            catch { done = null; }
            if (done === null) { try { done = await listAll(env, `/api/v3/agents/${encodeURIComponent(a.guid)}/installedpatches`); } catch { done = null; } }
            if (done) {
              const recent = done.map((p) => ({
                t: String(pick(p, "Title", "Name", "KB", "Description") || "Update"),
                d: (isoDate(pick(p, "InstalledOn", "InstallDate", "DateInstalled", "InstalledDate", "CreatedDate")) || "").slice(0, 10) || null,
              })).filter((x) => x.t)
                .sort((x, y) => String(y.d || "").localeCompare(String(x.d || "")));
              patches.installed = { count: done.length, recent: recent.slice(0, 8) };
              summary.installedAgents++;
            }
          } catch { /* installed history is best-effort */ }
          patchCache[String(a.agentId)] = patches;
          patchCacheDirty = true;
          summary.patchAgents++;
        } catch { /* one agent's patches must not fail the run */ }
      } else if (patches) summary.patchAgents++;

      detail[String(a.agentId)] = {
        equipmentId, os: a.os, cpu: a.cpu, memoryGb: a.memoryGb, user: a.user,
        lastReboot: a.lastReboot, lastSeen: a.lastSeen, patches,
      };
    }

    if (detail && Object.keys(detail).length) {
      try { await saveSnapshot(db, locationId, "atera_agent", { byAgent: detail }); } catch { /* table arrives with 0011 */ }
    }
  }

  // Monitoring devices pass: the same careful join as agents, under
  // their own source so the two passes never fight over a record.
  const seenMonByLocation = new Map();
  for (const g of groups.values()) {
    if (!g.devices || !g.devices.length) continue;
    const locationId = mapping.get(g.key);
    if (!locationId) { summary.monUnmapped += g.devices.length; continue; }
    if (!seenMonByLocation.has(locationId)) seenMonByLocation.set(locationId, new Set());
    const seenMon = seenMonByLocation.get(locationId);
    const links = await linksFor(locationId);
    for (const d of g.devices) {
      const status = d.online ? "online" : "offline";
      const dMacs = d.macs && d.macs.length ? d.macs : (d.mac ? [d.mac] : []);
      let row = await linkedRow(db, locationId, links, [srcKey("atera-device", String(d.id)), ...dMacs.map(macKey)]);
      if (!row) row = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND source = 'atera-device' AND external_id = ?")
        .bind(locationId, String(d.id)).first();
      if (!row) { for (const m of dMacs) { row = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND mac = ? ORDER BY id LIMIT 1").bind(locationId, m).first(); if (row) break; } }
      if (!row) row = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND LOWER(name) = LOWER(?) ORDER BY id LIMIT 1").bind(locationId, d.name).first();
      if (!row) row = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND LOWER(name) LIKE LOWER(?) || ' %' ORDER BY id LIMIT 1").bind(locationId, d.name).first();
      if (!row && d.ip) {
        const byIp = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND ip_address = ? ORDER BY id LIMIT 1").bind(locationId, d.ip).first();
        // Never claim a computer record (agent or endpoint syncs own
        // those); a monitoring device pointing at the same address
        // is the same box watched a second way, surfaced by the
        // duplicates review instead.
        if (byIp && byIp.source !== "atera" && !(byIp.source === "atera-device" && byIp.external_id && String(byIp.external_id) !== String(d.id))) row = byIp;
      }
      if (row) {
        await db.prepare(
          `UPDATE equipment SET status = ?, last_seen_at = COALESCE(?, last_seen_at),
             mac = COALESCE(mac, ?), ip_address = COALESCE(?, ip_address), updated_at = datetime('now') WHERE id = ?`)
          .bind(status, d.lastSeen, d.mac || null, d.ip, row.id).run();
        if (row.source === "atera-device") {
          await db.prepare("UPDATE equipment SET name = ?, type = ? WHERE id = ?").bind(d.name, d.type, row.id).run();
        } else {
          const base = String(row.name || "").replace(/ [0-9a-f]{2}:[0-9a-f]{2}$/i, "");
          if (base && base !== row.name && base.toLowerCase() === String(d.name).toLowerCase()) {
            await db.prepare("UPDATE equipment SET name = ? WHERE id = ?").bind(d.name, row.id).run();
          }
        }
        seenMon.add(row.id);
        if (recordLink(links, row.id, [srcKey("atera-device", String(d.id)), ...dMacs.map(macKey)])) linksDirty.add(locationId);
        summary.monDevices++;
      } else {
        const ins = await db.prepare(
          `INSERT INTO equipment (location_id, vendor, type, model, serial, status, name, mac, ip_address, source, external_id, last_seen_at)
           VALUES (?, 'Atera', ?, NULL, NULL, ?, ?, ?, ?, 'atera-device', ?, ?)`)
          .bind(locationId, d.type, status, d.name, d.mac || null, d.ip, String(d.id), d.lastSeen).run();
        seenMon.add(ins.meta.last_row_id);
        if (recordLink(links, ins.meta.last_row_id, [srcKey("atera-device", String(d.id)), ...dMacs.map(macKey)])) linksDirty.add(locationId);
        summary.monDevices++;
      }
    }
  }
  // Monitoring devices that vanished from Atera go offline, not away.
  for (const [locationId, seenMon] of seenMonByLocation) {
    const { results: rows } = await db.prepare(
      "SELECT id FROM equipment WHERE location_id = ? AND source = 'atera-device' AND status != 'offline'").bind(locationId).all();
    for (const r of rows || []) {
      if (!seenMon.has(r.id)) {
        await db.prepare("UPDATE equipment SET status = 'offline', updated_at = datetime('now') WHERE id = ?").bind(r.id).run();
      }
    }
  }

  // Agents that vanished from Atera: their rows go offline, never away.
  for (const [locationId, seen] of seenByLocation) {
    const { results: rows } = await db.prepare(
      "SELECT id FROM equipment WHERE location_id = ? AND source = 'atera' AND status != 'offline'").bind(locationId).all();
    for (const r of rows || []) {
      if (!seen.has(r.id)) {
        await db.prepare("UPDATE equipment SET status = 'offline', updated_at = datetime('now') WHERE id = ?").bind(r.id).run();
        summary.offlined++;
      }
    }
  }

  // Open alerts, mirrored per mapped location.
  try {
    const alerts = await listAll(env, "/api/v3/alerts");
    const open = alerts.filter((al) => {
      const st = String(pick(al, "Status", "AlertStatus") || "Open");
      return !/resolv|clos|dismiss/i.test(st);
    });
    const byLocation = new Map();
    for (const al of open) {
      const custId = pick(al, "CustomerID", "CustomerId");
      const siteName = pick(al, "SiteName", "FolderName");
      const siteId = pick(al, "SiteID", "SiteId", "FolderID");
      const siteKey = siteId != null ? String(siteId) : (siteName ? String(siteName).toLowerCase().replace(/[^a-z0-9]+/g, "-") : null);
      const keys = [siteKey ? `cust:${custId}:site:${siteKey}` : null, `cust:${custId}`].filter(Boolean);
      const loc = keys.map((k) => mapping.get(k)).find(Boolean);
      if (!loc) continue;
      if (!byLocation.has(loc)) byLocation.set(loc, []);
      byLocation.get(loc).push({
        title: String(pick(al, "Title", "AlertName", "Message") || "Atera alert"),
        severity: String(pick(al, "Severity") || ""),
        device: String(pick(al, "DeviceName", "MachineName", "AgentName") || ""),
        at: isoDate(pick(al, "CreatedDate", "DateCreated", "Created")),
      });
    }
    for (const [loc, list] of byLocation) {
      summary.alerts += list.length;
      try { await saveSnapshot(db, loc, "atera_alerts", { alerts: list.slice(0, 50) }); } catch { /* 0011 */ }
    }
    // Locations with alerts before but none now get an empty list.
    for (const loc of mapping.values()) {
      if (!byLocation.has(loc)) {
        try { await saveSnapshot(db, loc, "atera_alerts", { alerts: [] }); } catch { /* 0011 */ }
      }
    }
  } catch { summary.alertsError = "Alerts could not be read this run."; }

  // The rest of Atera's data (contacts, contracts, invoices, and
  // the rest) is pulled by runAteraExtra on its own hourly cron:
  // riding inside this sync exhausted the per-invocation subrequest
  // budget in production (every collection failed with "Too many
  // subrequests"). Between rounds, surface the last known results.
  try {
    const lastExtra = await getState(db, "atera_extra_last");
    if (lastExtra) {
      const parsed = JSON.parse(lastExtra);
      if (parsed && parsed.extra) { summary.extra = parsed.extra; if (parsed.extraErrors && Object.keys(parsed.extraErrors).length) summary.extraErrors = parsed.extraErrors; }
    }
  } catch { /* the summary stays lean */ }

  // The hourly marker is set only when patch state actually came back
  // for at least one agent, so a run with nothing mapped yet does not
  // consume the hour.
  if (patchDue && summary.patchAgents > 0) {
    await setState(db, "atera_patches_at", new Date().toISOString());
    if (patchCacheDirty) await setState(db, "atera_patch_cache", JSON.stringify(patchCache));
  }

  // Persist any identity links learned this run.
  for (const locationId of linksDirty) {
    try { await saveLinks(db, locationId, linksByLocation.get(locationId)); } catch { /* best effort */ }
  }

  summary.ok = true;
  return finish(`Atera sync complete. ${summary.inserted + summary.updated} computers mirrored, ${summary.unmappedDevices} waiting on mapping.${summary.monDevices ? ` ${summary.monDevices} monitoring devices mirrored.` : ""}`);
}

// Everything else Atera keeps, apart from tickets (Montek,
// 2026-11-07: pull all of Atera's data into the portal, tickets
// aside). This runs as its OWN scheduled invocation (hourly cron in
// wrangler.toml): inside the main sync it died on the per-invocation
// subrequest limit, because the three syncs share one budget.
// Every collection is independent: one Atera refuses records its
// error in 'atera_extra_last' and the rest still land.
export async function runAteraExtra(env) {
  const db = env.DB;
  if (!env.ATERA_API_KEY) return { ok: false, message: "No Atera API key is saved yet." };
  const { results: mapRows } = await db.prepare(
    "SELECT site_id, location_id FROM sync_sites WHERE provider = 'atera' AND location_id IS NOT NULL").all().catch(() => ({ results: [] }));
  const mapping = new Map((mapRows || []).map((r) => [r.site_id, r.location_id]));
  const extra = { contacts: 0, contracts: 0, invoices: 0, expenses: 0, products: 0, customValues: 0, kb: 0, departments: 0, waitingCustomers: 0 };
  const extraErrors = {};
  let answered = 0;
  const locsByCustomer = new Map();
  for (const [k, loc] of mapping) {
    const m = String(k).match(/^cust:([^:]+)/);
    if (!m) continue;
    if (!locsByCustomer.has(m[1])) locsByCustomer.set(m[1], new Set());
    locsByCustomer.get(m[1]).add(loc);
  }
  const tryPaths = async (paths) => {
    let err = null;
    for (const p of paths) { try { return await listAll(env, p); } catch (e) { err = e; } }
    throw err || new Error("Atera did not answer.");
  };
  const tryPathsPlain = async (paths) => {
    let err = null;
    for (const p of paths) {
      try { const data = await apiGet(env, p); return Array.isArray(data) ? data : (data.items || data.data || []); } catch (e) { err = e; }
      try { return await listAll(env, p); } catch (e) { err = e; }
    }
    throw err || new Error("Atera did not answer.");
  };
  const waiting = new Set();
  const perCustomer = async (kind, paths, shape, cap) => {
    try {
      const raw = await tryPaths(paths);
      answered++;
      const byCustomer = new Map();
      for (const item of raw) {
        const shaped = shape(item);
        if (!shaped) continue;
        const cid = shaped.__cid != null ? String(shaped.__cid) : null;
        delete shaped.__cid;
        if (!cid) continue;
        if (!byCustomer.has(cid)) byCustomer.set(cid, []);
        byCustomer.get(cid).push(shaped);
      }
      const written = new Set();
      for (const [cid, list] of byCustomer) {
        const locs = locsByCustomer.get(cid);
        if (!locs) { waiting.add(cid); continue; }
        extra[kind] += Math.min(list.length, cap);
        for (const loc of locs) {
          try { await saveSnapshot(db, loc, "atera_" + kind, { [kind]: list.slice(0, cap) }); written.add(loc); } catch { /* 0011 */ }
        }
      }
      for (const loc of mapping.values()) {
        if (!written.has(loc)) { try { await saveSnapshot(db, loc, "atera_" + kind, { [kind]: [] }); } catch { /* 0011 */ } }
      }
    } catch (e) { extraErrors[kind] = String(e.message || e).slice(0, 90); }
  };
  const personName = (o) => pick(o, "FullName", "ContactName", "Name") || [pick(o, "FirstName"), pick(o, "LastName")].filter(Boolean).join(" ") || null;
  await perCustomer("contacts", ["/api/v3/contacts"], (o) => {
    const name = personName(o);
    if (!name) return null;
    return { __cid: pick(o, "CustomerID", "CustomerId"), name: String(name), email: pick(o, "Email", "EmailAddress"), phone: pick(o, "Phone", "PhoneNumber", "MobilePhone", "CellPhone"), title: pick(o, "Title", "JobTitle", "Position") };
  }, 200);
  await perCustomer("contracts", ["/api/v3/contracts"], (o) => ({
    __cid: pick(o, "CustomerID", "CustomerId"),
    name: String(pick(o, "ContractName", "Name", "Title") || "Contract"),
    type: pick(o, "ContractType", "Type"),
    start: isoDate(pick(o, "StartDate", "Start")),
    end: isoDate(pick(o, "EndDate", "End")),
    amount: pick(o, "Amount", "Value", "Price"),
  }), 50);
  await perCustomer("invoices", ["/api/v3/billing/invoices", "/api/v3/invoices"], (o) => ({
    __cid: pick(o, "CustomerID", "CustomerId"),
    number: pick(o, "InvoiceNumber", "InvoiceID", "InvoiceId", "Number"),
    date: isoDate(pick(o, "InvoiceDate", "Date", "CreatedDate")),
    total: pick(o, "Total", "TotalAmount", "Amount"),
    status: pick(o, "Status", "InvoiceStatus"),
  }), 50);
  const account = { products: [], expenses: [], customValues: [], kb: [], departments: [] };
  const accountKind = async (key, paths, shape, cap, plain) => {
    try {
      const raw = plain ? await tryPathsPlain(paths) : await tryPaths(paths);
      answered++;
      account[key] = raw.map(shape).filter(Boolean).slice(0, cap);
      extra[key] = account[key].length;
    } catch (e) { extraErrors[key] = String(e.message || e).slice(0, 90); }
  };
  await accountKind("products", ["/api/v3/rates/products", "/api/v3/products"], (o) => ({ name: String(pick(o, "ProductName", "Name") || "Product"), price: pick(o, "Price", "Rate", "Amount"), unit: pick(o, "Unit", "Type") }), 200);
  await accountKind("expenses", ["/api/v3/rates/expenses", "/api/v3/expenses"], (o) => ({ name: String(pick(o, "Description", "ExpenseName", "Name") || "Expense"), amount: pick(o, "Amount", "Cost", "Price") }), 200);
  await accountKind("customValues", ["/api/v3/customvalues/customfields", "/api/v3/customvalues", "/api/v3/custom-values"], (o) => ({ name: String(pick(o, "FieldName", "Name", "CustomFieldName") || "Custom value"), value: pick(o, "Value", "CustomValue", "FieldValue") }), 200, true);
  await accountKind("kb", ["/api/v3/knowledgebases", "/api/v3/knowledgebase", "/api/v3/kb"], (o) => ({ title: String(pick(o, "Title", "ArticleTitle", "Name") || "Article") }), 200);
  await accountKind("departments", ["/api/v3/departments"], (o) => ({ name: String(pick(o, "DepartmentName", "Name") || "Department") }), 100, true);
  extra.waitingCustomers = waiting.size;
  if (answered > 0) {
    account.at = new Date().toISOString();
    await setState(db, "atera_account", JSON.stringify(account));
    await setState(db, "atera_extra_at", new Date().toISOString());
    await setState(db, "atera_extra_last", JSON.stringify({ extra, extraErrors, at: new Date().toISOString() }));
  } else if (Object.keys(extraErrors).length) {
    await setState(db, "atera_extra_last", JSON.stringify({ extra, extraErrors, at: new Date().toISOString() }));
  }
  return { ok: answered > 0, extra, extraErrors };
}
