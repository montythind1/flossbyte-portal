// Transactional email. Provider-agnostic: when RESEND_API_KEY and EMAIL_FROM
// are set it sends through the Resend API; otherwise the message is recorded
// in email_log as 'queued' and nothing crashes. Every attempt is logged.
//
// Design: one shared shell for every template. Table layout with explicit
// background colors on every section and a declared light color-scheme, so
// mail clients (including dark mode) render it as designed instead of
// improvising: navy header with the logo lockup, white card, thin teal
// rule, navy call-to-action button, quiet gray footer.

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MUTED_P = `style="font-size:13px;line-height:1.55;color:#5B6B82;margin-top:18px"`;

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 4px">
    <tr><td bgcolor="#0A1628" style="border-radius:6px">
      <a href="${href}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:600;letter-spacing:.2px;color:#ffffff;text-decoration:none">${label}</a>
    </td></tr></table>`;
}

function linkFallback(href) {
  return `<p style="margin:12px 0 0;font-size:13px;line-height:1.55;color:#5B6B82">Button not working? Paste this link into your browser:<br>
    <a href="${href}" style="color:#0B7568;word-break:break-all">${href}</a></p>`;
}

export function wrap(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>FlossByte Portal</title>
<style>:root{color-scheme:light;supported-color-schemes:light}
p{margin:0 0 14px}
@media (prefers-color-scheme:dark){.keep-navy{background-color:#0A1628!important}}</style></head>
<body style="margin:0;padding:0;background-color:#EDF0F3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EDF0F3">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:#ffffff;border:1px solid #D9E0E8;border-radius:10px;overflow:hidden">
  <tr><td bgcolor="#0A1628" class="keep-navy" style="padding:20px 32px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding-right:12px;vertical-align:middle"><img src="https://portal.flossbyte.com/assets/logo-icon.png" alt="FlossByte" height="34" style="display:block;height:34px;border:0"></td>
      <td style="vertical-align:middle;font-family:${FONT};color:#ffffff;font-size:19px;font-weight:700;letter-spacing:.2px">FlossByte<span style="display:block;font-size:10.5px;font-weight:600;letter-spacing:2.2px;color:#7FD8C8;margin-top:2px">CLIENT PORTAL</span></td>
    </tr></table></td></tr>
  <tr><td bgcolor="#00BFA5" style="height:3px;line-height:3px;font-size:0">&nbsp;</td></tr>
  <tr><td style="padding:30px 32px 16px;font-family:${FONT};color:#1F2D3D;font-size:15px;line-height:1.6">
    <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#0A1628;font-weight:700">${title}</h1>
    ${bodyHtml}
  </td></tr>
  <tr><td bgcolor="#F5F7F9" style="padding:20px 32px;border-top:1px solid #E1E7ED;font-family:${FONT};font-size:12.5px;line-height:1.6;color:#5B6B82">
    FlossByte, dental IT support. Questions: call <a href="tel:+16692372264" style="color:#0B7568;text-decoration:none">(669) 237-2264</a> or email <a href="mailto:hello@flossbyte.com" style="color:#0B7568;text-decoration:none">hello@flossbyte.com</a>.<br>
    This is an automated message sent from a no-reply address, please don't reply to it.
  </td></tr>
</table>
<div style="font-family:${FONT};font-size:11.5px;color:#8A97A5;margin-top:16px">FlossByte Client Portal &middot; portal.flossbyte.com</div>
</td></tr></table>
</body></html>`;
}

export async function sendEmail(env, { to, template, subject, html, text }) {
  let status = "queued", detail = "no email provider configured";
  // Sender is no-reply by Montek's decision (2026-11-05): transactional mail
  // only, replies are not received. EMAIL_FROM can override for testing.
  const from = env.EMAIL_FROM || "FlossByte Portal <no-reply@flossbyte.com>";
  if (env.RESEND_API_KEY) {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
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
    html: wrap("Finish setting up your portal login", `
      <p>Hi ${name},</p>
      <p>Your FlossByte client portal login has been created. Set your password to finish setting up your account:</p>
      ${button(link, "Set my password")}
      ${linkFallback(link)}
      <p ${MUTED_P}>This link can be used once and expires in 7 days. In the portal you can view your practice's equipment, support tickets, and documents.</p>`),
    text: `Hi ${name}, finish setting up your FlossByte portal login here: ${link} (link expires in 7 days).`,
  };
}

export function welcomeEmail(env, { name }) {
  return {
    subject: "Welcome to the FlossByte portal",
    html: wrap("Your portal account is ready", `
      <p>Hi ${name},</p>
      <p>Your FlossByte portal account is set up. Sign in to view your practice's equipment, open support tickets, and read your documents.</p>
      ${button(origin(env), "Sign in to the portal")}
      <p ${MUTED_P}>Need hands-on help? The Remote Support button inside the portal starts a session with our team.</p>`),
    text: `Hi ${name}, your FlossByte portal account is set up. Sign in at ${origin(env)}.`,
  };
}

export function resetEmail(env, { link }) {
  return {
    subject: "Reset your FlossByte portal password",
    html: wrap("Reset your password", `
      <p>We received a request to reset the password for your FlossByte portal account.</p>
      ${button(link, "Reset my password")}
      ${linkFallback(link)}
      <p ${MUTED_P}>This link expires in 1 hour. If you didn't ask for a reset, ignore this email, your password stays the same.</p>`),
    text: `Reset your FlossByte portal password here: ${link} (link expires in 1 hour). If you did not ask for this, ignore this email.`,
  };
}

export function ownershipTransferEmail(env, { fromName, fromEmail, toName, toEmail }) {
  return {
    subject: "FlossByte portal ownership transferred",
    html: wrap("Portal ownership transferred", `
      <p>Ownership of the FlossByte client portal was transferred.</p>
      <p>From: ${fromName} (${fromEmail})<br>To: ${toName} (${toEmail})</p>
      <p>${toName} is now the Super Admin, the only account that can manage admin logins and transfer ownership again. If this was not expected, contact FlossByte right away.</p>`),
    text: `Ownership of the FlossByte client portal was transferred from ${fromName} (${fromEmail}) to ${toName} (${toEmail}). ${toName} is now the Super Admin. If this was not expected, contact FlossByte right away.`,
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

export function quoteSentEmail(env, { name, quoteTitle, link }) {
  return {
    subject: `Your FlossByte quote: ${quoteTitle}`,
    html: wrap("Your FlossByte quote is ready", `
      <p>Hi ${name},</p>
      <p>Your quote <strong>${quoteTitle}</strong> is ready in your FlossByte portal. You can review the line items and terms there, and accept it right in the portal when you are ready:</p>
      ${button(link, "Review the quote")}
      ${linkFallback(link)}
      <p ${MUTED_P}>Questions about anything in it: call us at (669) 237-2264 or reply to hello@flossbyte.com.</p>`),
    text: `Hi ${name}, your FlossByte quote "${quoteTitle}" is ready in your portal: ${link}`,
  };
}

export function invoiceIssuedEmail(env, { name, invoiceNo, title, amount, dueDate, isDeposit, link }) {
  return {
    subject: `Invoice ${invoiceNo} from FlossByte: ${title}`,
    html: wrap("Your FlossByte invoice is ready", `
      <p>Hi ${name},</p>
      <p>${isDeposit ? `The deposit invoice for <strong>${title}</strong> is ready in your portal. Your project is scheduled once the deposit is paid.` : `A new invoice, <strong>${title}</strong>, is ready in your portal.`}</p>
      <p>Amount: <strong>${amount}</strong>${dueDate ? `<br>Due: ${dueDate}` : ""}</p>
      ${button(link, "View and pay")}
      ${linkFallback(link)}
      <p ${MUTED_P}>You can pay by card or by bank right on that page. Questions: call us at (669) 237-2264 or reply to hello@flossbyte.com.</p>`),
    text: `Hi ${name}, FlossByte invoice ${invoiceNo} for ${title} (${amount}) is ready in your portal: ${link}`,
  };
}

export function invoiceReminderEmail(env, { name, invoiceNo, title, amount, kind, daysLate, dueDate, link }) {
  const lead = kind === "overdue"
    ? `<p>Invoice <strong>${invoiceNo}</strong> for ${title} was due${dueDate ? " on " + dueDate : ""} and is now <strong>${daysLate} day${daysLate === 1 ? "" : "s"} past due</strong>. The balance is <strong>${amount}</strong>.</p><p>If something looks off, call us at (669) 237-2264 and we will sort it out. Otherwise, the invoice is ready to pay in your portal:</p>`
    : kind === "due"
      ? `<p>Invoice <strong>${invoiceNo}</strong> for ${title} is due today. The balance is <strong>${amount}</strong>. You can pay it in your portal:</p>`
      : `<p>A quick reminder about invoice <strong>${invoiceNo}</strong> for ${title}. The balance is <strong>${amount}</strong>${dueDate ? `, due ${dueDate}` : ""}. You can pay it any time in your portal:</p>`;
  return {
    subject: kind === "overdue" ? `Past due: invoice ${invoiceNo} from FlossByte` : `Reminder: invoice ${invoiceNo} from FlossByte`,
    html: wrap("Invoice reminder", `
      <p>Hi ${name},</p>
      ${lead}
      ${button(link, "View and pay")}
      ${linkFallback(link)}
      <p ${MUTED_P}>You can pay by card or by bank on that page. Already paid? You can ignore this; a payment can take a day to show. Questions: call us at (669) 237-2264.</p>`),
    text: `Hi ${name}, a reminder about FlossByte invoice ${invoiceNo} for ${title} (${amount}): ${link}`,
  };
}

export function quoteReminderEmail(env, { name, quoteTitle, total, second, link }) {
  return {
    subject: second ? `Still open: your FlossByte quote, ${quoteTitle}` : "A quick follow-up on your FlossByte quote",
    html: wrap("Your quote is still waiting", `
      <p>Hi ${name},</p>
      <p>${second ? `Your FlossByte quote <strong>${quoteTitle}</strong> (${total}) is still open. Reviewing it only takes a minute, and accepting it in the portal is what gets the work scheduled.` : `Just following up on your FlossByte quote <strong>${quoteTitle}</strong> (${total}). It is waiting in your portal whenever you are ready:`}</p>
      ${button(link, "Review the quote")}
      ${linkFallback(link)}
      <p ${MUTED_P}>Want changes, or a time to talk it through? Call us at (669) 237-2264 or reply to hello@flossbyte.com.</p>`),
    text: `Hi ${name}, following up on your FlossByte quote "${quoteTitle}" (${total}): ${link}`,
  };
}

export function ticketCreatedNoticeEmail(env, { customerName, locationName, title, priority, authorName, link }) {
  return {
    subject: `New ticket: ${title} (${customerName})`,
    html: wrap("A customer opened a support ticket", `
      <p><strong>${customerName}</strong> / ${locationName}</p>
      <p><strong>${title}</strong></p>
      <p ${MUTED_P}>Priority: ${priority}, opened by ${authorName}.</p>`, { label: "Open the ticket", url: link }),
    text: `${customerName} / ${locationName}: new ticket "${title}" (priority ${priority}, opened by ${authorName}). ${link}`,
  };
}

export function ticketReplyNoticeEmail(env, { heading, customerName, locationName, title, authorName, link, toCustomer }) {
  return {
    subject: `${toCustomer ? "FlossByte replied to your ticket" : "New reply on a ticket"}: ${title}`,
    html: wrap(heading, `
      <p><strong>${customerName}</strong> / ${locationName}</p>
      <p><strong>${title}</strong></p>
      <p ${MUTED_P}>Latest reply by ${authorName}.</p>`, { label: "View the ticket", url: link }),
    text: `${customerName} / ${locationName}: new reply on "${title}" by ${authorName}. ${link}`,
  };
}

// FlossByte-side notice for a service request. The button deep-links
// to the customer's Products tab in the admin console, where the
// switch for the requested service lives.
export function productRequestEmail(env, { customerName, locationName, productName, requestedBy, requestedByEmail, when, again, link }) {
  const heading = again ? "Service requested again" : "New service request";
  const row = (label, value) => `<tr><td style="padding:5px 16px 5px 0;color:#5B6B82;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:5px 0;font-weight:600">${value}</td></tr>`;
  return {
    subject: `Service request: ${productName} — ${customerName} (${locationName})`,
    html: wrap(heading, `
      <p>${again ? "A customer asked again about a service they do not have yet." : "A customer asked about a service they do not have yet."}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 2px">
        ${row("Practice:", customerName)}
        ${row("Office:", locationName)}
        ${row("Service:", productName)}
        ${row("Requested by:", `${requestedBy} (${requestedByEmail})`)}
        ${row("When:", when)}
      </table>
      ${button(link, `Open ${customerName} products`)}
      ${linkFallback(link)}
      <p ${MUTED_P}>Turning it on there gives the office access right away.</p>`),
    text: `${heading}: ${customerName} / ${locationName} requested ${productName} (asked by ${requestedBy}, ${requestedByEmail}, ${when}). Turn it on here: ${link}`,
  };
}

// Customer-side confirmation for the same request, sent to the
// organization's customer admins. Plain client language, no admin link.
export function productRequestCustomerEmail(env, { name, locationName, productName, requestedBy, again }) {
  return {
    subject: `We received your request for ${productName} — ${locationName}`,
    html: wrap("Request received", `
      <p>Hi ${name},</p>
      <p>We received ${again ? "your follow-up request" : "the request"} for <strong>${productName}</strong> at <strong>${locationName}</strong> (requested by ${requestedBy}).</p>
      <p>What happens next: FlossByte will follow up with a quote for turning it on. There is no charge to ask, and nothing about your current services changes unless you approve it.</p>
      <p ${MUTED_P}>Questions in the meantime: call us at (669) 237-2264 or email hello@flossbyte.com.</p>`),
    text: `Hi ${name}, we received ${again ? "your follow-up request" : "the request"} for ${productName} at ${locationName} (requested by ${requestedBy}). FlossByte will follow up with a quote; there is no charge to ask. Questions: (669) 237-2264 or hello@flossbyte.com.`,
  };
}

export function quoteAcceptedNoticeEmail(env, { customerName, quoteTitle, acceptedBy, total }) {
  return {
    subject: `Quote accepted: ${customerName}`,
    html: wrap("A quote was accepted in the portal", `
      <p><strong>${customerName}</strong> accepted the quote <strong>${quoteTitle}</strong> (${total}).</p>
      <p>Signed by: ${acceptedBy}.</p>
      <p ${MUTED_P}>Any deposit invoice was created automatically and is on the customer's Invoices tab in the admin console.</p>`),
    text: `${customerName} accepted the quote "${quoteTitle}" (${total}). Signed by: ${acceptedBy}.`,
  };
}
