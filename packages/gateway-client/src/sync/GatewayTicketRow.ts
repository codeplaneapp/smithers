import type {
  GatewayDocKind as ProtocolGatewayDocKind,
  GatewayTicketRow as ProtocolGatewayTicketRow,
} from "@smthrs/protocol/gateway-rpc";

/**
 * One row of the `tickets` collection — the live `listTickets` RPC response
 * shape (and the row `createTicket`/`updateTicket` return).
 *
 * The gateway builds each row from the `_smithers_docs` table (snake→camel cased
 * by the storage layer) — the SAME table the file-watcher seam upserts a `.md`
 * doc into and the `createTicket`/`updateTicket`/`deleteTicket` RPCs write.
 * `listTickets` returns only LIVE docs: a soft-deleted row (`deleted_at_ms IS NOT
 * NULL`) is a tombstone and is filtered server-side, so it NEVER appears here.
 *
 * Field provenance (verified against
 * `packages/db/src/internal-schema/smithersDocs.js` + the `listTickets` handler
 * in `packages/server/src/gateway.js`):
 *  - `path`         — `_smithers_docs.path` (PK; the doc identity / id).
 *  - `kind`         — `_smithers_docs.kind` (`ticket`/`plan`/`spec`/`proposal`).
 *  - `content`      — `_smithers_docs.content` (full markdown body).
 *  - `contentHash`  — `_smithers_docs.content_hash` (`sha256(content)`).
 *  - `status`       — `_smithers_docs.status` (free-form; rides the row so a
 *                     ticket's status survives reload — LOCKED Path A).
 *  - `updatedAtMs`  — `_smithers_docs.updated_at_ms`.
 */
export type GatewayDocKind = ProtocolGatewayDocKind;

export type GatewayTicketRow = ProtocolGatewayTicketRow;
