// Live chat between a customer login and FlossByte, entered through an
// in-chat handoff on the Genius page (Montek's design, 2026-11-07):
// Genius steps aside for the customer while a chat is open, the whole
// Genius conversation travels with the handoff as a brief for the
// admin, and ended chats archive per organization and office.
// Assignment is a field from day one (assigned_admin_id) so a round
// robin can replace first-come claiming later without a redesign.
import { esc } from "./layout.js";
import { sendEmail, wrap } from "./email.js";

export async function chatReady(db) {
  try { await db.prepare("SELECT 1 FROM chat_threads LIMIT 1").first(); return true; }
  catch (e) { return false; }
}

export function relTimeChat(iso) {
  if (!iso) return "";
  let s = String(iso);
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
  const t = Date.parse(s);
  if (isNaN(t)) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

export async function getOpenThread(db, locationId, userId) {
  if (!(await chatReady(db))) return null;
  return db.prepare(
    "SELECT * FROM chat_threads WHERE location_id = ? AND user_id = ? AND status IN ('waiting','active') ORDER BY id DESC LIMIT 1")
    .bind(locationId, userId).first();
}

export async function getThread(db, threadId) {
  return db.prepare(
    `SELECT t.*, c.name AS customer_name, l.name AS location_name,
            u.name AS requester_name, u.email AS requester_email,
            a.name AS admin_name
     FROM chat_threads t
     JOIN customers c ON c.id = t.customer_id
     JOIN locations l ON l.id = t.location_id
     JOIN users u ON u.id = t.user_id
     LEFT JOIN users a ON a.id = t.assigned_admin_id
     WHERE t.id = ?`).bind(threadId).first();
}

export async function threadMessages(db, threadId, afterId = 0) {
  const { results } = await db.prepare(
    `SELECT m.*, u.name AS sender_name FROM chat_messages m
     LEFT JOIN users u ON u.id = m.sender_user_id
     WHERE m.thread_id = ? AND m.id > ? ORDER BY m.id ASC`).bind(threadId, afterId).all();
  return results || [];
}

export async function addChatMessage(db, threadId, senderKind, senderUserId, body) {
  const r = await db.prepare(
    "INSERT INTO chat_messages (thread_id, sender_kind, sender_user_id, body) VALUES (?, ?, ?, ?)")
    .bind(threadId, senderKind, senderUserId, body).run();
  await db.prepare("UPDATE chat_threads SET last_message_at = datetime('now') WHERE id = ?").bind(threadId).run();
  return r.meta.last_row_id;
}

async function systemMessage(db, threadId, text) {
  await db.prepare(
    "INSERT INTO chat_messages (thread_id, sender_kind, sender_user_id, body) VALUES (?, 'system', NULL, ?)")
    .bind(threadId, text).run();
}

// The handoff brief: what the customer already asked Genius, plus the
// office's state right now, so the admin opens the chat informed and
// the customer never repeats themselves.
export async function buildBrief(db, loc, userId) {
  const brief = { recentQA: [], internet: null, offline: [], openTickets: 0 };
  try {
    const { results } = await db.prepare(
      "SELECT question, answer FROM ask_messages WHERE location_id = ? AND user_id = ? ORDER BY id DESC LIMIT 5")
      .bind(loc.id, userId).all();
    brief.recentQA = (results || []).reverse().map((m) => ({
      q: m.question, a: String(m.answer || "").slice(0, 300),
    }));
  } catch (e) { /* brief is best-effort */ }
  try {
    const snap = await db.prepare(
      "SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = 'internet'").bind(loc.id).first();
    if (snap && snap.payload) {
      const p = JSON.parse(snap.payload);
      brief.internet = { provider: p.provider || "", uptimePct: p.uptimePct ?? null };
    }
  } catch (e) { /* ignore */ }
  try {
    const { results } = await db.prepare(
      "SELECT name FROM equipment WHERE location_id = ? AND status = 'offline' ORDER BY name LIMIT 8").bind(loc.id).all();
    brief.offline = (results || []).map((r) => r.name);
  } catch (e) { /* ignore */ }
  try {
    const t = await db.prepare(
      "SELECT COUNT(*) AS n FROM tickets WHERE location_id = ? AND status != 'closed'").bind(loc.id).first();
    brief.openTickets = t ? t.n : 0;
  } catch (e) { /* ignore */ }
  return brief;
}

export async function startChat(env, user, loc) {
  const brief = await buildBrief(env.DB, loc, user.id);
  const r = await env.DB.prepare(
    "INSERT INTO chat_threads (customer_id, location_id, user_id, status, genius_context, last_message_at) VALUES (?, ?, ?, 'waiting', ?, datetime('now'))")
    .bind(loc.customer_id, loc.id, user.id, JSON.stringify(brief)).run();
  const threadId = r.meta.last_row_id;
  await systemMessage(env.DB, threadId, `${user.name} started a live chat. Genius has stepped aside while this chat is open.`);
  return threadId;
}

export async function endChat(db, thread, endedBy) {
  await db.prepare(
    "UPDATE chat_threads SET status = 'ended', ended_at = datetime('now'), ended_by = ? WHERE id = ?")
    .bind(endedBy, thread.id).run();
  await systemMessage(db, thread.id,
    endedBy === "customer" ? "The customer ended this chat. Genius is available again."
      : endedBy === "flossbyte" ? "FlossByte ended this chat. Genius is available again."
      : "This chat has ended. Genius is available again.");
}

// One bubble list used by both sides. Customer messages use the "q"
// style, FlossByte replies the "a" style, system events are dividers.
export function renderChatMessages(messages, showNames) {
  return (messages || []).map((m) => {
    if (m.sender_kind === "system") {
      return `<div class="muted" style="text-align:center;font-size:12.5px;margin:10px 0" data-mid="${m.id}">— ${esc(m.body)} —</div>`;
    }
    const name = showNames && m.sender_name ? `<div class="muted" style="font-size:12.5px;margin-top:6px">${esc(m.sender_name)}</div>` : "";
    return `${name}<div class="msg ${m.sender_kind === "customer" ? "q" : "a"}" data-mid="${m.id}">${esc(m.body)}</div>`;
  }).join("");
}

export function briefHtml(briefJson) {
  let b = null;
  try { b = JSON.parse(briefJson || "null"); } catch (e) { b = null; }
  if (!b) return "";
  const rows = [];
  if (b.internet) rows.push(`<div><span style="color:#45566E;font-weight:600">Internet:</span> ${esc(b.internet.provider || "On record")}${b.internet.uptimePct != null ? ` · up ${esc(String(b.internet.uptimePct))}% in the last 24 hours` : ""}</div>`);
  rows.push(`<div><span style="color:#45566E;font-weight:600">Devices offline now:</span> ${b.offline && b.offline.length ? esc(b.offline.join(", ")) : "none"}</div>`);
  rows.push(`<div><span style="color:#45566E;font-weight:600">Open tickets at this office:</span> ${Number(b.openTickets || 0)}</div>`);
  const qa = (b.recentQA || []).map((x) =>
    `<div style="margin-top:6px"><span style="color:#45566E;font-weight:600">Asked Genius:</span> ${esc(x.q)}<br><span class="muted">${esc(x.a)}</span></div>`).join("");
  return `<div class="card"><h3 style="margin-top:0">Handoff brief from Genius</h3>${rows.join("")}${qa || '<p class="muted">No recent Genius questions from this login.</p>'}</div>`;
}

async function adminTargets(env) {
  if (env.ADMIN_ALERT_EMAIL) return [env.ADMIN_ALERT_EMAIL];
  const { results } = await env.DB.prepare(
    "SELECT email FROM users WHERE kind = 'flossbyte' AND status = 'active'").all();
  return (results || []).map((r) => r.email);
}

export async function notifyChatStarted(env, loc, user, threadId) {
  const link = `${env.APP_ORIGIN || "https://portal.flossbyte.com"}/admin/chats/${threadId}`;
  const html = wrap("New live chat waiting",
    `<p><strong>${esc(user.name)}</strong> from ${esc(loc.customer_name)} · ${esc(loc.name)} started a live chat and is waiting for a reply.</p>
     <p>Open the FlossByte admin console to take the chat. The chat includes a short brief from Genius on what they already asked.</p>
     <p><a href="${link}">Open the chat</a></p>`);
  const text = `${user.name} from ${loc.customer_name} · ${loc.name} started a live chat and is waiting. Open it here: ${link}`;
  for (const to of await adminTargets(env)) {
    try { await sendEmail(env, { to, template: "chat_started", subject: `Live chat waiting: ${loc.customer_name} · ${loc.name}`, html, text }); } catch (e) { /* never blocks */ }
  }
}

export async function notifyCustomerReply(env, thread, adminUser) {
  const link = `${env.APP_ORIGIN || "https://portal.flossbyte.com"}/app/locations/${thread.location_id}/ask`;
  const html = wrap("FlossByte replied to your live chat",
    `<p>Hi ${esc((thread.requester_name || "").split(" ")[0] || "there")},</p>
     <p><strong>${esc(adminUser.name)}</strong> from FlossByte replied to your live chat for ${esc(thread.location_name)}.</p>
     <p><a href="${link}">Continue the chat</a></p>`);
  const text = `${adminUser.name} from FlossByte replied to your live chat for ${thread.location_name}. Continue here: ${link}`;
  try { await sendEmail(env, { to: thread.requester_email, template: "chat_reply", subject: "FlossByte replied to your live chat", html, text }); } catch (e) { /* never blocks */ }
}
