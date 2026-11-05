-- 0004: main contact name stored as first / middle / last parts.
-- contact_name stays as the combined display string, written by the app
-- from the parts so existing displays keep working.
ALTER TABLE customers ADD COLUMN contact_first_name TEXT;
ALTER TABLE customers ADD COLUMN contact_middle_name TEXT;
ALTER TABLE customers ADD COLUMN contact_last_name TEXT;
