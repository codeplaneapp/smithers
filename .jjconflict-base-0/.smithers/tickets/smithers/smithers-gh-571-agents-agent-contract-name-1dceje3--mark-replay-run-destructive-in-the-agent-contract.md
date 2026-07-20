# Mark replay_run destructive in the agent contract

GitHub: https://github.com/smithersai/smithers/issues/1071

Parent: smithers/gh-571-agents-agent-contract-name-sets-miss-the-s-0pisqb5.md

Context: replay_run creates a new run from a checkpoint and can restore VCS state, but its agent-contract metadata is non-destructive while the equivalent CLI replay tool is destructive. Acceptance criteria: add replay_run to the destructive tool names; ensure contract metadata and prompt guidance flag it destructive; add a regression test for the destructive flag.
