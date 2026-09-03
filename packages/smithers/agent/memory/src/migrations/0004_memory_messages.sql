CREATE TABLE memory_messages_v2 (
  id TEXT NOT NULL CHECK (length(id) > 0),
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (thread_id, id),
  FOREIGN KEY (thread_id) REFERENCES memory_threads (thread_id)
);

INSERT INTO memory_messages_v2 (id, thread_id, role, text, at_ms)
  SELECT id, thread_id, role, text, at_ms FROM memory_messages;

DROP TABLE memory_messages;

ALTER TABLE memory_messages_v2 RENAME TO memory_messages;

CREATE INDEX memory_messages_thread_order_idx
  ON memory_messages (thread_id, at_ms, id);
