-- Suite / unit number for a location, shown as its own field on every
-- location form (wizard, add location, edit location). Optional: most
-- addresses do not have one. Kept separate from the street address so
-- it can be displayed and edited on its own.
ALTER TABLE locations ADD COLUMN suite TEXT NOT NULL DEFAULT '';
