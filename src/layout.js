// Shared page chrome: FlossByte branding matched to flossbyte.com.
// Navy #0A1628, teal #00BFA5 (hover #00D4B8), Plus Jakarta Sans headings,
// Inter body, 72px navy header, navy footer.

export function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Dates are stored ISO; customers read US format ("Nov 20, 2026").
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDateUS(d) {
  if (!d) return "";
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(d);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

// Small stroke icons for the app rail (Lucide-style paths, currentColor).
const ICON_PATHS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M9 6h1M14 6h1M9 10h1M14 10h1M9 14h1M14 14h1"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 7h8M8 11h8M8 15h5"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="2" y1="14" x2="6" y2="14"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="18" y1="16" x2="22" y2="16"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  headset: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M21 14h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2z"/><path d="M3 14v-2a9 9 0 0 1 18 0v2"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
};
export function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
}

const CSS = `
:root{--navy:#0A1628;--teal:#00BFA5;--teal-hover:#00D4B8;--ink:#14213a;--muted:#5b6b82;--line:#dde3ea;--bg:#f5f7fa;--card:#fff;--warn:#b45309;--warn-bg:#fdf3e3;--bad:#b3261e;--ok:#067647}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,system-ui,sans-serif;color:var(--ink);background:var(--bg)}
h1,h2,h3,.brand-name{font-family:'Plus Jakarta Sans',Inter,sans-serif}
a{color:#00796b}
header.site{background:var(--navy);min-height:72px;display:flex;align-items:center}
.header-in{width:100%;max-width:1120px;margin:0 auto;padding:0 20px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:#fff}
.brand img{width:27px;height:40px;max-height:40px;object-fit:contain;display:block}
.brand-name{font-weight:800;font-size:20px;letter-spacing:.2px;color:#fff}
.brand-sub{color:var(--teal-hover);font-size:11px;letter-spacing:1.5px;text-transform:uppercase}
nav.top{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
nav.top a{color:#dbe4ee;text-decoration:none;font-size:14px}
nav.top a:hover{color:#fff}
.btn{display:inline-block;background:var(--teal);color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none}
.btn:hover{background:var(--teal-hover);color:#fff}
.btn.secondary{background:#e7edf3;color:var(--ink)}
.btn.secondary:hover{background:#d7e0ea}
.btn.small{padding:6px 12px;font-size:13px}
.btn.danger{background:var(--bad)}
details.addbox{margin-top:14px}
details.addbox>summary{list-style:none;width:fit-content}
details.addbox>summary::-webkit-details-marker{display:none}
details.addbox>summary::marker{content:""}
.tabbar{display:flex;gap:2px;flex-wrap:wrap;margin:16px 0 14px;border-bottom:2px solid var(--line)}
.tab-btn{background:none;border:none;border-bottom:3px solid transparent;margin-bottom:-2px;padding:9px 14px;font-size:15px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit}
.tab-btn:hover{color:var(--ink)}
.tab-btn.active{color:var(--teal);border-bottom-color:var(--teal)}
.tab-panel{display:none}
.tab-panel.active{display:block}
form.js-wizard .wstep{display:none}
form.js-wizard .wstep.active{display:block}
.wiz-progress{position:relative;margin:22px 4px 26px}
.wiz-track{position:absolute;left:13px;right:13px;top:13px;height:4px;background:#dde3ea;border-radius:2px}
.wiz-fill{height:100%;width:0;background:var(--teal);border-radius:2px;transition:width .35s ease}
.wiz-nodes{position:relative;display:flex;justify-content:space-between}
.wiz-node{display:flex;flex-direction:column;align-items:center;gap:6px;width:25%}
.wiz-node .dot{width:27px;height:27px;border-radius:50%;background:#fff;border:2px solid #c3cedb;color:var(--muted);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700}
.wiz-node .nlabel{font-size:12px;color:var(--muted);text-align:center}
.wiz-node.current .dot{border-color:var(--teal);color:var(--teal)}
.wiz-node.current .nlabel{color:var(--ink);font-weight:700}
.wiz-node.done .dot{background:var(--teal);border-color:var(--teal);color:#fff}
.wiz-node.done .nlabel{color:var(--ink)}
.confirm-box{display:flex;gap:10px;align-items:flex-start;margin-top:16px;cursor:pointer;font-weight:400;padding:2px}
.confirm-box input{width:19px;height:19px;margin-top:1px;flex:none}
.confirm-box.error{background:#fdecea;border:1.5px solid var(--bad);border-radius:8px;padding:12px 14px;font-weight:600}
.confirm-box.error input{accent-color:var(--bad)}
input.field-error{border:2px solid var(--bad);background:#fff5f4}
.req{color:var(--bad);font-weight:700}
.addr-wrap{position:relative}
.addr-list{position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid var(--line);border-radius:0 0 8px 8px;box-shadow:0 10px 24px rgba(10,22,40,.16);z-index:40;overflow:hidden}
.addr-item{padding:9px 12px;font-size:14px;cursor:pointer}
.addr-item:hover,.addr-item.active{background:#eef6f4}
main{max-width:1120px;margin:0 auto;padding:28px 20px 48px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px;margin-bottom:18px}
.card.narrow{max-width:440px;margin:40px auto}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input,select,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:15px;font-family:inherit;background:#fff}
textarea{min-height:90px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
.tile{border:1px solid var(--line);border-radius:12px;padding:18px;background:#fff;text-decoration:none;color:var(--ink);display:block}
.tile:hover{border-color:var(--teal)}
.tile .t{font-family:'Plus Jakarta Sans';font-weight:700;font-size:17px}
.tile .d{color:var(--muted);font-size:13px;margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;background:#e7edf3;white-space:nowrap}
.tscroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tscroll>table{min-width:600px}
@media (max-width:680px){
.tscroll{overflow-x:visible}
.tscroll>table.stack{min-width:0}
table.stack thead{display:none}
table.stack tr{display:block;padding:8px 0;border-bottom:1px solid var(--line)}
table.stack td{display:block;border-bottom:none;padding:3px 0}
table.stack td:empty{display:none}
table.stack form.row{flex-wrap:wrap}
}
.pill.on{background:#e0f5ef;color:var(--ok)}
.pill.off{background:#f3e2e0;color:var(--bad)}
.pill.warn{background:var(--warn-bg);color:var(--warn)}
.notice{background:var(--warn-bg);border:1px solid #f0d9a8;border-radius:10px;padding:14px 16px;margin-bottom:18px}
.error{background:#fbeae9;border:1px solid #efc4c1;color:var(--bad);border-radius:10px;padding:12px 16px;margin-bottom:16px}
.muted{color:var(--muted);font-size:14px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.row.between{justify-content:space-between}
footer.site{background:var(--navy);color:#c8d3e0;margin-top:24px}
.footer-in{max-width:1120px;margin:0 auto;padding:32px 20px;display:flex;gap:28px;flex-wrap:wrap;justify-content:space-between}
footer.site a{color:#fff}
footer.site .brand img{width:27px;height:40px;max-height:40px}
.switch{display:inline-flex;align-items:center;gap:8px}
@media (max-width:640px){.brand-sub{display:none}.header-in{flex-wrap:wrap;row-gap:8px;padding-top:10px;padding-bottom:10px}nav.top{width:100%;gap:12px;row-gap:6px}nav.top a{font-size:13px}}
h1{font-size:27px;line-height:1.25;margin:0 0 14px}
h2{font-size:20px;line-height:1.3}
h3{font-size:16px}
.btn{transition:background .15s ease}
.shell{display:grid;grid-template-columns:234px minmax(0,1fr);gap:26px;align-items:start}
main:has(.shell){max-width:1300px}
.rail{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 10px;position:sticky;top:20px}
.rail-context{padding:2px 10px 11px;border-bottom:1px solid var(--line);margin-bottom:10px}
.rail-context .rc-t{font-family:'Plus Jakarta Sans',Inter,sans-serif;font-weight:700;font-size:15px}
.rail-context .rc-s{color:var(--muted);font-size:12px;margin-top:1px}
.rail-item{display:flex;align-items:center;gap:8px;width:100%;padding:9px 10px;border-radius:8px;color:var(--ink);text-decoration:none;font-size:14px;font-weight:600;background:none;border:none;border-left:3px solid transparent;cursor:pointer;font-family:inherit;text-align:left}
a.rail-item:hover,button.rail-item:hover{background:#f0f4f8;color:var(--ink)}
.rail-item.active{background:#e6f7f3;color:#00796b;border-left-color:var(--teal)}
.rail .tab-btn{border-bottom:none;margin-bottom:0}
.rail .tab-btn.active{color:#00796b;border-bottom-color:transparent}
.rail-sep{border-top:1px solid var(--line);margin:10px 4px}
.rail-label{padding:12px 12px 2px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
@media (max-width:900px){
.shell{grid-template-columns:minmax(0,1fr);gap:14px}
.rail{top:8px;z-index:20;display:flex;align-items:center;gap:6px;overflow-x:auto;padding:8px;scrollbar-width:none}
.rail::-webkit-scrollbar{display:none}
.rail-context{border-bottom:none;margin:0;padding:0 6px 0 2px;flex:0 0 auto;max-width:38%}
.rail-context .rc-t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
.rail-context .rc-s{display:none}
.rail-sep{display:none}
.rail-item{width:auto;flex:0 0 auto;white-space:nowrap;border:1px solid var(--line);border-radius:999px;padding:7px 13px}
.rail-item.active{border-color:var(--teal)}
.card{padding:18px}
}
.ic{width:17px;height:17px;flex:0 0 auto}
tbody tr{transition:background .1s ease}
tbody tr:hover{background:#f8fafc}
td.num,th.num{text-align:right}
.chat{display:flex;flex-direction:column;gap:8px;margin-top:18px}
.msg{max-width:88%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.5;white-space:pre-wrap}
.msg.q{align-self:flex-end;background:#e6f7f3;border-bottom-right-radius:4px}
.msg.a{align-self:flex-start;background:#f0f4f8;border-bottom-left-radius:4px}
footer.slim{border-top:1px solid var(--line);margin-top:10px}
.footer-slim-in{max-width:1300px;margin:0 auto;padding:16px 20px;color:var(--muted);font-size:13px;display:flex;gap:6px;flex-wrap:wrap}
footer.slim a{color:var(--muted)}
.auth-wrap{display:grid;grid-template-columns:minmax(0,460px) minmax(0,1fr);min-height:100vh}
.auth-brand{background:var(--navy);color:#dbe4ee;padding:38px 42px;display:flex;flex-direction:column;gap:26px}
.auth-brand h2{color:#fff;font-size:26px;margin:0 0 10px}
.auth-brand p{color:#aebdd0;font-size:15px;line-height:1.6;margin:0;max-width:320px}
.auth-brand-foot{margin-top:auto;color:#8fa1b8;font-size:13px;line-height:1.8}
.auth-brand-foot a{color:#dbe4ee;text-decoration:none}
.auth-main{display:flex;align-items:center;justify-content:center;padding:34px 20px;background:#fff}
.auth-box{width:100%;max-width:400px}
.auth-box .card.narrow{margin:0;max-width:none;border:none;background:transparent;padding:0}
.auth-box h1{font-size:24px}
@media (max-width:900px){
.auth-wrap{grid-template-columns:1fr;min-height:0}
.auth-brand{padding:20px;gap:8px}
.auth-brand p{display:none}
.auth-brand-foot{margin-top:0}
.auth-main{padding:26px 18px 44px;align-items:flex-start}
}
@media (max-width:640px){
header.site{min-height:56px}
.header-in{flex-wrap:nowrap;padding-top:0;padding-bottom:0}
nav.top{width:auto;flex-wrap:nowrap;gap:14px}
nav.top>a{display:none}
.acct-name{display:none}
.brand-name{font-size:18px}
}
.pill.off{background:#fdecec;color:#9c2b2b}
.acct{position:relative}
.acct summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px}
.acct summary::-webkit-details-marker{display:none}
.avatar{width:32px;height:32px;border-radius:50%;background:var(--teal);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;font-family:var(--font-head)}
.acct-name{color:#fff;font-weight:600;font-size:14px}
.acct-menu{position:absolute;right:0;top:calc(100% + 10px);background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 32px rgba(10,22,40,.18);min-width:230px;padding:6px;z-index:60}
.acct-head{padding:8px 10px;border-bottom:1px solid var(--line);margin-bottom:4px}
.acct-head strong{display:block;font-size:14px;color:var(--ink)}
.acct-head span{font-size:12px;color:var(--muted);word-break:break-all}
.acct-menu a{display:block;padding:9px 10px;border-radius:8px;color:var(--ink) !important;text-decoration:none;font-size:14px}
.acct-menu a:hover{background:#f0f4f8;text-decoration:none}
.tile .tile-n{display:block;font-family:var(--font-head);font-size:26px;font-weight:800;color:var(--navy);line-height:1.1}
@media print{
header.site,footer.site,footer.slim,.rail,.btn,form,nav.top,.flash-print-hide{display:none !important}
body{background:#fff}
main{max-width:none !important;padding:0}
.shell{grid-template-columns:minmax(0,1fr)}
.card{border:none;padding:0}
.tscroll{overflow:visible}
.tscroll>table{min-width:0}
a{color:#000;text-decoration:none}
}
`;

export function page({ title, user, body, flash, error, auth }) {
  const head = `<head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | FlossByte Portal</title>
<link rel="icon" href="/assets/logo-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet">
<style>${CSS}</style></head>`;
  const alerts = `${error ? `<div class="error">${esc(error)}</div>` : ""}
${flash ? `<div class="notice">${esc(flash)}</div>` : ""}`;
  // Sign-in family of pages: split screen, brand panel beside the form,
  // no site header or footer. On phones the panel becomes a top strip.
  if (auth) {
    const html = `<!DOCTYPE html><html lang="en">${head}<body>
<div class="auth-wrap">
  <aside class="auth-brand">
    <a class="brand" href="/login">
      <img src="/assets/logo-icon.png" alt="FlossByte" width="27" height="40">
      <span><span class="brand-name">FlossByte</span><br><span class="brand-sub">Client Portal</span></span>
    </a>
    <div><h2>Your practice, in one place.</h2>
    <p>Equipment, support tickets, documents, and billing for your office, kept current by FlossByte.</p></div>
    <div class="auth-brand-foot">Questions? Call <a href="tel:+16692372264">(669) 237-2264</a><br>
    or email <a href="mailto:hello@flossbyte.com">hello@flossbyte.com</a></div>
  </aside>
  <div class="auth-main"><div class="auth-box">
${alerts}
${body}
  </div></div>
</div>
</body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  const initials = user ? user.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() : "";
  const nav = user
    ? `${user.kind === "flossbyte" ? `<a href="/admin">Clients</a>` : `<a href="/app">My Portal</a>`}
       <a href="https://flossbyte.com/remote" target="_blank" rel="noopener">Remote Support</a>
       <details class="acct"><summary><span class="avatar">${esc(initials)}</span><span class="acct-name">${esc(user.name.split(" ")[0])}</span></summary>
       <div class="acct-menu"><div class="acct-head"><strong>${esc(user.name)}</strong><span>${esc(user.email)}</span></div>
       <a href="/mfa">Security</a><a href="/logout">Sign out</a></div></details>`
    : `<a href="/login">Sign in</a><a href="/signup">Create account</a>
       <a href="https://flossbyte.com/remote" target="_blank" rel="noopener">Remote Support</a>`;
  // Signed-in pages get a one-line footer; the full marketing footer only
  // remains on the rare signed-out, non-auth page.
  const footer = user
    ? `<footer class="slim"><div class="footer-slim-in"><span>© ${new Date().getFullYear()} FlossByte</span><span>·</span><a href="tel:+16692372264">(669) 237-2264</a><span>·</span><a href="mailto:hello@flossbyte.com">hello@flossbyte.com</a></div></footer>`
    : `<footer class="site"><div class="footer-in">
  <div>
    <a class="brand" href="https://flossbyte.com">
      <img src="/assets/logo-icon.png" alt="FlossByte" width="27" height="40">
      <span class="brand-name">FlossByte</span></a>
    <p style="max-width:420px;font-size:14px">Managed IT services built exclusively for dental practices across the Peninsula, East Bay, and South Bay.</p>
  </div>
  <div style="font-size:14px">
    <p><strong style="color:#fff">Contact</strong></p>
    <p>Phone: <a href="tel:+16692372264">(669) 237-2264</a></p>
    <p>Email: <a href="mailto:hello@flossbyte.com">hello@flossbyte.com</a></p>
    <p><a href="https://flossbyte.com">flossbyte.com</a></p>
  </div>
</div></footer>`;
  const html = `<!DOCTYPE html><html lang="en">${head}<body>
<header class="site"><div class="header-in">
  <a class="brand" href="/">
    <img src="/assets/logo-icon.png" alt="FlossByte" width="27" height="40">
    <span><span class="brand-name">FlossByte</span><br><span class="brand-sub">Client Portal</span></span>
  </a>
  <nav class="top">${nav}</nav>
</div></header>
<main>
${alerts}
${body}
</main>
${footer}
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// Re-issue a rendered page with a different HTTP status (refusals should
// not report 200).
export function withStatus(res, status) {
  return new Response(res.body, { status, headers: res.headers });
}

// Styled error page in the normal app shell (replaces bare-text errors).
export function errorPage({ title, message, user }) {
  const home = user ? (user.kind === "flossbyte" ? "/admin" : "/app") : "/login";
  return page({ title, user, body: `<div class="card narrow"><h1>${esc(title)}</h1>
    <p class="muted">${esc(message)}</p>
    <p style="margin-top:16px"><a class="btn secondary" href="${home}">Go back</a></p></div>` });
}

export function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...extraHeaders } });
}
