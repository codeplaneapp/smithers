# 🐛 agents: usage extraction scans the output file, not raw stdout, when commandSpec.outputFile is set

GitHub: https://github.com/smithersai/smithers/issues/567

**What happens**
In `packages/agents/src/BaseCliAgent/BaseCliAgent.js:1023`, `stdout` is rebound to the output-file contents when `commandSpec.outputFile` exists. Line 1130 then calls `extractUsageFromOutput(stdout)` under the comment "Extract token usage from raw stdout before text extraction strips it" — so for output-file agents it scans the final-message file (which contains no NDJSON usage events), never `result.stdout`.

**Why it's wrong / failure scenario**
CodexAgent always sets `outputFile` (`--output-last-message`, CodexAgent.js:574-595) and its comment at CodexAgent.js:558 explicitly claims `extractUsageFromOutput` will parse the `--json` stream events — it can't. Codex usage is rescued only by the `?? usageFromCompletedEvent(completedEvent)` fallback (turn.completed carries usage). Any CLI that writes an output file and reports usage only via per-event stdout NDJSON silently loses all token-usage metrics.

**Expected behavior**
`extractUsageFromOutput(result.stdout)` (or scan both raw stdout and the file), matching the comment's stated intent.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
