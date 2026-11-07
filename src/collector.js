// Collector ingest: small scripts running on office computers (via
// the RMM agent) report facts the cloud APIs cannot see, starting
// with backup results. Each office has its own token; the token is
// stored only as a hash in system_state (no migration needed):
//   collector_token_<sha256>  -> location id
//   collector_loc_<id>        -> { hash, createdAt, lastUsed }
// A report is a POST with the token in the X-Collector-Token header
// (or a "token" field in the JSON body). Tokens are generated and
// rotated by FlossByte from the office's WiFi & Internet page.
import { sha256Hex } from "./auth.js";

async function getState(db, key) {
  const row = await db.prepare("SELECT value FROM system_state WHERE key = ?").bind(key).first().catch(() => null);
  return row ? row.value : null;
}
async function setState(db, key, value) {
  await db.prepare(
    "INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value).run();
}
async function delState(db, key) {
  await db.prepare("DELETE FROM system_state WHERE key = ?").bind(key).run().catch(() => {});
}

export async function issueCollectorToken(db, locationId) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const plain = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await sha256Hex(plain);
  const prev = await getState(db, `collector_loc_${locationId}`);
  if (prev) { try { const p = JSON.parse(prev); if (p.hash) await delState(db, `collector_token_${p.hash}`); } catch { /* old token row may not exist */ } }
  await setState(db, `collector_token_${hash}`, String(locationId));
  await setState(db, `collector_loc_${locationId}`, JSON.stringify({ hash, createdAt: new Date().toISOString(), lastUsed: null }));
  return plain;
}

export async function collectorTokenState(db, locationId) {
  const raw = await getState(db, `collector_loc_${locationId}`);
  if (!raw) return null;
  try { const p = JSON.parse(raw); return { createdAt: p.createdAt || null, lastUsed: p.lastUsed || null }; }
  catch { return null; }
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export async function collectorReport(env, request) {
  let body = null;
  try { body = await request.json(); } catch { return json(400, { ok: false, error: "JSON body required." }); }
  const token = request.headers.get("x-collector-token") || body.token || "";
  if (!token) return json(401, { ok: false, error: "Missing collector token." });
  const hash = await sha256Hex(String(token));
  const locRaw = await getState(env.DB, `collector_token_${hash}`);
  const locationId = locRaw ? Number(locRaw) : null;
  if (!locationId) return json(401, { ok: false, error: "Unknown collector token." });
  if (body.kind !== "backup") return json(400, { ok: false, error: "Only kind=backup is accepted for now." });
  const ok = body.ok === true;
  const atMs = Date.parse(String(body.at || ""));
  if (!Number.isFinite(atMs)) return json(400, { ok: false, error: "A valid 'at' timestamp is required." });
  const ageMs = Date.now() - atMs;
  if (ageMs < -24 * 36e5 || ageMs > 8 * 24 * 36e5) return json(400, { ok: false, error: "The 'at' timestamp is out of range." });
  const snap = {
    ok,
    at: new Date(atMs).toISOString(),
    product: String(body.product || "").slice(0, 60),
    detail: String(body.detail || "").slice(0, 200),
    source: "collector",
  };
  await env.DB.prepare(
    `INSERT INTO network_snapshots (location_id, kind, payload, captured_at) VALUES (?, 'backup', ?, datetime('now'))
     ON CONFLICT(location_id, kind) DO UPDATE SET payload = excluded.payload, captured_at = datetime('now')`)
    .bind(locationId, JSON.stringify(snap)).run();
  const stateRaw = await getState(env.DB, `collector_loc_${locationId}`);
  if (stateRaw) {
    try { const p = JSON.parse(stateRaw); p.lastUsed = new Date().toISOString(); await setState(env.DB, `collector_loc_${locationId}`, JSON.stringify(p)); } catch { /* state row is informational */ }
  }
  return json(200, { ok: true });
}
