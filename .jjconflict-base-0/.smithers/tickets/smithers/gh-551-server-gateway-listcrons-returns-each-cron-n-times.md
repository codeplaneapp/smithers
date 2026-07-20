# 🐛 server: gateway listCrons() returns each cron N times when N workflows share a DB

GitHub: https://github.com/smithersai/smithers/issues/551

**What happens**
`SmithersGateway.listCrons()` (packages/server/src/gateway.js:5539-5554) loops over `this.workflows.values()` and calls `adapter.listCrons(false)` for each entry. `SmithersDb.listCrons` (packages/db/src/adapter.js:2929) does `SELECT * FROM _smithers_cron` with no per-workflow filter, so on a shared DB every registered workflow's adapter returns the same rows.

**Why it's wrong**
Every other cross-workflow reader in this class dedupes shared-DB workflows via a `seenAdapters` set (listRunsAcrossWorkflows ~5108, listMemoryFactsAcrossWorkflows ~5147, listTicketsAcrossWorkflows ~5346, listPendingApprovals ~5465, listDocsAcrossWorkflows ~5510, resolveRun ~5587). `listCrons()` does not, so with N workflows registered over one shared smithers.db (the normal init-pack gateway) the `cron.list` RPC (caller at gateway.js:6698) returns each cron N times, all attributed to the same workflow via `workflowKeyFromCronPath`.

**Expected**
Iterate each distinct adapter once (seenAdapters pattern) or dedupe by `cronId`. `findCron` (first match) and `processDueCrons` are unaffected.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
