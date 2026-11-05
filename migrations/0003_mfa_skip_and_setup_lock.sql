-- FlossByte Customer Portal, MFA skip + setup lock (0003)
-- Two additions from Montek's 2026-11-05 direction:
-- 1. Customers may skip the MFA offer at sign-in. A per-user flag remembers
--    the dismissal so they are not re-prompted on every login. FlossByte
--    admin accounts never see the skip: their MFA stays mandatory.
-- 2. The one-time setup locks permanently. Once a Super Admin has been
--    created, a marker row records it forever; /setup never reopens, even
--    if every FlossByte user row were deleted directly in the database.

ALTER TABLE users ADD COLUMN mfa_prompt_dismissed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
