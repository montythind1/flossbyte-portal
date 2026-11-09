-- One-Time Project flow (2026-11-09).
--
-- Record only: the Worker creates this storage idempotently at
-- runtime (ensureProjectSchema in src/projects.js, called on every
-- signed-in request), following the ensureGeniusProduct precedent, so
-- no manual D1 step is required. This file documents the shape.
--
-- One project per location, bound to the location's project quote
-- (quotes are organization-level; projects.quote_id records the
-- resolution). Manual stage fields (scheduled_date, in_progress_at,
-- work_complete_date) sit next to the derived ones; the support
-- window is work_complete_date + support_days.
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  location_id INTEGER NOT NULL UNIQUE REFERENCES locations(id),
  quote_id INTEGER REFERENCES quotes(id),
  name TEXT,
  scheduled_date TEXT,
  in_progress_at TEXT,
  work_complete_date TEXT,
  support_days INTEGER NOT NULL DEFAULT 30,
  finished INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects (customer_id);

-- One Statement of Work (PDF) per quote, stored in R2; accepting the
-- quote accepts the SOW with it, recorded on the quote.
ALTER TABLE quotes ADD COLUMN sow_r2_key TEXT;
ALTER TABLE quotes ADD COLUMN sow_name TEXT;
ALTER TABLE quotes ADD COLUMN sow_mime TEXT;
ALTER TABLE quotes ADD COLUMN sow_size INTEGER;
ALTER TABLE quotes ADD COLUMN sow_accepted_at TEXT;
ALTER TABLE quotes ADD COLUMN sow_accepted_by TEXT;
