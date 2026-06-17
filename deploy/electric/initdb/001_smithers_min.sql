-- Minimal smithers schema, just enough for a real Electric shape end-to-end.
-- The full schema is created by the engine elsewhere; this fixture only needs
-- the run + event tables so the proxy's `runs`/`events` shapes have a real
-- table to back them.
--
-- Mounted at /docker-entrypoint-initdb.d so it runs once on first boot.

CREATE TABLE IF NOT EXISTS _smithers_runs (
  run_id        TEXT PRIMARY KEY,
  workflow_name TEXT,
  status        TEXT,
  created_at_ms BIGINT,
  config_json   TEXT
);

CREATE TABLE IF NOT EXISTS _smithers_events (
  run_id       TEXT,
  seq          BIGINT,
  type         TEXT,
  payload_json TEXT,
  PRIMARY KEY (run_id, seq)
);
