-- Durable completion-order provenance is created by the dialect-aware
-- migration runner and backfilled from existing output rows.
CREATE TABLE IF NOT EXISTS _smithers_output_provenance (
  run_id TEXT NOT NULL,
  output_table TEXT NOT NULL,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (run_id, output_table, node_id, iteration),
  UNIQUE (run_id, seq)
);
