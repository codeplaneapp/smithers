# Add robust all-runs filtering

GitHub: https://github.com/smithersai/smithers/issues/944

Parent: smithers/gh-851-polish-the-monitor-runs-list-and-responsive-hierar.md

Context: Large workspaces need fast filtering without losing the current overview context. Acceptance criteria: Support case-insensitive search by run ID and workflow; filter by normalized status and workflow; show filtered and total counts; reset pagination when filters change; test filtering and option generation.


> Closed by ticket-fleet sync: Implemented on main. apps/cli/src/monitor-ui/monitorModel.ts:305-323 normalizes statuses; lines 385-407 provide case-insensitive run-ID/workflow search, normalized status/workflow filtering, and option generation; lines 415-432 implement pagination. apps/cli/src/monitor-ui/monitor.tsx:3162-3169 applies filters and resets the page, while lines 3183-3208 and 979-1068 show filtered/total counts and pagination. apps/cli/tests/monitor-ui-model.test.ts:131-151 tests filtering and options, and lines 184-218 test pagination. Relevant commits are aa613528bf56 (live all-runs monitor) and 9be93f899096 (paginated all-runs table).
