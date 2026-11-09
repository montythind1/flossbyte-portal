-- Customer date proposals for One-Time Projects (2026-11-09).
--
-- Record only: the Worker adds these columns idempotently at
-- runtime (ensureProjectSchema in src/projects.js, called on every
-- signed-in request), following the ensureGeniusProduct precedent,
-- so no manual D1 step is required. This file documents the shape.
--
-- A proposal is a suggestion, never a booking: up to three dates
-- the office would like (JSON array of YYYY-MM-DD strings), a
-- free-text note, and who sent them with when. The confirmed date
-- stays in projects.scheduled_date, which only FlossByte sets.
ALTER TABLE projects ADD COLUMN proposed_dates TEXT;
ALTER TABLE projects ADD COLUMN proposed_note TEXT;
ALTER TABLE projects ADD COLUMN proposed_by TEXT;
ALTER TABLE projects ADD COLUMN proposed_at TEXT;
