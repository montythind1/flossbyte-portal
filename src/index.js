// FlossByte Customer Portal, single Worker entry point.
// Server-rendered pages plus a document download route. All customer data
// access is scoped server-side by the signed-in user's user_access rows.
import { resolveSession } from "./auth.js";
import { redirect, errorPage } from "./layout.js";
import * as pub from "./pages-public.js";
import * as client from "./pages-client.js";
import { collectorReport } from "./collector.js";
import * as admin from "./pages-admin.js";
import * as places from "./places.js";
import { runUnifiSync } from "./unifi.js";
import { runSophosSync } from "./sophos.js";
import { runAteraSync } from "./atera.js";

function notFound(user) {
  const res = errorPage({ title: "Not found", message: "That page does not exist.", user });
  return new Response(res.body, { status: 404, headers: res.headers });
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error("portal error", err && err.stack || err);
      return new Response("Something went wrong on our side. Please try again.", { status: 500 });
    }
  },
  // Hourly device sync (cron in wrangler.toml). Each sync records its own
  // outcome for the Device sync page and never throws past this handler.
  async scheduled(event, env, ctx) {
    const jobs = [runUnifiSync(env), runSophosSync(env), runAteraSync(env)];
    // Monthly Office IT report on the 1st; the sender itself records
    // the month marker, so extra hourly runs in between are no-ops.
    if (new Date().getUTCDate() === 1) jobs.push(admin.sendMonthlyReports(env, false));
    ctx.waitUntil(Promise.allSettled(jobs));
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
  if (path === "/signup") return redirect("/login");
  if (path === "/reset" && method === "GET") return pub.resetRequestPage(request);
  if (path === "/reset" && method === "POST") return pub.resetRequestPost(env, request);
  if (path === "/invite/resend" && method === "POST") return pub.inviteResendPost(env, request);
  if (path === "/api/collector/report" && method === "POST") return collectorReport(env, request);
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
  if (path === "/mfa/password" && method === "POST") return pub.passwordChangePost(env, request, user);
  if (path === "/mfa/profile" && method === "POST") return pub.profilePost(env, request, user);
  if (path === "/mfa/disable" && method === "POST") return pub.mfaDisablePost(env, request, user);
  if (path === "/mfa/signout-others" && method === "POST") return pub.signoutOthersPost(env, request, user);

  // FlossByte admins must finish MFA enrollment before the console.
  const needsMfa = user.kind === "flossbyte" && !user.mfa_enabled;

  // ----- Admin console -----
  if (path.startsWith("/admin")) {
    if (user.kind !== "flossbyte") return new Response("Forbidden", { status: 403 });
    if (needsMfa) return redirect("/mfa");
    if (path === "/admin" && method === "GET") return admin.clientsPage(env, request, user);
    if (path === "/admin/customers/new" && method === "GET") return admin.newCustomerPage(env, request, user);
    if (path === "/admin/customers/check-email" && method === "GET") return admin.checkCustomerEmail(env, request);
    if (path === "/admin/places/autocomplete" && method === "GET") return places.placesAutocomplete(env, request);
    if (path === "/admin/places/details" && method === "GET") return places.placesDetails(env, request);
    if (path === "/admin/customers" && method === "POST") return admin.createCustomerPost(env, request, user);
    if (path === "/admin/admins" && method === "GET") return admin.adminsPage(env, request, user);
    if (path === "/admin/admins" && method === "POST") return admin.createAdminPost(env, request, user);
    if (path === "/admin/tickets" && method === "GET") return admin.ticketsInboxPage(env, request, user);
    if (path === "/admin/chats" && method === "GET") return admin.chatsPage(env, request, user);
    m = path.match(/^\/admin\/chats\/(\d+)$/);
    if (m && method === "GET") return admin.chatThreadPage(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/chats\/(\d+)\/poll$/);
    if (m && method === "GET") return admin.chatAdminPoll(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/chats\/(\d+)\/take$/);
    if (m && method === "POST") return admin.chatTakePost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/chats\/(\d+)\/api$/);
    if (m && method === "POST") return admin.chatAdminApiPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/chats\/(\d+)\/message$/);
    if (m && method === "POST") return admin.chatAdminMessagePost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/chats\/(\d+)\/end$/);
    if (m && method === "POST") return admin.chatAdminEndPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/chats\/(\d+)\/ticket$/);
    if (m && method === "POST") return admin.chatTicketPost(env, request, user, Number(m[1]));
    if (path === "/admin/activity" && method === "GET") return admin.activityPage(env, request, user);
    if (path === "/admin/sync" && method === "GET") return admin.syncPage(env, request, user);
    if (path === "/admin/sync/map" && method === "POST") return admin.syncMapPost(env, request, user);
    if (path === "/admin/sync/run" && method === "POST") return admin.syncRunPost(env, request, user);
    if (path === "/admin/sync/run-sophos" && method === "POST") return admin.syncRunSophosPost(env, request, user);
    if (path === "/admin/sync/run-atera" && method === "POST") return admin.syncRunAteraPost(env, request, user);
    if (path === "/admin/sync/merge" && method === "POST") return admin.syncMergePost(env, request, user);
    if (path === "/admin/sync/dup-dismiss" && method === "POST") return admin.syncDupDismissPost(env, request, user);
    if (path === "/admin/sync/mute" && method === "POST") return admin.syncMutePost(env, request, user);
    if (path === "/admin/sync/report" && method === "POST") return admin.syncReportPost(env, request, user);
    m = path.match(/^\/admin\/transfer\/(\d+)$/);
    if (m && method === "GET") return admin.transferPage(env, request, user, Number(m[1]));
    if (m && method === "POST") return admin.transferPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)$/);
    if (m && method === "GET") return admin.customerPage(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/locations\/new$/);
    if (m && method === "GET") return admin.addLocationPage(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/users\/new$/);
    if (m && method === "GET") return admin.addUserPage(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/edit$/);
    if (m && method === "POST") return admin.updateCustomerPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/delete$/);
    if (m && method === "GET") return admin.deleteCustomerPage(env, request, user, Number(m[1]));
    if (m && method === "POST") return admin.deleteCustomerPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/locations$/);
    if (m && method === "POST") return admin.addLocationPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/products$/);
    if (m && method === "POST") return admin.productTogglePost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/users$/);
    if (m && method === "POST") return admin.inviteCustomerUserPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/locations\/(\d+)\/edit$/);
    if (m && method === "POST") return admin.editLocationPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/admins\/(\d+)\/(disable|enable|remove|resend)$/);
    if (m && method === "POST") return admin.adminActionPost(env, request, user, Number(m[1]), m[2]);
    m = path.match(/^\/admin\/customers\/(\d+)\/users\/(\d+)\/resend$/);
    if (m && method === "POST") return admin.customerUserResendPost(env, request, user, Number(m[1]), Number(m[2]));
    m = path.match(/^\/admin\/customers\/(\d+)\/users\/(\d+)\/edit$/);
    if (m && method === "GET") return admin.userEditPage(env, request, user, Number(m[1]), Number(m[2]));
    if (m && method === "POST") return admin.userEditPost(env, request, user, Number(m[1]), Number(m[2]));
    m = path.match(/^\/admin\/customers\/(\d+)\/checklist-dismiss$/);
    if (m && method === "POST") return admin.checklistDismissPost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/quotes$/);
    if (m && method === "POST") return admin.quoteCreatePost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/quotes\/(\d+)\/(send|delete|final)$/);
    if (m && method === "POST") return admin.quoteActionPost(env, request, user, Number(m[1]), Number(m[2]), m[3]);
    m = path.match(/^\/admin\/customers\/(\d+)\/invoices$/);
    if (m && method === "POST") return admin.invoiceCreatePost(env, request, user, Number(m[1]));
    m = path.match(/^\/admin\/customers\/(\d+)\/invoices\/(\d+)\/(paid|void)$/);
    if (m && method === "POST") return admin.invoiceActionPost(env, request, user, Number(m[1]), Number(m[2]), m[3]);
    return notFound(user);
  }

  // ----- Client portal -----
  // Customers are offered MFA (QR code, with a skip) until they enable it
  // or dismiss the offer; the dismissal is stored on their account.
  // A customer who has not been connected to any organization yet skips
  // the detour: they land on the "waiting to be connected" page first
  // and get the MFA offer once they actually have something to protect.
  if (user.kind === "customer" && !user.mfa_enabled && !user.mfa_prompt_dismissed) {
    const access = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_access WHERE user_id = ?").bind(user.id).first();
    if (access && access.n > 0) return redirect("/mfa");
  }
  if (path === "/app" && method === "GET") return client.appHome(env, request, user);
  if (path === "/app/team" && method === "GET") return client.teamPage(env, request, user);
  if (path === "/app/services" && method === "GET") return client.servicesPage(env, request, user);
  if (path === "/app/billing" && method === "GET") return client.billingPage(env, request, user);
  if (path === "/app/evidence" && method === "GET") return client.evidencePage(env, request, user);
  if (path === "/app/quotes" && method === "GET") return redirect("/app/billing");
  if (path === "/app/invoices" && method === "GET") return redirect("/app/billing");
  m = path.match(/^\/app\/invoices\/(\d+)$/);
  if (m && method === "GET") return client.invoiceViewPage(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/quotes\/(\d+)$/);
  if (m && method === "GET") return client.quoteViewPage(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/quotes\/(\d+)\/accept$/);
  if (m && method === "POST") return client.quoteAcceptPost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/quotes\/(\d+)\/decline$/);
  if (m && method === "POST") return client.quoteDeclinePost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/team\/(\d+)\/remove$/);
  if (m && method === "GET") return client.teamRemoveConfirmPage(env, request, user, Number(m[1]));
  if (m && method === "POST") return client.teamRemovePost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/team\/(\d+)\/edit$/);
  if (m && method === "GET") return client.teamEditPage(env, request, user, Number(m[1]));
  if (m && method === "POST") return client.teamEditPost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/documents\/(\d+)\/view$/);
  if (m && method === "GET") return client.documentView(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)$/);
  if (m && method === "GET") return client.locationOverview(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/products\/([a-z_]+)$/);
  if (m && method === "GET") return client.productPage(env, request, user, Number(m[1]), m[2]);
  m = path.match(/^\/app\/locations\/(\d+)\/equipment$/);
  if (m && method === "GET") return client.equipmentPage(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/equipment\/print$/);
  if (m && method === "GET") return client.equipmentPrintPage(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/equipment\.csv$/);
  if (m && method === "GET") return client.equipmentCsv(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/equipment\/(\d+)$/);
  if (m && method === "GET") return client.equipmentDetailPage(env, request, user, Number(m[1]), Number(m[2]));
  m = path.match(/^\/app\/locations\/(\d+)\/topology$/);
  if (m && method === "GET") return client.topologyPage(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/network$/);
  if (m && method === "GET") return client.networkPage(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/wifi$/);
  if (m && method === "POST") return client.wifiAddPost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/wifi\/delete$/);
  if (m && method === "POST") return client.wifiDeletePost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/isp-service$/);
  if (m && method === "POST") return client.ispServicePost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/backup$/);
  if (m && method === "POST") return client.backupPost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/backup\/token$/);
  if (m && method === "POST") return client.backupTokenPost(env, request, user, Number(m[1]));
  if (m && method === "POST") return client.equipmentPost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/equipment\/(\d+)\/edit$/);
  if (m && method === "GET") return client.equipmentEditPage(env, request, user, Number(m[1]), Number(m[2]));
  if (m && method === "POST") return client.equipmentEditPost(env, request, user, Number(m[1]), Number(m[2]));
  m = path.match(/^\/app\/locations\/(\d+)\/equipment\/(\d+)\/delete$/);
  if (m && method === "POST") return client.equipmentDeletePost(env, request, user, Number(m[1]), Number(m[2]));
  m = path.match(/^\/app\/locations\/(\d+)\/request-product$/);
  if (m && method === "POST") return client.productRequestPost(env, request, user, Number(m[1]));
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
  m = path.match(/^\/app\/locations\/(\d+)\/ask\/escalate$/);
  if (m && method === "POST") return client.askEscalatePost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/chat\/start$/);
  if (m && method === "POST") return client.chatStartPost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/chat\/message$/);
  if (m && method === "POST") return client.chatMessagePost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/chat\/api$/);
  if (m && method === "POST") return client.chatApiPost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/ask\/api$/);
  if (m && method === "POST") return client.askApiPost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/chat\/end$/);
  if (m && method === "POST") return client.chatEndPost(env, request, user, Number(m[1]));
  m = path.match(/^\/app\/locations\/(\d+)\/chat\/poll$/);
  if (m && method === "GET") return client.chatPoll(env, request, user, Number(m[1]));

  return notFound(user);
}
