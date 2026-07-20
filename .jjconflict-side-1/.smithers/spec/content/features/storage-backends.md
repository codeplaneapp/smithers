# Storage backends and migration

> **Status:** Partial | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Platform & delivery | **Tier:** Platform

Smithers stores run-of-record data in SQLite by default and supports `PGlite/Postgres` through openSmithersBackend, createSmithersPostgres, dialect descriptors, and a CLI migration path from legacy smithers.db.

## What you can do

Run locally with `SQLite/PGlite`, migrate safely, or use managed Postgres for durable multi-connection deployments.

## Capabilities

### Backend resolution

openSmithersBackend resolves explicit opts, SMITHERS\_BACKEND, .smithers config, migration markers, and fresh-workspace defaults.

### Migration command

`smithers migrate` copies legacy SQLite rows to `PGlite/Postgres` in bounded batches, verifies counts, and writes `.smithers/migrated.json`.

### Postgres factory

createSmithersPostgres returns the same createSmithers API against pg or embedded PGlite.

### Schema signatures

DB schema signatures and input bounds protect `gateway/client` assumptions around table shape and payload size.

### Electric shape proxy

The Electric proxy scopes cloud-sync shape access, strips forwarded auth, applies rate limits, and records shape metrics.

## Endpoints and commands

- `API openSmithersBackend` ([docs](docs/deployment/production-hardening.mdx))
- `API createSmithersPostgres` ([docs](docs/deployment/production-hardening.mdx))
- `CLI smithers migrate` ([docs](docs/cli/overview.mdx))
- `RPC getSchemaSignature` ([docs](docs/rpc/get-schema-signature.mdx))

## Related docs

- [Production hardening persistence](docs/deployment/production-hardening.mdx#persistence)

## Test cases

- `packages/engine/tests/create-smithers-postgres.test.jsx`
- `packages/engine/tests/effect-builder-postgres.test.js`
- `apps/cli/tests/sqlite-default-roundtrip.e2e.test.js`
- `apps/cli/tests/pglite-roundtrip.e2e.test.js`
- `apps/cli/tests/postgres-roundtrip.e2e.test.js`
- `apps/cli/tests/migrate-command.test.js`
- `packages/db/tests/db-adapter.test.js`
- `packages/db/tests/db-transaction.test.js`
- `packages/db/tests/migrations.test.js`
- `packages/db/tests/db-write-retry.test.js`
- `packages/cloudflare/tests/cloudflare-sqlite.test.js`

## Observability

- DB metrics include dbQueryDuration, dbTransactionDuration, dbRetries, dbTransactionRetries, and dbTransactionRollbacks.
- Migration writes `.smithers/migrated.json` and read paths use backend markers to avoid silently opening the wrong store.

## Debugging

- If a legacy smithers.db has data and no migration marker, backend open should fail with SMITHERS\_MIGRATION\_REQUIRED instead of creating an empty backend.
- Use `smithers migrate` --to pglite or --to postgres, then `pglite/postgres` roundtrip e2e tests to verify parity.

## Architecture

- `packages/db/src/index.js` exports adapter, dialect, ensure, input bounds, schema signature, snapshots, `output/input` helpers, and write-retry logic.
- `packages/smithers/src/index.js` exports openSmithersBackend, openSmithersStore, migrateSmithersStore, and createSmithersPostgres.
- `docs/deployment/production-hardening.mdx` explains SQLite, PGlite, Postgres, Electric Cloud Sync, and D1 limitations.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-18 feature and docs audit: mapped the published Electric shape proxy and its managed sync boundary.
- `packages/db/src/dialect.js`
- `packages/smithers/src/openSmithersBackend.js`
- `packages/smithers/src/create.js`
- `packages/smithers/src/migrateSmithersStore.js`
- `apps/cli/src/argv-utils.js`
- `apps/cli/tests/migrate-command.test.js`
- `packages/db`
- `packages/electric-proxy`

## Open gaps

- Electric Cloud Sync is documented for managed Postgres but needs deployment-level proof in the target hosted environment.
- Cloudflare D1 descriptor is `read-mostly/non-atomic` by design and should not be presented as durable run-of-record storage.
