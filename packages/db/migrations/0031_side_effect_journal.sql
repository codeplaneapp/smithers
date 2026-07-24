ALTER TABLE _smithers_tool_calls ADD COLUMN kind TEXT;
ALTER TABLE _smithers_tool_calls ADD COLUMN side_effect INTEGER;
ALTER TABLE _smithers_tool_calls ADD COLUMN idempotent INTEGER;
ALTER TABLE _smithers_tool_calls ADD COLUMN accepts_idempotency_key INTEGER;
ALTER TABLE _smithers_tool_calls ADD COLUMN has_revert INTEGER;
ALTER TABLE _smithers_tool_calls ADD COLUMN idempotency_key TEXT;
-- null | reverting | reverted | revert-failed | revert-stale
ALTER TABLE _smithers_tool_calls ADD COLUMN revert_status TEXT;
ALTER TABLE _smithers_tool_calls ADD COLUMN reverted_at_ms INTEGER;
ALTER TABLE _smithers_tool_calls ADD COLUMN revert_error_json TEXT;
ALTER TABLE _smithers_tool_calls ADD COLUMN forced_past_json TEXT;

CREATE TABLE _smithers_tool_call_archive (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  status TEXT NOT NULL,
  error_json TEXT,
  kind TEXT,
  side_effect INTEGER,
  idempotent INTEGER,
  accepts_idempotency_key INTEGER,
  has_revert INTEGER,
  idempotency_key TEXT,
  revert_status TEXT, -- null | reverting | reverted | revert-failed | revert-stale
  reverted_at_ms INTEGER,
  revert_error_json TEXT,
  forced_past_json TEXT,
  archived_by_op TEXT NOT NULL,
  archived_at_ms INTEGER NOT NULL,
  archive_reason TEXT NOT NULL,
  PRIMARY KEY (run_id, node_id, iteration, attempt, seq, archived_by_op)
);
