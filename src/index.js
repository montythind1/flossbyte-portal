// FlossByte Customer Portal, single Worker entry point.
// Server-rendered pages plus a document download route. All customer data
// access is scoped server-side by the signed-in user's user_access rows.
import { resolveSession } from "./auth.js";
import { redirect } from "./layout.js";
import * as pub from "./pages-public.js";
import * as client from "./pages-client.js";
import * as admin from "./pages-admin.js";

function notFound() { return new Response("Not found", { status: 404 }); }

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error("portal error", err && err.stack || err);
      return new Response("Something went wrong on our side. Please try again.", { status: 500 });
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const db = env.DB;
  if (!db) return new Response("Database is not configured yet.", { status: 503 });

  const user = await resolveSession(db, request);

  // ----- Public -----
  if (path === "/") {
    if (!user) return (await pub.setupLocked(db)) ? redirect("/login") : redirect("/setup");
    return redirect(user.kind === "flossbyte" ? "/admin" : "/app");
  }
  if (path === "/setup" && method === "GET") return pub.setupPage(env, request);
  if (path === "/setup" && method === "POST") return pub.setupPost(env, request);
  if (path === "/login" && method === "GET") return user ? redirect(user.kind === "flossbyte" ? "/admin" : "/app") : pub.loginPage(request);
  if (path === "/login" && method === "POST") return pub.loginPost(env, request);
  if (path === "/login/mfa" && method === "GET") return pub.loginMfaPage(request);
  if (path === "/login/mfa" && method === "POST") return pub.loginMfaPost(env, request);
  if (path === "/logout") return pub.logoutGet(env, request);
  if (path === "/signup" && method === "GET") return pub.signupPage(request);
  if (path === "/signup" && method === "POST") return pub.signupPost(env, request);
  if (path === "/reset" && method === "GET") return pub.resetRequestPage(request);
  if (path === "/reset" && method === "POST") return pub.resetRequestPost(env, request);
  if (path === "/invite/resend" && method === "POST") return pub.inviteResendPost(env, request);
  let m = path.match(/^\/invite\/([A-Za-z0-9_-]+)$/);
  if (m && method === "GET") return pub.invitePage(env, request, m[1]);
  if (m && method === "POST") return pub.invitePost(env, request, m[1]);
  m = path.match(/^\/reset\/([A-Za-z0-9_-]+)$/);
  if (m && method === "GET") return pub.resetPage(env, request, m[1]);
  if (m && method === "POST") return pub.resetPost(env, request, m[1]);

  // ----- Signed-in account -----
  if (!user) return redirect("/login");
  if (path === "/mfa" && method === "GET") return pub.mfaPage(env, request, user);
  if (path === "/mfa/verify" && method === "POST") return pub.mfaVerifyPost(env, request, user);
  if (path === "/mfa/skip" && method === "POST") return pub.mfaSkipPost(env, request, user);

  // FlossByte admins must finish MFA enrollment before the console.
  const needsMfa = user.kind === "flossbyte" && !user.mfa_enabled;

  // ----- Admin console -----
  if (path.startsWith("/admin")) {
    if (user.kind !== "flossbyte") return new Response("Forbidden", { status: 403 });
    if (needsMfa) return redirect("/mfa");
    if (path === "/admin" && method === "GET") return admin.clientsPage(env, request, user);
    if (path === "/admin/customers/new" && method === "GET") return admin.newCustomerPage(env, request, user);
    if (path === "/admin/customers/check-email" && method === "GET") return admin.checkCustomerEmail(env, request);
    if (path === "/admin/customers" && method === "POST") return admin.createCustomerPost(env, request, user);
    if (path === "/admin/pending" && method === "GET") return admin.pendingPage(env, request, user);
    if (path === "/admin/admins" && method === "GET") return admin.adminsPage(env, request, user);
    if (path === "/admin/admins" && method === "POST") return admin.createAdminPost(env, request, user);
    m = path.match(/^\/admin\/transfer\/(\d+)$/);
    if (m && method === "GET") return admin.transferPage(env, request, user, Number(m[1]));
    if (m && method === "POST") return admin.transferPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)$/);
    if (m && method === "GET") return admin.customerPage(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/edit$/);
    if (m && method === "POST") return admin.updateCustomerPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/locations$/);
    if (m && method === "POST") return admin.addLocationPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/products$/);
    if (m && method === "POST") return admin.productTogglePost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/users$/);
    if (m && method === "POST") return admin.inviteCustomerUserPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/locations\/(\d+)\/edit$/);
    if (m && method === "POST") return admin.editLocationPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/pending\/(\d+)\/connect$/);
    if (m && method === "POST") return admin.pendingConnectPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/admins\/(\d+)\/(disable|enable|remove|resend)$/);
    if (m && method === "POST") return admin.adminActionPost(env, request, user, Number(m[1]), m[2]);
    m = path.match(/^\/admin\/customers\/(\d+)\/users\/(\d+)\/resend$/);
    if (m && method === "POST") return admin.customerUserResendPost(env, request, user, Number(m[1]), Number(m[2]));
    return notFound();
  }

  // ----- Client portal -----
  // Customers are offered MFA (QR code, with a skip) until they enable it
  // or dismiss the offer; the dismissal is stored on their account.
  if (user.kind === "customer" && !user.mfa_enabled && !user.mfa_prompt_dismissed) {
    return redirect("/mfa");
  }
  if (path === "/app" && method === "GET") return client.appHome(env, request, user);
  if (path === "/app/team" && method === "GET") return client.teamPage(env, request, user);
  m = path.match(/^\/app\/team\/(\d+)\/remove$/);
  if (m && method === "GET") return client.teamRemoveConfirmPage(env, request, user, Number(m[1]));
  if (m && method === "POST") return client.teamRemovePost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/documents\/(\d+)\/view$/);
  if (m && method === "GET") return client.documentView(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)$/);
  if (m && method === "GET") return client.locationOverview(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/products\/([a-z_]+)$/);
  if (m && method === "GET") return client.productPage(env, request, user, Number(m[1]), m[2]);
  m = path.match(/^\/app\/locations\/(\d+)\/equipment$/);
  if (m && method === "GET") return client.equipmentPage(env, request, user, Number(m[1]));
  if (m && method === "POST") return client.equipmentPost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/tickets$/);
  if (m && method === "GET") return client.ticketsPage(env, request, user, Number(m[1]));
  if (m && method === "POST") return client.ticketCreatePost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/tickets\/(\d+)$/);
  if (m && method === "GET") return client.ticketDetailPage(env, request, user, Number(m[1]), Number(m[2]));
  m = path.match(/^\/app\/locations\/(\d+)\/tickets\/(\d+)\/update$/);
  if (m && method === "POST") return client.ticketUpdatePost(env, request, user, Number(m[1]), Number(m[2]));
  m = path.match(/^\/app\/locations\/(\d+)\/tickets\/(\d+)\/status$/);
  if (m && method === "POST") return client.ticketStatusPost(env, request, user, Number(m[1]), Number(m[2]));
  m = path.match(/^\/app\/locations\/(\d+)\/documents$/);
  if (m && method === "GET") return client.documentsPage(env, request, user, Number(m[1]));
  if (m && method === "POST") return client.documentUploadPost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/ask$/);
  if (m && method === "GET") return client.askPage(env, request, user, Number(m[1]));
  if (m && method === "POST") return client.askPost(env, request, user, Number(m[1]));

  return notFound();
}
