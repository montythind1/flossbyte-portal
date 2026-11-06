// Password hashing (PBKDF2), server-side sessions, and one-time tokens.
// Only hashes of session and action tokens are ever stored.

const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 30;

export function toB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toB64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, key, 256);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("pbkdf2$")) return false;
  const [, iterStr, saltB64, hashB64] = stored.split("$");
  const iterations = parseInt(iterStr, 10) || PBKDF2_ITERATIONS;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromB64(saltB64), iterations, hash: "SHA-256" }, key, 256);
  const expected = fromB64(hashB64);
  const actual = new Uint8Array(bits);
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

function sqlTime(date) { return date.toISOString().slice(0, 19).replace("T", " "); }

export async function createSession(db, userId) {
  const raw = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  await db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(raw), userId, sqlTime(expires)).run();
  return raw;
}

export function sessionCookie(raw, maxAgeSeconds = SESSION_DAYS * 86400) {
  return `fb_session=${raw}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// Returns the signed-in user row or null. Disabled users and revoked or
// expired sessions resolve to null.
export async function resolveSession(db, request) {
  const raw = readCookie(request, "fb_session");
  if (!raw) return null;
  const row = await db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now')`)
    .bind(await sha256Hex(raw)).first();
  if (!row || row.status === "disabled") return null;
  return row;
}

export async function revokeSession(db, request) {
  const raw = readCookie(request, "fb_session");
  if (!raw) return;
  await db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?")
    .bind(await sha256Hex(raw)).run();
}

export async function revokeAllSessions(db, userId) {
  await db.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL")
    .bind(userId).run();
}

// Creates a one-time invite / reset / MFA-challenge token. Returns the raw
// token (shown once, in a link or cookie); only its hash is stored.
export async function createAuthToken(db, userId, purpose, ttlMinutes) {
  const raw = randomToken();
  const expires = new Date(Date.now() + ttlMinutes * 60 * 1000);
  await db.prepare("INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(raw), userId, purpose, sqlTime(expires)).run();
  return raw;
}

export async function consumeAuthToken(db, raw, purpose) {
  if (!raw) return null;
  const row = await db.prepare(
    `SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ?
     AND used_at IS NULL AND expires_at > datetime('now')`)
    .bind(await sha256Hex(raw), purpose).first();
  if (!row) return null;
  await db.prepare("UPDATE auth_tokens SET used_at = datetime('now') WHERE id = ?").bind(row.id).run();
  return row;
}

export async function peekAuthToken(db, raw, purpose) {
  if (!raw) return null;
  return db.prepare(
    `SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ?
     AND used_at IS NULL AND expires_at > datetime('now')`)
    .bind(await sha256Hex(raw), purpose).first();
}

// ---------- Shared people-field helpers ----------
// A login keeps one stored name; forms work in first / middle / last.
export function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", middle: "", last: "" };
  if (parts.length === 1) return { first: parts[0], middle: "", last: "" };
  return { first: parts[0], middle: parts.slice(1, -1).join(" "), last: parts[parts.length - 1] };
}
export function joinName(first, middle, last) {
  return [first, middle, last].map((s) => String(s || "").trim()).filter(Boolean).join(" ");
}
// US phone numbers are stored in exactly one format: (AAA) BBB-CCCC.
// Anything that reduces to 10 digits (an optional leading country-code
// 1 is dropped) is accepted and reformatted; anything else is invalid.
export function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
