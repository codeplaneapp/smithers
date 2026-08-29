CREATE TABLE IF NOT EXISTS memory_vectors (
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  namespace_kind TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_bytes BLOB NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (
    namespace_kind, namespace_id, record_kind, record_id, embedding_model
  ),
  CHECK (record_kind IN ('fact', 'note')),
  CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global')),
  CHECK (length(record_id) > 0),
  CHECK (length(namespace_id) > 0),
  CHECK (length(embedding_model) > 0),
  CHECK (length(content_digest) > 0),
  CHECK (dimensions > 0)
);

CREATE INDEX IF NOT EXISTS memory_vectors_namespace_idx
  ON memory_vectors (namespace_kind, namespace_id, embedding_model, updated_at_ms);
