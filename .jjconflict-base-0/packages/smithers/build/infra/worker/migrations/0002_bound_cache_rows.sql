-- Defense in depth for direct D1 writers and older Worker versions. The HTTP
-- protocol applies the same byte and provenance bounds before these triggers.
CREATE TRIGGER smithers_build_cache_entry_validate_insert
BEFORE INSERT ON smithers_build_cache_entry
WHEN length(CAST(NEW.key_digest AS BLOB)) NOT BETWEEN 1 AND 512
  OR length(CAST(NEW.entry_json AS BLOB)) > 1048576
  OR length(CAST(NEW.result_json AS BLOB)) > 2097152
  OR (NEW.recorded_run_id IS NULL) <> (NEW.recorded_event_seq IS NULL)
  OR (
    NEW.recorded_run_id IS NOT NULL
    AND length(CAST(NEW.recorded_run_id AS BLOB)) NOT BETWEEN 1 AND 512
  )
BEGIN
  SELECT RAISE(ABORT, 'cache entry violates protocol bounds');
END;

CREATE TRIGGER smithers_build_cache_entry_validate_update
BEFORE UPDATE OF
  key_digest,
  entry_json,
  result_json,
  recorded_run_id,
  recorded_event_seq
ON smithers_build_cache_entry
WHEN length(CAST(NEW.key_digest AS BLOB)) NOT BETWEEN 1 AND 512
  OR length(CAST(NEW.entry_json AS BLOB)) > 1048576
  OR length(CAST(NEW.result_json AS BLOB)) > 2097152
  OR (NEW.recorded_run_id IS NULL) <> (NEW.recorded_event_seq IS NULL)
  OR (
    NEW.recorded_run_id IS NOT NULL
    AND length(CAST(NEW.recorded_run_id AS BLOB)) NOT BETWEEN 1 AND 512
  )
BEGIN
  SELECT RAISE(ABORT, 'cache entry violates protocol bounds');
END;
