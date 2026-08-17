import { createSmithers } from "smthrs/create";

/**
 * `bun test tests` runs every packages/server test file in ONE process, so a
 * `createSmithers` handle that is never closed stays open for the whole run:
 * the db, `-wal` and `-shm` fds plus the WAL shared-memory mapping and the
 * sqlite3 locking state, multiplied by every fixture every file ever built.
 * Instrumenting the `bun:sqlite` constructor counted a peak of 189
 * simultaneously-live handles across this suite (#1577).
 *
 * These fixtures are throwaway — a temp-file database per test — so nothing
 * needs to outlive the file that made it. Open them through
 * `createTrackedSmithers` and call `closeTrackedSmithers` from a file-scope
 * `afterAll`, and the peak becomes "the handles one file opens" instead of
 * "the handles the whole suite ever opened".
 *
 * The tracking set is module state, so it is shared by every test file in the
 * process. That is deliberate: files run one at a time, so each file's
 * `afterAll` also sweeps up anything an earlier file forgot.
 *
 * @type {Set<{ close: () => void }>}
 */
const trackedHandles = new Set();

/**
 * `createSmithers`, with the returned handle registered for teardown.
 *
 * @type {typeof createSmithers}
 */
export function createTrackedSmithers(schemas, opts) {
  const api = createSmithers(schemas, opts);
  trackedHandles.add(api);
  return api;
}

/**
 * Close every handle opened through `createTrackedSmithers` since the last
 * sweep. `close()` is idempotent and a no-op for backends that own no closable
 * handle, and a fixture whose database is already gone must not fail teardown,
 * so every close is individually guarded.
 *
 * The `Bun.gc` is load-bearing, not hygiene. `Database.close()` is
 * `sqlite3_close_v2`, which only unwinds the connection once every prepared
 * statement on it is finalized; drizzle's bun-sqlite driver leaves one
 * unreachable-but-not-yet-collected `Statement` behind per database, so without
 * a collection the connection stays a zombie and keeps its three fds, its
 * `-shm` mapping and its locking state exactly as if it were still open.
 * Measured: 20 drizzle-wrapped databases hold 60 fds across `close()` and
 * release all 60 on the next full collection. One synchronous collection per
 * test file is cheap and makes teardown mean something.
 */
export function closeTrackedSmithers() {
  for (const api of trackedHandles) {
    try {
      api.close();
    } catch {}
  }
  const closed = trackedHandles.size;
  trackedHandles.clear();
  if (closed > 0) Bun.gc(true);
}
