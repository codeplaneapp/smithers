import { AsyncLocalStorage } from "node:async_hooks";
import * as BunContext from "@effect/platform-bun/BunContext";

/**
 * @typedef {import("effect").Layer.Layer<any, never, never>} PlatformLayer
 */

/** @type {PlatformLayer} */
const defaultPlatformLayer = BunContext.layer;

// Per-run layer, scoped via AsyncLocalStorage so CONCURRENT runs in one process
// (the gateway/server drive many workflows at once) never bleed layers into each
// other, and detached loops spawned inside a run (cancel watch, durability
// snapshots) inherit the correct layer across awaits/timers. A separate
// process-wide `overrideLayer` backs setPlatformLayer for single-run embedders.
/** @type {AsyncLocalStorage<PlatformLayer>} */
const storage = new AsyncLocalStorage();
/** @type {PlatformLayer | undefined} */
let overrideLayer;

/**
 * @returns {PlatformLayer}
 */
export function getDefaultPlatformLayer() {
  return defaultPlatformLayer;
}

/**
 * The layer active for the current run: the AsyncLocalStorage-scoped layer if
 * one is running, else the process-wide override, else the Bun default.
 * @returns {PlatformLayer}
 */
export function getPlatformLayer() {
  return storage.getStore() ?? overrideLayer ?? defaultPlatformLayer;
}

/**
 * Set a PROCESS-WIDE override (e.g. an embedder running a single run, or tests).
 * For concurrent runs prefer withPlatformLayer, which scopes per run and is not
 * clobbered by other runs.
 * @param {PlatformLayer} layer
 */
export function setPlatformLayer(layer) {
  overrideLayer = layer;
}

export function resetPlatformLayer() {
  overrideLayer = undefined;
}

/**
 * Run `execute` with `layer` active for its whole (async) lifetime, scoped to
 * this call via AsyncLocalStorage. Concurrency-safe: parallel runs each read
 * their own layer, and the store propagates across awaits and into
 * timers/fibers spawned within `execute`.
 * @template T
 * @param {PlatformLayer} layer
 * @param {() => T | Promise<T>} execute
 * @returns {T | Promise<T>}
 */
export function withPlatformLayer(layer, execute) {
  return storage.run(layer, execute);
}
