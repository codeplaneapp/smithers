import { POSTGRES } from "./dialect.js";

const PGLITE_VERSION_PATTERN = /\bPGlite\b/i;

/**
 * Capture the current PostgreSQL transaction id as text when the adapter is
 * backed by a real Postgres connection. Embedded PGlite deliberately returns
 * null because local mode confirms writes through the gateway SSE seq.
 *
 * @param {{ lastCommittedTxid?: string | null; internalStorage?: { dialect?: string; queryOneRaw?: (statement: string, params?: readonly unknown[]) => Promise<Record<string, unknown> | undefined> } }} adapter
 * @returns {Promise<string | null>}
 */
export async function captureTxid(adapter) {
    const storage = adapter?.internalStorage;
    if (!storage || storage.dialect !== POSTGRES || typeof storage.queryOneRaw !== "function") {
        return null;
    }
    const versionRow = await storage.queryOneRaw("SELECT version() AS version");
    const version = typeof versionRow?.version === "string" ? versionRow.version : "";
    if (PGLITE_VERSION_PATTERN.test(version)) {
        return null;
    }
    const captured = typeof adapter.lastCommittedTxid === "string" ? adapter.lastCommittedTxid : null;
    if (captured && /^\d+$/.test(captured)) {
        adapter.lastCommittedTxid = null;
        return captured;
    }
    const row = await storage.queryOneRaw("SELECT pg_current_xact_id()::xid::text AS txid");
    const txid = typeof row?.txid === "string" ? row.txid : null;
    return txid && /^\d+$/.test(txid) ? txid : null;
}
