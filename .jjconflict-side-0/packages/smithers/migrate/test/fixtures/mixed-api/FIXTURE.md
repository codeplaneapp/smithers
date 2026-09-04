# `mixed-api`

One workflow file that imports Smithers 0.x and a foreign authoring API together. `createSmithers`, `Sequence`, `Parallel`, `Ralph`, and `on` come from `@smithers-ai/workflow`; `ClaudeCodeAgent`, `CodexAgent`, and `Worktree` come from `smithers-orchestrator`.

The tool migrates the 0.x half and says so. The foreign factory's `<Workflow>` and `<Task>` are not 0.x components, so their props (`triggers`, `if`) never reach the catalog, and `Detect.scan` reports the file as `mixed-authoring-api` rather than dropping the other half in silence.

Origin: `/Users/williamcory/plue` at commit `2db1ecff21f7da8101f466570a6b997285eae394` (2026-08-28).

| Path | Origin |
| --- | --- |
| `.smithers/workflows/issue-pipeline.tsx` | byte-for-byte copy of `.smithers/workflows/issue-pipeline.tsx` |
| `.smithers/package.json` | byte-for-byte copy of `.smithers/package.json` |

No sanitizations. The origin manifest does not declare `@smithers-ai/workflow`, which is why the foreign import is found by specifier and not by manifest.
