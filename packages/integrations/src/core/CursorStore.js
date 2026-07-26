// @smithers-type-exports-begin
/** @typedef {import("./CursorStoreTypes.ts").CursorStore} CursorStore */
// @smithers-type-exports-end

import { Effect } from "effect";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * CursorStore backed by the db adapter's `_smithers_integration_cursors`
 * table, so a polling source survives process restarts.
 * @param {SmithersDb} adapter
 * @returns {CursorStore}
 */
export function makeDbCursorStore(adapter) {
  return {
    get: (sourceId) => adapter.getIntegrationCursor(sourceId),
    set: (sourceId, cursor) => Effect.asVoid(adapter.setIntegrationCursor(sourceId, cursor)),
  };
}

/**
 * In-memory CursorStore (tests / ephemeral sources).
 * @returns {CursorStore}
 */
export function makeInMemoryCursorStore() {
  /** @type {Map<string, string | null>} */
  const cursors = new Map();
  return {
    get: (sourceId) => Effect.sync(() => cursors.get(sourceId)),
    set: (sourceId, cursor) =>
      Effect.sync(() => {
        cursors.set(sourceId, cursor);
      }),
  };
}
