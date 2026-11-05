// Transactional email. Provider-agnostic: when RESEND_API_KEY and EMAIL_FROM
// are set it sends through the Resend API; otherwise the message is recorded
// in email_log as 'queued' and nothing crashes. Every attempt is logged.

function wrap(title, bodyHtml) {
  return `<div style="font-family:Arial,sans-serif;color:#14213a;max-width:560px;margin:0 auto">
    <div style="background:#0A1628;color:#ffffff;padding:18px 22px;border-radius:8px 8px 0 0">
      <strong style="font-size:18px">FlossByte</strong>
      <span style="color:#00D4B8;font-size:12px"> CLIENT PORTAL</span></div>
    <div style="border:1px solid #dde3ea;border-top:none;padding:22px;border-radius:0 0 8px 8px">
      <h2 style="margin:0 0 12px;font-size:18px">${title}</h2>${bodyHtml}
      <p style="color:#5b6b82;font-size:13px;margin-top:24px">FlossByte, dental IT support.
      Questions: call (669) 237-2264 or reply to this email.</p></div></div>`;
}

export async function sendEmail(env, { to, template, subject, html, text }) {
  let status = "queued", detail = "no email provider configured";
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text }),
      });
      status = resp.ok ? "sent" : "failed";
      detail = `resend http ${resp.status}`;
    } catch (err) {
      status = "failed"; detail = String(err && err.message || err);
    }
  }
  try {
    await env.DB.prepare(
      "INSERT INTO email_log (recipient, template, subject, status, detail) VALUES (?, ?, ?, ?, ?)")
      .bind(to, template, subject, status, detail).run();
  } catch { /* logging must never break the flow */ }
  return status;
}

function origin(env) { return env.APP_ORIGIN || "https://portal.flossbyte.com"; }

export function inviteEmail(env, { name, link }) {
  return {
    subject: "Finish setting up your FlossByte portal login",
    html: wrap("Finish your portal sign-in", `
      <p>Hi ${name},</p>
      <p>Your FlossByte portal login is ready to finish. Set your password here:</p>
      <p><a href="${link}" style="background:#00BFA5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Set my password</a></p>
      <p style="font-size:13px;color:#5b6b82">This link works once and expires in 7 days. In the portal you can see your practice equipment, tickets, and documents.</p>`),
    text: `Hi ${name}, finish setting up your FlossByte portal login here: ${link} (link expires in 7 days).`,
  };
}

export function welcomeEmail(env, { name }) {
  return {
    subject: "Welcome to the FlossByte portal",
    html: wrap("Welcome", `
      <p>Hi ${name},</p>
      <p>Your FlossByte portal account is set up. Sign in any time at
      <a href="${origin(env)}">${origin(env).replace("https://", "")}</a> to check your equipment,
      open tickets, and documents.</p>
      <p>Need hands-on help? The Remote Support button in the portal starts a session with us.</p>`),
    text: `Hi ${name}, your FlossByte portal account is set up. Sign in at ${origin(env)}.`,
  };
}

export function resetEmail(env, { link }) {
  return {
    subject: "Reset your FlossByte portal password",
    html: wrap("Password reset", `
      <p>We got a request to reset your portal password.</p>
      <p><a href="${link}" style="background:#00BFA5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Reset my password</a></p>
      <p style="font-size:13px;color:#5b6b82">This link expires in 1 hour. If you did not ask for this, ignore this email and your password stays the same.</p>`),
    text: `Reset your FlossByte portal password here: ${link} (link expires in 1 hour). If you did not ask for this, ignore this email.`,
  };
}

export function pendingSignupAlertEmail(env, { userName, userEmail }) {
  return {
    subject: "New portal signup waiting to be connected",
    html: wrap("New signup waiting", `
      <p>${userName} (${userEmail}) created a portal account on their own.</p>
      <p>The account has no access to anything until you connect it to a customer in the admin console, under Pending accounts.</p>`),
    text: `${userName} (${userEmail}) created a portal account. It has no access until you connect it in the admin console under Pending accounts.`,
  };
}

export function newCustomerNoticeEmail(env, { customerName, createdBy }) {
  return {
    subject: `New customer added to the portal: ${customerName}`,
    html: wrap("New customer added", `
      <p>${customerName} was added to the FlossByte portal by ${createdBy}.</p>
      <p>Next steps in the admin console: add locations, invite the customer logins, and check the product switches.</p>`),
    text: `${customerName} was added to the FlossByte portal by ${createdBy}. Next: add locations, invite logins, check product switches.`,
  };
}
