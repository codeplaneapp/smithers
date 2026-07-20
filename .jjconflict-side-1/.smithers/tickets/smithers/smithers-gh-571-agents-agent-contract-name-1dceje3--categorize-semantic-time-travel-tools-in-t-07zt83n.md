# Categorize semantic time-travel tools in the agent contract

GitHub: https://github.com/smithersai/smithers/issues/1070

Parent: smithers/gh-571-agents-agent-contract-name-sets-miss-the-s-0pisqb5.md

Context: The semantic MCP surface registers fork_run, replay_run, rewind_run, restore_checkpoint, list_snapshots, get_timeline, and time_travel, but the agent contract categorizes unrecognized names as admin, which omits them from prompt guidance. Acceptance criteria: assign all seven tools to appropriate non-admin categories; ensure all seven appear in generated prompt guidance; add regression tests for category assignment and prompt inclusion.
