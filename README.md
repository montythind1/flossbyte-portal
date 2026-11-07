# FlossByte Customer Portal

The customer portal for FlossByte, a dental IT support company. Customers sign
in to see their own practice equipment (Sophos, UniFi, SonicWall, and more),
license and warranty expiry dates, support tickets, documents, which FlossByte
products they have, and Genius, an AI assistant that answers only from
their own records. FlossByte runs everything from an admin console with per-customer
product on/off switches.

Runs on Cloudflare Workers with a D1 (SQLite) database and R2 file storage,
on the free tier. No customer data and no PHI belong in this repository, ever.
The portal itself holds no PHI: it tracks IT equipment, tickets, and IT
documents only.

## Structure

- `src/index.js` , router and Worker entry point
- `src/auth.js` , PBKDF2 password hashing, server-side sessions (hashed,
  revocable), one-time invite/reset/MFA tokens (hashed)
- `src/totp.js` , TOTP two-step verification (RFC 6238, WebCrypto HMAC-SHA1)
- `src/access.js` , the isolation helpers every data query goes through
- `src/email.js` , outgoing email (Resend when configured, otherwise logged
  as queued) and the message templates
- `src/layout.js` , shared page chrome in FlossByte branding
- `src/pages-public.js` , setup, login, signup, invite, reset, MFA pages
- `src/pages-client.js` , client views: overview, equipment, tickets,
  documents, product pages, Genius
- `src/genius.js` , the records-only AI layer for Genius (Cloudflare
  Workers AI; exact identifiers and passwords stay on the deterministic
  records path)
- `src/pages-admin.js` , admin console: clients, locations, product switches,
  invites, pending accounts, admin accounts
- `migrations/` , D1 schema migrations, plain standard SQL
- `public/assets/logo-icon.png` , the FlossByte tooth logo used in the header
  and footer (copied from the flossbyte.com website assets)

## How isolation works

Three levels: **customers** (the organization that signs and pays),
**locations** (practices under a customer), and **users** (individual
logins). A customer login reaches data only through rows in `user_access`:
a row naming a location grants that location; a row with no location grants
every location of that customer. Every equipment, ticket, document, and Ask
query is checked against those grants on the server, so one customer can
never see another customer's records, including by guessing a URL.

FlossByte logins (`kind = 'flossbyte'`) see the admin console. The first
login created on the one-time `/setup` screen is the **Super Admin**. Only
the Super Admin can create, disable, or remove other admin accounts; the
Super Admin account itself can never be disabled or removed, and disabling
an admin kills their sessions right away.

Product switches live in `customer_products`. Off is enforced on the
server: the client sees a locked "Not included" tile, and direct requests
for that service's data are refused. Managed IT Support defaults on for new
customers; FlossVerify, HIPAA & Security, VoIP, and One-Time Project
default off.

## Identity rules (hard rules, app and database)

Two identity rules sit on top of isolation and are enforced twice: in the
app first, so people see a plain error, and in the database as a backstop.

- **Customer contact email is unique.** Creating a customer whose contact
  email matches an existing customer's contact email (case-insensitive,
  trimmed) is refused outright. There is no "create anyway" for an email
  match. Customer names may repeat freely and are never blocked.
- **One user, one organization.** A customer login may hold `user_access`
  rows under exactly one customer. Every grant goes through
  `grantUserAccess` in `src/access.js` (FlossByte admin invites,
  pending-account connect, and any future customer-admin user management
  all inherit it), and a grant under a second customer is refused.
  FlossByte logins hold no `user_access` and are unaffected. The only way
  to move a person is to remove all of their access under the old customer
  first, then grant under the new one.

Migration `0002_identity_rules.sql` adds the database backstops: a unique
partial index on the normalized contact email, and triggers on
`user_access` that abort a second-organization insert or update even if a
future code path forgets the app-level check.

## Removing a user who left

A customer admin can remove people from their own organization on the
Team page (`/app/team`, linked from the portal home and location pages).
Removal runs through `removeUserFromCustomer` in `src/access.js`, which
checks on the server that the actor is an admin of that same customer,
that the target belongs to that customer, that nobody removes their own
login, and that the organization's last remaining admin cannot be
removed. Removal deletes the person's access rows for the customer,
disables the login, and revokes their sessions right away; it is written
to the audit log. The user record itself is kept (disabled, not deleted),
so tickets, ticket updates, and documents they created stay on record.

Because removal deletes all of the person's access, the freed email can
later be invited to a different organization: the invite reactivates the
login with only the new organization's access and the role of the new
grant. Nothing from the old organization comes back.

## Local development

```bash
npm install
npx wrangler d1 migrations apply flossbyte-portal --local
npm run dev
```

Open the local URL and complete the one-time `/setup` screen to create the
Super Admin. Copy `.dev.vars.example` to `.dev.vars` if you want real email
locally; without it, outgoing email is recorded in the `email_log` table
with status `queued`.

## Production setup (one time, in the FlossByte Cloudflare account)

```bash
npm install
npx wrangler login
npx wrangler d1 create flossbyte-portal
# paste the returned database_id into wrangler.toml
npx wrangler r2 bucket create flossbyte-portal-docs
npx wrangler d1 migrations apply flossbyte-portal --remote
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM
npx wrangler secret put ADMIN_ALERT_EMAIL
npm run deploy
```

Then point the `portal` DNS record for flossbyte.com at the Worker
(a Worker custom domain for `portal.flossbyte.com` works) and open the
site: the first screen is the one-time Super Admin setup. Do that before
sharing the link with anyone.

Notes:

- Email is optional at launch. With no `RESEND_API_KEY`, invites and reset
  links are logged in `email_log` instead of sent, and nothing crashes;
  add the key later and email starts flowing.
- Backups: D1 Time Travel covers point-in-time restore. Run a scheduled
  `wrangler d1 export` to R2 for an extra copy if you want one.
- Portability is deliberate: standard SQL, no Cloudflare-only logic in the
  business rules, documents behind one storage binding. A later move to
  another host and a Postgres/MySQL database is a data export plus dialect
  tweaks, not a rewrite.

## Not in this version

Quotes, SOW, MSA, invoices, and Stripe payments (the journey pack, planned
next), automatic vendor sync (Sophos Central, UniFi, Atera), and anything
touching patient data. Patient data would need a BAA-covered store and
never belongs in this database.
