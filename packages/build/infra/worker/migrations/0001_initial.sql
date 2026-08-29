-- D1 stores action-cache entries. CAS bytes live in R2 under their SHA-256.
-- The original JSON text is retained so CachedResult can round-trip verbatim.
CREATE TABLE smithers_build_cache_entry (
  key_digest         TEXT    PRIMARY KEY CHECK (length(key_digest) > 0),
  entry_json         TEXT    NOT NULL CHECK (json_valid(entry_json)),
  result_json        TEXT    NOT NULL CHECK (json_valid(result_json)),
  created_at_ms      INTEGER CHECK (
    created_at_ms IS NULL OR created_at_ms BETWEEN 0 AND 9007199254740991
  ),
  recorded_run_id    TEXT    CHECK (recorded_run_id IS NULL OR length(recorded_run_id) > 0),
  recorded_event_seq INTEGER CHECK (
    recorded_event_seq IS NULL OR recorded_event_seq BETWEEN 0 AND 9007199254740991
  ),
  published_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_accessed_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  access_count       INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0)
);

CREATE INDEX smithers_build_cache_entry_lru_idx
  ON smithers_build_cache_entry (last_accessed_at);
