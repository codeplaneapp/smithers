/**
 * @param {unknown} error
 * @returns {SqliteErrorMetadata | null}
 */
function readSqliteErrorMetadata(error) {
    if (!error || (typeof error !== "object" && !(error instanceof Error))) {
        return null;
    }
    const code = typeof error?.code === "string" ? error.code : "";
    const message = String(error?.message ?? "");
    return { code, message };
}
/**
 * @param {unknown} error
 * @returns {SqliteErrorMetadata | null}
 */
function findSqliteErrorMetadata(error) {
    const seen = new Set();
    let current = error;
    while (current && !seen.has(current)) {
        seen.add(current);
        const metadata = readSqliteErrorMetadata(current);
        if (metadata) {
            const message = metadata.message.toLowerCase();
            if (metadata.code.startsWith("SQLITE_BUSY") ||
                metadata.code.startsWith("SQLITE_IOERR") ||
                message.includes("database is locked") ||
                message.includes("database is busy") ||
                message.includes("disk i/o error")) {
                return metadata;
            }
        }
        current = current?.cause;
    }
    return readSqliteErrorMetadata(error);
}
/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableSqliteWriteError(error) {
    const metadata = findSqliteErrorMetadata(error);
    if (!metadata)
        return false;
    const { code } = metadata;
    if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_IOERR")) {
        return true;
    }
    const message = metadata.message.toLowerCase();
    return (message.includes("database is locked") ||
        message.includes("database is busy") ||
        message.includes("disk i/o error"));
}
