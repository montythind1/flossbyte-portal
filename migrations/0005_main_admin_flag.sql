-- 0005: each organization has exactly one main customer admin, flagged on
-- their access grant. Set at organization creation from the Customer
-- admin email; the rest of the organization's logins are regular users.
ALTER TABLE user_access ADD COLUMN is_main_admin INTEGER NOT NULL DEFAULT 0;
