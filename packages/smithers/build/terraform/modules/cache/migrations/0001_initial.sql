-- The remote cache schema.
--
-- Two stores, not one, exactly as docs/specs/Concepts/Remote Cache.md
-- requires: step-key digest to recorded result, and content digest to bytes.
-- They are separate tables because their publication order matters, and the
-- reference table is what lets eviction respect that order in reverse.
--
-- This is a fresh-install schema, and there is no migration runner. Postgres
-- runs this file once, when it initializes an empty data directory. A volume
-- that was initialized by an earlier version of this file keeps that earlier
-- schema; adopting a change means recreating the volume, which discards the
-- cache. The cache is reconstructible by definition, so that is a restart and
-- not a data loss.

BEGIN;

-- Startup refuses a database initialized by a schema it does not understand.
-- This migration is deliberately fresh-install only; upgrading means replacing
-- the reconstructible cache volume and letting this file initialize it again.
CREATE TABLE smithers_build_cache_schema (
  singleton      boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL CHECK (schema_version = 1)
);

INSERT INTO smithers_build_cache_schema (singleton, schema_version) VALUES (true, 1);

-- Content-addressed artifacts. The address is lowercase hex SHA-256, the same
-- digest every step key already folds.
CREATE TABLE smithers_build_artifact (
  digest           char(64)    PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  content          bytea       NOT NULL,
  size_bytes       bigint      NOT NULL CHECK (
    size_bytes BETWEEN 0 AND 16777216
    AND size_bytes = octet_length(content)
  ),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz NOT NULL DEFAULT now(),
  access_count     bigint      NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  CONSTRAINT smithers_build_artifact_content_address_is_valid
    CHECK (digest = encode(sha256(content), 'hex'))
);

-- Recorded results, keyed by step-key digest.
--
-- `body` is the document the client published, stored verbatim, so a lookup
-- returns the bytes that were written rather than a re-encoding of them. Two
-- clients publish here and their documents differ: RemoteCacheStore sends the
-- CacheStore.CacheEntry envelope, and the smthrs CLI's result cache sends its
-- CachedResult JSON. The service keeps both intact and derives only what SQL
-- has to compare.
--
-- `result_canonical` is that derived discriminator: the entry's `result`
-- member when it has one, otherwise the whole document, rendered with object
-- members in sorted order. Publication conflict is decided on this column, so
-- a re-publication that only reordered its members is identical rather than a
-- reported hermeticity violation.
--
-- Journal provenance is optional because only one of the two clients records
-- it, and it is stored whole or not at all: half a fence would let an eviction
-- naming only a run id delete an entry it never recorded.
--
-- The length bounds are the same bounds the service enforces before the
-- statement runs. They are here as well so a second writer cannot widen them.
CREATE TABLE smithers_build_cache_entry (
  key_digest         text        PRIMARY KEY CHECK (
    octet_length(key_digest) BETWEEN 1 AND 512
    AND key_digest !~ '[[:cntrl:]]'
  ),
  body               text        NOT NULL CHECK (octet_length(body) <= 1048576 AND body IS JSON),
  -- Canonical rendering is normally shorter than the document it came from,
  -- but a number can round-trip one character longer, so the discriminator
  -- gets headroom the service's one-mebibyte body bound does not need.
  result_canonical   text        NOT NULL CHECK (
    octet_length(result_canonical) <= 2097152
    AND result_canonical IS JSON
  ),
  created_at_ms      bigint      CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  recorded_run_id    text        CHECK (
    octet_length(recorded_run_id) BETWEEN 1 AND 512
    AND recorded_run_id !~ '[[:cntrl:]]'
  ),
  recorded_event_seq bigint      CHECK (recorded_event_seq BETWEEN 0 AND 9007199254740991),
  published_at       timestamptz NOT NULL DEFAULT now(),
  last_accessed_at   timestamptz NOT NULL DEFAULT now(),
  access_count       bigint      NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  CONSTRAINT smithers_build_cache_entry_provenance_is_whole
    CHECK ((recorded_run_id IS NULL) = (recorded_event_seq IS NULL))
);

-- Which artifacts an entry references.
--
-- The service populates this from the engine's declared-output boundary only.
-- Digest-looking text in logs and arbitrary result fields never pins a blob.
-- A declared digest that has not yet been uploaded is legal here: publication
-- ordering remains the client's responsibility, and the insert selects only
-- blobs that are already present.
--
-- What the table does buy is safe eviction: an artifact that some live entry
-- references is never a release candidate.
CREATE TABLE smithers_build_cache_entry_artifact (
  key_digest text     NOT NULL REFERENCES smithers_build_cache_entry (key_digest) ON DELETE CASCADE,
  digest     char(64) NOT NULL REFERENCES smithers_build_artifact (digest) ON DELETE RESTRICT,
  PRIMARY KEY (key_digest, digest)
);

CREATE INDEX smithers_build_cache_entry_artifact_digest_idx
  ON smithers_build_cache_entry_artifact (digest);

-- Access tracking drives eviction ordering. Both stores are least-recently-used
-- ordered, which is the policy Bazel's disk cache uses.
CREATE INDEX smithers_build_cache_entry_lru_idx ON smithers_build_cache_entry (last_accessed_at);
CREATE INDEX smithers_build_artifact_lru_idx ON smithers_build_artifact (last_accessed_at);

-- Artifacts no live entry references.
CREATE VIEW smithers_build_unreferenced_artifact AS
SELECT a.digest, a.size_bytes, a.last_accessed_at, a.access_count
FROM smithers_build_artifact AS a
WHERE NOT EXISTS (
  SELECT 1 FROM smithers_build_cache_entry_artifact AS r WHERE r.digest = a.digest
);

-- Release is an explicit verb, never a side effect of a read or a write
-- (docs/specs/Concepts/Reconciliation.md). Nothing in this schema deletes on
-- its own; an operator or a scheduled job calls these two functions, and the
-- returned counts are what a human approves against.
--
-- Use a cutoff older than the longest expected publication, plus the read
-- service's access-record grace window (lruTouchGraceSeconds in
-- service/storage.js, five minutes). CAS probes update last_accessed_at before
-- the client publishes its cache entry, and a probe that finds the record
-- already fresh within that window leaves it alone rather than paying an
-- indexed write per read, so the record trails the probe by at most the window.
-- The grace interval prevents release from winning between those two requests.
--
-- A negative or null budget releases nothing rather than raising: `LIMIT` on a
-- negative value is an error, and an operator who typed one deserves a count
-- of zero, not a half-finished job. A null cutoff also matches no row, because
-- the comparison is null and never true.
--
-- Both functions select their candidates `FOR UPDATE SKIP LOCKED`, which is
-- how release stays out of the publication protocol's way. A publication holds
-- the entry row it classified until it commits (`FOR NO KEY UPDATE`, in
-- service/storage.js) and holds `FOR KEY SHARE` on every blob it is about to
-- reference. Without SKIP LOCKED a release would block behind those locks, and
-- would report a count it had not finished taking; with it, a row somebody is
-- publishing is simply not a candidate this pass. It stays a candidate for the
-- next one, because releasing is an explicit, repeatable verb.
--
-- The artifact function reads the base table rather than
-- smithers_build_unreferenced_artifact so the locking clause names a real relation.
-- The predicate is the view's predicate; the view stays for inspection.

CREATE FUNCTION smithers_build_release_entries(cutoff timestamptz, budget integer)
RETURNS bigint LANGUAGE sql AS $$
  WITH doomed AS (
    SELECT key_digest
    FROM smithers_build_cache_entry
    WHERE last_accessed_at < cutoff
    ORDER BY last_accessed_at
    LIMIT greatest(coalesce(budget, 0), 0)
    FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM smithers_build_cache_entry
    WHERE key_digest IN (SELECT key_digest FROM doomed)
    RETURNING 1
  )
  SELECT count(*) FROM gone;
$$;

CREATE FUNCTION smithers_build_release_artifacts(cutoff timestamptz, budget integer)
RETURNS bigint LANGUAGE sql AS $$
  WITH doomed AS (
    SELECT a.digest
    FROM smithers_build_artifact AS a
    WHERE a.last_accessed_at < cutoff
      AND NOT EXISTS (
        SELECT 1 FROM smithers_build_cache_entry_artifact AS r WHERE r.digest = a.digest
      )
    ORDER BY a.last_accessed_at
    LIMIT greatest(coalesce(budget, 0), 0)
    FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM smithers_build_artifact
    WHERE digest IN (SELECT digest FROM doomed)
    RETURNING 1
  )
  SELECT count(*) FROM gone;
$$;

COMMIT;
