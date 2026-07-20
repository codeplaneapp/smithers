import { createHash } from "node:crypto";

/**
 * Lowercase hex `sha256` of a UTF-8 string. The gateway's
 * `createTicket`/`updateTicket` handlers and the file-watcher seam both hash doc
 * `content` through this ONE helper so a `content_hash` written by an RPC and
 * one computed from a `.md` file are byte-for-byte comparable (the watcher's
 * last-write-wins compare key).
 * @param {string} content
 * @returns {string}
 */
export function sha256Hex(content) {
    return createHash("sha256").update(content, "utf8").digest("hex");
}
