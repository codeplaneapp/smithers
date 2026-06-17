import { getTableName } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as internalSchema from "./internal-schema.js";
import { schemaSignature } from "./schema-signature.js";

/**
 * @param {unknown} value
 * @returns {value is { queryAll: (statement: string, params?: readonly unknown[]) => Promise<readonly Record<string, unknown>[]> }}
 */
function isStorageLike(value) {
    return Boolean(value &&
        typeof value === "object" &&
        typeof /** @type {any} */ (value).queryAll === "function");
}

/**
 * @param {unknown} value
 */
function resolveStorage(value) {
    if (isStorageLike(value)) {
        return value;
    }
    const storage = /** @type {{ internalStorage?: unknown } | null | undefined} */ (value)?.internalStorage;
    if (isStorageLike(storage)) {
        return storage;
    }
    throw new Error("getSmithersSchemaSignature requires a SmithersDb or SqlMessageStorage instance");
}

/**
 * @returns {Array<import("drizzle-orm").Table>}
 */
function internalTables() {
    return Object.values(internalSchema)
        .filter((table) => {
            try {
                return typeof getTableName(/** @type {any} */ (table)) === "string";
            }
            catch {
                return false;
            }
        })
        .sort((left, right) => getTableName(/** @type {any} */ (left)).localeCompare(getTableName(/** @type {any} */ (right))));
}

/**
 * Return the durable Smithers schema head and a stable hash of the internal
 * table catalog. The migration head is the client persistence schemaVersion;
 * the signature lets clients or operators detect a same-head table-shape drift.
 *
 * @param {unknown} adapterOrStorage
 * @returns {Promise<{ schemaVersion: string; signature: string; components: Record<string, string> }>}
 */
export async function getSmithersSchemaSignature(adapterOrStorage) {
    const storage = resolveStorage(adapterOrStorage);
    const rows = await storage.queryAll("SELECT id FROM _smithers_schema_migrations ORDER BY id");
    const headId = rows
        .map((row) => row.id)
        .filter((id) => typeof id === "string")
        .at(-1) ?? "0000";
    const schemaVersion = headId.match(/^\d+/)?.[0] ?? headId;
    const components = Object.fromEntries(internalTables().map((table) => [
        getTableName(table),
        schemaSignature(table),
    ]));
    const signature = createHash("sha256")
        .update(JSON.stringify({ headId, schemaVersion, components }))
        .digest("hex");
    return { schemaVersion, signature, components };
}
