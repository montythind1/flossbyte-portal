-- Quote document attachment (2026-11-09).
--
-- Record only: the Worker adds these columns idempotently at runtime
-- (ensureProjectSchema in src/projects.js, alongside the SOW columns
-- from 0015), so no manual D1 step is required. This file documents
-- the shape.
--
-- One quote document (PDF) per quote, stored in R2: the PDF of the
-- quote itself (for example exported from Xero), attached alongside
-- the Statement of Work. The portal quote's own line items stay the
-- record the tracker and the money math read; accepting the quote
-- accepts the quote document with it, recorded on the quote, and the
-- PDF files into the office's Documents on acceptance.
ALTER TABLE quotes ADD COLUMN qdoc_r2_key TEXT;
ALTER TABLE quotes ADD COLUMN qdoc_name TEXT;
ALTER TABLE quotes ADD COLUMN qdoc_mime TEXT;
ALTER TABLE quotes ADD COLUMN qdoc_size INTEGER;
ALTER TABLE quotes ADD COLUMN qdoc_accepted_at TEXT;
ALTER TABLE quotes ADD COLUMN qdoc_accepted_by TEXT;
