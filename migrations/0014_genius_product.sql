-- Genius becomes a switchable product (key 'genius'), like the other
-- products. It was available to every office before it had a switch,
-- so existing customers are backfilled ON at the customer level and
-- keep it; the admin toggle controls it from there. Organizations
-- created later get an explicit row from the create-organization
-- wizard, off unless chosen.
--
-- The Worker also performs this catalog insert and backfill lazily
-- (ensureGeniusProduct in src/access.js), so applying this file by
-- hand is a record for fresh installs, not a release step.
INSERT OR IGNORE INTO products (key, name, description) VALUES
  ('genius', 'Genius', 'AI assistant that answers from this practice''s own records.');

INSERT INTO customer_products (customer_id, location_id, product, enabled, plan_note)
SELECT c.id, NULL, 'genius', 1, NULL FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM customer_products cp
  WHERE cp.customer_id = c.id AND cp.location_id IS NULL AND cp.product = 'genius');
