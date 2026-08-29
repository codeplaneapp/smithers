CREATE TABLE IF NOT EXISTS memory_facts (
  namespace_kind TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  ttl_ms INTEGER,
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (namespace_kind, namespace_id, fact_key),
  CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
  CHECK (length(namespace_id) > 0),
  CHECK (length(fact_key) > 0),
  CHECK (ttl_ms IS NULL OR ttl_ms >= 0)
);

CREATE INDEX IF NOT EXISTS memory_facts_expiry_idx
  ON memory_facts (updated_at_ms, ttl_ms) WHERE ttl_ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_threads (
  thread_id TEXT PRIMARY KEY CHECK (length(thread_id) > 0),
  namespace_kind TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  title TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
  CHECK (length(namespace_id) > 0)
);

CREATE TABLE IF NOT EXISTS memory_messages (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES memory_threads (thread_id)
);

CREATE INDEX IF NOT EXISTS memory_messages_thread_order_idx
  ON memory_messages (thread_id, at_ms, id);

CREATE TABLE IF NOT EXISTS memory_notes (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  namespace_kind TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  text TEXT NOT NULL,
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at_ms INTEGER NOT NULL,
  CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
  CHECK (length(namespace_id) > 0),
  CHECK (status IN ('pending', 'accepted', 'rejected'))
);

CREATE INDEX IF NOT EXISTS memory_notes_namespace_order_idx
  ON memory_notes (namespace_kind, namespace_id, created_at_ms, id);

CREATE TABLE IF NOT EXISTS memory_note_supersedes (
  superseder_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (superseder_id, target_id),
  FOREIGN KEY (superseder_id) REFERENCES memory_notes (id),
  FOREIGN KEY (target_id) REFERENCES memory_notes (id),
  CHECK (superseder_id <> target_id)
);
