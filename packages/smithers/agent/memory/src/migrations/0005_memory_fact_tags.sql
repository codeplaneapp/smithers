ALTER TABLE memory_facts
  ADD COLUMN tags_json TEXT CHECK (tags_json IS NULL OR json_valid(tags_json));
