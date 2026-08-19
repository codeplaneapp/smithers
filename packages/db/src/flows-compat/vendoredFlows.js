/**
 * How this package reaches the vendored flows library.
 *
 * The flows packages are not on the registry yet. They are committed as tarballs
 * under `vendor/flows/`, exposed under `@flows/*` aliases declared by that
 * directory's own workspace package, and public-hoisted into the repository root
 * `node_modules` by `.npmrc`. `vendor/flows/README.md` is the governing document.
 *
 * Two constraints follow, and together they are why the flows modules are
 * resolved here at runtime instead of being imported statically:
 *
 * 1. **A flows edge cannot appear in a Bun-visible manifest.** The vendored
 *    tarballs depend on each other by exact version, and none of those versions
 *    is on the registry. Bun has no version-scoped override, so declaring
 *    `"@flows/journal": "file:../../vendor/flows/…"` in this package's manifest
 *    makes `bun install` fail with `@smthrs/database@0.1.0 failed to resolve`,
 *    measured, and the repository requires `bun.lock` to refresh with every
 *    manifest change. The hoisted alias is what puts the packages on the
 *    resolution path until the alpha publishes and step 1 of the README's swap
 *    moves real version ranges into the manifests that import them.
 * 2. **`@smthrs/database` has no alias at all.** It is a dependency of
 *    `@flows/journal` rather than a package the migration imports directly, so it
 *    is reachable only from that package's own resolution root. `DurableWriter`,
 *    which both flows stores require, lives there.
 *
 * Only collision-free flows packages may be loaded. Nine `@smthrs` names exist in
 * both trees, and under Bun a workspace package name wins over the vendored copy,
 * so `@flows/flows` — which re-exports `@smthrs/engine` — resolves into this
 * repository's own `packages/engine` and fails to load. `@flows/journal` and
 * `@flows/run-store` collide with nothing; their closure is `@smthrs/database`
 * plus `effect`.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const requireFromHere = createRequire(import.meta.url);

/** @type {Promise<FlowsModules> | null} */
let loading = null;
/** @type {FlowsModules | null} */
let loaded = null;

/**
 * @typedef {object} FlowsModules
 * @property {any} journal `@flows/journal`
 * @property {any} runStore `@flows/run-store`
 * @property {any} durableWriter `@smthrs/database/DurableWriter`
 */

/**
 * @param {string} specifier
 * @param {NodeJS.Require} [from]
 * @returns {Promise<any>}
 */
function loadModule(specifier, from = requireFromHere) {
  return import(pathToFileURL(from.resolve(specifier)).href);
}

/**
 * Load the flows storage packages, once per process.
 *
 * @returns {Promise<FlowsModules>}
 */
export function loadFlowsModules() {
  if (loading === null) {
    loading = (async () => {
      const journalEntry = requireFromHere.resolve("@flows/journal");
      const requireFromJournal = createRequire(journalEntry);
      const modules = {
        journal: await loadModule("@flows/journal"),
        runStore: await loadModule("@flows/run-store"),
        durableWriter: await loadModule("@smthrs/database/DurableWriter", requireFromJournal),
      };
      loaded = modules;
      return modules;
    })();
  }
  return loading;
}

/**
 * The already-loaded flows modules.
 *
 * Every caller runs inside an operation the flows stores are already open for,
 * so this never races the load. It throws rather than returning `undefined`,
 * because a missing module here is a wiring bug and not a runtime condition.
 *
 * @returns {FlowsModules}
 */
export function flowsModules() {
  if (loaded === null) {
    throw new Error("flows storage modules have not been loaded; call loadFlowsModules() first");
  }
  return loaded;
}

/**
 * The journal's deterministic event id for an idempotency key. Kept behind this
 * function so the id format stays flows', never a copy of it.
 *
 * @param {string} runId
 * @param {string} sourceId
 * @param {number} sourceSeq
 * @returns {string}
 */
export function makeJournalEventId(runId, sourceId, sourceSeq) {
  return flowsModules().journal.JournalEvent.makeEventId(runId, sourceId, sourceSeq);
}
