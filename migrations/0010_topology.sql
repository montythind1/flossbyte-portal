-- Topology: each equipment row can point at the network device it
-- hangs off of, identified by that device's MAC address, so the
-- portal can draw an office's network as a tree (gateway at the top,
-- switches and access points under it, endpoints under those).
ALTER TABLE equipment ADD COLUMN parent_mac TEXT;
