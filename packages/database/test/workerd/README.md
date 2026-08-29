# workerd harness

`WorkerdDurableObject.test.ts` runs `worker.ts` inside real workerd and checks
the platform claims `DurableObjectDatabase` is built on. The rest of the
package's suite runs against `src/test/DurableObjectStorageFake.ts`, which
mirrors the platform's behaviour over `node:sqlite`; the fake can prove the
driver's logic but not that the platform behaves the way the fake says.

## Running it

The suite is skipped unless `FLOWS_WORKERD_BIN` names a workerd binary.
workerd ships as a platform-specific optional package and is not a dependency
of `@smthrs/database`, so a machine that only wants the ordinary suite installs
nothing extra and CI leaves the variable unset.

```sh
npm exec --yes --package=workerd -- node -p "require.resolve('workerd/bin/workerd')"
FLOWS_WORKERD_BIN=/path/to/workerd pnpm --filter @smthrs/database run test
```

`FLOWS_WORKERD_PORT` overrides the loopback port, which defaults to 8787. The
port is fixed rather than searched, so a collision fails the run instead of
silently talking to another process.

The test bundles `worker.ts` with esbuild for `platform: "neutral"` under the
`workerd` condition, writes a workerd config next to the bundle, and serves it.
Bundling for a neutral platform is itself a check: an import of a Node builtin
that reached the driver would fail the build here.

## What it checks

Seven assertions, each a claim about the platform rather than about the
driver's logic:

1. `exec` refuses `BEGIN`. The driver reaches for `ctx.storage.transaction`
   instead of SQL because of this, and the fake enforces the same rule.
2. `exec` accepts `SAVEPOINT` and `ROLLBACK TO` inside a platform transaction.
   Nested `DurableWriter.write` is a savepoint, and savepoints are the part of
   the transaction vocabulary the platform could plausibly reserve alongside
   `BEGIN`. **This is the assumption most worth confirming.** If it fails, the
   nested-write path in `src/cloudflare/DurableObjectDatabase.ts` — the
   `withSavepoint` function — is the only code that has to change.
3. A failed write rolls the whole transaction back.
4. A failed nested write rolls back to its savepoint while the outer commits.
5. `changes()` reports the exact affected-row count on an indexed table, which
   is why the driver reads it instead of the cursor's `rowsWritten` billing
   counter.
6. A blob round trips: the platform hands back `ArrayBuffer`, the driver
   normalizes to `Uint8Array`.
7. Two concurrent read-modify-write transactions do not lose an update — the
   serialization `DurableWriter.write` states normatively, here supplied by the
   client's connection semaphore rather than by a database-level lock, because
   a Durable Object owns one database on one thread.

## Status

The harness has not been executed in the environment this lane was developed
in: running the workerd binary was not permitted there. The bundling step, the
worker module, and the assertions are written against the documented workerd
config schema, so treat the first run as part of reviewing this change.
