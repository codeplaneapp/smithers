CREATE TABLE IF NOT EXISTS _smithers_rewind_leases (
  run_id TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
