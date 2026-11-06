-- Device sync (0007): automatic equipment capture from vendor clouds.
-- Equipment rows gain a friendly name, a MAC address, where the row came
-- from (manual entry vs a sync), the vendor-side device id, and when the
-- device was last seen by a sync. sync_sites maps a vendor site (a UniFi
-- site today, a Sophos tenant later) to exactly one portal location, set
-- by a FlossByte admin on the Device sync page; unmapped sites are
-- discovered and listed but never imported.
ALTER TABLE equipment ADD COLUMN name TEXT;
ALTER TABLE equipment ADD COLUMN mac TEXT;
ALTER TABLE equipment ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE equipment ADD COLUMN external_id TEXT;
ALTER TABLE equipment ADD COLUMN last_seen_at TEXT;
CREATE INDEX IF NOT EXISTS idx_equipment_external ON equipment (source, external_id);
CREATE INDEX IF NOT EXISTS idx_equipment_mac ON equipment (mac);

CREATE TABLE IF NOT EXISTS sync_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  site_id TEXT NOT NULL,
  site_name TEXT,
  location_id INTEGER REFERENCES locations(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, site_id)
);
