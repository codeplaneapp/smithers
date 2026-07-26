ALTER TABLE _smithers_tool_calls ADD COLUMN call_token TEXT;
ALTER TABLE _smithers_tool_call_archive ADD COLUMN call_token TEXT;

CREATE UNIQUE INDEX _smithers_tool_calls_call_token_uidx
  ON _smithers_tool_calls (call_token);
CREATE UNIQUE INDEX _smithers_tool_call_archive_call_token_uidx
  ON _smithers_tool_call_archive (call_token);
