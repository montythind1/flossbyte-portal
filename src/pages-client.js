// Client-facing portal pages. Every handler re-checks access to the location
// on the server; nothing here trusts ids from the browser.
import { page, redirect, esc, icon, fmtDateUS, withStatus } from "./layout.js";
import {
  canAccessLocation, locationScope, getLocation, productEnabled, productStates,
  expiringItems, audit, accessibleLocationIds, customerAdminOrg, orgMembers,
  removeUserFromCustomer,
} from "./access.js";
import { sendEmail, quoteAcceptedNoticeEmail, ticketCreatedNoticeEmail, ticketReplyNoticeEmail, productRequestEmail } from "./email.js";
import { splitName, joinName } from "./auth.js";

function orgOrigin(env) { return env.APP_ORIGIN || "https://portal.flossbyte.com"; }

const REMOTE_URL = "https://flossbyte.com/remote";

function fmtDate(d) { return d || ""; }
function fmtMoney(cents) {
  return "$" + (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Equipment and Tickets serve both paying lanes: a Managed IT plan, or a
// one-time project (the portal is the project's record, and the ticket
// door stays open for the next job).
async function laneOn(db, customerId, locationId) {
  return (await productEnabled(db, customerId, locationId, "managed_it")) ||
         (await productEnabled(db, customerId, locationId, "one_time_project"));
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const ms = new Date(dateStr + "T00:00:00Z").getTime() - Date.now();
  return Math.ceil(ms / 86400000);
}

async function guard(env, user, locationId) {
  const loc = await getLocation(env.DB, locationId);
  if (!loc) return { error: 404 };
  if (!(await canAccessLocation(env.DB, user, locationId))) return { error: 403 };
  return { loc };
}

// ---------- Device names a person can read ----------
// UniFi only knows what a device calls itself, and plenty of devices
// announce junk: a Windows default hostname ("DESKTOP-51GEUKL"), a
// model code ("ET788C77A1448C"), or a bare MAC address. These helpers
// translate the recognizable patterns into what the thing actually is,
// and a rename FlossByte sets once (stored in a 'device_names'
// snapshot, keyed by the sync's external id or the MAC) wins over
// every automatic guess. The source name is never overwritten.
function baseName(e) {
  let n = String(e.name || "").trim();
  const macHex = String(e.mac || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  const m = /\s([0-9a-f]{2}):([0-9a-f]{2})$/i.exec(n);
  if (m && macHex.endsWith((m[1] + m[2]).toLowerCase())) n = n.slice(0, m.index).trim();
  return n;
}
function deviceKind(e) {
  const n = `${baseName(e)} ${e.model || ""}`.trim();
  const t = String(e.type || "");
  if (t === "Gateway" || t === "Firewall") return t;
  if (t === "Access point") return "Access point";
  if (t === "Switch") return "Switch";
  if (t === "Camera" || /bullet|dome|camera/i.test(n)) return "Camera";
  if (t === "Recorder" || /NVR|recorder/i.test(n)) return "Camera recorder";
  if (/^SIP-T|yealink/i.test(n)) return "Desk phone";
  if (/^VFI-|verifone/i.test(n)) return "Card reader";
  if (/epson|^ET[0-9A-F]{6,}$|printer/i.test(n)) return "Printer";
  if (/sonos/i.test(n)) return "Speaker";
  if (/^iPad/i.test(n)) return "Tablet";
  if (/^iPhone/i.test(n)) return "Phone";
  if (/server/i.test(n)) return "Server";
  if (/^OP\d|frontdesk|front\d|doc\d|desktop-|laptop-|^Mac\b|computer|workstation/i.test(n)) return "Computer";
  if (t === "Connected device") return "Device";
  return t || "Device";
}
function autoName(e) {
  const kind = deviceKind(e);
  const n = baseName(e);
  if (!n || /^[0-9a-f:]{12,17}$/i.test(n)) return kind === "Device" ? "Unnamed device" : kind;
  if (/^DESKTOP-[A-Z0-9]+$/i.test(n) || /^LAPTOP-[A-Z0-9]+$/i.test(n)) return kind;
  if (/^EPSON/i.test(n) || /^ET[0-9A-F]{6,}$/i.test(n)) return "Epson printer";
  if (/^SIP-T\w*/i.test(n)) return "Yealink desk phone";
  if (/^VFI-/i.test(n)) return "Verifone card reader";
  if (/^SonosZP/i.test(n)) return "Sonos speaker";
  return n;
}
function kindIcon(kind) {
  if (kind === "Computer" || kind === "Tablet") return "monitor";
  if (kind === "Desk phone" || kind === "Phone") return "phone";
  if (kind === "Printer") return "printer";
  if (kind === "Camera" || kind === "Camera recorder") return "camera";
  if (kind === "Server") return "server";
  if (kind === "Speaker") return "speaker";
  if (kind === "Gateway" || kind === "Switch" || kind === "Access point") return "topology";
  return "box";
}
function kindTile(e, size, dark) {
  const s = size || 34;
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${s}px;height:${s}px;border-radius:9px;background:${dark ? "rgba(255,255,255,.14)" : "#EAF7F4"};color:${dark ? "#8FF5E2" : "#0A7C6E"};flex:none">${icon(kindIcon(deviceKind(e)))}</span>`;
}
// Filter buckets for the equipment list: the office's own groupings.
function kindBucket(e) {
  const k = deviceKind(e);
  if (k === "Computer" || k === "Server" || k === "Tablet") return "computers";
  if (k === "Desk phone" || k === "Phone") return "phones";
  if (k === "Printer") return "printers";
  if (k === "Gateway" || k === "Switch" || k === "Access point") return "network";
  return "other";
}
const BUCKET_RANK = { network: 0, computers: 1, phones: 2, printers: 3, other: 4 };

function displayName(e, renames) {
  if (renames) {
    if (e.external_id && renames[e.external_id]) return renames[e.external_id];
    if (e.mac && renames[e.mac]) return renames[e.mac];
  }
  return autoName(e);
}
async function loadRenames(db, locationId) {
  try {
    const r = await db.prepare("SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = 'device_names'").bind(locationId).first();
    if (r) { const p = JSON.parse(r.payload || "{}"); if (p && p.names && typeof p.names === "object") return p.names; }
  } catch { /* snapshots table absent: no renames yet */ }
  return {};
}
async function saveRenames(db, locationId, names) {
  await db.prepare("INSERT INTO network_snapshots (location_id, kind, payload) VALUES (?, 'device_names', ?) ON CONFLICT(location_id, kind) DO UPDATE SET payload = excluded.payload, captured_at = datetime('now')")
    .bind(locationId, JSON.stringify({ names })).run();
}
function relTime(iso) {
  if (!iso) return "";
  const t = Date.parse(String(iso).replace(" ", "T") + "Z");
  if (!t) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

function denied(user, code) {
  const body = `<div class="card narrow"><h1>${code === 404 ? "Not found" : "No access"}</h1>
    <p class="muted">${code === 404 ? "That page does not exist." : "This login does not have access to that practice."}</p></div>`;
  return withStatus(page({ title: "Portal", user, body }), code);
}

// App shell openers (see adminNav in pages-admin.js): left rail on
// desktop, swipeable chip bar on phones; the layout CSS owns the switch.
function locNav(loc, active) {
  const base = `/app/locations/${loc.id}`;
  const item = (key, href, label, ic) =>
    `<a class="rail-item${active === key ? " active" : ""}" href="${href}">${icon(ic)}${label}</a>`;
  return `<div class="shell"><aside class="rail">
    <a href="/app" style="display:block;padding:0 10px 9px;margin-bottom:9px;border-bottom:1px solid #EEF2F7;color:#5A6B82;text-decoration:none;font-size:13px;font-weight:600">&larr; Your practices</a>
    <div class="rail-context"><div class="rc-t">${esc(loc.name)}</div><div class="rc-s">${esc(loc.customer_name)}</div></div>
    ${item("overview", base, "Overview", "grid")}
    <a class="rail-item${["network", "equipment", "topology"].includes(active) ? " active" : ""}" href="${base}/network">${icon("topology")}Office IT</a>
    ${item("tickets", base + "/tickets", "Tickets", "ticket")}${item("documents", base + "/documents", "Documents", "folder")}
    ${item("ask", base + "/ask", "Ask", "chat")}</aside><div class="shell-main">`;
}

// Top tabs inside the Network section: the sidebar picks the place,
// the tabs pick the view of it (WiFi & Internet / Equipment / Network
// map). Page URLs are unchanged, so existing links keep working.
function locTabs(loc, current) {
  const base = `/app/locations/${loc.id}`;
  const tab = (key, href, label) =>
    `<a href="${href}" style="padding:9px 14px;font-weight:${current === key ? "700" : "500"};color:${current === key ? "#0A1628" : "#5A6B82"};border-bottom:3px solid ${current === key ? "#00BFA5" : "transparent"};margin-bottom:-2px;text-decoration:none;white-space:nowrap">${label}</a>`;
  return `<div style="display:flex;gap:2px;border-bottom:2px solid #E6EBF2;margin:4px 0 18px;overflow-x:auto">${tab("network", base + "/network", "WiFi &amp; Internet")}${tab("equipment", base + "/equipment", "Equipment")}${tab("topology", base + "/topology", "Network map")}</div>`;
}

function orgRail(user, active, orgName, locs) {
  const item = (key, href, label, ic) =>
    `<a class="rail-item${active === key ? " active" : ""}" href="${href}">${icon(ic)}${label}</a>`;
  // Account administration (services, team) sits in its own labeled
  // group, and only the organization's admins see it at all; everyday
  // items (practices, billing) stay above it.
  const account = user.role === "customer_admin"
    ? `<div class="rail-label">Account</div>${item("services", "/app/services", "Services", "shield")}${item("team", "/app/team", "Team", "users")}`
    : "";
  // Direct shortcuts into each practice, so from any organization
  // page (Billing included) a practice is one click away. This is the
  // "way back" from organization scope into a practice.
  const practiceLinks = locs && locs.length
    ? `<div class="rail-label">Go to a practice</div>${locs.map((l) => `<a class="rail-item" href="/app/locations/${l.id}">${icon("pin")}${esc(l.name)}</a>`).join("")}`
    : "";
  return `<div class="shell"><aside class="rail">
    <div class="rail-context"><div class="rc-t">${esc(orgName || "My Portal")}</div></div>
    ${item("practices", "/app", "Your practices", "home")}${item("billing", "/app/billing", "Billing", "receipt")}
    ${practiceLinks}${account}</aside><div class="shell-main">`;
}

// The locations a login can reach, shaped for the org rail shortcuts.
async function railLocs(env, user) {
  const ids = await accessibleLocationIds(env.DB, user);
  if (!ids) return [];
  const out = [];
  for (const id of ids) { const l = await getLocation(env.DB, id); if (l) out.push({ id: l.id, name: l.name }); }
  return out;
}

function lockedTile(user, loc, productName, productKey) {
  const body = `${locNav(loc, "")}<div class="card"><h2>${esc(productName)}</h2>
    <p><span class="pill off">Not included</span></p>
    <p class="muted">This service is not turned on for your practice.</p>
    ${productKey ? requestForm(loc, productKey) : ""}</div>`;
  return page({ title: productName, user, body });
}

// One-click "ask FlossByte for this service" — emails the FlossByte team.
function requestForm(loc, productKey) {
  return `<form method="post" action="/app/locations/${loc.id}/request-product" style="margin-top:12px">
    <input type="hidden" name="product" value="${esc(productKey)}">
    <button class="btn small" type="submit">Request this service</button></form>`;
}

// Alert the FlossByte team: the configured alert address when set,
// otherwise every active FlossByte admin's inbox.
async function alertFlossByte(env, template, mail) {
  let targets = [];
  if (env.ADMIN_ALERT_EMAIL) targets = [env.ADMIN_ALERT_EMAIL];
  else {
    const { results } = await env.DB.prepare("SELECT email FROM users WHERE kind = 'flossbyte' AND status = 'active'").all();
    targets = (results || []).map((r) => r.email);
  }
  for (const to of targets) { try { await sendEmail(env, { to, template, ...mail }); } catch (e) { /* email never blocks the action */ } }
}

export async function productRequestPost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const f = await request.formData();
  const key = String(f.get("product") || "");
  const prod = await env.DB.prepare("SELECT * FROM products WHERE key = ?").bind(key).first();
  if (prod) {
    await audit(env.DB, user.id, "product_request", "location", locationId, prod.name);
    const mail = productRequestEmail(env, {
      customerName: loc.customer_name, locationName: loc.name, productName: prod.name,
      requestedBy: user.name, link: `${orgOrigin(env)}/admin/customers/${loc.customer_id}`,
    });
    await alertFlossByte(env, "product_request", mail);
  }
  return redirect("/app/services?msg=" + encodeURIComponent("Request sent. FlossByte will be in touch about it."));
}

// ---------- Entry: /app ----------
export async function appHome(env, request, user) {
  if (user.kind === "flossbyte") return redirect("/admin");
  const ids = await accessibleLocationIds(env.DB, user);
  if (!ids || ids.size === 0) {
    const body = `<div class="card narrow"><h1>Account created</h1>
      <p>Your login is ready. FlossByte still needs to connect it to your practice, and this screen is all you can see until that happens.</p>
      <p class="muted">Once connected, your equipment, tickets, and documents show up here. If this takes more than a business day, call us at (669) 237-2264.</p></div>`;
    return page({ title: "Waiting", user, body });
  }
  if (ids.size === 1) return redirect(`/app/locations/${[...ids][0]}`);
  const db = env.DB;
  const locs = [];
  for (const id of ids) { const loc = await getLocation(db, id); if (loc) locs.push(loc); }
  // The rail already carries Billing, Services, and Team, so this page
  // is only about the practices: an organization summary strip, then
  // one status card per practice. No link is repeated.
  const srow = (label, val) => `<div style="display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-bottom:1px solid #EEF2F7"><span style="color:#45566E;font-weight:600">${label}</span><span style="text-align:right;font-weight:600">${val}</span></div>`;
  let totOnline = 0, totDevices = 0, totTickets = 0;
  let worst = null;
  const cards = [];
  for (const loc of locs) {
    const c = await db.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online FROM equipment WHERE location_id = ?")
      .bind(loc.id).first();
    const t = await db.prepare(
      "SELECT COUNT(*) AS n FROM tickets WHERE location_id = ? AND status != 'closed'").bind(loc.id).first();
    const health = await officeHealth(db, loc.id);
    if (health && typeof health.score === "number" && (!worst || health.score < worst.score)) {
      worst = { name: loc.name, score: health.score, label: health.label, reasons: health.reasons || [] };
    }
    const snap = await db.prepare(
      "SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = 'internet'").bind(loc.id).first();
    let isp = null;
    if (snap) { try { isp = JSON.parse(snap.payload || "{}").isp || null; } catch { isp = null; } }
    totDevices += c.total || 0; totOnline += c.online || 0; totTickets += t.n || 0;
    const pill = health && typeof health.score === "number"
      ? `<span class="pill ${health.score >= 85 ? "on" : health.score < 60 ? "off" : "warn"}">Health: ${esc(health.label)}</span>` : "";
    cards.push(`<a class="card" href="/app/locations/${loc.id}" style="text-decoration:none;color:inherit;display:block">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div><div style="font-size:18px;font-weight:800">${esc(loc.name)}</div>
        ${loc.city ? `<div class="muted">${esc(loc.city)}</div>` : ""}</div>
        <div>${pill}</div></div>
      <div style="margin-top:8px">
      ${srow("Internet", isp ? `${isp.uptimePct != null && isp.uptimePct >= 99 ? "Working" : "Check connection"}${isp.ispName ? " · " + esc(isp.ispName) : ""}` : "—")}
      ${srow("Devices online", c.total ? `${c.online || 0} of ${c.total}` : "None recorded")}
      ${srow("Open tickets", t.n ? String(t.n) : "No open tickets")}
      </div>
      <p style="margin:12px 0 0;color:#0A7C6E;font-weight:700">Open practice ›</p></a>`);
  }
  const billing = locs.length ? await db.prepare(
    `SELECT (SELECT COUNT(*) FROM invoices WHERE customer_id = ? AND status = 'unpaid') AS unpaid,
            (SELECT COUNT(*) FROM quotes WHERE customer_id = ? AND status = 'sent') AS quotes_waiting`)
    .bind(locs[0].customer_id, locs[0].customer_id).first().catch(() => null) : null;
  // Status band: the organization name is the headline, and under it
  // one navy band carries the overall status in words plus only the
  // actionable numbers (quotes waiting, unpaid invoices, open
  // tickets). The per-practice counts live on the cards, not repeated
  // here as tiles.
  // One status accent only: a colored dot and the status word in the
  // same color, on a plain white card. The palette stays navy + teal,
  // with a single semantic color wherever the status is.
  const dot = (c) => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${c};flex:none"></span>`;
  let bandDot, bandMainHtml;
  if (!worst || worst.score >= 85) { bandDot = dot("#0A7C6E"); bandMainHtml = "Everything is running"; }
  else if (worst.score >= 60) { bandDot = dot("#b45309"); bandMainHtml = `${esc(worst.name)} is running <span style="color:#b45309">fair</span>`; }
  else { bandDot = dot("#b91c1c"); bandMainHtml = `${esc(worst.name)} <span style="color:#b91c1c">needs attention</span>`; }
  const lastCheck = locs.length ? await db.prepare(
    "SELECT MAX(captured_at) AS last FROM network_snapshots WHERE location_id IN (SELECT id FROM locations WHERE customer_id = ?)")
    .bind(locs[0].customer_id).first().catch(() => null) : null;
  const bandSub = (!worst || worst.score >= 85 ? "Nothing needs attention at any practice."
    : (worst.reasons.slice(0, 2).join(" · ") || "See its practice card for details."))
    + (lastCheck && lastCheck.last ? ` · checked ${relTime(lastCheck.last)}` : "");
  const chip = "background:#F2F6FA;border:1px solid #DDE5EE;color:#0A1628;border-radius:99px;padding:6px 12px;font-weight:600;font-size:13px;text-decoration:none;white-space:nowrap";
  const chips = [
    billing && billing.quotes_waiting ? `<a href="/app/billing" style="${chip}">${billing.quotes_waiting} quote${billing.quotes_waiting > 1 ? "s" : ""} waiting</a>` : "",
    billing && billing.unpaid ? `<a href="/app/billing" style="${chip}">${billing.unpaid} unpaid invoice${billing.unpaid > 1 ? "s" : ""}</a>` : "",
    totTickets ? `<span style="${chip}">${totTickets} open ticket${totTickets > 1 ? "s" : ""}</span>` : "",
  ].filter(Boolean).join("");
  const band = `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:center">
      <div><div style="display:flex;align-items:center;gap:9px;font-size:17px;font-weight:800">${bandDot}<span>${bandMainHtml}</span></div>
      <div class="muted" style="margin-top:4px;margin-left:19px">${esc(bandSub)}</div></div>
      ${chips ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${chips}</div>` : ""}
    </div></div>`;
  // The organization totals sit under the band as a stat row in the
  // portal's standard tile style (Montek asked for the numbers back
  // with the white-band design kept).
  const strip = `<div class="statgrid">
    <div class="stat"><b>${locs.length}</b><span>${locs.length === 1 ? "Practice" : "Practices"}</span></div>
    <div class="stat"><b>${totDevices ? `${totOnline} of ${totDevices}` : "0"}</b><span>Devices online</span></div>
    <div class="stat"><b>${totTickets}</b><span>Open tickets</span></div>
    <div class="stat"><b>${billing ? billing.unpaid || 0 : 0}</b><span>Unpaid invoices</span></div>
  </div>`;
  const orgName = locs.length ? locs[0].customer_name : "";
  const body = `${orgRail(user, "practices", orgName || "My Portal", locs)}<h1 style="margin-bottom:14px">${esc(orgName || "Your practices")}</h1>
    ${band}
    ${strip}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">${cards.join("")}</div>`;
  return page({ title: "My Portal", user, body });
}

// ---------- Location overview ----------
export async function locationOverview(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const db = env.DB;
  const counts = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM equipment WHERE location_id = ?) AS equipment,
            (SELECT COUNT(*) FROM tickets WHERE location_id = ? AND status != 'closed') AS open_tickets,
            (SELECT COUNT(*) FROM documents WHERE location_id = ?) AS documents`)
    .bind(locationId, locationId, locationId).first();
  const managedOn = await laneOn(db, loc.customer_id, locationId);
  const expiring = managedOn ? await expiringItems(db, locationId, 90) : [];
  // (Billing is organization scope, so it is not linked from inside a
  // practice at all; it lives one level up, on the organization rail.)
  const expiringHtml = expiring.length
    ? `<div class="notice"><strong>Needs attention, next 90 days</strong><ul style="margin:8px 0 0;padding-left:18px">
        ${expiring.map((e) => {
          const kind = e.license_expires && (!e.warranty_expires || e.license_expires <= e.warranty_expires) ? "License" : "Warranty";
          const date = kind === "License" ? e.license_expires : e.warranty_expires;
          const days = daysUntil(date);
          return `<li>${esc(e.vendor || "")} ${esc(e.model || e.type || "Equipment")}: ${kind.toLowerCase()} expires ${esc(fmtDateUS(date))} (${days < 0 ? "expired" : days + " days"})</li>`;
        }).join("")}</ul></div>` : "";
  const health = await officeHealth(env.DB, locationId);
  const netSnap = await db.prepare(
    "SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = 'internet'").bind(locationId).first().catch(() => null);
  let ispTile = null;
  if (netSnap) { try { ispTile = JSON.parse(netSnap.payload || "{}").isp || null; } catch { ispTile = null; } }
  const body = `${locNav(loc, "overview")}<h1>${esc(loc.name)}</h1>
    ${expiringHtml}
    ${healthCard(health)}
    <div class="grid">
      <a class="tile" href="/app/locations/${locationId}/equipment"><span class="tile-n">${counts.equipment}</span><span class="d">Equipment on record</span></a>
      <a class="tile" href="/app/locations/${locationId}/tickets"><span class="tile-n">${counts.open_tickets}</span><span class="d">Open tickets</span></a>
      <a class="tile" href="/app/locations/${locationId}/documents"><span class="tile-n">${counts.documents}</span><span class="d">Documents</span></a>
      <a class="tile" href="/app/locations/${locationId}/network"><span class="tile-n">${ispTile ? (ispTile.uptimePct != null && ispTile.uptimePct >= 99 ? "Working" : ispTile.uptimePct >= 95 ? "Unstable" : "Down") : "&mdash;"}</span><span class="d">Internet${ispTile && ispTile.ispName ? " · " + esc(ispTile.ispName) : ""}${ispTile && ispTile.downMbps != null ? " · " + Math.round(ispTile.downMbps) + " Mbps" : ""}</span></a>
    </div>`;
  const msg = new URL(request.url).searchParams.get("msg");
  return page({ title: loc.name, user, body, flash: msg || undefined });
}

// ---------- Services (Account section, customer_admin only) ----------
// What the organization has with FlossByte, per location, and where an
// admin asks for a service the practice does not have yet. Kept off the
// everyday location pages on purpose: this is account administration.
// Plain-English service descriptions for the customer Services page.
// The database descriptions read like a catalog ("A scoped project
// engagement"); customers get the version a person would say out loud.
const PRODUCT_PLAIN = {
  managed_it: "We look after this office's computers, network, and internet, and fix problems early.",
  flossverify: "We check your patients' insurance before their visit, so the front desk does not have to.",
  hipaa_security: "A yearly check that this office meets the HIPAA security rules, with a written report and a fix list.",
  voip: "This office's phones, run over the internet and looked after by us.",
  one_time_project: "One-off jobs, like a new office setup or a server move, quoted up front before work starts.",
};

export async function servicesPage(env, request, user) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const db = env.DB;
  const cust = await db.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const { results: locs } = await db.prepare("SELECT * FROM locations WHERE customer_id = ? ORDER BY id").bind(org).all();
  const cards = [];
  for (const loc of locs || []) {
    const states = await productStates(db, org, loc.id);
    const rowsHtml = states.map((p) => `<tr><td><strong>${esc(p.name)}</strong>
        <div class="muted">${esc(PRODUCT_PLAIN[p.key] || p.description || "")}</div></td>
      <td>${p.enabled ? `<span class="pill on">Included</span>` : `<span class="pill off">Not included</span>`}</td>
      <td>${p.enabled ? "" : requestForm(loc, p.key)}</td></tr>`).join("");
    cards.push(`<div class="card"><h2 style="margin-top:0">${esc(loc.name)}</h2>
      <div class="tscroll"><table class="stack"><thead><tr><th>Service</th><th>Status</th><th></th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div></div>`);
  }
  const rail = await railLocs(env, user);
  const body = `${orgRail(user, "services", cust ? cust.name : "My Portal", rail)}<h1>Services</h1>
    <p class="muted">What your organization has with FlossByte, office by office. Only your organization's admins see this page. To change a service that is on, contact FlossByte.</p>
    ${cards.join("") || `<div class="card"><p class="muted">No offices yet.</p></div>`}`;
  const qp = new URL(request.url).searchParams;
  return page({ title: "Services", user, body, flash: qp.get("msg") || undefined, error: qp.get("err") || undefined });
}

// ---------- Team (customer_admin only) ----------
export async function teamPage(env, request, user) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const members = await orgMembers(env.DB, org);
  const rows = members.map((m) => {
    const isSelf = m.id === user.id;
    const action = m.status === "disabled"
      ? `<span class="muted">Removed</span>`
      : `<a class="btn small secondary" href="/app/team/${m.id}/edit">Edit</a>${isSelf ? "" : ` <a class="btn small danger" href="/app/team/${m.id}/remove">Remove</a>`}`;
    return `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td>
      <td>${m.role === "customer_admin" ? "Admin" : "User"}</td>
      <td>${esc(m.locations_label || "")}</td>
      <td><span class="pill ${m.status === "disabled" ? "off" : "on"}">${esc(m.status)}</span></td>
      <td>${action}</td></tr>`;
  }).join("");
  const rail = await railLocs(env, user);
  const body = `${orgRail(user, "team", cust ? cust.name : "My Portal", rail)}<h1>Team</h1>
    <p class="muted">People with a login for ${esc(cust ? cust.name : "your organization")}. Use Edit to fix someone's name; an email address can't be changed once a login is created. Removing someone signs them out right away and takes away everything they could see here. Tickets and documents they created stay on record.</p>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Sees</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="muted">No logins yet.</td></tr>`}</tbody></table></div></div>`;
  const msg = new URL(request.url).searchParams.get("msg");
  return page({ title: "Team", user, body, flash: msg || undefined, error: new URL(request.url).searchParams.get("err") || undefined });
}

export async function teamRemoveConfirmPage(env, request, user, targetId) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const members = await orgMembers(env.DB, org);
  const target = members.find((m) => m.id === Number(targetId));
  if (!target || target.status === "disabled") return denied(user, 404);
  const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const body = `<div class="card narrow"><h1>Remove ${esc(target.name)}?</h1>
    <p>${esc(target.name)} (${esc(target.email)}) will be signed out and will no longer see anything for ${esc(cust ? cust.name : "your organization")}.</p>
    <p class="muted">Tickets and documents they created stay on record. If they ever need access again, FlossByte can invite them fresh.</p>
    <form method="post" action="/app/team/${target.id}/remove" class="row">
      <button class="btn danger" type="submit">Remove this user</button>
      <a class="btn secondary" href="/app/team">Cancel</a></form></div>`;
  return page({ title: "Remove user", user, body });
}

export async function teamRemovePost(env, request, user, targetId) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const result = await removeUserFromCustomer(env.DB, user, targetId, org);
  if (!result.ok) return redirect("/app/team?err=" + encodeURIComponent(result.error));
  return redirect("/app/team?msg=" + encodeURIComponent(`${result.target.name} was removed.`));
}

export async function teamEditPage(env, request, user, targetId) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const members = await orgMembers(env.DB, org);
  const target = members.find((m) => m.id === Number(targetId));
  if (!target || target.status === "disabled") return denied(user, 404);
  const np = splitName(target.name);
  const body = `<div class="card narrow"><h1>Edit name</h1>
    <form method="post" action="/app/team/${target.id}/edit">
      <div class="row"><span style="flex:1"><label>First name <span class="req">*</span></label><input name="first_name" value="${esc(np.first)}" required></span>
      <span style="flex:1"><label>Middle name</label><input name="middle_name" value="${esc(np.middle)}"></span>
      <span style="flex:1"><label>Last name <span class="req">*</span></label><input name="last_name" value="${esc(np.last)}" required></span></div>
      <label>Email</label><input value="${esc(target.email)}" disabled>
      <p class="muted" style="margin:4px 0 0">The email is their login and can't be changed.</p>
      <p style="margin-top:16px"><button class="btn" type="submit">Save name</button>
      <a class="btn secondary" href="/app/team">Cancel</a></p>
    </form></div>`;
  return page({ title: "Edit name", user, body, error: new URL(request.url).searchParams.get("err") || undefined });
}

export async function teamEditPost(env, request, user, targetId) {
  const org = await customerAdminOrg(env.DB, user);
  if (org === null) return denied(user, 403);
  const members = await orgMembers(env.DB, org);
  const target = members.find((m) => m.id === Number(targetId));
  if (!target || target.status === "disabled") return denied(user, 404);
  const f = await request.formData();
  const first = String(f.get("first_name") || "").trim();
  const middle = String(f.get("middle_name") || "").trim();
  const last = String(f.get("last_name") || "").trim();
  if (!first || !last) return redirect(`/app/team/${target.id}/edit?err=` + encodeURIComponent("First name and last name are required."));
  const name = joinName(first, middle, last);
  await env.DB.prepare("UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?").bind(name, target.id).run();
  await audit(env.DB, user.id, "user_update", "user", target.id, `client ${org}`);
  return redirect("/app/team?msg=" + encodeURIComponent(`${name}'s name is saved.`));
}

// ---------- Product status / locked page ----------
export async function productPage(env, request, user, locationId, productKey) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const prod = await env.DB.prepare("SELECT * FROM products WHERE key = ?").bind(productKey).first();
  if (!prod) return denied(user, 404);
  const on = await productEnabled(env.DB, loc.customer_id, locationId, productKey);
  if (!on) return lockedTile(user, loc, prod.name, prod.key);
  if (productKey === "managed_it") return redirect(`/app/locations/${locationId}/equipment`);
  const states = await productStates(env.DB, loc.customer_id, locationId);
  const state = states.find((s) => s.key === productKey);
  const body = `${locNav(loc, "")}<div class="card"><h2>${esc(prod.name)}</h2>
    <p><span class="pill on">On for this practice</span></p>
    <p class="muted">${esc(prod.description || "")}</p>
    <p class="muted">Work for this service shows up here as it gets scheduled. Questions: call (669) 237-2264.</p></div>`;
  return page({ title: prod.name, user, body });
}

// ---------- Equipment ----------
// Office health score, Atera-style: start at 100 and deduct for what
// is actually wrong, with the reasons shown next to the number so it
// never reads as a black box. Computed only from the office's own
// records (offline devices, expiring items, measured internet uptime).
async function officeHealth(db, locationId) {
  try {
    const { results } = await db.prepare("SELECT * FROM equipment WHERE location_id = ?").bind(locationId).all();
    const rows = results || [];
    if (!rows.length) return null;
    let score = 100;
    const reasons = [];
    const isKey = (e) => e.source === "unifi" || /server|firewall|gateway/i.test(`${e.type || ""} ${e.name || ""}`);
    const keyOff = rows.filter((e) => e.status === "offline" && isKey(e));
    const otherOff = rows.filter((e) => e.status === "offline" && !isKey(e));
    // details mirrors reasons, but names the devices and carries the
    // exact points each problem cost, so "Why is it 60?" can be
    // answered line by line. The two always add up to 100 - score.
    const details = [];
    const nameList = (list) => {
      const names = list.slice(0, 4).map((e) => autoName(e));
      return names.join(", ") + (list.length > 4 ? `, and ${list.length - 4} more` : "");
    };
    if (keyOff.length) {
      const pts = Math.min(50, keyOff.length * 25);
      score -= pts;
      reasons.push(`${keyOff.length === 1 ? "A key device is" : keyOff.length + " key devices are"} offline`);
      details.push({ text: `Key device offline: ${nameList(keyOff)}${keyOff.length * 25 > 50 ? " (deduction capped)" : ""}`, pts });
    }
    if (otherOff.length) {
      const pts = Math.min(20, otherOff.length * 5);
      score -= pts;
      reasons.push(`${otherOff.length} other ${otherOff.length === 1 ? "device is" : "devices are"} offline`);
      details.push({ text: `${otherOff.length} other ${otherOff.length === 1 ? "device" : "devices"} offline: ${nameList(otherOff)}${otherOff.length * 5 > 20 ? " (deduction capped)" : ""}`, pts });
    }
    const nextExp = (e) => [e.license_expires, e.warranty_expires].filter(Boolean).sort()[0];
    const expired = rows.filter((e) => { const x = nextExp(e); return x && daysUntil(x) < 0; });
    const expSoon = rows.filter((e) => { const x = nextExp(e); return x && daysUntil(x) >= 0 && daysUntil(x) <= 30; });
    if (expired.length) {
      score -= 15;
      reasons.push(`${expired.length} ${expired.length === 1 ? "item has" : "items have"} expired`);
      details.push({ text: `Expired license or warranty: ${nameList(expired)}`, pts: 15 });
    } else if (expSoon.length) {
      score -= 10;
      reasons.push(`${expSoon.length} ${expSoon.length === 1 ? "item expires" : "items expire"} within 30 days`);
      details.push({ text: `Expires within 30 days: ${nameList(expSoon)}`, pts: 10 });
    }
    try {
      const snap = await db.prepare("SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = 'internet'").bind(locationId).first();
      const isp = snap && snap.payload ? (JSON.parse(snap.payload).isp || {}) : {};
      if (isp.uptimePct != null && isp.uptimePct < 99) {
        const pts = isp.uptimePct < 95 ? 20 : 10;
        score -= pts;
        reasons.push(`Internet was up ${Math.round(isp.uptimePct * 10) / 10}% of the last day`);
        details.push({ text: `Internet was up ${Math.round(isp.uptimePct * 10) / 10}% of the last 24 hours`, pts });
      }
    } catch { /* the internet section is optional */ }
    score = Math.max(0, score);
    return { score, label: score >= 85 ? "Good" : score >= 60 ? "Fair" : "Needs attention", reasons, details };
  } catch { return null; }
}
function healthCard(h) {
  if (!h) return "";
  const color = h.score >= 85 ? "#0A7C6E" : h.score >= 60 ? "#b45309" : "#b91c1c";
  const det = (h.details || []).map((d) =>
    `<div style="display:flex;justify-content:space-between;gap:14px;padding:7px 0;border-bottom:1px solid #EEF2F7"><span>${esc(d.text)}</span><b style="color:#b91c1c;white-space:nowrap">&minus;${d.pts}</b></div>`).join("");
  const why = det ? `<details style="margin-top:12px"><summary style="cursor:pointer;color:#0A7C6E;font-weight:700">Why is it ${h.score}?</summary>
    <div style="margin-top:6px">${det}
    <p class="muted" style="margin:8px 0 0">The score starts at 100 and loses the points above. Fixing an item raises the score at the next hourly check.</p></div></details>` : "";
  return `<div class="card"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
    <div><span style="font-size:34px;font-weight:800;color:${color}">${h.score}</span><span class="muted"> / 100</span></div>
    <div style="flex:1;min-width:200px"><b>Office health: ${h.label}</b>
    <br><span class="muted">${h.reasons.length ? esc(h.reasons.slice(0, 3).join(" · ")) : "Everything is online and up to date."}</span></div></div>${why}</div>`;
}

export async function equipmentPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Equipment", "managed_it");
  const q = new URL(request.url).searchParams;
  const search = (q.get("q") || "").trim();
  const vendor = (q.get("vendor") || "").trim();
  const { results: allRaw } = await env.DB.prepare("SELECT * FROM equipment WHERE location_id = ?").bind(locationId).all();
  const allRows = allRaw || [];
  const vendors = [...new Set(allRows.map((r) => r.vendor).filter(Boolean))];
  const scope = await locationScope(env.DB, user, locationId);
  const canEdit = user.kind === "flossbyte" || scope === "admin";
  const isFb = user.kind === "flossbyte";
  const renames = await loadRenames(env.DB, locationId);
  const f = ["all", "computers", "phones", "printers", "network", "other", "offline"].includes(q.get("f") || "") ? q.get("f") : "all";
  const needle = search.toLowerCase();
  const filtered = allRows.filter((e) => {
    if (vendor && e.vendor !== vendor) return false;
    if (needle && ![e.vendor, e.model, e.type, e.serial, e.name, e.ip_address, displayName(e, renames)].some((v) => v && String(v).toLowerCase().includes(needle))) return false;
    if (f === "offline") return e.status === "offline";
    if (f !== "all") return kindBucket(e) === f;
    return true;
  }).sort((a, b) => (BUCKET_RANK[kindBucket(a)] - BUCKET_RANK[kindBucket(b)]) || displayName(a, renames).localeCompare(displayName(b, renames)));
  const onlineCount = allRows.filter((e) => e.status === "online").length;
  const offlineCount = allRows.filter((e) => e.status === "offline").length;
  const expSoonRows = allRows.filter((e) => {
    const x = [e.license_expires, e.warranty_expires].filter(Boolean).sort()[0];
    return x && daysUntil(x) <= 90;
  });
  const tiles = allRows.length ? `<div class="statgrid">
    <div class="stat"><b>${allRows.length}</b><span>Devices</span></div>
    <div class="stat"><b>${onlineCount}</b><span>Online</span></div>
    <div class="stat"><b>${offlineCount}</b><span>Offline</span></div>
    <div class="stat"><b>${expSoonRows.length}</b><span>Expiring within 90 days</span></div>
  </div>` : "";
  const chipBase = new URLSearchParams();
  if (search) chipBase.set("q", search);
  if (vendor) chipBase.set("vendor", vendor);
  const chip = (key, label, n) => {
    const p = new URLSearchParams(chipBase);
    if (key !== "all") p.set("f", key);
    const qs = p.toString();
    const on = f === key;
    return `<a href="/app/locations/${locationId}/equipment${qs ? "?" + qs : ""}" style="padding:6px 12px;border-radius:999px;border:1px solid ${on ? "#0A1628" : "#D5DDE8"};background:${on ? "#0A1628" : "#fff"};color:${on ? "#fff" : "#33475E"};font-weight:${on ? "700" : "500"};text-decoration:none;white-space:nowrap">${label} (${n})</a>`;
  };
  const bucketCount = (k) => allRows.filter((e) => kindBucket(e) === k).length;
  const chips = allRows.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">${chip("all", "All", allRows.length)}${chip("computers", "Computers", bucketCount("computers"))}${chip("phones", "Phones", bucketCount("phones"))}${chip("printers", "Printers", bucketCount("printers"))}${chip("network", "Network gear", bucketCount("network"))}${chip("other", "Other", bucketCount("other"))}${chip("offline", "Offline", offlineCount)}</div>` : "";
  const rows = filtered.map((e) => {
    const exp = [e.license_expires, e.warranty_expires].filter(Boolean).sort()[0];
    const days = daysUntil(exp);
    const pill = exp && days <= 90 ? `<span class="pill warn">${esc(fmtDateUS(exp))}</span>` : exp ? esc(fmtDateUS(exp)) : '<span class="muted">Nothing on file</span>';
    const title = displayName(e, renames);
    const kind = deviceKind(e);
    const bn = baseName(e);
    const renamed = (e.external_id && renames[e.external_id]) || (e.mac && renames[e.mac]);
    const sub = [kind !== title ? kind : "", e.vendor, e.model && e.model !== title ? e.model : "", e.serial ? "Serial " + e.serial : "", e.firmware ? "Firmware " + e.firmware : "", !renamed && bn && bn !== title ? `Network name: ${bn}` : ""].filter(Boolean).join(" · ");
    const statusPill = e.status === "online" ? `<span class="pill on">Online</span>`
      : e.status === "offline" ? `<span class="pill off">Offline</span>` : `<span class="pill">${esc(e.status)}</span>`;
    const lastSeen = e.status === "offline" && e.last_seen_at ? `<br><span class="muted" style="font-size:12px">Last seen ${esc(relTime(e.last_seen_at))}</span>` : "";
    const mode = e.ip_mode === "static" ? ` <span class="pill">Static</span>` : e.ip_mode === "dhcp" ? ` <span class="pill">DHCP</span>` : "";
    return `<tr><td><div style="display:flex;gap:10px;align-items:flex-start">${kindTile(e)}<div><a href="/app/locations/${locationId}/equipment/${e.id}" style="font-weight:700;color:inherit;text-decoration:none">${esc(title)}</a>${sub ? `<br><span class="muted">${esc(sub)}</span>` : ""}</div></div></td>
      <td>${statusPill}${lastSeen}</td><td>${e.ip_address ? esc(e.ip_address) + mode : '<span class="muted">—</span>'}</td>${isFb ? `<td>${pill}</td>` : ""}${canEdit ? `<td><a href="/app/locations/${locationId}/equipment/${e.id}/edit">Edit</a></td>` : ""}</tr>`;
  }).join("");
  // A plain-language "needs attention" strip, only when something is
  // actually wrong: offline devices by the name the office knows, and
  // anything expiring inside 90 days.
  let attention = "";
  {
    const off = allRows.filter((e) => e.status === "offline");
    const bits = [];
    if (off.length) bits.push(`${off.length === 1 ? "1 device is" : off.length + " devices are"} offline: ${off.slice(0, 4).map((e) => esc(displayName(e, renames))).join(", ")}${off.length > 4 ? ", and more" : ""}`);
    if (expSoonRows.length) bits.push(`${expSoonRows.length === 1 ? "1 item expires" : expSoonRows.length + " items expire"} within 90 days`);
    if (bits.length) attention = `<div class="card" style="border-left:4px solid #b45309"><p style="margin:0"><b>Needs attention:</b> ${bits.join(". ")}.</p></div>`;
  }
  const addForm = canEdit ? `<div class="card"><h3>Add equipment</h3>
    <form method="post" action="/app/locations/${locationId}/equipment" class="row" style="align-items:end">
      <span style="flex:1;min-width:130px"><label>Vendor</label><input name="vendor" list="eq-vendors" placeholder="Sophos, UniFi, SonicWall">${datalist("eq-vendors", EQ_VENDORS)}</span>
      <span style="flex:1;min-width:110px"><label>Type</label><input name="type" list="eq-types" placeholder="Firewall">${datalist("eq-types", EQ_TYPES)}</span>
      <span style="flex:1;min-width:130px"><label>Name</label><input name="name" placeholder="Front desk PC"></span>
      <span style="flex:1;min-width:130px"><label>Model</label><input name="model"></span>
      <span style="flex:1;min-width:130px"><label>Serial</label><input name="serial"></span>
      <span style="flex:1;min-width:120px"><label>IP address</label><input name="ip_address" placeholder="192.168.1.50"></span>
      <span style="flex:1;min-width:130px"><label>IP type</label><select name="ip_mode"><option value="">Not set</option><option value="dhcp">DHCP (automatic)</option><option value="static">Static (fixed)</option></select></span>
      <span style="flex:1;min-width:110px"><label>Status</label><select name="status"><option>online</option><option>offline</option><option>unknown</option></select></span>
      <span style="flex:1;min-width:130px"><label>Firmware</label><input name="firmware"></span>
      <span style="flex:1;min-width:150px"><label>License expires</label><input name="license_expires" type="date"></span>
      <span style="flex:1;min-width:150px"><label>Warranty expires</label><input name="warranty_expires" type="date"></span>
      <button class="btn small" type="submit">Add</button></form></div>` : "";
  const colCount = 3 + (isFb ? 1 : 0) + (canEdit ? 1 : 0);
  const body = `${locNav(loc, "equipment")}<h1>Equipment</h1>${locTabs(loc, "equipment")}${attention}${tiles}
    <form method="get" class="row" style="margin-bottom:14px">
      <span style="flex:2;min-width:180px"><input name="q" placeholder="Search name, model, serial, IP address" value="${esc(search)}"></span>
      <span style="flex:1;min-width:140px"><select name="vendor"><option value="">All vendors</option>
        ${vendors.map((v) => `<option ${v === vendor ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></span>
      ${f !== "all" ? `<input type="hidden" name="f" value="${esc(f)}">` : ""}
      <button class="btn small secondary" type="submit">Filter</button>
      <a class="btn small secondary" href="/app/locations/${locationId}/equipment/print">Print inventory</a>
      <a class="btn small secondary" href="/app/locations/${locationId}/equipment.csv">Download CSV</a></form>
    ${chips}
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Device</th><th>Status</th><th>IP address</th>${isFb ? "<th>Next expiry</th>" : ""}${canEdit ? "<th></th>" : ""}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${colCount}" class="muted">${allRows.length ? "Nothing matches that filter." : "No equipment recorded yet."}</td></tr>`}</tbody></table></div></div>${addForm}`;
  return page({ title: "Equipment", user, body });
}

// ---------- Device detail, print sheet, CSV ----------

export async function equipmentDetailPage(env, request, user, locationId, equipmentId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Equipment", "managed_it");
  const row = await env.DB.prepare("SELECT * FROM equipment WHERE id = ? AND location_id = ?").bind(equipmentId, locationId).first();
  if (!row) return denied(user, 404);
  const scope = await locationScope(env.DB, user, locationId);
  const canEdit = user.kind === "flossbyte" || scope === "admin";
  const isFb = user.kind === "flossbyte";
  const renames = await loadRenames(env.DB, locationId);
  const title = displayName(row, renames);
  const kind = deviceKind(row);
  let parent = null;
  let children = [];
  try {
    const cols = await env.DB.prepare("PRAGMA table_info(equipment)").all();
    if ((cols.results || []).some((c) => c.name === "parent_mac")) {
      if (row.parent_mac) parent = await env.DB.prepare("SELECT * FROM equipment WHERE location_id = ? AND mac = ?").bind(locationId, row.parent_mac).first();
      if (row.mac) {
        const { results: kids } = await env.DB.prepare("SELECT * FROM equipment WHERE location_id = ? AND parent_mac = ? ORDER BY name").bind(locationId, row.mac).all();
        children = kids || [];
      }
    }
  } catch { parent = null; children = []; }
  let stats = null;
  if (row.mac) {
    try {
      const snap = await env.DB.prepare("SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = 'device_stats'").bind(locationId).first();
      const devs = snap && snap.payload ? (JSON.parse(snap.payload).devices || []) : [];
      stats = devs.find((d) => d.mac && d.mac.toLowerCase() === String(row.mac).toLowerCase()) || null;
    } catch { stats = null; }
  }
  const statusPill = row.status === "online" ? `<span class="pill on">Online</span>`
    : row.status === "offline" ? `<span class="pill off">Offline</span>` : `<span class="pill">${esc(row.status)}</span>`;
  const upFmt = (sec) => { if (typeof sec !== "number") return ""; const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600); return d ? `${d}d ${h}h` : `${h}h`; };
  const bn = baseName(row);
  const renamed = (row.external_id && renames[row.external_id]) || (row.mac && renames[row.mac]);
  const recordLabel = row.source === "unifi" || row.source === "unifi-client" ? "Synced from UniFi" : row.source === "sophos" ? "Synced from Sophos" : "Added by FlossByte";
  // Header band: navy, with the handful of facts people actually come
  // for (IP, uptime, last seen) as quiet highlights.
  const quick = [
    row.ip_address ? ["IP address", `${esc(row.ip_address)}${row.ip_mode === "static" ? " · Static" : row.ip_mode === "dhcp" ? " · DHCP" : ""}`] : null,
    stats && typeof stats.uptimeSec === "number" ? ["Uptime", upFmt(stats.uptimeSec)] : null,
    row.last_seen_at ? ["Last seen", esc(relTime(row.last_seen_at))] : null,
    ["Record", recordLabel],
  ].filter(Boolean).map(([k, v]) =>
    `<div><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8FA5C4">${k}</div><div style="font-weight:700;margin-top:2px">${v}</div></div>`).join("");
  const header = `<div class="card" style="padding:0;overflow:hidden">
    <div style="background:linear-gradient(135deg,#0A1628 0%,#14335F 100%);color:#fff;padding:22px">
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">${kindTile(row, 48, true)}
        <div style="flex:1;min-width:200px"><h1 style="margin:0;color:#fff">${esc(title)}</h1>
        <p style="margin:3px 0 0;color:#B9C7DC">${esc(kind)} · ${esc(loc.name)}</p></div>
        <div>${statusPill}</div></div>
      ${quick ? `<div style="display:flex;gap:30px;flex-wrap:wrap;margin-top:18px">${quick}</div>` : ""}
    </div>
    <div style="padding:14px 22px;display:flex;gap:8px;flex-wrap:wrap">
      <a class="btn small secondary" href="/app/locations/${locationId}/tickets?device=${encodeURIComponent(title + (row.ip_address ? " (" + row.ip_address + ")" : ""))}">Report a problem with this device</a>
      ${canEdit ? `<a class="btn small" href="/app/locations/${locationId}/equipment/${row.id}/edit">Edit this device</a>` : ""}
    </div></div>`;
  // Details as a quiet divider list, not boxes.
  const drow = (label, valueHtml) =>
    `<div style="display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid #EEF2F7"><span style="color:#45566E;font-weight:600">${label}</span><span style="text-align:right;font-weight:600">${valueHtml}</span></div>`;
  const expRow = (label, d) => {
    if (!d) return "";
    const days = daysUntil(d);
    return drow(label, `${esc(fmtDateUS(d))}${days <= 90 ? ` <span class="pill warn">${days < 0 ? "expired" : days + " days left"}</span>` : ""}`);
  };
  const detailRows = [
    row.model ? drow("Model", esc((row.vendor ? row.vendor + " " : "") + row.model)) : "",
    row.serial ? drow("Serial number", esc(row.serial)) : "",
    row.firmware ? drow("Firmware", esc(row.firmware)) : "",
    isFb && row.mac ? drow("MAC address", esc(row.mac)) : "",
    !renamed && bn && bn !== title ? drow("Network name", esc(bn)) : "",
    expRow("License expires", row.license_expires),
    expRow("Warranty expires", row.warranty_expires),
  ].filter(Boolean).join("");
  const parentCard = parent ? `<div class="card"><h3 style="margin-top:0">Plugged into</h3>
    <div style="display:flex;gap:12px;align-items:center">${kindTile(parent, 38)}
      <div style="flex:1"><a href="/app/locations/${locationId}/equipment/${parent.id}" style="font-weight:700;color:inherit;text-decoration:none">${esc(displayName(parent, renames))}</a>
      <br><span class="muted">${esc(deviceKind(parent))}${parent.ip_address ? " · " + esc(parent.ip_address) : ""}</span></div>
      <span class="pill ${parent.status === "online" ? "on" : parent.status === "offline" ? "off" : ""}">${esc(parent.status)}</span></div></div>` : "";
  const health = stats ? `<div class="card"><h3 style="margin-top:0">Health</h3>
    ${typeof stats.cpu === "number" ? drow("Processor", `${Math.round(stats.cpu)}% used`) : ""}
    ${typeof stats.mem === "number" ? drow("Memory", `${Math.round(stats.mem)}% used`) : ""}
    ${typeof stats.uptimeSec === "number" ? drow("Uptime", upFmt(stats.uptimeSec)) : ""}
    </div>` : "";
  const kids = children.length ? `<div class="card"><h3 style="margin-top:0">Plugged into this device</h3>
    ${children.slice(0, 15).map((c) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #EEF2F7"><a href="/app/locations/${locationId}/equipment/${c.id}" style="font-weight:600;color:inherit;text-decoration:none">${esc(displayName(c, renames))}</a><span class="muted">${esc(deviceKind(c))}${c.ip_address ? " · " + esc(c.ip_address) : ""}</span></div>`).join("")}
    ${children.length > 15 ? `<p class="muted" style="margin-bottom:0">and ${children.length - 15} more</p>` : ""}</div>` : "";
  const body = `${locNav(loc, "equipment")}<p class="flash-print-hide"><a href="/app/locations/${locationId}/equipment">&larr; Equipment</a></p>
    ${header}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;align-items:start">
      <div class="card"><h3 style="margin-top:0">Details</h3>${detailRows || '<p class="muted">Nothing else on file for this device.</p>'}
      ${row.notes ? `<p style="margin:14px 0 0"><span class="muted">Notes</span><br>${esc(row.notes)}</p>` : ""}</div>
      <div style="display:grid;gap:16px">${parentCard}${health}${kids}</div>
    </div>`;
  return page({ title: title, user, body });
}

export async function equipmentPrintPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Equipment", "managed_it");
  const { results } = await env.DB.prepare("SELECT * FROM equipment WHERE location_id = ?").bind(locationId).all();
  const renames = await loadRenames(env.DB, locationId);
  const rows = (results || []).sort((a, b) => (BUCKET_RANK[kindBucket(a)] - BUCKET_RANK[kindBucket(b)]) || displayName(a, renames).localeCompare(displayName(b, renames)));
  const today = fmtDateUS(new Date().toISOString().slice(0, 10));
  const trs = rows.map((e) => {
    const exp = [e.license_expires, e.warranty_expires].filter(Boolean).sort()[0];
    return `<tr><td><b>${esc(displayName(e, renames))}</b></td><td>${esc(deviceKind(e))}</td><td>${esc(e.ip_address || "")}</td><td>${esc(e.serial || "")}</td><td>${esc(e.status)}</td><td>${exp ? esc(fmtDateUS(exp)) : ""}</td></tr>`;
  }).join("");
  const body = `${locNav(loc, "equipment")}<p class="flash-print-hide"><a href="/app/locations/${locationId}/equipment">&larr; Equipment</a></p>
    <div class="card"><h1 style="margin-top:0">Equipment inventory</h1>
    <p class="muted">${esc(loc.customer_name)} · ${esc(loc.name)} · ${esc(today)} · ${rows.length} devices</p>
    <div class="tscroll"><table class="stack"><thead><tr><th>Device</th><th>Type</th><th>IP address</th><th>Serial</th><th>Status</th><th>Next expiry</th></tr></thead>
    <tbody>${trs || `<tr><td colspan="6" class="muted">No equipment recorded yet.</td></tr>`}</tbody></table></div>
    <p class="muted" style="margin-bottom:0">Kept by FlossByte. This list is updated automatically from the office network.</p></div>
    <p class="flash-print-hide"><button class="btn" type="button" onclick="window.print()">Print this sheet</button></p>
    <script>window.addEventListener("load",function(){setTimeout(function(){window.print()},400)})</script>`;
  return page({ title: "Equipment inventory", user, body });
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function equipmentCsv(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return new Response("Not found", { status: error });
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return new Response("Not available", { status: 403 });
  const { results } = await env.DB.prepare("SELECT * FROM equipment WHERE location_id = ?").bind(locationId).all();
  const renames = await loadRenames(env.DB, locationId);
  const head = ["Device", "Type", "Vendor", "Model", "Serial", "IP address", "IP type", "Status", "Firmware", "MAC address", "License expires", "Warranty expires"];
  const lines = [head.join(",")];
  for (const e of results || []) {
    lines.push([displayName(e, renames), deviceKind(e), e.vendor, e.model, e.serial, e.ip_address, e.ip_mode, e.status, e.firmware, e.mac, e.license_expires, e.warranty_expires].map(csvCell).join(","));
  }
  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="equipment-${locationId}.csv"` },
  });
}

export async function ispServicePost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (user.kind !== "flossbyte") return denied(user, 403);
  const f = await request.formData();
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
  const svc = {
    provider: String(f.get("provider") || "").trim().slice(0, 60),
    plan: String(f.get("plan") || "").trim().slice(0, 80),
    down: num(f.get("down")), up: num(f.get("up")),
    account: String(f.get("account") || "").trim().slice(0, 40),
    contractEnd: /^\d{4}-\d{2}-\d{2}$/.test(String(f.get("contract_end") || "")) ? String(f.get("contract_end")) : "",
  };
  await env.DB.prepare(
    `INSERT INTO network_snapshots (location_id, kind, payload, captured_at) VALUES (?, 'isp_service', ?, datetime('now'))
     ON CONFLICT(location_id, kind) DO UPDATE SET payload = excluded.payload, captured_at = datetime('now')`)
    .bind(locationId, JSON.stringify(svc)).run();
  await audit(env.DB, user.id, "isp_service_update", "location", locationId, svc.provider || "");
  return redirect(`/app/locations/${locationId}/network?msg=` + encodeURIComponent("Internet plan details saved."));
}

// ---------- Topology ----------
// The office network drawn as a tree from the equipment record: each
// row points at the device it hangs off of (parent_mac, filled by the
// UniFi sync), so the gateway sits at the top, switches and access
// points branch under it, and endpoints hang under those. Rows with no
// known parent (hand-entered gear, other vendors) list as roots.
export async function topologyPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Network map", "managed_it");
  let hasParent = false;
  try {
    const cols = await env.DB.prepare("PRAGMA table_info(equipment)").all();
    hasParent = (cols.results || []).some((c) => c.name === "parent_mac");
  } catch { hasParent = false; }
  if (!hasParent) {
    const body = `${locNav(loc, "topology")}<h1>Network map</h1>${locTabs(loc, "topology")}
      <div class="card"><p style="margin:0">The network map needs the latest portal database update before it can draw. Once that update is in, this page builds itself from the hourly sync, with no setup here.</p></div>`;
    return page({ title: "Network map", user, body });
  }
  const { results } = await env.DB.prepare("SELECT * FROM equipment WHERE location_id = ?").bind(locationId).all();
  const all = results || [];
  if (!all.length) {
    const body = `${locNav(loc, "topology")}<h1>Network map</h1>${locTabs(loc, "topology")}
      <div class="card"><p class="muted" style="margin:0">No equipment recorded yet, so there is nothing to draw. Synced network gear appears here once it is on the <a href="/app/locations/${locationId}/equipment">Equipment</a> list.</p></div>`;
    return page({ title: "Network map", user, body });
  }
  const renames = await loadRenames(env.DB, locationId);
  const label = (e) => displayName(e, renames);
  const byMac = new Map();
  for (const e of all) if (e.mac) byMac.set(e.mac, e);
  const kids = new Map();
  const roots = [];
  for (const e of all) {
    const p = e.parent_mac && e.parent_mac !== e.mac ? byMac.get(e.parent_mac) : null;
    if (p) { if (!kids.has(p.id)) kids.set(p.id, []); kids.get(p.id).push(e); }
    else roots.push(e);
  }
  const rank = (e) => e.type === "Gateway" ? 0 : e.type === "Firewall" ? 1 : e.type === "Switch" ? 2
    : e.type === "Access point" ? 3 : e.type === "Controller" ? 4 : e.type === "Recorder" ? 5
    : e.source === "unifi-client" ? 8 : 6;
  const byRank = (a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b));
  roots.sort(byRank);
  for (const list of kids.values()) list.sort(byRank);
  const seen = new Set();
  const nodeHtml = (e, depth) => {
    if (seen.has(e.id) || depth > 8) return "";
    seen.add(e.id);
    const children = (kids.get(e.id) || []).map((c) => nodeHtml(c, depth + 1)).join("");
    const meta = [deviceKind(e), e.ip_address].filter(Boolean).join(" · ");
    return `<li><span class="topo-node${e.status === "offline" ? " off" : ""}${depth === 0 ? " root" : ""}"><span class="topo-dot"></span><span class="topo-name">${esc(label(e))}</span><span class="topo-meta">${esc(meta)}</span></span>${children ? `<ul>${children}</ul>` : ""}</li>`;
  };
  let tree = roots.map((e) => nodeHtml(e, 0)).join("");
  const leftovers = all.filter((e) => !seen.has(e.id));
  if (leftovers.length) {
    tree += leftovers.map((e) => { const meta = [deviceKind(e), e.ip_address].filter(Boolean).join(" · "); return `<li><span class="topo-node${e.status === "offline" ? " off" : ""}"><span class="topo-dot"></span><span class="topo-name">${esc(label(e))}</span><span class="topo-meta">${esc(meta)}</span></span></li>`; }).join("");
  }
  const online = all.filter((e) => e.status === "online").length;
  const offNames = all.filter((e) => e.status === "offline").map((e) => esc(displayName(e, renames)));
  const lastSeen = all.map((e) => e.last_seen_at || "").sort().pop();
  const verdict = offNames.length
    ? `<div class="card" style="border-left:4px solid #b45309"><p style="margin:0"><b>Needs attention:</b> ${offNames.length === 1 ? "1 device is" : offNames.length + " devices are"} offline: ${offNames.slice(0, 4).join(", ")}${offNames.length > 4 ? ", and more" : ""}. Everything else is working.</p></div>`
    : `<div class="card" style="border-left:4px solid #0e9f6e"><p style="margin:0"><b>Everything is online.</b> All ${all.length} devices are up and connected.</p></div>`;
  const body = `${locNav(loc, "topology")}<h1>Network map</h1>${locTabs(loc, "topology")}
    <p class="muted" style="margin-top:0">${all.length} devices, ${online} online${lastSeen ? ` · last checked ${esc(relTime(lastSeen))}` : ""}. Devices are grouped under whatever they plug into, starting from the main internet box at the top. A green dot means the device is on; red means it is off or unreachable.</p>
    ${verdict}
    <div class="card"><div class="topo"><ul>${tree}</ul></div></div>`;
  return page({ title: "Network map", user, body });
}

// The Network page renders the snapshots the UniFi sync stores per
// location (migration 0011): internet health from ISP metrics, the
// office's network/WiFi/firewall/VPN settings, per-device health, and
// Protect cameras where a console runs Protect. Everything shown is a
// read; the page itself changes nothing.
export async function networkPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "WiFi & Internet", "managed_it");
  let hasTable = false;
  try {
    hasTable = !!(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'network_snapshots'").first());
  } catch { hasTable = false; }
  if (!hasTable) {
    const body = `${locNav(loc, "network")}<h1>WiFi &amp; Internet</h1>${locTabs(loc, "network")}
      <div class="card"><p style="margin:0">This page needs the latest portal database update before it can fill in. Once that update is in, this page builds itself from the hourly sync, with no setup here.</p></div>`;
    return page({ title: "WiFi & Internet", user, body });
  }
  const { results } = await env.DB.prepare(
    "SELECT kind, payload, captured_at FROM network_snapshots WHERE location_id = ?").bind(locationId).all();
  const snaps = {};
  let captured = "";
  for (const r of results || []) {
    try { snaps[r.kind] = JSON.parse(r.payload || "{}"); } catch { snaps[r.kind] = {}; }
    if (r.captured_at && r.captured_at > captured && r.kind !== "wifi") captured = r.captured_at;
  }
  const isFb = user.kind === "flossbyte";
  const n1 = (v) => (typeof v === "number" && Number.isFinite(v)) ? v.toFixed(1) : "—";
  const n0 = (v) => (typeof v === "number" && Number.isFinite(v)) ? Math.round(v).toLocaleString("en-US") : "—";
  const pct = (v) => (typeof v === "number" && Number.isFinite(v)) ? `${Math.round(v)}%` : "—";
  const uptimeFmt = (sec) => {
    if (typeof sec !== "number" || !(sec > 0)) return "—";
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
  const onPill = (on) => on === false ? `<span class="pill off">Off</span>` : `<span class="pill on">On</span>`;
  const statePill = (s) => {
    const t = String(s || "");
    if (!t) return "";
    const bad = /off|down|disconn|fail/i.test(t), good = /on|up|connect|active|established/i.test(t);
    return ` <span class="pill${bad ? " off" : good ? " on" : ""}">${esc(t)}</span>`;
  };
  const table = (head, rows) => rows.length
    ? `<div class="tscroll"><table class="stack"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : "";
  const cfg = snaps.config || {};
  const inet = snaps.internet || {};
  const isp = inet.isp || null;
  let eqRows = [];
  try {
    const { results: er } = await env.DB.prepare("SELECT * FROM equipment WHERE location_id = ?").bind(locationId).all();
    eqRows = er || [];
  } catch { eqRows = []; }
  const eqTotal = eqRows.length;
  const eqOn = eqRows.filter((e) => e.status === "online").length;
  const renames = await loadRenames(env.DB, locationId);
  const eqByMac = new Map();
  for (const e of eqRows) if (e.mac) eqByMac.set(e.mac, e);

  // ---- WiFi card: what the front desk actually gets asked for. ----
  // Passwords come from the sync when a console provides them, and
  // from the list FlossByte keeps for the office (stored as a 'wifi'
  // snapshot) when it does not.
  const manualWifi = (snaps.wifi && Array.isArray(snaps.wifi.networks)) ? snaps.wifi.networks : [];
  const syncedSsids = cfg.ssids || [];
  // Synced networks are the live truth and list first; the kept list
  // fills in a password or a who-it-is-for label where the sync has
  // none, and covers offices whose consoles return no WiFi data.
  const manualByName = new Map(manualWifi.filter((w) => w && w.name).map((w) => [String(w.name).toLowerCase(), w]));
  const wifiEntries = [];
  const syncedNames = new Set();
  for (const s of syncedSsids) {
    const nm = s.name || s.ssid;
    if (!nm) continue;
    syncedNames.add(String(nm).toLowerCase());
    const man = manualByName.get(String(nm).toLowerCase());
    wifiEntries.push({ name: nm, pass: s.pass || (man && man.pass) || "", kind: (man && man.kind) || "", security: s.security || "", manual: false });
  }
  for (const w of manualWifi) {
    if (!w || !w.name || syncedNames.has(String(w.name).toLowerCase())) continue;
    wifiEntries.push({ name: w.name, pass: w.pass || "", kind: w.kind || "", security: "", manual: true });
  }
  let anyPass = false;
  const wifiRow = (w) => {
    const kindPill = w.kind === "guest" ? ` <span class="pill">For patients</span>` : w.kind === "staff" ? ` <span class="pill on">Staff</span>` : "";
    const sec = w.security ? ` <span class="muted">${esc(w.security)}</span>` : "";
    let passHtml;
    if (w.pass) {
      anyPass = true;
      passHtml = `<span class="muted">Password:</span> <code class="wp" data-p="${esc(w.pass)}" style="font-size:15px;letter-spacing:.4px">••••••••••</code>
        <button type="button" class="btn small secondary" onclick="wpToggle(this)">Show</button>
        <button type="button" class="btn small secondary" onclick="wpCopy(this)">Copy</button>`;
    } else {
      passHtml = `<span class="muted">Password not recorded yet.${isFb ? " Add it below so the office can find it here." : " FlossByte can add it here for you."}</span>`;
    }
    const del = w.manual && isFb ? ` <form method="post" action="/app/locations/${locationId}/wifi/delete" style="display:inline"><input type="hidden" name="name" value="${esc(w.name)}"><button class="btn small secondary" type="submit">Remove</button></form>` : "";
    return `<div style="padding:12px 0;border-bottom:1px solid #eef1f4"><div><b style="font-size:17px">${esc(w.name)}</b>${kindPill}${sec}</div><div style="margin-top:6px">${passHtml}${del}</div></div>`;
  };
  const wifiForm = isFb ? `<form method="post" action="/app/locations/${locationId}/wifi" class="row" style="align-items:end;margin-top:14px">
      <span style="flex:1;min-width:150px"><label>WiFi name</label><input name="name" required placeholder="OfficeWiFi"></span>
      <span style="flex:1;min-width:150px"><label>Password</label><input name="pass" placeholder="WiFi password"></span>
      <span style="min-width:140px"><label>Who uses it</label><select name="kind"><option value="staff">Staff</option><option value="guest">Patients (guest)</option><option value="other">Other</option></select></span>
      <button class="btn small" type="submit">Save WiFi</button></form>
    <p class="muted" style="margin-bottom:0">Kept here by FlossByte so the office always has it. Saving a name that is already listed replaces its password.</p>` : "";
  const wifiKinds = new Set(wifiEntries.map((w) => w.kind));
  const wifiExplainer = wifiKinds.has("staff") && wifiKinds.has("guest")
    ? `<p class="muted" style="margin-top:0">Staff WiFi is for the team. The patient WiFi is safe to give out at the front desk.</p>` : "";
  const wifiCard = `<div class="card"><h2 style="margin-top:0">WiFi</h2>${wifiExplainer}
    ${wifiEntries.length ? wifiEntries.map(wifiRow).join("") : `<p class="muted" style="margin:0">No WiFi networks recorded yet.</p>`}${wifiForm}</div>`;
  const wifiScript = `<script>
function wpToggle(b){var c=b.parentElement.querySelector('.wp');if(!c)return;var hidden=c.textContent.indexOf('•')===0;c.textContent=hidden?c.getAttribute('data-p'):'••••••••••';b.textContent=hidden?'Hide':'Show';}
function wpCopy(b){var c=b.parentElement.querySelector('.wp');if(!c||!navigator.clipboard)return;navigator.clipboard.writeText(c.getAttribute('data-p'));b.textContent='Copied';setTimeout(function(){b.textContent='Copy';},1500);}
</script>`;

  // ---- Internet card: the answer to "is our internet OK?" ----
  let internetCard = "";
  if (isp || eqTotal) {
    const working = !isp || (isp.uptimePct == null ? true : isp.uptimePct >= 99);
    const tiles = `<div class="statgrid">
      <div class="stat"><b>${isp ? (working ? "Working" : "Having trouble") : "—"}</b><span>Internet status${isp && isp.ispName ? " · " + esc(isp.ispName) : ""}</span></div>
      ${isp && isp.downMbps != null ? `<div class="stat"><b>${n1(isp.downMbps)} Mbps</b><span>Download speed</span></div>` : ""}
      ${isp && isp.upMbps != null ? `<div class="stat"><b>${n1(isp.upMbps)} Mbps</b><span>Upload speed</span></div>` : ""}
      ${isp && isp.uptimePct != null ? `<div class="stat"><b>${n1(isp.uptimePct)}%</b><span>Time online, last ${isp.hours || 24} hours</span></div>` : ""}
      ${eqTotal ? `<div class="stat"><b>${eqOn} of ${eqTotal}</b><span>Devices online</span></div>` : ""}
    </div>`;
    const note = isp && (isp.downtimeSec || 0) > 0 ? `<p class="muted" style="margin-bottom:0">Total time down in the last ${isp.hours || 24} hours: ${n1((isp.downtimeSec || 0) / 60)} minutes.</p>` : "";
    internetCard = `<div class="card"><h2 style="margin-top:0">Internet</h2>${tiles}${note}</div>`;
  }

  // ---- Cameras and recent changes stay plain and visible. ----
  const camRows = ((snaps.protect || {}).cameras || []).map((c) => `<tr><td>${esc(c.name || "Camera")}</td><td>${esc(c.model || "")}</td><td>${esc(c.state || c.status || "")}</td></tr>`);
  const camerasCard = camRows.length ? `<div class="card"><h2 style="margin-top:0">Cameras</h2>${table(["Camera", "Model", "State"], camRows)}</div>` : "";
  const changeEvents = ((snaps.changes || {}).events || []).slice(0, 15);
  const changesCard = changeEvents.length ? `<div class="card"><h2 style="margin-top:0">Recent changes</h2>${changeEvents.map((e) => `<p style="margin:4px 0"><span class="muted">${esc(fmtDateUS(String(e.at || "").slice(0, 10)))}</span> · ${esc(e.text || "")}</p>`).join("")}</div>` : "";

  // ---- Everything an engineer would want, one tap down. ----
  const tech = [];
  const wanRows = (inet.wans || []).map((w) => `<tr><td>${esc(w.name || "WAN")}</td><td>${esc(w.ipAddress || w.ip || "")}</td><td>${esc(w.type || "")}${statePill(w.state || w.status)}</td></tr>`);
  if (wanRows.length) tech.push(`<h3>Internet connections</h3>${table(["Interface", "IP address", "Status"], wanRows)}`);
  if (isp) tech.push(`<h3>Internet measurements (last ${isp.hours || 24} hours)</h3><p class="muted" style="margin-top:0">Average latency ${n0(isp.avgLatencyMs)} ms · peak ${n0(isp.maxLatencyMs)} ms · packet loss ${n1(isp.packetLossPct)}% · downtime ${n1((isp.downtimeSec || 0) / 60)} min</p>`);
  const statRows = ((snaps.device_stats || {}).devices || []).map((d) => { const er = d.mac ? eqByMac.get(d.mac) : null; const dn = er ? displayName(er, renames) : (d.name || "Device"); return `<tr><td>${esc(dn)}</td><td>${uptimeFmt(d.uptimeSec)}</td><td>${pct(d.cpu)}</td><td>${pct(d.mem)}</td><td>${typeof d.load1 === "number" ? d.load1.toFixed(2) : "—"}</td></tr>`; });
  if (statRows.length) tech.push(`<h3>Device health</h3>${table(["Device", "Uptime", "CPU", "Memory", "Load"], statRows)}`);
  const netRows = (cfg.networks || []).map((n) => `<tr><td>${esc(n.name || "Network")}${n.default ? ` <span class="pill">Default</span>` : ""}</td><td>${n.vlanId != null ? "VLAN " + esc(String(n.vlanId)) : "—"}</td><td>${onPill(n.enabled)}</td></tr>`);
  if (netRows.length) tech.push(`<h3>Networks</h3>${table(["Name", "VLAN", "Status"], netRows)}`);
  const polRows = (cfg.firewallPolicies || []).map((p) => `<tr><td>${esc(p.name || "Policy")}</td><td>${esc(p.action || "")}</td><td>${onPill(p.enabled)}</td></tr>`);
  const srvRows = (cfg.vpnServers || []).map((v) => `<tr><td>${esc(v.name || "VPN server")}</td><td>${esc(v.type || "")}</td><td>${onPill(v.enabled)}</td></tr>`);
  const tunRows = (cfg.vpnTunnels || []).map((v) => `<tr><td>${esc(v.name || "Tunnel")}</td><td>${esc(v.type || "")}${statePill(v.state || v.status)}</td><td>${onPill(v.enabled)}</td></tr>`);
  if (polRows.length || srvRows.length || tunRows.length || (cfg.firewallZones || []).length || (cfg.aclRules || []).length || (cfg.radiusProfiles || []).length) {
    tech.push(`<h3>Firewall and VPN</h3>
      ${(cfg.firewallZones || []).length ? `<p style="margin-top:0">Zones: ${(cfg.firewallZones || []).map((z) => `<span class="pill">${esc(z.name || "Zone")}</span>`).join(" ")}</p>` : ""}
      ${polRows.length ? table(["Policy", "Action", "Status"], polRows) : ""}
      ${(cfg.aclRules || []).length ? `<p class="muted">${(cfg.aclRules || []).length} switch access rules in place.</p>` : ""}
      ${srvRows.length ? table(["Server", "Type", "Status"], srvRows) : ""}
      ${tunRows.length ? table(["Tunnel", "Type", "Status"], tunRows) : ""}
      ${(cfg.radiusProfiles || []).length ? `<p class="muted">RADIUS profiles: ${(cfg.radiusProfiles || []).map((r) => esc(r.name || "")).filter(Boolean).join(", ")}</p>` : ""}`);
  }
  const techCard = tech.length ? `<details class="card"><summary style="cursor:pointer;font-weight:600">Technical details</summary><div style="margin-top:10px">${tech.join("")}</div></details>` : "";

  const histDays = ((snaps.internet_history || {}).days || []).filter((d) => d && d.date);
  let historyCard = "";
  if (histDays.length >= 2) {
    const bars = histDays.map((d) => {
      const u = d.uptimePct != null ? d.uptimePct : 100;
      const col = u >= 99.5 ? "#00BFA5" : u >= 98 ? "#f59e0b" : "#dc2626";
      return `<div title="${esc(d.date)}: ${u >= 99.95 ? "online all day" : `online ${esc(String(u))}% of the day${d.downtimeMin ? `, down ${esc(String(d.downtimeMin))} min` : ""}`}" style="flex:1;background:${col};height:${Math.max(8, Math.round(u))}%;border-radius:3px 3px 0 0;min-width:6px"></div>`;
    }).join("");
    historyCard = `<div class="card"><h2 style="margin-top:0">Internet, last ${histDays.length} days</h2>
      <div style="display:flex;gap:3px;align-items:flex-end;height:90px">${bars}</div>
      <p class="muted" style="margin-bottom:0">Each bar is one day, ending today. Green means the internet was up at least 99.5% of that day. Hover a bar for the day's numbers.</p></div>`;
  }
  const svc = snaps.isp_service || null;
  const ispNow = (snaps.internet || {}).isp || null;
  const svcField = (label, name, val, ph, type) => `<span style="flex:1;min-width:130px"><label>${label}</label><input name="${name}" value="${esc(val == null ? "" : String(val))}" placeholder="${ph || ""}"${type ? ` type="${type}"` : ""}></span>`;
  const svcForm = (v) => `<form method="post" action="/app/locations/${locationId}/isp-service" class="row" style="align-items:end">
    ${svcField("Provider", "provider", v.provider || (ispNow && ispNow.ispName) || "", "Comcast Business")}
    ${svcField("Plan", "plan", v.plan, "Gigabit")}
    ${svcField("Promised download (Mbps)", "down", v.down, "500")}
    ${svcField("Promised upload (Mbps)", "up", v.up, "35")}
    ${svcField("Account number", "account", v.account, "")}
    ${svcField("Contract ends", "contract_end", v.contractEnd, "", "date")}
    <button class="btn small" type="submit">Save plan</button></form>`;
  let ispCard = "";
  if (svc && (svc.provider || svc.plan || svc.down)) {
    const promised = Number(svc.down) || 0;
    const measured = ispNow && ispNow.downMbps != null ? Math.round(ispNow.downMbps) : null;
    const pct = promised && measured != null ? Math.min(100, Math.round((measured / promised) * 100)) : null;
    const cDays = svc.contractEnd ? daysUntil(svc.contractEnd) : null;
    const srow = (label, val) => val ? `<div style="display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid #EEF2F7"><span style="color:#45566E;font-weight:600">${label}</span><span style="text-align:right;font-weight:600">${val}</span></div>` : "";
    ispCard = `<div class="card"><h2 style="margin-top:0">Internet plan</h2>
      ${srow("Provider", esc(svc.provider || ""))}
      ${srow("Plan", esc(svc.plan || ""))}
      ${srow("Promised speed", svc.down || svc.up ? `${svc.down ? esc(String(svc.down)) + " down" : ""}${svc.down && svc.up ? " · " : ""}${svc.up ? esc(String(svc.up)) + " up" : ""} Mbps` : "")}
      ${srow("Account number", esc(svc.account || ""))}
      ${srow("Contract ends", svc.contractEnd ? `${esc(fmtDateUS(svc.contractEnd))}${cDays != null && cDays <= 90 ? ` <span class="pill warn">${cDays < 0 ? "ended" : cDays + " days left"}</span>` : ""}` : "")}
      ${pct != null ? `<div style="margin-top:12px"><div style="height:8px;background:#E6EBF2;border-radius:99px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${pct >= 80 ? "#00BFA5" : pct >= 50 ? "#f59e0b" : "#dc2626"}"></div></div>
      <p class="muted" style="margin:6px 0 0">Measured download is ${measured} Mbps, ${pct}% of the ${promised} Mbps on the plan.</p></div>` : ""}
      ${isFb ? `<details style="margin-top:12px"><summary class="muted" style="cursor:pointer">Update plan details</summary><div style="margin-top:10px">${svcForm(svc)}</div></details>` : ""}
    </div>`;
  } else if (isFb) {
    ispCard = `<div class="card"><h2 style="margin-top:0">Internet plan</h2>
      <p class="muted">Add the plan details from the office's internet bill once, and this page compares what they pay for with what they actually get.${ispNow && ispNow.ispName ? ` The connection itself already reports ${esc(ispNow.ispName)}.` : ""}</p>
      ${svcForm({})}</div>`;
  }
  const sections = [wifiCard, internetCard, ispCard, historyCard, camerasCard, changesCard, techCard].filter(Boolean);
  if (!Object.keys(snaps).length && !isFb) {
    const body = `${locNav(loc, "network")}<h1>WiFi &amp; Internet</h1>${locTabs(loc, "network")}
      <div class="card"><p class="muted" style="margin:0">Nothing here yet. Once FlossByte connects this office, this page shows its WiFi names and passwords, internet health, and cameras, all kept up to date automatically.</p></div>`;
    return page({ title: "WiFi & Internet", user, body });
  }
  const capLine = captured ? `<p class="muted" style="margin-top:0">Last checked ${esc(relTime(captured))} (${esc(fmtDateUS(captured.slice(0, 10)))}). This page only reads the office's setup; nothing here can change it.</p>` : "";
  const health = await officeHealth(env.DB, locationId);
  const body = `${locNav(loc, "network")}<h1>WiFi &amp; Internet</h1>${locTabs(loc, "network")}${capLine}${healthCard(health)}${sections.join("")}${anyPass ? wifiScript : ""}`;
  return page({ title: "WiFi & Internet", user, body });
}

// The WiFi list FlossByte keeps for an office lives in a 'wifi'
// snapshot row (name, password, who it is for). Only FlossByte logins
// can change it; the office reads it on the WiFi & Internet page and
// through Ask. UniFi cannot hand passwords over for offices on the
// older console setup, so this list is the reliable copy.
async function loadWifiList(env, locationId) {
  try {
    const r = await env.DB.prepare("SELECT payload FROM network_snapshots WHERE location_id = ? AND kind = 'wifi'").bind(locationId).first();
    if (r) { const p = JSON.parse(r.payload || "{}"); if (Array.isArray(p.networks)) return p.networks; }
  } catch { /* table missing: treated as an empty list */ }
  return [];
}
async function saveWifiList(env, locationId, networks) {
  await env.DB.prepare("INSERT INTO network_snapshots (location_id, kind, payload) VALUES (?, 'wifi', ?) ON CONFLICT(location_id, kind) DO UPDATE SET payload = excluded.payload, captured_at = datetime('now')")
    .bind(locationId, JSON.stringify({ networks })).run();
}
export async function wifiAddPost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "WiFi & Internet", "managed_it");
  if (user.kind !== "flossbyte") return denied(user, 403);
  const f = await request.formData();
  const name = String(f.get("name") || "").trim();
  if (!name) return redirect(`/app/locations/${locationId}/network?err=` + encodeURIComponent("The WiFi name is required."));
  const kind = ["staff", "guest", "other"].includes(String(f.get("kind") || "")) ? String(f.get("kind")) : "staff";
  const entry = { name, pass: String(f.get("pass") || "").trim(), kind };
  const list = await loadWifiList(env, locationId);
  const i = list.findIndex((w) => String(w.name || "").toLowerCase() === name.toLowerCase());
  if (i >= 0) list[i] = entry; else list.push(entry);
  await saveWifiList(env, locationId, list);
  await audit(env.DB, user.id, "wifi_save", "location", locationId, name);
  return redirect(`/app/locations/${locationId}/network?msg=` + encodeURIComponent(`WiFi "${name}" is saved for this office.`));
}
export async function wifiDeletePost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "WiFi & Internet", "managed_it");
  if (user.kind !== "flossbyte") return denied(user, 403);
  const f = await request.formData();
  const name = String(f.get("name") || "").trim();
  const list = (await loadWifiList(env, locationId)).filter((w) => String(w.name || "").toLowerCase() !== name.toLowerCase());
  await saveWifiList(env, locationId, list);
  await audit(env.DB, user.id, "wifi_remove", "location", locationId, name);
  return redirect(`/app/locations/${locationId}/network?msg=` + encodeURIComponent(`WiFi "${name}" was removed.`));
}

export async function equipmentPost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Equipment", "managed_it");
  const scope = await locationScope(env.DB, user, locationId);
  if (!(user.kind === "flossbyte" || scope === "admin")) return denied(user, 403);
  const f = await request.formData();
  let hasMode = false, hasIp = false;
  try {
    const cols = await env.DB.prepare("PRAGMA table_info(equipment)").all();
    const names = (cols.results || []).map((c) => c.name);
    hasMode = names.includes("ip_mode");
    hasIp = names.includes("ip_address");
  } catch { hasMode = false; hasIp = false; }
  const ipMode = ["dhcp", "static"].includes(String(f.get("ip_mode") || "")) ? String(f.get("ip_mode")) : "";
  const cols = ["location_id", "vendor", "type", "name", "model", "serial", "status", "firmware", "warranty_expires", "license_expires", "notes"];
  const binds = [locationId, f.get("vendor") || null, f.get("type") || null, f.get("name") || null, f.get("model") || null,
    f.get("serial") || null, String(f.get("status") || "online"), f.get("firmware") || null,
    f.get("warranty_expires") || null, f.get("license_expires") || null, f.get("notes") || null];
  if (hasIp) { cols.push("ip_address"); binds.push(String(f.get("ip_address") || "").trim() || null); }
  if (hasMode) { cols.push("ip_mode"); binds.push(ipMode); }
  await env.DB.prepare(
    `INSERT INTO equipment (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...binds).run();
  await audit(env.DB, user.id, "equipment_add", "location", locationId, String(f.get("model") || ""));
  return redirect(`/app/locations/${locationId}/equipment`);
}

const EQ_VENDORS = ["UniFi", "Sophos", "SonicWall", "Dell", "HP", "Lenovo", "Apple", "Cisco", "NETGEAR", "Microsoft", "Other"];
const EQ_TYPES = ["Firewall", "Switch", "Access point", "Gateway", "Controller", "Computer", "Server", "Printer", "Camera", "Phone system", "NAS", "Recorder", "Other"];
function datalist(id, values) {
  return `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}"></option>`).join("")}</datalist>`;
}

async function loadEquipment(env, user, locationId, equipmentId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return { error: denied(user, error) };
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return { error: lockedTile(user, loc, "Equipment", "managed_it") };
  const scope = await locationScope(env.DB, user, locationId);
  if (!(user.kind === "flossbyte" || scope === "admin")) return { error: denied(user, 403) };
  const row = await env.DB.prepare("SELECT * FROM equipment WHERE id = ? AND location_id = ?").bind(equipmentId, locationId).first();
  if (!row) return { error: denied(user, 404) };
  return { loc, row };
}

export async function equipmentEditPage(env, request, user, locationId, equipmentId) {
  const { loc, row, error } = await loadEquipment(env, user, locationId, equipmentId);
  if (error) return error;
  const synced = row.source && row.source !== "manual";
  const fields = synced
    ? `<p class="muted">This device syncs from ${row.source === "unifi" ? "UniFi" : row.source === "sophos" ? "Sophos" : "its vendor"} automatically, so its name, model, serial, and status update from the source. You can still set expiry dates and notes here.</p>
       <label>Vendor</label><input value="${esc(row.vendor || "")}" disabled>
       <label>Type</label><input value="${esc(row.type || "")}" disabled>
       <label>Model</label><input value="${esc(row.name ? (row.model ? row.name + " (" + row.model + ")" : row.name) : (row.model || ""))}" disabled>
       <label>Serial</label><input value="${esc(row.serial || "")}" disabled>`
    : `<label>Vendor</label><input name="vendor" list="eq-vendors" value="${esc(row.vendor || "")}">${datalist("eq-vendors", EQ_VENDORS)}
       <label>Type</label><input name="type" list="eq-types" value="${esc(row.type || "")}">${datalist("eq-types", EQ_TYPES)}
       <label>Name</label><input name="name" value="${esc(row.name || "")}">
       <label>Model</label><input name="model" value="${esc(row.model || "")}">
       <label>Serial</label><input name="serial" value="${esc(row.serial || "")}">
       <label>Status</label><select name="status">${["online", "offline", "unknown"].map((s) => `<option ${row.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
       <label>Firmware</label><input name="firmware" value="${esc(row.firmware || "")}">
       <label>IP address</label><input name="ip_address" value="${esc(row.ip_address || "")}" placeholder="192.168.1.50">`;
  const modeField = "ip_mode" in row ? `<label>IP type</label><select name="ip_mode"><option value="" ${!row.ip_mode ? "selected" : ""}>Not set</option><option value="dhcp" ${row.ip_mode === "dhcp" ? "selected" : ""}>DHCP (automatic)</option><option value="static" ${row.ip_mode === "static" ? "selected" : ""}>Static (fixed address)</option></select>
      <p class="muted" style="margin-top:2px">The sync cannot tell whether a device keeps its address or gets a new one each time, so this is set here. The device's IP address itself is ${synced ? "filled in by the sync" : "editable on manual records"}: ${esc(row.ip_address || "none recorded yet")}.</p>` : "";
  const renames = await loadRenames(env.DB, locationId);
  const currentRename = (row.external_id && renames[row.external_id]) || (row.mac && renames[row.mac]) || "";
  const renameField = `<label>Name shown in the portal</label><input name="display_name" value="${esc(currentRename)}" placeholder="${esc(autoName(row))}">
      <p class="muted" style="margin-top:2px">What the office sees on the Equipment list and the Network map. On the network this device calls itself "${esc(baseName(row) || row.model || "unnamed")}". Set a clearer name here once, like "OP1 computer", and it sticks; the sync never overwrites it. Leave blank to use the automatic name (${esc(autoName(row))}).</p>`;
  const body = `${locNav(loc, "equipment")}<p><a href="/app/locations/${locationId}/equipment">&larr; Equipment</a></p>
    <div class="card"><h2>Edit equipment</h2>
    <form method="post" action="/app/locations/${locationId}/equipment/${row.id}/edit">
      ${fields}
      ${renameField}
      ${modeField}
      <label>License expires</label><input name="license_expires" type="date" value="${esc(row.license_expires || "")}">
      <label>Warranty expires</label><input name="warranty_expires" type="date" value="${esc(row.warranty_expires || "")}">
      <label>Notes</label><textarea name="notes">${esc(row.notes || "")}</textarea>
      <p style="margin-top:16px"><button class="btn" type="submit">Save changes</button></p></form></div>
    ${synced ? "" : `<div class="card"><h3>Remove this equipment</h3>
      <p class="muted">For gear that was replaced or taken out of service. This deletes the record.</p>
      <form method="post" action="/app/locations/${locationId}/equipment/${row.id}/delete">
        <label style="font-weight:400"><input type="checkbox" name="confirm" value="yes" style="width:auto;margin-right:8px">Yes, delete this equipment record</label>
        <p style="margin-top:12px"><button class="btn danger" type="submit">Delete equipment</button></p></form></div>`}`;
  const q2 = new URL(request.url).searchParams;
  return page({ title: "Edit equipment", user, body, flash: q2.get("msg") || undefined, error: q2.get("err") || undefined });
}

export async function equipmentEditPost(env, request, user, locationId, equipmentId) {
  const { row, error } = await loadEquipment(env, user, locationId, equipmentId);
  if (error) return error;
  const f = await request.formData();
  const synced = row.source && row.source !== "manual";
  const hasMode = "ip_mode" in row;
  const ipMode = ["dhcp", "static"].includes(String(f.get("ip_mode") || "")) ? String(f.get("ip_mode")) : "";
  if (synced) {
    if (hasMode) {
      await env.DB.prepare("UPDATE equipment SET license_expires = ?, warranty_expires = ?, notes = ?, ip_mode = ? WHERE id = ?")
        .bind(f.get("license_expires") || null, f.get("warranty_expires") || null, f.get("notes") || null, ipMode, equipmentId).run();
    } else {
      await env.DB.prepare("UPDATE equipment SET license_expires = ?, warranty_expires = ?, notes = ? WHERE id = ?")
        .bind(f.get("license_expires") || null, f.get("warranty_expires") || null, f.get("notes") || null, equipmentId).run();
    }
  } else {
    const sets = ["vendor = ?", "type = ?", "name = ?", "model = ?", "serial = ?", "status = ?", "firmware = ?",
      "license_expires = ?", "warranty_expires = ?", "notes = ?"];
    const binds = [f.get("vendor") || null, f.get("type") || null, f.get("name") || null, f.get("model") || null,
      f.get("serial") || null, String(f.get("status") || "online"), f.get("firmware") || null,
      f.get("license_expires") || null, f.get("warranty_expires") || null, f.get("notes") || null];
    if ("ip_address" in row) { sets.push("ip_address = ?"); binds.push(String(f.get("ip_address") || "").trim() || null); }
    if (hasMode) { sets.push("ip_mode = ?"); binds.push(ipMode); }
    binds.push(equipmentId);
    await env.DB.prepare(`UPDATE equipment SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  }
  // The portal display name lives outside the equipment row (a
  // 'device_names' snapshot) so the sync, which refreshes the row's
  // own fields hourly, can never overwrite a name FlossByte set.
  try {
    if (f.get("display_name") !== null) {
      const key = row.external_id || row.mac || "";
      if (key) {
        const renames = await loadRenames(env.DB, locationId);
        const dn = String(f.get("display_name") || "").trim();
        if (dn) renames[key] = dn; else delete renames[key];
        await saveRenames(env.DB, locationId, renames);
      }
    }
  } catch { /* renames are a display nicety; never block the edit */ }
  await audit(env.DB, user.id, "equipment_edit", "equipment", Number(equipmentId), row.model || row.name || "");
  return redirect(`/app/locations/${locationId}/equipment`);
}

export async function equipmentDeletePost(env, request, user, locationId, equipmentId) {
  const { row, error } = await loadEquipment(env, user, locationId, equipmentId);
  if (error) return error;
  if (row.source && row.source !== "manual") return redirect(`/app/locations/${locationId}/equipment`);
  const f = await request.formData();
  if (String(f.get("confirm") || "") !== "yes") return redirect(`/app/locations/${locationId}/equipment/${equipmentId}/edit?err=` + encodeURIComponent("Tick the confirmation box to delete this equipment."));
  await env.DB.prepare("DELETE FROM equipment WHERE id = ?").bind(equipmentId).run();
  await audit(env.DB, user.id, "equipment_delete", "equipment", Number(equipmentId), row.model || row.name || "");
  return redirect(`/app/locations/${locationId}/equipment`);
}

// ---------- Tickets ----------
const STATUS_LABEL = { open: "Open", in_progress: "In progress", waiting: "Waiting", closed: "Closed" };

export async function ticketsPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Tickets", "managed_it");
  const device = (new URL(request.url).searchParams.get("device") || "").trim().slice(0, 120);
  const { results } = await env.DB.prepare(
    "SELECT * FROM tickets WHERE location_id = ? ORDER BY (status = 'closed'), updated_at DESC").bind(locationId).all();
  const rows = (results || []).map((t) => `<tr><td><a href="/app/locations/${locationId}/tickets/${t.id}">${esc(t.title)}</a></td>
    <td><span class="pill">${esc(STATUS_LABEL[t.status] || t.status)}</span></td><td>${esc(t.priority)}</td><td>${esc(fmtDateUS(t.created_at))}</td></tr>`).join("");
  const body = `${locNav(loc, "tickets")}<h1>Tickets</h1>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Title</th><th>Status</th><th>Priority</th><th>Opened</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="muted">No tickets yet.</td></tr>`}</tbody></table></div></div>
    <div class="card"><h3>Open a ticket</h3>
      <form method="post" action="/app/locations/${locationId}/tickets">
        <label>What is going on? <span class="req">*</span></label><input name="title" required value="${device ? esc(`Problem with ${device}`) : ""}">
        <label>Details</label><textarea name="body">${device ? esc(`Device: ${device}\nWhat is happening: `) : ""}</textarea>
        <label>Priority</label><select name="priority"><option>low</option><option selected>normal</option><option>high</option><option>urgent</option></select>
        <p style="margin-top:14px"><button class="btn" type="submit">Open ticket</button></p></form></div>`;
  return page({ title: "Tickets", user, body });
}

export async function ticketCreatePost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Tickets", "managed_it");
  const f = await request.formData();
  const res = await env.DB.prepare(
    "INSERT INTO tickets (location_id, title, priority, created_by) VALUES (?, ?, ?, ?)")
    .bind(locationId, String(f.get("title") || "Support request"), String(f.get("priority") || "normal"), user.id).run();
  const tid = res.meta.last_row_id;
  const detail = String(f.get("body") || "").trim();
  if (detail) await env.DB.prepare("INSERT INTO ticket_updates (ticket_id, author_id, body) VALUES (?, ?, ?)").bind(tid, user.id, detail).run();
  await audit(env.DB, user.id, "ticket_create", "ticket", tid, null);
  if (user.kind === "customer") {
    const mail = ticketCreatedNoticeEmail(env, {
      customerName: loc.customer_name, locationName: loc.name,
      title: String(f.get("title") || "Support request"), priority: String(f.get("priority") || "normal"),
      authorName: user.name, link: `${orgOrigin(env)}/app/locations/${locationId}/tickets/${tid}`,
    });
    await alertFlossByte(env, "ticket_created", mail);
  }
  return redirect(`/app/locations/${locationId}/tickets/${tid}`);
}

export async function ticketDetailPage(env, request, user, locationId, ticketId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  if (!(await laneOn(env.DB, loc.customer_id, locationId))) return lockedTile(user, loc, "Tickets", "managed_it");
  const t = await env.DB.prepare("SELECT * FROM tickets WHERE id = ? AND location_id = ?").bind(ticketId, locationId).first();
  if (!t) return denied(user, 404);
  const { results } = await env.DB.prepare(
    `SELECT tu.*, u.name AS author_name FROM ticket_updates tu LEFT JOIN users u ON u.id = tu.author_id
     WHERE tu.ticket_id = ? ORDER BY tu.created_at`).bind(ticketId).all();
  const thread = (results || []).map((u) => `<div style="border-bottom:1px solid var(--line);padding:10px 0">
    <div class="muted">${esc(u.author_name || "User")} · ${esc(fmtDateUS(u.created_at))} ${esc(u.created_at.slice(11, 16))}</div><p style="margin:4px 0">${esc(u.body)}</p></div>`).join("");
  const scope = await locationScope(env.DB, user, locationId);
  const canManage = user.kind === "flossbyte" || scope === "admin";
  const manage = canManage ? `<form method="post" action="/app/locations/${locationId}/tickets/${ticketId}/status" class="row" style="margin-top:14px">
      <span style="min-width:170px"><select name="status">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${t.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></span>
      <span style="min-width:140px"><select name="priority">${["low", "normal", "high", "urgent"].map((p) => `<option ${t.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select></span>
      <button class="btn small secondary" type="submit">Update status</button></form>` : "";
  const body = `${locNav(loc, "tickets")}<h1>${esc(t.title)}</h1>
    <p><span class="pill">${esc(STATUS_LABEL[t.status] || t.status)}</span> <span class="muted">Priority: ${esc(t.priority)} · opened ${esc(fmtDateUS(t.created_at))}</span></p>
    <div class="card">${thread || `<p class="muted">No updates yet.</p>`}
      <form method="post" action="/app/locations/${locationId}/tickets/${ticketId}/update">
        <label>Add an update <span class="req">*</span></label><textarea name="body" required></textarea>
        <p style="margin-top:10px"><button class="btn" type="submit">Post update</button></p></form>
      ${manage}</div>`;
  return page({ title: t.title, user, body });
}

export async function ticketUpdatePost(env, request, user, locationId, ticketId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const t = await env.DB.prepare("SELECT * FROM tickets WHERE id = ? AND location_id = ?").bind(ticketId, locationId).first();
  if (!t) return denied(user, 404);
  const f = await request.formData();
  const bodyText = String(f.get("body") || "").trim();
  if (bodyText) {
    await env.DB.prepare("INSERT INTO ticket_updates (ticket_id, author_id, body) VALUES (?, ?, ?)").bind(ticketId, user.id, bodyText).run();
    await env.DB.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").bind(ticketId).run();
    const link = `${orgOrigin(env)}/app/locations/${locationId}/tickets/${ticketId}`;
    if (user.kind === "customer") {
      const mail = ticketReplyNoticeEmail(env, {
        heading: "A customer replied to a ticket", customerName: loc.customer_name, locationName: loc.name,
        title: t.title, authorName: user.name, link, toCustomer: false,
      });
      await alertFlossByte(env, "ticket_reply", mail);
    } else if (user.kind === "flossbyte" && t.created_by && t.created_by !== user.id) {
      const creator = await env.DB.prepare("SELECT email, kind FROM users WHERE id = ?").bind(t.created_by).first();
      if (creator && creator.kind === "customer") {
        const mail = ticketReplyNoticeEmail(env, {
          heading: "FlossByte replied to your ticket", customerName: loc.customer_name, locationName: loc.name,
          title: t.title, authorName: user.name, link, toCustomer: true,
        });
        try { await sendEmail(env, { to: creator.email, template: "ticket_reply_customer", ...mail }); } catch (e) { /* never block */ }
      }
    }
  }
  return redirect(`/app/locations/${locationId}/tickets/${ticketId}`);
}

export async function ticketStatusPost(env, request, user, locationId, ticketId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const scope = await locationScope(env.DB, user, locationId);
  if (!(user.kind === "flossbyte" || scope === "admin")) return denied(user, 403);
  const f = await request.formData();
  const status = String(f.get("status") || "open");
  const priority = String(f.get("priority") || "normal");
  if (STATUS_LABEL[status]) {
    await env.DB.prepare("UPDATE tickets SET status = ?, priority = ?, updated_at = datetime('now') WHERE id = ? AND location_id = ?")
      .bind(status, priority, ticketId, locationId).run();
    await audit(env.DB, user.id, "ticket_status", "ticket", Number(ticketId), status);
  }
  return redirect(`/app/locations/${locationId}/tickets/${ticketId}`);
}

// ---------- Documents ----------
export async function documentsPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const { results } = await env.DB.prepare(
    `SELECT d.*, u.name AS uploader FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE d.location_id = ? ORDER BY d.created_at DESC`).bind(locationId).all();
  const rows = (results || []).map((d) => `<tr><td>${d.r2_key ? `<a href="/app/documents/${d.id}/view" target="_blank" rel="noopener">${esc(d.name)}</a>` : esc(d.name)}</td>
    <td>${esc(d.mime || "")}</td><td>${d.size ? Math.round(d.size / 1024) + " KB" : ""}</td>
    <td>${esc(d.uploader || "")}</td><td>${esc(fmtDateUS(d.created_at))}</td></tr>`).join("");
  const body = `${locNav(loc, "documents")}<h1>Documents</h1>
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Uploaded by</th><th>Date</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="muted">No documents yet.</td></tr>`}</tbody></table></div></div>
    <div class="card"><h3>Upload a document</h3>
      <form method="post" action="/app/locations/${locationId}/documents" enctype="multipart/form-data">
        <label>File <span class="req">*</span></label><input type="file" name="file" required>
        <p style="margin-top:12px"><button class="btn" type="submit">Upload</button></p></form>
      <p class="muted">Keep patient information out of the portal. This space is for IT documents: network notes, invoices, warranty paperwork.</p></div>`;
  return page({ title: "Documents", user, body });
}

export async function documentUploadPost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string" || file.size === 0) return redirect(`/app/locations/${locationId}/documents`);
  if (file.size > 10 * 1024 * 1024) {
    return page({ title: "Upload", user, body: `<div class="card narrow"><h1>File too large</h1><p class="muted">Keep uploads under 10 MB.</p></div>` });
  }
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
  const key = `locations/${locationId}/${Date.now()}-${safeName}`;
  if (env.DOCS) await env.DOCS.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
  const res = await env.DB.prepare(
    "INSERT INTO documents (location_id, name, r2_key, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(locationId, file.name, env.DOCS ? key : null, file.type || null, file.size, user.id).run();
  await audit(env.DB, user.id, "document_upload", "document", res.meta.last_row_id, file.name);
  return redirect(`/app/locations/${locationId}/documents`);
}

export async function documentView(env, request, user, documentId) {
  const doc = await env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(documentId).first();
  if (!doc) return denied(user, 404);
  if (!(await canAccessLocation(env.DB, user, doc.location_id))) return denied(user, 403);
  if (!doc.r2_key || !env.DOCS) return denied(user, 404);
  const obj = await env.DOCS.get(doc.r2_key);
  if (!obj) return denied(user, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": doc.mime || "application/octet-stream",
      "Content-Disposition": `inline; filename="${doc.name.replace(/"/g, "")}"`,
    },
  });
}

// ---------- Ask (answers only from this location's own records) ----------
function tokenize(text) {
  return [...new Set(String(text).toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !["what", "when", "which", "have", "does", "the", "and", "for", "our", "any"].includes(w)))];
}

export async function askAnswer(db, locationId, question) {
  const q = question.toLowerCase();
  const parts = [];
  const wantsExpiry = /expir|warrant|license|renew/.test(q);
  if (wantsExpiry) {
    const items = await expiringItems(db, locationId, 90);
    if (items.length) {
      parts.push("Expiring in the next 90 days:\n" + items.map((e) =>
        `• ${e.vendor || ""} ${e.model || e.type || "equipment"} (license ${e.license_expires ? fmtDateUS(e.license_expires) : "n/a"}, warranty ${e.warranty_expires ? fmtDateUS(e.warranty_expires) : "n/a"})`).join("\n"));
    } else parts.push("Nothing on record expires in the next 90 days.");
  }
  // Network snapshots (UniFi): internet health, settings, device
  // health, cameras and the change history. Skipped silently when no
  // snapshot has been captured for this location yet.
  let snaps = null;
  try {
    const { results: srows } = await db.prepare("SELECT kind, payload FROM network_snapshots WHERE location_id = ?").bind(locationId).all();
    if (srows && srows.length) {
      snaps = {};
      for (const r of srows) { try { snaps[r.kind] = JSON.parse(r.payload || "{}"); } catch { snaps[r.kind] = {}; } }
    }
  } catch { snaps = null; }
  if (snaps) {
    const inet = snaps.internet || {};
    if (/internet|isp|latency|packet loss|downtime|broadband|provider/.test(q) && (inet.isp || (inet.wans || []).length)) {
      const lines = [];
      if (inet.isp) {
        const i = inet.isp;
        lines.push(`• Provider: ${i.ispName || "not recorded"}`);
        if (i.uptimePct != null) lines.push(`• Uptime over the last ${i.hours || 24} hours: ${Number(i.uptimePct).toFixed(1)}% (downtime ${Math.round((i.downtimeSec || 0) / 60)} min)`);
        if (i.avgLatencyMs != null) lines.push(`• Latency: ${Math.round(i.avgLatencyMs)} ms average, ${Math.round(i.maxLatencyMs || 0)} ms peak`);
        if (i.downMbps != null) lines.push(`• Speed: ${Number(i.downMbps).toFixed(1)} Mbps down, ${Number(i.upMbps || 0).toFixed(1)} Mbps up on average`);
      }
      for (const w of inet.wans || []) lines.push(`• ${w.name || "WAN"}: ${w.ipAddress || w.ip || "no IP recorded"}${w.state || w.status ? ` (${w.state || w.status})` : ""}`);
      if (lines.length) parts.push("Internet:\n" + lines.join("\n"));
    }
    const cfg = snaps.config || {};
    const wifiManual = (snaps.wifi && Array.isArray(snaps.wifi.networks)) ? snaps.wifi.networks : [];
    if (/wi-?fi|ssid|wireless|password/.test(q) && ((cfg.ssids || []).length || wifiManual.length)) {
      const lines = [];
      const manByName = new Map(wifiManual.filter((w) => w && w.name).map((w) => [String(w.name).toLowerCase(), w]));
      const seenNames = new Set();
      for (const s of cfg.ssids || []) {
        const nm = s.name || s.ssid;
        if (!nm) continue;
        seenNames.add(String(nm).toLowerCase());
        const man = manByName.get(String(nm).toLowerCase());
        const pass = s.pass || (man && man.pass) || "";
        lines.push(`• ${nm}${man && man.kind === "guest" ? " (for patients)" : man && man.kind === "staff" ? " (staff)" : ""} (${s.security || "security not recorded"}, ${s.enabled === false ? "off" : "on"})${pass ? `: password ${pass}` : ""}`);
      }
      for (const w of wifiManual) {
        if (!w || !w.name || seenNames.has(String(w.name).toLowerCase())) continue;
        lines.push(`• ${w.name}${w.kind === "guest" ? " (for patients)" : w.kind === "staff" ? " (staff)" : ""}: ${w.pass ? `password ${w.pass}` : "password not recorded"}`);
      }
      if (lines.length) parts.push("WiFi networks:\n" + lines.join("\n"));
    }
    if (/vpn|tunnel/.test(q) && ((cfg.vpnTunnels || []).length || (cfg.vpnServers || []).length)) {
      const lines = [
        ...(cfg.vpnTunnels || []).map((t) => `• Tunnel ${t.name} (${t.type || ""}${t.state || t.status ? `, ${t.state || t.status}` : ""})`),
        ...(cfg.vpnServers || []).map((v) => `• Server ${v.name} (${v.type || ""}, ${v.enabled === false ? "off" : "on"})`),
      ];
      parts.push("VPN:\n" + lines.join("\n"));
    }
    if (/firewall|vlan/.test(q) && ((cfg.networks || []).length || (cfg.firewallPolicies || []).length)) {
      const lines = [
        ...(cfg.networks || []).map((n) => `• Network ${n.name}${n.vlanId != null ? ` (VLAN ${n.vlanId})` : ""}, ${n.enabled === false ? "off" : "on"}`),
        ...(cfg.firewallPolicies || []).map((p) => `• Policy ${p.name} (${p.action || ""}, ${p.enabled === false ? "off" : "on"})`),
      ];
      if (lines.length) parts.push("Networks and firewall:\n" + lines.join("\n"));
    }
    if (/camera|protect/.test(q) && ((snaps.protect || {}).cameras || []).length) {
      parts.push("Cameras:\n" + snaps.protect.cameras.map((c) => `• ${c.name} (${c.model || ""}, ${c.state || c.status || ""})`).join("\n"));
    }
    if (/changed|changes|recently|last week/.test(q) && ((snaps.changes || {}).events || []).length) {
      parts.push("Recent changes:\n" + snaps.changes.events.slice(0, 8).map((e) => `• ${String(e.at || "").slice(0, 10)}: ${e.text}`).join("\n"));
    }
    if (/device health|cpu|memory|health of/.test(q) && ((snaps.device_stats || {}).devices || []).length) {
      parts.push("Device health:\n" + snaps.device_stats.devices.slice(0, 10).map((d) => `• ${d.name || d.mac}: CPU ${d.cpu != null ? Math.round(d.cpu) + "%" : "n/a"}, memory ${d.mem != null ? Math.round(d.mem) + "%" : "n/a"}`).join("\n"));
    }
  }
  // "What is X connected to?" answered from the topology parents.
  if (/connected to|plugged into|uplink/.test(q)) {
    try {
      const cols = await db.prepare("PRAGMA table_info(equipment)").all();
      if ((cols.results || []).some((c) => c.name === "parent_mac")) {
        const { results: alleq } = await db.prepare("SELECT name, type, mac, parent_mac FROM equipment WHERE location_id = ? AND mac IS NOT NULL").bind(locationId).all();
        const byMac = new Map((alleq || []).map((e) => [e.mac, e]));
        const qwords = tokenize(question);
        const hits = (alleq || []).filter((e) => e.parent_mac && qwords.some((w) => String(e.name || "").toLowerCase().includes(w)));
        if (hits.length) {
          parts.push("Connections:\n" + hits.slice(0, 6).map((e) => {
            const p = byMac.get(e.parent_mac);
            return `• ${e.name} connects through ${p ? (p.name || p.type || "a network device") : "the gateway"}`;
          }).join("\n"));
        }
      }
    } catch { /* topology parents not available yet */ }
  }
  const words = tokenize(question);
  if (words.length) {
    let eqFields = ["vendor", "type", "model", "serial", "status", "notes", "name"];
    try {
      const cols = await db.prepare("PRAGMA table_info(equipment)").all();
      if ((cols.results || []).some((c) => c.name === "ip_address")) eqFields.push("ip_address");
    } catch { /* older table: search the base fields */ }
    const like = words.map(() => `(${eqFields.map((c) => `${c} LIKE ?`).join(" OR ")})`).join(" OR ");
    const binds = [locationId];
    for (const w of words) { const l = `%${w}%`; for (let i = 0; i < eqFields.length; i++) binds.push(l); }
    const { results: eq } = await db.prepare(`SELECT * FROM equipment WHERE location_id = ? AND (${like}) LIMIT 8`).bind(...binds).all();
    if (eq && eq.length) {
      const askRenames = (snaps && snaps.device_names && snaps.device_names.names) || {};
      parts.push("Equipment on record:\n" + eq.map((e) =>
        `• ${displayName(e, askRenames)} (${deviceKind(e)}${e.ip_address ? `, IP ${e.ip_address}` : ""}, status ${e.status})`).join("\n"));
    }
    const tLike = words.map(() => "title LIKE ?").join(" OR ");
    const tBinds = [locationId, ...words.map((w) => `%${w}%`)];
    const { results: tk } = await db.prepare(`SELECT * FROM tickets WHERE location_id = ? AND (${tLike}) LIMIT 5`).bind(...tBinds).all();
    if (tk && tk.length) {
      parts.push("Tickets on record:\n" + tk.map((t) => `• "${t.title}" (${STATUS_LABEL[t.status] || t.status}, ${t.priority})`).join("\n"));
    }
    const dLike = words.map(() => "name LIKE ?").join(" OR ");
    const dBinds = [locationId, ...words.map((w) => `%${w}%`)];
    const { results: dc } = await db.prepare(`SELECT * FROM documents WHERE location_id = ? AND (${dLike}) LIMIT 5`).bind(...dBinds).all();
    if (dc && dc.length) {
      parts.push("Documents on record: " + dc.map((d) => d.name).join(", ") + ".");
    }
  }
  if (!parts.length) {
    return "That is not in your portal records yet, so I cannot answer it from your data. Ask about equipment, license or warranty expiry dates, your internet, WiFi, VPN, cameras, recent network changes, tickets, or documents, or open a ticket and we will look into it.";
  }
  return parts.join("\n") + "\n(Answered from your own portal records only.)";
}

export async function askPage(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const { results } = await env.DB.prepare(
    "SELECT * FROM ask_messages WHERE location_id = ? ORDER BY created_at DESC LIMIT 10").bind(locationId).all();
  const history = (results || []).reverse().map((m) => `<div class="msg q">${esc(m.question)}</div>
    <div class="msg a">${esc(m.answer)}</div>`).join("");
  const starter = (q) => `<form method="post" action="/app/locations/${locationId}/ask" style="margin:0"><input type="hidden" name="question" value="${esc(q)}"><button class="btn small secondary" type="submit">${esc(q)}</button></form>`;
  const body = `${locNav(loc, "ask")}<h1>Ask</h1>
    <div class="card"><p class="muted">Ask about your internet, WiFi, equipment, cameras, expiry dates, tickets, documents, and recent changes. Answers come only from what is recorded for this practice.</p>
    <p class="muted" style="margin-bottom:6px">Try one of these:</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">${starter("Is our internet OK?")}${starter("What's the WiFi password?")}${starter("Which devices are offline?")}</div>
    <form method="post" action="/app/locations/${locationId}/ask">
      <input name="question" placeholder="What is expiring in the next 90 days?" required>
      <p style="margin-top:12px"><button class="btn" type="submit">Ask</button></p></form>
    ${history ? `<div class="chat">${history}</div>` : ""}</div>`;
  return page({ title: "Ask", user, body });
}

export async function askPost(env, request, user, locationId) {
  const { loc, error } = await guard(env, user, locationId);
  if (error) return denied(user, error);
  const f = await request.formData();
  const question = String(f.get("question") || "").trim();
  if (question) {
    const answer = await askAnswer(env.DB, locationId, question);
    await env.DB.prepare("INSERT INTO ask_messages (location_id, user_id, question, answer) VALUES (?, ?, ?, ?)")
      .bind(locationId, user.id, question, answer).run();
  }
  return redirect(`/app/locations/${locationId}/ask`);
}

// ---------- Quotes and invoices (organization level) ----------
// A login belongs to exactly one organization, so any accessible
// location identifies the org. Quotes are visible once sent; only a
// customer admin can accept or decline, and accepting creates the
// deposit invoice on the spot when the quote asks for one.
async function clientOrgId(env, user) {
  const ids = await accessibleLocationIds(env.DB, user);
  if (!ids || ids.size === 0) return null;
  const loc = await getLocation(env.DB, [...ids][0]);
  return loc ? loc.customer_id : null;
}

async function loadQuote(db, quoteId, customerId) {
  const quote = await db.prepare("SELECT * FROM quotes WHERE id = ? AND customer_id = ?").bind(quoteId, customerId).first();
  if (!quote) return null;
  const { results: items } = await db.prepare(
    "SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort, id").bind(quoteId).all();
  const total = (items || []).reduce((s, i) => s + Math.round(i.qty * i.unit_price_cents), 0);
  return { quote, items: items || [], total };
}

const QUOTE_STATUS = { sent: "Waiting for you", accepted: "Accepted", declined: "Declined" };
const INVOICE_KIND = { deposit: "Deposit", final: "Final balance", standard: "Invoice" };

async function quotesSection(env, org) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM quotes WHERE customer_id = ? AND status IN ('sent','accepted','declined') ORDER BY updated_at DESC").bind(org).all();
  const rows = [];
  for (const qt of results || []) {
    const { total } = await loadQuote(env.DB, qt.id, org);
    rows.push(`<tr><td><a href="/app/quotes/${qt.id}">${esc(qt.title)}</a></td>
      <td>${qt.kind === "plan" ? "Service plan" : "Project"}</td><td class="num">${fmtMoney(total)}</td>
      <td><span class="pill ${qt.status === "accepted" ? "on" : qt.status === "declined" ? "off" : ""}">${esc(QUOTE_STATUS[qt.status] || qt.status)}</span></td>
      <td>${esc(fmtDateUS((qt.sent_at || qt.created_at || "")))}</td></tr>`);
  }
  return `
    <div class="card" style="padding:10px 14px"><h3 style="margin:2px 0 8px">Quotes</h3><div class="tscroll"><table class="stack"><thead><tr><th>Quote</th><th>Type</th><th class="num">Total</th><th>Status</th><th>Sent</th></tr></thead>
    <tbody>${rows.join("") || `<tr><td colspan="5" class="muted">No quotes yet. When FlossByte sends you one, it shows up here for review and acceptance.</td></tr>`}</tbody></table></div></div>`;
}

export async function quoteViewPage(env, request, user, quoteId) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  const loaded = await loadQuote(env.DB, quoteId, org);
  if (!loaded || loaded.quote.status === "draft") return denied(user, 404);
  const { quote, items, total } = loaded;
  const deposit = Math.round(total * (quote.deposit_percent || 0) / 100);
  const itemRows = items.map((i) => `<tr><td>${esc(i.description)}</td><td class="num">${esc(String(i.qty))}</td>
    <td class="num">${fmtMoney(i.unit_price_cents)}</td><td class="num">${fmtMoney(Math.round(i.qty * i.unit_price_cents))}</td></tr>`).join("");
  let statusBlock = "";
  if (quote.status === "accepted") {
    statusBlock = `<div class="notice"><strong>Accepted</strong> by ${esc(quote.accepted_by || "")} on ${esc(fmtDateUS((quote.accepted_at || "")))}.
      ${deposit > 0 ? `The deposit invoice is on your <a href="/app/billing">Billing</a> page.` : ""}</div>`;
  } else if (quote.status === "declined") {
    statusBlock = `<div class="notice">This quote was declined. If that was a mistake, call FlossByte at (669) 237-2264.</div>`;
  } else if (user.role === "customer_admin") {
    statusBlock = `<div class="card"><h3>Accept this quote</h3>
      <form method="post" action="/app/quotes/${quote.id}/accept">
        <label>Your full name <span class="req">*</span></label><input name="signer_name" required>
        <p><label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="agree" value="yes" required style="width:auto;margin-top:4px">
        <span>I agree to the terms below and accept this quote for our organization.</span></label></p>
        <button class="btn" type="submit">Accept quote</button></form>
      <form method="post" action="/app/quotes/${quote.id}/decline" style="margin-top:10px">
        <button class="btn small secondary" type="submit">Decline</button></form></div>`;
  } else {
    statusBlock = `<div class="card"><p class="muted">This quote is waiting for your practice's admin to review and accept it.</p></div>`;
  }
  const rail = await railLocs(env, user);
  const body = `${orgRail(user, "billing", "My Portal", rail)}<p><a href="/app/billing">&larr; Billing</a></p><h1>${esc(quote.title)}</h1>
    <p class="muted">${quote.kind === "plan" ? "Service plan" : "Project"} quote from FlossByte. Total <strong>${fmtMoney(total)}</strong>${deposit > 0 ? `, with a ${quote.deposit_percent}% deposit of <strong>${fmtMoney(deposit)}</strong> due on acceptance and ${fmtMoney(total - deposit)} after that.` : "."}</p>
    <p><button class="btn small secondary" type="button" onclick="window.print()">Print / save as PDF</button></p>
    ${statusBlock}
    <div class="card" style="padding:8px 14px"><div class="tscroll"><table class="stack"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
    <tbody>${itemRows}</tbody></table></div></div>
    ${quote.terms ? `<div class="card"><h3>Terms</h3><div style="white-space:pre-wrap">${esc(quote.terms)}</div></div>` : ""}`;
  const msg = new URL(request.url).searchParams.get("msg");
  return page({ title: quote.title, user, body, flash: msg || undefined, error: new URL(request.url).searchParams.get("err") || undefined });
}

export async function quoteAcceptPost(env, request, user, quoteId) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  if (user.role !== "customer_admin") return denied(user, 403);
  const loaded = await loadQuote(env.DB, quoteId, org);
  if (!loaded || loaded.quote.status !== "sent") return redirect("/app/billing");
  const f = await request.formData();
  const signer = String(f.get("signer_name") || "").trim();
  if (String(f.get("agree") || "") !== "yes" || !signer) {
    return redirect(`/app/quotes/${quoteId}?err=` + encodeURIComponent("Type your full name and check the agreement box to accept."));
  }
  const { quote, total } = loaded;
  await env.DB.prepare(
    "UPDATE quotes SET status = 'accepted', accepted_at = datetime('now'), accepted_by = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(signer, quoteId).run();
  const deposit = Math.round(total * (quote.deposit_percent || 0) / 100);
  let invoiceNote = "";
  if (deposit > 0) {
    await env.DB.prepare(
      "INSERT INTO invoices (customer_id, quote_id, title, kind, amount_cents, created_by) VALUES (?, ?, ?, 'deposit', ?, ?)")
      .bind(org, quoteId, `${quote.title}: deposit (${quote.deposit_percent}%)`, deposit, user.id).run();
    invoiceNote = " The deposit invoice is on your Billing page; work is scheduled once it is paid.";
  }
  await audit(env.DB, user.id, "quote_accept", "quote", quoteId, `signed by ${signer}`);
  {
    const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
    const mail = quoteAcceptedNoticeEmail(env, {
      customerName: cust ? cust.name : "A customer", quoteTitle: quote.title, acceptedBy: signer, total: fmtMoney(total),
    });
    await alertFlossByte(env, "quote_accepted", mail);
  }
  return redirect(`/app/quotes/${quoteId}?msg=` + encodeURIComponent("Quote accepted. Thank you." + invoiceNote));
}

export async function quoteDeclinePost(env, request, user, quoteId) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  if (user.role !== "customer_admin") return denied(user, 403);
  const loaded = await loadQuote(env.DB, quoteId, org);
  if (!loaded || loaded.quote.status !== "sent") return redirect("/app/billing");
  await env.DB.prepare(
    "UPDATE quotes SET status = 'declined', updated_at = datetime('now') WHERE id = ?").bind(quoteId).run();
  await audit(env.DB, user.id, "quote_decline", "quote", quoteId, null);
  return redirect("/app/billing?msg=" + encodeURIComponent("Quote declined."));
}

async function invoicesSection(env, org) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM invoices WHERE customer_id = ? AND status != 'void' ORDER BY created_at DESC").bind(org).all();
  const rows = (results || []).map((inv) => {
    const pay = inv.status === "unpaid" && inv.pay_url
      ? `<a class="btn small" href="${esc(inv.pay_url)}" target="_blank" rel="noopener">Pay</a>`
      : inv.status === "unpaid" ? `<span class="muted">We'll email you a payment link.</span>` : "";
    const note = inv.kind === "deposit"
      ? (inv.status === "unpaid" ? `<div class="muted">Work is scheduled once this deposit is paid.</div>` : `<div class="muted">Deposit received.</div>`) : "";
    const overdue = inv.status === "unpaid" && inv.due_date && inv.due_date < new Date().toISOString().slice(0, 10);
    return `<tr><td><a href="/app/invoices/${inv.id}">INV-${1000 + inv.id}</a></td><td>${esc(inv.title)}${note}</td>
      <td>${esc(INVOICE_KIND[inv.kind] || "Invoice")}</td><td class="num">${fmtMoney(inv.amount_cents)}</td>
      <td><span class="pill ${inv.status === "paid" ? "on" : ""}">${inv.status === "paid" ? "Paid" : "Unpaid"}</span>${inv.status === "paid" && inv.paid_at ? `<div class="muted">${esc(fmtDateUS(inv.paid_at))}</div>` : ""}</td>
      <td>${esc(fmtDateUS(inv.due_date))}${overdue ? ` <span style="color:#b91c1c;font-weight:700">overdue</span>` : ""}</td><td>${pay}</td></tr>`;
  }).join("");
  return `
    <div class="card" style="padding:10px 14px;margin-top:16px"><h3 style="margin:2px 0 8px">Invoices</h3><div class="tscroll"><table class="stack"><thead><tr><th>Number</th><th>Invoice</th><th>Type</th><th class="num">Amount</th><th>Status</th><th>Due</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="muted">No invoices yet. When there's something to pay, it shows up here.</td></tr>`}</tbody></table></div></div>`;
}

export async function invoiceViewPage(env, request, user, invoiceId) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE id = ? AND customer_id = ?").bind(invoiceId, org).first();
  if (!inv) return denied(user, 404);
  const cust = await env.DB.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const pay = inv.status === "unpaid" && inv.pay_url
    ? `<p style="margin-top:16px"><a class="btn" href="${esc(inv.pay_url)}" target="_blank" rel="noopener">Pay ${fmtMoney(inv.amount_cents)}</a></p>`
    : inv.status === "unpaid" ? `<p class="muted" style="margin-top:16px">We'll email you a payment link for this invoice. Questions: call (669) 237-2264.</p>` : "";
  const rail = await railLocs(env, user);
  const body = `${orgRail(user, "billing", cust ? cust.name : "My Portal", rail)}<p><a href="/app/billing">&larr; Billing</a></p>
    <h1>INV-${1000 + inv.id}</h1>
    <p class="muted">${esc(inv.title)}</p>
    <p><button class="btn small secondary" type="button" onclick="window.print()">Print / save as PDF</button></p>
    <div class="card"><div class="tscroll"><table>
      <tbody>
      <tr><td class="muted">Billed to</td><td>${esc(cust ? cust.name : "")}</td></tr>
      <tr><td class="muted">Type</td><td>${esc(INVOICE_KIND[inv.kind] || "Invoice")}</td></tr>
      <tr><td class="muted">Amount</td><td><strong>${fmtMoney(inv.amount_cents)}</strong></td></tr>
      <tr><td class="muted">Status</td><td><span class="pill ${inv.status === "paid" ? "on" : ""}">${inv.status === "paid" ? "Paid" : inv.status === "void" ? "Void" : "Unpaid"}</span>${inv.status === "paid" && inv.paid_at ? ` ${esc(fmtDateUS(inv.paid_at))}${inv.paid_method ? " by " + esc(inv.paid_method) : ""}` : ""}</td></tr>
      ${inv.due_date ? `<tr><td class="muted">Due</td><td>${esc(fmtDateUS(inv.due_date))}${inv.status === "unpaid" && inv.due_date < new Date().toISOString().slice(0, 10) ? ` <span style="color:#b91c1c;font-weight:700">overdue</span>` : ""}</td></tr>` : ""}
      </tbody></table></div>${pay}</div>`;
  return page({ title: `INV-${1000 + inv.id}`, user, body });
}

export async function billingPage(env, request, user) {
  const org = await clientOrgId(env, user);
  if (org === null) return denied(user, 403);
  const db = env.DB;
  const cust = await db.prepare("SELECT name FROM customers WHERE id = ?").bind(org).first();
  const sums = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotes WHERE customer_id = ? AND status = 'sent') AS quotes_waiting,
            (SELECT COUNT(*) FROM invoices WHERE customer_id = ? AND status = 'unpaid') AS unpaid_count,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM invoices WHERE customer_id = ? AND status = 'unpaid') AS outstanding,
            (SELECT COUNT(*) FROM invoices WHERE customer_id = ? AND status = 'paid') AS paid_count`)
    .bind(org, org, org, org).first().catch(() => null);
  const strip = sums ? `<div class="statgrid">
    <div class="stat"><b>${sums.quotes_waiting}</b><span>Quotes waiting for you</span></div>
    <div class="stat"><b>${sums.unpaid_count}</b><span>Unpaid invoices</span></div>
    <div class="stat"><b>${fmtMoney(sums.outstanding)}</b><span>Outstanding</span></div>
    <div class="stat"><b>${sums.paid_count}</b><span>Invoices paid</span></div>
  </div>` : "";
  const rail = await railLocs(env, user);
  const quotesHtml = await quotesSection(env, org);
  const invoicesHtml = await invoicesSection(env, org);
  const body = `${orgRail(user, "billing", cust ? cust.name : "My Portal", rail)}<h1 style="margin-bottom:2px">Billing</h1>
    <p class="muted" style="margin:0 0 14px">${esc(cust ? cust.name : "")} · quotes and invoices for the whole organization</p>
    ${strip}${quotesHtml}${invoicesHtml}`;
  const msg = new URL(request.url).searchParams.get("msg");
  return page({ title: "Billing", user, body, flash: msg || undefined, error: new URL(request.url).searchParams.get("err") || undefined });
}
