// Shared page chrome: FlossByte branding matched to flossbyte.com.
// Navy #0A1628, teal #00BFA5 (hover #00D4B8), Plus Jakarta Sans headings,
// Inter body, 72px navy header, navy footer.

export function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
`;

export function page({ title, user, body, flash, error }) {
  const nav = user
    ? `${user.kind === "flossbyte" ? `<a href="/admin">Clients</a>` : `<a href="/app">My Portal</a>`}
       <a href="/mfa">Security</a>
       <a href="https://flossbyte.com/remote" target="_blank" rel="noopener">Remote Support</a>
       <a href="/logout">Sign out (${esc(user.name.split(" ")[0])})</a>`
    : `<a href="/login">Sign in</a><a href="/signup">Create account</a>
       <a href="https://flossbyte.com/remote" target="_blank" rel="noopener">Remote Support</a>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | FlossByte Portal</title>
<link rel="icon" href="/assets/logo-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header class="site"><div class="header-in">
  <a class="brand" href="/">
    <img src="/assets/logo-icon.png" alt="FlossByte" width="27" height="40">
    <span><span class="brand-name">FlossByte</span><br><span class="brand-sub">Client Portal</span></span>
  </a>
  <nav class="top">${nav}</nav>
</div></header>
<main>
${error ? `<div class="error">${esc(error)}</div>` : ""}
${flash ? `<div class="notice">${esc(flash)}</div>` : ""}
${body}
</main>
<footer class="site"><div class="footer-in">
  <div>
    <a class="brand" href="https://flossbyte.com">
      <img src="/assets/logo-icon.png" alt="FlossByte" width="27" height="40">
      <span class="brand-name">FlossByte</span></a>
    <p style="max-width:420px;font-size:14px">HIPAA-compliant managed IT services built exclusively for dental practices across the Peninsula, East Bay, and South Bay.</p>
  </div>
  <div style="font-size:14px">
    <p><strong style="color:#fff">Contact</strong></p>
    <p>Phone: <a href="tel:+16692372264">(669) 237-2264</a></p>
    <p>Email: <a href="mailto:hello@flossbyte.com">hello@flossbyte.com</a></p>
    <p><a href="https://flossbyte.com">flossbyte.com</a></p>
  </div>
</div></footer>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...extraHeaders } });
}
