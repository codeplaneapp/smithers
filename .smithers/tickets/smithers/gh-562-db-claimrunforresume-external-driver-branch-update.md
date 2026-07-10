# 🐛 db: claimRunForResume external-driver branch updates nonexistent claimed_at_ms/claimed_by columns

GitHub: https://github.com/smithersai/smithers/issues/562

**What happens**
`claimRunForResume` has three branches (packages/db/src/adapter.js:1238-1304). The Postgres branch (1242-1265) and the bun:sqlite branch (1290-1302) both `SET runtime_owner_id = ?, heartbeat_at_ms = ?`. The middle branch — taken for any non-Postgres, non-bun-sqlite backend (external async SQLite-compatible drivers) — runs `UPDATE _smithers_runs SET claimed_at_ms = ?, claimed_by = ?` (adapter.js:1269-1276).

**Why it's wrong / failure scenario**
No `claimed_at_ms`/`claimed_by` columns exist anywhere: `internal-schema.js` defines only `heartbeat_at_ms`/`runtime_owner_id`, no migration in `schema-migrations.js` creates them, and the only other references are `updateClaimedRun`'s optional claim-guard WHERE (adapter.js:1341-1342, 1358-1359). On such a backend the UPDATE fails with "no such column" — and even if the columns existed, the branch would never set `runtime_owner_id`/`heartbeat_at_ms`, which is the claim contract the other branches and `releaseRunResumeClaim` (1309-1320) rely on.

**Expected**
The branch should set `runtime_owner_id`/`heartbeat_at_ms` like the other two, or the schema should actually define the claimed_* columns.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
