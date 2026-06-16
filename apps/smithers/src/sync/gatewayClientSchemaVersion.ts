/**
 * Schema version the persisted client collections are pinned to in Phase 2.
 *
 * This is the CLIENT's bundled schema head, NOT a value fetched from the
 * gateway. Persistence must rehydrate a warm reload instantly and offline, so
 * it cannot block `loadRows` on a network round-trip — and no `schema_signature`
 * RPC exists until the Postgres versioned-migration work in Phase 3. Bumping
 * this constant (which happens when the shipped app's schema head advances)
 * clears every local replica and forces a cold re-sync: the client-migration
 * lever from the design doc §5.4 / §9.3.
 *
 * Phase 3 replaces this constant with the server `schema_signature` so a
 * server-side schema bump drives the cold resync; until then a slow or offline
 * gateway can never delay local rehydration.
 */
export const gatewayClientSchemaVersion = "0016";
