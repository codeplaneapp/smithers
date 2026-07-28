CREATE TABLE IF NOT EXISTS _smithers_agent_checkpoint_contents (
  content_hash TEXT PRIMARY KEY,
  checkpoint_json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS _smithers_agent_checkpoints (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  codec TEXT NOT NULL,
  version INTEGER NOT NULL,
  agent_id TEXT,
  purpose TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, node_id, iteration, attempt, sequence),
  FOREIGN KEY (run_id, node_id, iteration, attempt)
    REFERENCES _smithers_attempts(run_id, node_id, iteration, attempt) ON DELETE CASCADE,
  FOREIGN KEY (content_hash) REFERENCES _smithers_agent_checkpoint_contents(content_hash)
);

CREATE INDEX IF NOT EXISTS _smithers_agent_checkpoints_content_hash_idx
  ON _smithers_agent_checkpoints (content_hash);

CREATE TRIGGER IF NOT EXISTS _smithers_agent_checkpoints_attempt_delete
AFTER DELETE ON _smithers_attempts
BEGIN
  DELETE FROM _smithers_agent_checkpoints
  WHERE run_id = OLD.run_id
    AND node_id = OLD.node_id
    AND iteration = OLD.iteration
    AND attempt = OLD.attempt;
END;

CREATE TRIGGER IF NOT EXISTS _smithers_agent_checkpoint_refs_delete
AFTER DELETE ON _smithers_agent_checkpoints
BEGIN
  DELETE FROM _smithers_agent_checkpoint_contents
  WHERE content_hash = OLD.content_hash
    AND NOT EXISTS (
      SELECT 1 FROM _smithers_agent_checkpoints refs
      WHERE refs.content_hash = OLD.content_hash
    );
END;
