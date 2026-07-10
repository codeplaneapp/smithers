# Mark replay_run destructive in the agent contract

GitHub: https://github.com/smithersai/smithers/issues/842

Add replay_run to DESTRUCTIVE_TOOL_NAMES so its contract metadata and prompt guidance flag it destructive, matching the equivalent CLI replay operation. Add a regression test for the destructive flag.
