// Public and account pages: setup, login, MFA, signup, invite, password reset.
import { page, redirect, esc } from "./layout.js";
import {
  hashPassword, verifyPassword, createSession, revokeSession, sessionCookie,
  clearCookie, readCookie, createAuthToken, consumeAuthToken, peekAuthToken,
  revokeAllSessions,
} from "./auth.js";
import { verifyTotp, generateSecret, otpauthUrl } from "./totp.js";
import { audit } from "./access.js";
import { sendEmail, inviteEmail, welcomeEmail, resetEmail, pendingSignupAlertEmail } from "./email.js";

function params(request) { return new URL(request.url).searchParams; }
function origin(env) { return env.APP_ORIGIN || "https://portal.flossbyte.com"; }

export async function anyFlossbyteAdmin(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE kind = 'flossbyte'").first();
  return row && row.n > 0;
}

// ---------- One-time setup ----------
export async function setupPage(env, request) {
  if (await anyFlossbyteAdmin(env.DB)) return redirect("/login");
  const body = `<div class="card narrow"><h1>Create the admin login</h1>
    <p class="muted">This one-time setup creates the FlossByte Super Admin for the portal. After this, the setup screen never appears again.</p>
    <form method="post" action="/setup">
      <label>Your name</label><input name="name" required autocomplete="name">
      <label>Email</label><input name="email" type="email" required autocomplete="email">
      <label>Password</label><input name="password" type="password" required minlength="10" autocomplete="new-password">
      <label>Password again</label><input name="password2" type="password" required autocomplete="new-password">
      <p style="margin-top:18px"><button class="btn" type="submit">Create admin login</button></p>
    </form></div>`;
  return page({ title: "Setup", body });
}

export async function setupPost(env, request) {
  if (await anyFlossbyteAdmin(env.DB)) return redirect("/login");
  const form = await request.formData();
  const name = String(form.get("name") || "").trim();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const pw = String(form.get("password") || "");
  if (!name || !email || pw.length < 10) {
    return page({ title: "Setup", error: "Name, email, and a password of at least 10 characters are required.", body: "" });
  }
  if (pw !== String(form.get("password2") || "")) {
    return page({ title: "Setup", error: "The two passwords do not match.", body: "" });
  }
  const res = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, kind, role, status, email_verified_at)
     VALUES (?, ?, ?, 'flossbyte', 'super_admin', 'active', datetime('now'))`)
    .bind(email, name, await hashPassword(pw)).run();
  const userId = res.meta.last_row_id;
  await audit(env.DB, userId, "setup_super_admin", "user", userId, email);
  const raw = await createSession(env.DB, userId);
  return redirect("/mfa", { "Set-Cookie": sessionCookie(raw) });
}

// ---------- Login ----------
export function loginPage(request) {
  const q = params(request);
  const body = `<div class="card narrow"><h1>Sign in</h1>
    <form method="post" action="/login">
      <label>Email</label><input name="email" type="email" required autocomplete="email">
      <label>Password</label><input name="password" type="password" required autocomplete="current-password">
      <p style="margin-top:18px"><button class="btn" type="submit" style="width:100%">Sign in</button></p>
    </form>
    <p class="muted" style="margin-top:16px">New customer? <a href="/signup">Create account</a></p>
    <p class="muted">Forgot your password? <a href="/reset">Reset it</a></p></div>`;
  return page({ title: "Sign in", body, flash: q.get("msg") || undefined, error: q.get("err") || undefined });
}

export async function loginPost(env, request) {
  const form = await request.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const pw = String(form.get("password") || "");
  const fail = () => redirect("/login?err=" + encodeURIComponent("Email or password doesn't match."));
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (!user || user.status === "disabled" || user.status === "invited") return fail();
  if (!(await verifyPassword(pw, user.password_hash))) return fail();
  if (user.mfa_enabled && user.mfa_secret) {
    const raw = await createAuthToken(env.DB, user.id, "mfa", 10);
    return redirect("/login/mfa", { "Set-Cookie": `fb_mfa=${raw}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` });
  }
  await env.DB.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").bind(user.id).run();
  const raw = await createSession(env.DB, user.id);
  const dest = user.kind === "flossbyte" ? (user.mfa_enabled ? "/admin" : "/mfa") : "/app";
  return redirect(dest, { "Set-Cookie": sessionCookie(raw) });
}

export function loginMfaPage(request) {
  const q = params(request);
  const body = `<div class="card narrow"><h1>Two-step verification</h1>
    <p class="muted">Enter the 6-digit code from your authenticator app.</p>
    <form method="post" action="/login/mfa">
      <label>Code</label><input name="code" inputmode="numeric" autocomplete="one-time-code" required>
      <p style="margin-top:18px"><button class="btn" type="submit" style="width:100%">Verify</button></p>
    </form></div>`;
  return page({ title: "Verify", body, error: q.get("err") || undefined });
}

export async function loginMfaPost(env, request) {
  const raw = readCookie(request, "fb_mfa");
  const token = await peekAuthToken(env.DB, raw, "mfa");
  if (!token) return redirect("/login?err=" + encodeURIComponent("That verification expired. Sign in again."));
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(token.user_id).first();
  const form = await request.formData();
  if (!user || !(await verifyTotp(user.mfa_secret, String(form.get("code") || "")))) {
    return redirect("/login/mfa?err=" + encodeURIComponent("That code doesn't match. Try again."));
  }
  await consumeAuthToken(env.DB, raw, "mfa");
  await env.DB.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").bind(user.id).run();
  const session = await createSession(env.DB, user.id);
  const headers = new Headers({ Location: user.kind === "flossbyte" ? "/admin" : "/app" });
  headers.append("Set-Cookie", sessionCookie(session));
  headers.append("Set-Cookie", clearCookie("fb_mfa"));
  return new Response(null, { status: 302, headers });
}

export async function logoutGet(env, request) {
  await revokeSession(env.DB, request);
  return redirect("/login?msg=" + encodeURIComponent("You are signed out."), { "Set-Cookie": clearCookie("fb_session") });
}

// ---------- Self-signup (pending, no access) ----------
export function signupPage(request) {
  const q = params(request);
  const body = `<div class="card narrow"><h1>Create account</h1>
    <p class="muted">Create your login here. FlossByte then connects your account to your practice, and only then can you see your equipment, tickets, and documents.</p>
    <form method="post" action="/signup">
      <label>Your name</label><input name="name" required autocomplete="name">
      <label>Practice name</label><input name="practice" required>
      <label>Email</label><input name="email" type="email" required autocomplete="email">
      <label>Password</label><input name="password" type="password" required minlength="10" autocomplete="new-password">
      <p style="margin-top:18px"><button class="btn" type="submit" style="width:100%">Create account</button></p>
    </form>
    <p class="muted" style="margin-top:16px">Already have a login? <a href="/login">Back to login</a></p></div>`;
  return page({ title: "Create account", body, error: q.get("err") || undefined });
}

export async function signupPost(env, request) {
  if (!(await anyFlossbyteAdmin(env.DB))) return redirect("/setup");
  const form = await request.formData();
  const name = String(form.get("name") || "").trim();
  const practice = String(form.get("practice") || "").trim();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const pw = String(form.get("password") || "");
  if (!name || !email || pw.length < 10) {
    return redirect("/signup?err=" + encodeURIComponent("Name, email, and a password of at least 10 characters are required."));
  }
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return redirect("/signup?err=" + encodeURIComponent("That email already has a login. Sign in instead."));
  const res = await env.DB.prepare(
    `INSERT INTO users (email, name, password_hash, kind, role, status) VALUES (?, ?, ?, 'customer', 'customer_user', 'pending')`)
    .bind(email, name, await hashPassword(pw)).run();
  const userId = res.meta.last_row_id;
  await audit(env.DB, userId, "self_signup", "user", userId, `practice stated: ${practice}`);
  const mail = welcomeEmail(env, { name });
  await sendEmail(env, { to: email, template: "welcome", ...mail });
  if (env.ADMIN_ALERT_EMAIL) {
    const alert = pendingSignupAlertEmail(env, { userName: name, userEmail: email });
    await sendEmail(env, { to: env.ADMIN_ALERT_EMAIL, template: "admin_pending_signup", ...alert });
  }
  const raw = await createSession(env.DB, userId);
  return redirect("/app", { "Set-Cookie": sessionCookie(raw) });
}

// ---------- Invite (finish sign-in) ----------
export async function invitePage(env, request, tokenRaw) {
  const token = await peekAuthToken(env.DB, tokenRaw, "invite");
  if (!token) return page({ title: "Link expired", body: `<div class="card narrow"><h1>Link expired</h1><p class="muted">This invite link is no longer valid. Ask FlossByte to send a fresh one.</p></div>` });
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(token.user_id).first();
  const body = `<div class="card narrow"><h1>Finish your sign-in</h1>
    <p class="muted">Hi ${esc(user.name)}, set the password for ${esc(user.email)} to finish.</p>
    <form method="post" action="/invite/${esc(tokenRaw)}">
      <label>Password</label><input name="password" type="password" required minlength="10" autocomplete="new-password">
      <label>Password again</label><input name="password2" type="password" required autocomplete="new-password">
      <p style="margin-top:18px"><button class="btn" type="submit" style="width:100%">Set password and sign in</button></p>
    </form></div>`;
  return page({ title: "Finish sign-in", body });
}

export async function invitePost(env, request, tokenRaw) {
  const token = await peekAuthToken(env.DB, tokenRaw, "invite");
  if (!token) return redirect("/login?err=" + encodeURIComponent("That invite link expired. Ask FlossByte for a new one."));
  const form = await request.formData();
  const pw = String(form.get("password") || "");
  if (pw.length < 10 || pw !== String(form.get("password2") || "")) {
    return redirect(`/invite/${tokenRaw}?err=bad`);
  }
  await consumeAuthToken(env.DB, tokenRaw, "invite");
  await env.DB.prepare(
    `UPDATE users SET password_hash = ?, status = 'active', email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?`)
    .bind(await hashPassword(pw), token.user_id).run();
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(token.user_id).first();
  const mail = welcomeEmail(env, { name: user.name });
  await sendEmail(env, { to: user.email, template: "welcome", ...mail });
  await audit(env.DB, user.id, "invite_accepted", "user", user.id, user.email);
  const raw = await createSession(env.DB, user.id);
  const dest = user.kind === "flossbyte" ? "/mfa" : "/app";
  return redirect(dest, { "Set-Cookie": sessionCookie(raw) });
}

// ---------- Password reset ----------
export function resetRequestPage(request) {
  const q = params(request);
  const body = `<div class="card narrow"><h1>Reset password</h1>
    <form method="post" action="/reset">
      <label>Email</label><input name="email" type="email" required autocomplete="email">
      <p style="margin-top:18px"><button class="btn" type="submit" style="width:100%">Email me a reset link</button></p>
    </form>
    <p class="muted" style="margin-top:16px"><a href="/login">Back to login</a></p></div>`;
  return page({ title: "Reset password", body, flash: q.get("msg") || undefined });
}

export async function resetRequestPost(env, request) {
  const form = await request.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (user && user.status !== "disabled") {
    const raw = await createAuthToken(env.DB, user.id, "reset", 60);
    const mail = resetEmail(env, { link: `${origin(env)}/reset/${raw}` });
    await sendEmail(env, { to: email, template: "password_reset", ...mail });
  }
  // Same answer whether or not the email exists.
  return redirect("/reset?msg=" + encodeURIComponent("If that email has a portal login, a reset link is on its way."));
}

export async function resetPage(env, request, tokenRaw) {
  const token = await peekAuthToken(env.DB, tokenRaw, "reset");
  if (!token) return page({ title: "Link expired", body: `<div class="card narrow"><h1>Link expired</h1><p class="muted">This reset link is no longer valid. <a href="/reset">Request a new one</a>.</p></div>` });
  const body = `<div class="card narrow"><h1>Set a new password</h1>
    <form method="post" action="/reset/${esc(tokenRaw)}">
      <label>New password</label><input name="password" type="password" required minlength="10" autocomplete="new-password">
      <label>Password again</label><input name="password2" type="password" required autocomplete="new-password">
      <p style="margin-top:18px"><button class="btn" type="submit" style="width:100%">Set password</button></p>
    </form></div>`;
  return page({ title: "Set new password", body });
}

export async function resetPost(env, request, tokenRaw) {
  const token = await peekAuthToken(env.DB, tokenRaw, "reset");
  if (!token) return redirect("/login?err=" + encodeURIComponent("That reset link expired. Request a new one."));
  const form = await request.formData();
  const pw = String(form.get("password") || "");
  if (pw.length < 10 || pw !== String(form.get("password2") || "")) {
    return redirect(`/reset/${tokenRaw}`);
  }
  await consumeAuthToken(env.DB, tokenRaw, "reset");
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(await hashPassword(pw), token.user_id).run();
  await revokeAllSessions(env.DB, token.user_id);
  await audit(env.DB, token.user_id, "password_reset", "user", token.user_id, null);
  return redirect("/login?msg=" + encodeURIComponent("Password updated. Sign in with the new one."));
}

// ---------- MFA enrollment (signed in) ----------
export async function mfaPage(env, request, user) {
  const q = params(request);
  let body;
  if (user.mfa_enabled) {
    body = `<div class="card narrow"><h1>Two-step verification</h1>
      <p><span class="pill on">On</span></p>
      <p class="muted">Your login asks for an authenticator code after your password. That stays on for FlossByte admin accounts.</p>
      <p><a class="btn secondary" href="${user.kind === "flossbyte" ? "/admin" : "/app"}">Back to the portal</a></p></div>`;
  } else {
    let secret = user.mfa_secret;
    if (!secret) {
      secret = generateSecret();
      await env.DB.prepare("UPDATE users SET mfa_secret = ? WHERE id = ?").bind(secret, user.id).run();
    }
    body = `<div class="card narrow"><h1>Set up two-step verification</h1>
      ${user.kind === "flossbyte" ? `<p class="muted">FlossByte admin logins need this. It takes a minute with any authenticator app.</p>` : `<p class="muted">Optional, and a good idea. Use any authenticator app.</p>`}
      <p class="muted">Scan this code with your authenticator app, then enter the 6-digit code it shows:</p>
      <div id="mfaQr" data-url="${esc(otpauthUrl(secret, user.email))}" style="background:#fff;padding:12px;border-radius:10px;width:max-content;max-width:100%"></div>
      <p class="muted" style="margin-top:14px">Can't scan it? Type this key into the app instead:</p>
      <p style="font-size:18px;letter-spacing:2px"><strong>${esc(secret)}</strong></p>
      <script src="/assets/qrcode.js"></script>
      <script src="/assets/mfa-qr.js"></script>
      <form method="post" action="/mfa/verify">
        <label>Code from the app</label><input name="code" inputmode="numeric" autocomplete="one-time-code" required>
        <p style="margin-top:18px"><button class="btn" type="submit">Turn on</button></p>
      </form></div>`;
  }
  return page({ title: "Security", user, body, error: q.get("err") || undefined, flash: q.get("msg") || undefined });
}

export async function mfaVerifyPost(env, request, user) {
  const form = await request.formData();
  if (!user.mfa_secret || !(await verifyTotp(user.mfa_secret, String(form.get("code") || "")))) {
    return redirect("/mfa?err=" + encodeURIComponent("That code doesn't match. Check the app and try again."));
  }
  await env.DB.prepare("UPDATE users SET mfa_enabled = 1 WHERE id = ?").bind(user.id).run();
  await audit(env.DB, user.id, "mfa_enabled", "user", user.id, null);
  return redirect((user.kind === "flossbyte" ? "/admin" : "/app") + "?msg=" + encodeURIComponent("Two-step verification is on."));
}

export { inviteEmail };
