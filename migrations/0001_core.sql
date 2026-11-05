-- FlossByte Customer Portal, core schema (0001)
-- Standard SQL only (SQLite dialect for D1). No vendor-specific logic in
-- application rules, so a later move to another SQL store stays cheap.
-- Isolation rule: customer data is reachable only through user_access.

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  phone TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  phone TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_locations_customer ON locations(customer_id);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  kind TEXT NOT NULL DEFAULT 'customer' CHECK (kind IN ('flossbyte','customer')),
  role TEXT NOT NULL DEFAULT 'customer_user'
    CHECK (role IN ('super_admin','admin','customer_admin','customer_user')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('invited','active','disabled','pending')),
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_secret TEXT,
  email_verified_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_kind ON users(kind);

-- The only bridge between a customer login and customer data.
-- location_id NULL means every location belonging to that customer.
CREATE TABLE IF NOT EXISTS user_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  location_id INTEGER REFERENCES locations(id),
  scope TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, customer_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_user_access_user ON user_access(user_id);
CREATE INDEX IF NOT EXISTS idx_user_access_customer ON user_access(customer_id);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Invite, password reset, and MFA login challenges. Only hashes are stored.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('invite','reset','mfa')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);

CREATE TABLE IF NOT EXISTS products (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT
);
INSERT OR IGNORE INTO products (key, name, description) VALUES
  ('managed_it', 'Managed IT Support', 'Equipment, tickets, and remote support for this practice.'),
  ('flossverify', 'FlossVerify', 'Insurance eligibility verification by FlossByte.'),
  ('hipaa_security', 'HIPAA & Security', 'HIPAA and security services for this practice.'),
  ('voip', 'VoIP', 'Phone service managed by FlossByte.'),
  ('one_time_project', 'One-Time Project', 'A scoped project engagement with FlossByte.');

-- Product on/off state. location_id NULL is the customer-wide default;
-- a location row overrides it for that location.
CREATE TABLE IF NOT EXISTS customer_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  location_id INTEGER REFERENCES locations(id),
  product TEXT NOT NULL REFERENCES products(key),
  enabled INTEGER NOT NULL DEFAULT 0,
  plan_note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (customer_id, location_id, product)
);
CREATE INDEX IF NOT EXISTS idx_customer_products_customer ON customer_products(customer_id);

CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  vendor TEXT,
  type TEXT,
  model TEXT,
  serial TEXT,
  status TEXT NOT NULL DEFAULT 'online',
  firmware TEXT,
  warranty_expires TEXT,
  license_expires TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_equipment_location ON equipment(location_id);
CREATE INDEX IF NOT EXISTS idx_equipment_license ON equipment(license_expires);
CREATE INDEX IF NOT EXISTS idx_equipment_warranty ON equipment(warranty_expires);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting','closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_location ON tickets(location_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

CREATE TABLE IF NOT EXISTS ticket_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  author_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_updates_ticket ON ticket_updates(ticket_id);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  r2_key TEXT,
  mime TEXT,
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_location ON documents(location_id);

CREATE TABLE IF NOT EXISTS ask_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  user_id INTEGER REFERENCES users(id),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ask_location ON ask_messages(location_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  template TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at);
