# 🐛 control-plane: [medium] entity mutation and its audit event write are not atomic (separate auto-committed statements)

GitHub: https://github.com/smithersai/smithers/issues/725

_via ultracode (Opus multi-agent) review_

**Summary:** In `ControlPlaneStore`, each create/upsert performs its primary write and its audit-event write as two separate auto-committed SQLite statements with no enclosing transaction, so the entity and its audit record are not atomic.

**Locations** (`packages/control-plane/src/index.js`):
- `createOrg` — INSERT at 588-591, `recordAuditEvent` at 599-606
- `createTeam` — 634-637 / 645-651
- `addTeamMember` — 670-674 / 675
- `createProject` — 700 / 708
- `addProjectTeam` — 738 / 739
- `upsertBillingAccount` — 766 / 767
- `upsertIdentityProvider` — ~808 / 820
- `setUsageLimit` — 944 / 945
- `putSecretRef` — ~1043 / 1054
- `recordAuditEvent` itself does an independent INSERT at 1109-1121

The module already uses `sqlite.transaction(...)` at line 208 for the migration; none of these methods do.

**Failure scenario:** SQLite runs in autocommit, so `createOrg` commits the org row, and only then does `recordAuditEvent` run as a second commit. A process crash or DB-connection death in that window leaves a persisted org with no `org.create` audit event — the audit trail is permanently incomplete for that entity. The same gap exists for every listed method. Additionally, if `recordAuditEvent` throws (e.g. validation / `assertProjectExists`) after the primary row is committed, the call surfaces an error while the entity still persists — an inconsistency without needing any crash.

**Why it matters:** This package advertises durable audit primitives; a control-plane audit log that can silently miss the creation event for a persisted org/project/secret undermines its compliance guarantee. Wrapping each mutation plus its audit write in a single `sqlite.transaction(...)` makes the audit record atomic with the change it records.
