-- Device IP addresses and how they are assigned.
-- ip_address: the address the sync reads from UniFi for each device
-- (the equipment table never stored it before this migration).
-- ip_mode: 'dhcp' (automatic) or 'static' (fixed). UniFi's API does
-- not report which one a device uses, so this is set on the equipment
-- record in the portal and shown next to the IP address.
ALTER TABLE equipment ADD COLUMN ip_address TEXT;
ALTER TABLE equipment ADD COLUMN ip_mode TEXT NOT NULL DEFAULT '';
