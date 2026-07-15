# @smithers-orchestrator/control-plane — src

Single-module package. `index.js` exports `ensureControlPlaneTables(sqlite)` and
`ControlPlaneStore`: durable org/team/project, billing-account, identity-provider,
usage + quota, secret-reference, and audit primitives over an injected minimal
sqlite handle (`bun:sqlite` `Database`, or any object with `exec`/`query`/`transaction`).
All tables are prefixed `_smithers_cp_`, and every mutation except
`recordUsage` (which only appends a `_smithers_cp_usage_events` row) also
writes an audit event.

`index.d.ts` is the hand-maintained public type surface (`ControlPlaneSqlite`,
`ControlPlaneOrg`, ...); `index.js` pulls those types back in via `@typedef`
JSDoc imports. Consumers reach this package through the
`smithers-orchestrator/control-plane` re-export in `packages/smithers`.

Gotchas:

- Secret refs and usage limits key on a non-null `project_key` column where the
  reserved sentinel `__org__` stands in for org-wide (`project_id IS NULL`)
  scope. The id validators reject `__org__` so a project of that name cannot
  collide with the org-wide rows.
- `ensureControlPlaneTables` runs a self-healing, transactional migration for
  the legacy nullable-PK secret_refs schema — it also recovers from a crash
  that left `_smithers_cp_secret_refs_legacy` behind mid-migration.
- This store holds secret REFERENCES (provider + ref), never secret values;
  `tests/control-plane.test.js` asserts no plaintext lands in any
  `_smithers_cp_%` table.
