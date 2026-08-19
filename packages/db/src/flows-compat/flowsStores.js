/**
 * The flows storage services the compat module runs on: `Journal`, `RunStore`,
 * and `AttemptStore` over the workspace's own SQLite file.
 *
 * The flows modules themselves are loaded through `vendoredFlows.js`, which
 * documents why they are resolved at runtime rather than imported statically.
 *
 * The SQL client is `@effect/sql-sqlite-bun`, and it is the one flows dependency
 * this package declares. flows composes `@effect/sql-sqlite-node`, which opens
 * `node:sqlite` with `allowExtension`, and Bun's SQLite is built with
 * `SQLITE_OMIT_LOAD_EXTENSION`, so that driver cannot open a database under the
 * runtime Smithers SQLite workspaces run on.
 */
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Duration, Effect, Exit, Layer, Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { resolve } from "node:path";
import { loadFlowsModules } from "./vendoredFlows.js";

/** Bound on the journal's in-process admission queue. */
const JOURNAL_QUEUE_CAPACITY = 1024;
/** How long a flows write waits for the Smithers connection to release the file. */
const BUSY_TIMEOUT = Duration.seconds(30);

/**
 * @typedef {object} FlowsStores
 * @property {string} filename
 * @property {<A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>} runPromise runs an effect with the flows services provided
 * @property {() => Promise<void>} close releases the flows connection and its fibers
 */

/**
 * One flows service context per database file, shared by every `SmithersDb` over
 * that file.
 *
 * Adapters are constructed ad hoc all over the engine, and each flows context
 * owns a SQLite connection, a journal writer fiber, and its in-process sequence
 * floors. Opening one per adapter would multiply all three against one workspace,
 * so they are keyed by resolved filename and reference counted: the last handle
 * to close releases the context.
 *
 * @type {Map<string, { context: Promise<any>; scope: any; refs: number }>}
 */
const openContexts = new Map();

/**
 * @param {string} filename
 * @returns {any} the layer stack for one database file
 */
async function buildStoresLayer(filename) {
  const { journal, runStore, durableWriter } = await loadFlowsModules();
  const sqlLayer = SqliteClient.layer({ filename, busyTimeout: BUSY_TIMEOUT });
  const writerLayer = Layer.provideMerge(durableWriter.layer(), sqlLayer);
  const migratedLayer = Layer.provideMerge(
    Layer.effectDiscard(Effect.andThen(journal.Migrations.run, runStore.Migrations.run)),
    writerLayer,
  );
  return Layer.provideMerge(
    Layer.mergeAll(
      journal.SqlJournal.layer({ capacity: JOURNAL_QUEUE_CAPACITY, overflow: "reject" }),
      runStore.RunStore.layer,
      // Smithers records an in-flight attempt as `in-progress`, which is the
      // state the fences in `heartbeat` and `finish` must recognise, and its
      // `insertAttempt` is an upsert.
      runStore.AttemptStore.layerWith({ inProgressStates: ["in-progress"], putMode: "upsert" }),
    ),
    migratedLayer,
  );
}

/**
 * Open the flows storage services against an existing Smithers SQLite file.
 *
 * The flows tables (`flows_journal_events`, `flows_runs`, `flows_attempts`, and
 * `flows_migrations`) are created on first open. The journal's migration set is
 * applied before the run store's because the migrator's high-water mark only
 * moves forward and the run store owns the higher id block.
 *
 * @param {{ filename: string }} options
 * @returns {Promise<FlowsStores>}
 */
export async function openFlowsStores(options) {
  const filename = resolve(options.filename);
  let entry = openContexts.get(filename);
  if (entry === undefined) {
    const scope = Scope.makeUnsafe();
    entry = {
      scope,
      refs: 0,
      context: (async () => {
        const storesLayer = await buildStoresLayer(filename);
        return Effect.runPromise(/** @type {any} */ (Layer.buildWithScope(/** @type {any} */ (storesLayer), scope)));
      })(),
    };
    openContexts.set(filename, entry);
  }
  const shared = entry;
  shared.refs += 1;
  /** @type {any} */
  let context;
  try {
    context = await shared.context;
  } catch (cause) {
    shared.refs -= 1;
    if (shared.refs <= 0) openContexts.delete(filename);
    throw cause;
  }
  let released = false;
  return {
    filename,
    runPromise: (effect) => Effect.runPromise(Effect.provide(/** @type {any} */ (effect), context)),
    close: async () => {
      if (released) return;
      released = true;
      shared.refs -= 1;
      if (shared.refs > 0) return;
      openContexts.delete(filename);
      await Effect.runPromise(Scope.close(shared.scope, Exit.void));
    },
  };
}

export { SqlClient };
