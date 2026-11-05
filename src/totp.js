// TOTP (RFC 6238) using WebCrypto HMAC-SHA1. No dependencies.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function generateSecret() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

async function hotp(secretB32, counter) {
  const key = await crypto.subtle.importKey(
    "raw", base32Decode(secretB32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(4, counter, false); // counters stay well below 2^32
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = sig[sig.length - 1] & 0x0f;
  const code = ((sig[offset] & 0x7f) << 24) | ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) | (sig[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, "0");
}

export async function totpNow(secretB32, atMs = Date.now()) {
  return hotp(secretB32, Math.floor(atMs / 1000 / 30));
}

// Accepts the current step plus one step either side for clock drift.
export async function verifyTotp(secretB32, code) {
  const clean = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (const delta of [0, -1, 1]) {
    if (await hotp(secretB32, step + delta) === clean) return true;
  }
  return false;
}

export function otpauthUrl(secretB32, accountEmail) {
  const label = encodeURIComponent("FlossByte Portal:" + accountEmail);
  const issuer = encodeURIComponent("FlossByte Portal");
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${issuer}&digits=6&period=30`;
}
