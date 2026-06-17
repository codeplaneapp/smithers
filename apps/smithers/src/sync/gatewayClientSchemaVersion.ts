import { getGatewayClient } from "../gateway/gatewayClient";

const BUNDLED_SCHEMA_VERSION = "0016";
let cachedSchemaVersion: Promise<string> | undefined;

type SchemaSignatureRow = { schemaVersion: string; signature: string };

/** Default signature fetcher: the live `getSchemaSignature` RPC. */
function fetchSchemaSignature(): Promise<SchemaSignatureRow> {
  return getGatewayClient().getSchemaSignature({});
}

/**
 * Schema version the persisted client collections are pinned to.
 *
 * Phase 3 sources this from the Gateway's `getSchemaSignature` RPC so the
 * server migration ledger, not the bundled UI, drives cold re-sync. If the
 * Gateway is unavailable during startup we return the bundled version as a
 * durable-cache fallback for this attempt only — we do NOT memoize the offline
 * answer. Memoizing it would pin every collection for the whole app lifetime to
 * `:offline`, so a server schema bump could never clear the persisted replica
 * until a full reload that happened to fetch successfully. Instead we drop the
 * memo on failure so the next caller re-attempts and adopts the real server
 * signature once RPC recovers. Only a successful resolution is cached.
 */
export function gatewayClientSchemaVersion(
  fetchSignature: () => Promise<SchemaSignatureRow> = fetchSchemaSignature,
): Promise<string> {
  if (cachedSchemaVersion) {
    return cachedSchemaVersion;
  }
  const pending: Promise<string> = fetchSignature()
    .then((row) => `${row.schemaVersion}:${row.signature}`)
    .catch(() => {
      if (cachedSchemaVersion === pending) {
        cachedSchemaVersion = undefined;
      }
      return `${BUNDLED_SCHEMA_VERSION}:offline`;
    });
  cachedSchemaVersion = pending;
  return pending;
}
