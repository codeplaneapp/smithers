# 🐛 agents: agent-contract name sets miss the semantic time-travel tools — miscategorized as 'admin', dropped from prompt guidance, replay_run not flagged destructive

GitHub: https://github.com/smithersai/smithers/issues/571

**What happens**
The live semantic MCP surface (`apps/cli/src/mcp/semantic-tools.js`) registers `fork_run`, `replay_run`, `rewind_run`, `restore_checkpoint`, `list_snapshots`, `get_timeline`, and `time_travel`. None of these names appear in the WORKFLOW/APPROVAL/RUN/DEBUG name sets in `packages/agents/src/agent-contract/createSmithersAgentContract.js` (:20-75), so `inferCategory` defaults them all to `admin` (:122). `renderSmithersAgentPromptGuidance.js` excludes `admin` from `PROMPT_CATEGORY_ORDER` (:9-14), so these tools are never mentioned in the generated prompt guidance (used by `apps/cli/src/ask.js` with the default `semantic` surface).

Additionally `DESTRUCTIVE_TOOL_NAMES` (:76-95) lists the CLI names `fork`, `replay`, `timetravel` (absent from the semantic surface) but not `replay_run`; `replay_run`'s description ("Fork a run from a checkpoint for replay...") does not start with "Destructive:", so it is flagged `destructive: false` while the equivalent CLI `replay` is flagged destructive. (`rewind_run`/`restore_checkpoint`/`time_travel` are rescued by their "Destructive:" description prefix.)

**Why it's wrong**
The guidance tells agents to rely only on the listed tool names, then omits the entire time-travel surface; the destructive flag is inconsistent between the CLI and semantic aliases of the same operation.

**Expected behavior**
Name sets cover the actual semantic tool names (or categorize by suffix patterns), and `replay_run` is marked destructive to match `replay`.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
