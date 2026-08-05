CREATE TABLE IF NOT EXISTS _smithers_agent_processes (
  pid INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT,
  engine_pid INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  PRIMARY KEY (pid)
);
