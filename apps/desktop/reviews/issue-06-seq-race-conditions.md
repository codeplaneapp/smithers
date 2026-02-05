# Sequence numbers are race-prone under concurrent inserts

Severity: Medium

Location: `src/bun/db.ts:231`, `src/bun/db.ts:408`

Description:
`chat_messages` and `workflow_events` compute `seq` via `MAX(seq) + 1` without a transaction. Concurrent inserts can produce duplicates or out-of-order sequences.

Impact:
Message ordering and event streaming can become inconsistent when multiple writers are active.

Suggested Fix:
Use transactions or rely on an autoincrementing sequence to ensure uniqueness and monotonic ordering.
