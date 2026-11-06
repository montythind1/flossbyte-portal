-- Network snapshots: the UniFi sync stores the latest read of each
-- mapped location's internet health (ISP metrics + WANs), settings
-- (networks, WiFi, firewall, VPN), device statistics and Protect
-- cameras as one JSON payload per kind, refreshed hourly. This is
-- inventory and configuration data only, never patient data.
CREATE TABLE IF NOT EXISTS network_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(location_id, kind)
);
