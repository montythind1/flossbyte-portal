-- Journey pack core: quotes a customer can accept in the portal, and
-- invoices (deposit, final, standalone). Money is integer cents; totals
-- are always computed from quote_items on the server, never posted.
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'project',
  status TEXT NOT NULL DEFAULT 'draft',
  deposit_percent INTEGER NOT NULL DEFAULT 0,
  terms TEXT,
  created_by INTEGER,
  sent_at TEXT,
  accepted_at TEXT,
  accepted_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS quote_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  quote_id INTEGER REFERENCES quotes(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'standard',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid',
  due_date TEXT,
  pay_url TEXT,
  paid_at TEXT,
  paid_method TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes (customer_id, status);
CREATE INDEX IF NOT EXISTS idx_quote_items_quote ON quote_items (quote_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id, status);
