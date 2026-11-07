// Genius: the AI layer over the portal's existing Ask flow.
//
// The boundary is deliberate. This module never queries another
// location and never receives WiFi passwords, serial numbers, MAC
// addresses, IP addresses, account numbers, or patient data. pages-client.js first
// checks access to the office, builds the deterministic records answer,
// and supplies a records-only context for this one location. Genius can
// explain and connect those facts in plain language; it cannot create
// new facts. If the model is unavailable or returns something unsafe,
// the caller keeps the deterministic answer.
//
// Guessing policy (Montek, 2026-11-07): facts about the office are
// never guessed. For problem and how-to questions the model may add
// generic, safe checks under the exact heading TIP_LABEL so staff can
// always tell records from general guidance; the caller's footer says
// which kind of answer they got. No tips at all for firewall, server,
// security, backup-restore, or practice-data topics.

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const MAX_CONTEXT_CHARS = 18000;
export const TIP_LABEL = "General tip (not from your office's records):";

export function geniusFooter(answer) {
  return String(answer || "").includes(TIP_LABEL)
    ? "(Answered by Genius from your own portal records, plus general tips marked above.)"
    : "(Answered by Genius from your own portal records only.)";
}

function text(value, max = 500) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function parseJson(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

export function isExactLookupQuestion(question) {
  return /(password|passcode|credential|serial|\bmac\b|\bip\b|account number|wi[-\s]?fi\s+(pass|code|key)|network\s+(pass|code|key))/i.test(String(question || ""));
}

// A typed request for a human ("chat with someone", "I want to chat
// with a live person", "talk to a human") is a live-chat handoff
// request, not an IT question. Anchored to person words plus a
// chat/talk/connect verb (or the exact phrase "live chat") so
// questions ABOUT chat systems or software never trigger it.
export function isLiveChatRequest(question) {
  const q = String(question || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return false;
  const person = "(live |real |actual )?(person|human|someone|agent|representative|rep|flossbyte|support)";
  if (/\blive chat\b/.test(q)) return true;
  if (/\b(message|contact) flossbyte\b/.test(q)) return true;
  if (/^(contact|message) support[.!]?$/.test(q)) return true;
  if (new RegExp("\\b(chat|talk|speak|connect|message) (to|with) (a |an |the )?" + person + "\\b").test(q)) return true;
  if (/\b(want|need|would like|like|trying) to (chat|talk|speak|connect|message) (to|with )?(a |an |the )?(live )?(person|human|someone|agent|representative|rep|flossbyte|support)\b/.test(q)) return true;
  if (/\b(connect|transfer|get|bring|give) me (to |with )?(a |an |the )?(live )?(person|human|someone|agent|representative|rep|flossbyte|support)\b/.test(q)) return true;
  if (/\b(live|real|actual) (person|human|agent)\b/.test(q)) return true;
  if (/^(chat|talk|speak) (to|with) (someone|a person|flossbyte)[.!]?$/.test(q)) return true;
  if (/^(human|person|agent|live person|real person)[.!]?$/.test(q)) return true;
  return false;
}

export function redactSecrets(value) {
  return String(value || "")
    .replace(/(password\s+)([^\s,;]+)/gi, "$1[exact value shown by the portal]")
    .replace(/(passcode\s+)([^\s,;]+)/gi, "$1[exact value shown by the portal]")
    .replace(/(api[_\s-]?key\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[IP address in the portal record]")
    .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, "[MAC address in the portal record]");
}

function snapshotMap(rows) {
  const out = {};
  for (const row of rows || []) out[row.kind] = parseJson(row.payload);
  return out;
}

function readableName(e, renames) {
  if (renames) {
    if (e.external_id && renames[e.external_id]) return renames[e.external_id];
    if (e.mac && renames[e.mac]) return renames[e.mac];
  }
  let name = text(e.name || "", 120);
  const macHex = String(e.mac || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  const suffix = /\s([0-9a-f]{2}):([0-9a-f]{2})$/i.exec(name);
  if (suffix && macHex.endsWith((suffix[1] + suffix[2]).toLowerCase())) {
    name = name.slice(0, suffix.index).trim();
  }
  return name || text(e.model || e.type || "Unnamed device", 120);
}

export async function buildGeniusContext(db, loc, options = {}) {
  const locationId = Number(loc.id);
  const sections = [];
  sections.push(`Office: ${text(loc.name, 160)}\nPractice: ${text(loc.customer_name || "", 160)}`);

  if (options.health) {
    const h = options.health;
    sections.push(`Office health: ${h.score}/100 (${h.label}).` +
      ((h.reasons || []).length ? ` Reasons: ${(h.reasons || []).join("; ")}.` : ""));
  }

  const { results: snapRows } = await db.prepare(
    "SELECT kind, payload FROM network_snapshots WHERE location_id = ?").bind(locationId).all();
  const snaps = snapshotMap(snapRows);
  const renames = (snaps.device_names && snaps.device_names.names) || {};

  const { results: equipmentRows } = await db.prepare(
    `SELECT * FROM equipment WHERE location_id = ?
     ORDER BY CASE WHEN status = 'offline' THEN 0 ELSE 1 END, name, type
     LIMIT 100`).bind(locationId).all();
  const equipment = equipmentRows || [];
  const nameById = new Map(equipment.map((e) => [e.id, readableName(e, renames)]));
  if (equipment.length) {
    const offline = equipment.filter((e) => e.status === "offline");
    const lines = equipment.map((e) => {
      const bits = [`${readableName(e, renames)} (${text(e.type || "Device", 80)})`, `status ${text(e.status, 30)}`];
      const model = [e.vendor, e.model].filter(Boolean).join(" ");
      if (model) bits.push(`model ${text(model, 120)}`);
      if (e.last_seen_at) bits.push(`last seen ${text(e.last_seen_at, 40)}`);
      if (e.license_expires) bits.push(`license expires ${text(e.license_expires, 20)}`);
      if (e.warranty_expires) bits.push(`warranty expires ${text(e.warranty_expires, 20)}`);
      return `- ${bits.join(", ")}`;
    });
    sections.push(`Equipment (${equipment.length} on record, ${offline.length} offline):\n${lines.join("\n")}`);
  } else {
    sections.push("Equipment: none on record.");
  }

  const expiring = [];
  for (const e of equipment) {
    if (e.license_expires) expiring.push(`${readableName(e, renames)} license: ${e.license_expires}`);
    if (e.warranty_expires) expiring.push(`${readableName(e, renames)} warranty: ${e.warranty_expires}`);
  }
  if (expiring.length) sections.push(`Recorded license and warranty dates:\n- ${expiring.slice(0, 30).join("\n- ")}`);

  const inet = snaps.internet || {};
  if (inet.isp || (inet.wans || []).length) {
    const lines = [];
    if (inet.isp) {
      const i = inet.isp;
      if (i.ispName) lines.push(`Provider: ${text(i.ispName, 100)}`);
      if (i.uptimePct != null) lines.push(`Uptime over the last ${Number(i.hours || 24)} hours: ${Number(i.uptimePct).toFixed(1)}%`);
      if (i.downtimeSec != null) lines.push(`Downtime: ${Math.round(Number(i.downtimeSec || 0) / 60)} minutes`);
      if (i.avgLatencyMs != null) lines.push(`Average latency: ${Math.round(Number(i.avgLatencyMs))} ms`);
      if (i.downMbps != null || i.upMbps != null) lines.push(`Measured speed: ${Number(i.downMbps || 0).toFixed(1)} Mbps down, ${Number(i.upMbps || 0).toFixed(1)} Mbps up`);
    }
    for (const w of inet.wans || []) lines.push(`Connection ${text(w.name || "WAN", 80)}: ${text(w.state || w.status || "state not recorded", 80)}`);
    if (lines.length) sections.push(`Internet:\n- ${lines.join("\n- ")}`);
  }

  const plan = snaps.isp_service || {};
  if (plan.provider || plan.plan || plan.down || plan.up) {
    const bits = [];
    if (plan.provider) bits.push(`provider ${text(plan.provider, 100)}`);
    if (plan.plan) bits.push(`plan ${text(plan.plan, 120)}`);
    if (plan.down || plan.up) bits.push(`promised ${text(plan.down || "?", 30)} down / ${text(plan.up || "?", 30)} up Mbps`);
    if (plan.contractEnd) bits.push(`contract ends ${text(plan.contractEnd, 20)}`);
    sections.push(`Internet plan: ${bits.join(", ")}`);
  }

  const backup = snaps.backup || {};
  if (backup.at || backup.product || backup.ok != null) {
    sections.push(`Backup: ${backup.ok === true ? "last recorded backup completed" : backup.ok === false ? "last recorded backup did not complete" : "status recorded"}` +
      `${backup.at ? ` at ${text(backup.at, 50)}` : ""}${backup.product ? ` using ${text(backup.product, 100)}` : ""}.`);
  }

  const cfg = snaps.config || {};
  const wifiManual = (snaps.wifi && Array.isArray(snaps.wifi.networks)) ? snaps.wifi.networks : [];
  const wifiNames = new Map();
  for (const s of cfg.ssids || []) {
    if (s && (s.name || s.ssid)) wifiNames.set(String(s.name || s.ssid).toLowerCase(), {
      name: s.name || s.ssid, security: s.security || "security not recorded", enabled: s.enabled !== false, kind: "",
    });
  }
  for (const w of wifiManual) {
    if (!w || !w.name) continue;
    const key = String(w.name).toLowerCase();
    const cur = wifiNames.get(key) || { name: w.name, security: "security not recorded", enabled: true, kind: "" };
    cur.kind = w.kind || "";
    wifiNames.set(key, cur);
  }
  if (wifiNames.size) {
    sections.push("WiFi networks (passwords intentionally not included):\n" + [...wifiNames.values()].map((w) =>
      `- ${text(w.name, 100)}${w.kind ? ` (${text(w.kind, 30)})` : ""}, ${text(w.security, 80)}, ${w.enabled ? "on" : "off"}`).join("\n"));
  }
  if ((cfg.networks || []).length) {
    sections.push("Networks:\n" + cfg.networks.slice(0, 20).map((n) =>
      `- ${text(n.name || "Network", 100)}${n.vlanId != null ? `, VLAN ${Number(n.vlanId)}` : ""}, ${n.enabled === false ? "off" : "on"}`).join("\n"));
  }
  if ((cfg.vpnTunnels || []).length || (cfg.vpnServers || []).length) {
    const lines = [
      ...(cfg.vpnTunnels || []).map((t) => `Tunnel ${text(t.name || "", 100)}: ${text(t.state || t.status || "state not recorded", 60)}`),
      ...(cfg.vpnServers || []).map((v) => `Server ${text(v.name || "", 100)}: ${v.enabled === false ? "off" : "on"}`),
    ];
    sections.push(`VPN:\n- ${lines.join("\n- ")}`);
  }
  if (((snaps.protect || {}).cameras || []).length) {
    sections.push("Cameras:\n" + snaps.protect.cameras.slice(0, 30).map((c) =>
      `- ${text(c.name || "Camera", 100)} (${text(c.model || "", 80)}), ${text(c.state || c.status || "state not recorded", 60)}`).join("\n"));
  }
  if (((snaps.changes || {}).events || []).length) {
    sections.push("Recent recorded changes:\n" + snaps.changes.events.slice(0, 10).map((e) =>
      `- ${text(e.at, 30)}: ${text(e.text, 240)}`).join("\n"));
  }

  const agentEntries = Object.values((snaps.atera_agent || {}).byAgent || {}).filter((d) => d && d.equipmentId);
  if (agentEntries.length) {
    const lines = agentEntries.slice(0, 40).map((d) => {
      const bits = [nameById.get(d.equipmentId) || "Computer"];
      if (d.os) bits.push(`OS ${text(d.os, 120)}`);
      if (d.cpu) bits.push(`processor ${text(d.cpu, 120)}`);
      if (d.memoryGb) bits.push(`${text(d.memoryGb, 20)} GB memory`);
      if (d.lastReboot) bits.push(`last restarted ${text(d.lastReboot, 50)}`);
      if (d.patches && d.patches.count != null) bits.push(`${Number(d.patches.count || 0)} Windows updates waiting`);
      if (d.patches && d.patches.installed && d.patches.installed.count != null) bits.push(`${Number(d.patches.installed.count || 0)} updates installed`);
      return `- ${bits.join(", ")}`;
    });
    sections.push(`Computer details from Atera:\n${lines.join("\n")}`);
    const waiting = agentEntries.flatMap((d) => ((d.patches && d.patches.titles) || []).slice(0, 3).map((title) =>
      `${nameById.get(d.equipmentId) || "Computer"}: ${text(title, 180)}`));
    if (waiting.length) sections.push(`Some waiting update names:\n- ${waiting.slice(0, 15).join("\n- ")}`);
  }
  const alerts = (snaps.atera_alerts || {}).alerts || [];
  if (alerts.length) {
    sections.push("Open Atera alerts:\n" + alerts.slice(0, 20).map((a) =>
      `- ${text(a.title, 200)}${a.device ? ` on ${text(a.device, 100)}` : ""}${a.severity ? ` (${text(a.severity, 40)})` : ""}`).join("\n"));
  }

  try {
    const { results: tickets } = await db.prepare(
      "SELECT title, status, priority, created_at FROM tickets WHERE location_id = ? ORDER BY updated_at DESC LIMIT 12").bind(locationId).all();
    if (tickets && tickets.length) {
      sections.push("Recent tickets:\n" + tickets.map((t) =>
        `- ${text(t.title, 180)} (${text(t.status, 40)}, ${text(t.priority, 40)}, opened ${text(t.created_at, 30)})`).join("\n"));
    }
  } catch { /* tickets are optional context */ }

  try {
    const { results: docs } = await db.prepare(
      "SELECT name, created_at FROM documents WHERE location_id = ? ORDER BY created_at DESC LIMIT 20").bind(locationId).all();
    if (docs && docs.length) sections.push(`Documents on file: ${docs.map((d) => text(d.name, 160)).join(", ")}.`);
  } catch { /* documents are optional context */ }

  let history = [];
  if (options.userId) {
    try {
      const { results } = await db.prepare(
        `SELECT question, answer FROM ask_messages
         WHERE location_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 4`).bind(locationId, options.userId).all();
      history = (results || []).reverse();
    } catch { history = []; }
  }

  return {
    context: sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS),
    history,
  };
}

export function buildGeniusMessages({ question, context, history, recordsAnswer }) {
  const system = [
    "You are Genius, FlossByte's assistant inside a dental practice's private IT portal.",
    "Answer the question being asked now. Any earlier conversation is background only: never repeat, continue, or summarize a previous answer unless the current question is about the same thing.",
    "Speak in plain, friendly language for office staff who may not know IT terms. Explain a technical term briefly when you use one.",
    "Use ONLY the office records supplied in this request. Treat those records as the complete source of truth. Never invent a device, date, status, cause, price, policy, or action.",
    "Never guess a fact about this office: not a device status, a cause of a problem, a date, a name, or whether something was done. If the records do not contain a fact, say that plainly.",
    `For a problem or how-to question, after the records-based answer you may add ONE separate section headed exactly "${TIP_LABEL}" with general guidance: simple, safe, reversible checks anyone can do (look at a power light, confirm a cable is plugged in, clear a paper jam, close and reopen an app, restart the affected printer or computer). Phrase tips as general possibilities ("often", "usually", "you can check"), never as facts about this office.`,
    "Offer no general tip when the question asks for a fact about the office, and no tip at all for firewall, server, network or security settings, backup restores, passwords, deleting data, or the practice-management system's data. For those, say the records do not cover it and suggest sending the conversation to FlossByte.",
    "Never provide or request passwords, passcodes, serial numbers, MAC addresses, IP addresses, account numbers, API keys, or patient information. Those exact values are intentionally absent from your context; the portal's exact records answer handles those questions separately.",
    "Do not claim that you changed a setting, contacted anyone, opened a ticket, or fixed anything. You only answer questions.",
    "Keep the answer concise: a direct answer first, then the few record-based details or safe next steps that help. Use short paragraphs or a short bullet list.",
  ].join(" ");

  const messages = [{ role: "system", content: system }];
  // Earlier ANSWERS are deliberately not replayed to the model: a
  // small model copies a long previous answer (a device list, say)
  // into an unrelated new answer. Only the earlier questions ride
  // along, as background, so follow-ups keep some thread.
  const priorQuestions = (history || []).map((h) => text(h.question, 200)).filter(Boolean);
  const background = priorQuestions.length
    ? `\n\nRECENT QUESTIONS FROM THIS LOGIN (background only; do not repeat their answers):\n- ${priorQuestions.join("\n- ")}`
    : "";
  const factSheet = recordsAnswer && !String(recordsAnswer).startsWith("That is not in your portal records yet")
    ? `\n\nVERIFIED RECORDS ANSWER (prefer these exact facts):\n${redactSecrets(recordsAnswer).slice(0, 7000)}`
    : "";
  messages.push({
    role: "user",
    content: `OFFICE RECORDS:\n${context}${factSheet}${background}\n\nQUESTION:\n${text(question, 1200)}`,
  });
  return messages;
}

export function extractGeniusText(result) {
  if (!result) return "";
  if (typeof result === "string") return result.trim();
  let out = result.response || result.text || (result.result && (result.result.response || result.result.text)) || "";
  if (!out && Array.isArray(result.choices) && result.choices.length) {
    const content = result.choices[0].message && result.choices[0].message.content;
    if (typeof content === "string") out = content;
    else if (Array.isArray(content)) out = content.map((c) => c.text || "").join("\n");
  }
  return String(out || "").trim();
}

export function cleanGeniusAnswer(value) {
  let out = String(value || "").replace(/\r\n/g, "\n").trim();
  out = out.replace(/^(Genius\s*:\s*)/i, "").trim();
  if (!out) return null;
  if (/(password|passcode)\s+(is|:)\s*\S+/i.test(out)) return null;
  if (/(serial number|mac address)\s+(is|:)\s*\S+/i.test(out)) return null;
  // Exact network identifiers stay on the deterministic records path.
  // If a model includes one anyway, remove just that fragment rather
  // than discarding an otherwise usable answer.
  out = out.replace(/\s*,?\s*IP\s+\d{1,3}(?:\.\d{1,3}){3}/gi, "")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (!out) return null;
  if (out.length > 3200) out = out.slice(0, 3197).trimEnd() + "...";
  return out;
}

export async function geniusAnswer(env, input) {
  if (!env || !env.AI || typeof env.AI.run !== "function") return null;
  const model = text(env.GENIUS_MODEL || DEFAULT_MODEL, 160) || DEFAULT_MODEL;
  try {
    const result = await env.AI.run(model, {
      messages: buildGeniusMessages(input),
      temperature: 0.1,
      max_tokens: 500,
    });
    return cleanGeniusAnswer(extractGeniusText(result));
  } catch {
    return null;
  }
}
