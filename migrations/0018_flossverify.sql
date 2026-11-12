-- FlossVerify: insurance verification requests and their breakdowns.
-- One row per patient visit the office asks FlossByte to verify; the
-- breakdown (what the payer actually covers) is filled in by whoever
-- does the checking, by hand today and by an eligibility API later.
-- Test patients are invented people (is_test = 1); real patient data
-- does not belong in this database until it lives somewhere covered
-- by a HIPAA agreement.
CREATE TABLE IF NOT EXISTS fv_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  patient_name TEXT NOT NULL,
  patient_dob TEXT,
  member_id TEXT,
  subscriber_name TEXT,
  subscriber_dob TEXT,
  relationship TEXT,
  carrier TEXT,
  plan_name TEXT,
  group_number TEXT,
  payer_phone TEXT,
  appt_date TEXT NOT NULL,
  appt_time TEXT,
  provider TEXT,
  planned_treatment TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  problem_note TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fv_req_loc ON fv_requests(location_id, appt_date);
CREATE INDEX IF NOT EXISTS idx_fv_req_cust ON fv_requests(customer_id, appt_date);

CREATE TABLE IF NOT EXISTS fv_breakdowns (
  request_id INTEGER PRIMARY KEY,
  coverage_active INTEGER,
  effective_date TEXT,
  termination_date TEXT,
  deductible_cents INTEGER,
  deductible_met_cents INTEGER,
  max_cents INTEGER,
  max_used_cents INTEGER,
  est_patient_cents INTEGER,
  rows_json TEXT,
  verified_by TEXT,
  verified_at TEXT,
  method TEXT,
  payer_ref TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
