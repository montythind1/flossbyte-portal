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
    ip: asList(pick(a, "IPAddresses", "IpAddresses", "IPAddress"))[0] || null,
    serial: pick(a, "SerialNumber", "Serial"),
    model: [pick(a, "SystemManufacturer", "Manufacturer", "Vendor"), pick(a, "SystemModel", "Model")].filter(Boolean).join(" ") || null,
    cpu: pick(a, "Processor", "CPU", "Cpu"),
    // Atera reports memory in MB (16165 means ~16 GB); a value that
    // small in GB would be a very strange machine, so convert.
    memoryGb: (() => { const m = pick(a, "Memory", "RAM", "RamGB"); const n = Number(m); if (!Number.isFinite(n) || n <= 0) return null; const gb = n > 200 ? n / 1024 : n; return Math.round(gb * 10) / 10; })(),
    user: pick(a, "CurrentLoggedUser", "CurrentUser", "LoggedUser") || pickFuzzy(a, /(logged|current).*(user|in)/i),
    lastReboot: isoDate(pick(a, "LastRebootTime", "LastReboot", "LastBootTime") || pickFuzzy(a, /^last.*(reboot|boot|restart)/i)),
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
    if (!groups.has(key)) groups.set(key, { key, name: [a.customerName, a.siteName].filter(Boolean).join(" · ") || key, agents: [] });
    groups.get(key).agents.push(a);
  }
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

  for (const g of groups.values()) {
    const locationId = mapping.get(g.key);
    if (!locationId) { summary.unmappedDevices += g.agents.length; continue; }
    if (!seenByLocation.has(locationId)) { seenByLocation.set(locationId, new Set()); detailByLocation.set(locationId, {}); }
    const seen = seenByLocation.get(locationId);
    const detail = detailByLocation.get(locationId);

    for (const a of g.agents) {
      const status = a.online ? "online" : "offline";
      // Match: Atera id, then MAC, then serial, then name.
      let row = await db.prepare(
        "SELECT * FROM equipment WHERE location_id = ? AND source = 'atera' AND external_id = ?")
        .bind(locationId, String(a.agentId)).first();
      if (!row && a.mac) row = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND mac = ? ORDER BY id LIMIT 1").bind(locationId, a.mac).first();
      if (!row && a.serial) row = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND serial = ? ORDER BY id LIMIT 1").bind(locationId, String(a.serial)).first();
      if (!row) row = await db.prepare("SELECT * FROM equipment WHERE location_id = ? AND LOWER(name) = LOWER(?) ORDER BY id LIMIT 1").bind(locationId, a.name).first();

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

  // The hourly marker is set only when patch state actually came back
  // for at least one agent, so a run with nothing mapped yet does not
  // consume the hour.
  if (patchDue && summary.patchAgents > 0) {
    await setState(db, "atera_patches_at", new Date().toISOString());
    if (patchCacheDirty) await setState(db, "atera_patch_cache", JSON.stringify(patchCache));
  }

  summary.ok = true;
  return finish(`Atera sync complete. ${summary.inserted + summary.updated} computers mirrored, ${summary.unmappedDevices} waiting on mapping.`);
}
