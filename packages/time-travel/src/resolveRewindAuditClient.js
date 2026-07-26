/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * Resolve the portable storage layer used by the rewind audit helpers.
 *
 * Rewind audit writes/reads run against the `_smithers_time_travel_audit` table
 * through the adapter's dialect-agnostic {@link SmithersDb.internalStorage} (the
 * same layer the adapter's own methods use), so they work on bun:sqlite,
 * PostgreSQL, and PGlite alike. `?` placeholders are rewritten to `$n` for
 * PostgreSQL and snake_case columns are returned camelCased.
 *
 * @param {SmithersDb} adapter
 * @returns {SmithersDb["internalStorage"]}
 */
export function resolveRewindAuditClient(adapter) {
  const storage = adapter?.internalStorage;
  if (!storage || typeof storage.execute !== "function") {
    throw new TypeError("Could not resolve storage for rewind audit writes; adapter has no internalStorage.");
  }
  return storage;
}
