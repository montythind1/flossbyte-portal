-- FlossByte Customer Portal, identity rules (0002)
-- Database backstops for the 2026-11-05 identity decisions. The app checks
-- first and shows friendly errors (src/access.js); these constraints are
-- the last line, so no code path, present or future, can create the
-- forbidden states.

-- 1. Customer contact email is a hard identity. One customer per contact
--    email, compared case-insensitively and trimmed. Customer NAME may
--    repeat freely, so no constraint touches name. Customers with no
--    usable contact email are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_contact_email
  ON customers (LOWER(TRIM(contact_email)))
  WHERE contact_email IS NOT NULL AND TRIM(contact_email) <> '';

-- 2. One user, one organization: a user may hold user_access rows under
--    exactly one customer. Abort any insert that would add a second one.
--    Removing all of a user's rows first and then inserting under the new
--    customer stays allowed: that is the only legitimate cross-org move.
CREATE TRIGGER IF NOT EXISTS trg_user_access_one_org_insert
BEFORE INSERT ON user_access
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM user_access
  WHERE user_id = NEW.user_id AND customer_id <> NEW.customer_id
)
BEGIN
  SELECT RAISE(ABORT, 'user_access: user already belongs to a different customer');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_access_one_org_update
BEFORE UPDATE OF user_id, customer_id ON user_access
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM user_access
  WHERE user_id = NEW.user_id AND customer_id <> NEW.customer_id AND id <> NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'user_access: user already belongs to a different customer');
END;
