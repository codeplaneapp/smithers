CREATE TABLE IF NOT EXISTS memory_fts_kinds (
  namespace_kind TEXT PRIMARY KEY,
  enabled_at_ms INTEGER NOT NULL,
  CHECK (namespace_kind IN ('flow', 'agent', 'user', 'global'))
);

-- Each memory_fts_<namespace-kind> FTS5 virtual table is created and
-- backfilled lazily by MemoryStore.enableFts. Users who never enable search
-- pay no FTS write amplification.
