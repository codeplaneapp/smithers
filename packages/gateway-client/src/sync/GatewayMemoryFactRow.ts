import type { GatewayMemoryFact } from "@smithers-orchestrator/protocol/gateway-rpc";

/**
 * One row of the `memoryFacts` collection — the live `listMemoryFacts` RPC
 * response shape.
 *
 * The gateway builds each row from the `_smithers_memory_facts` table
 * (snake→camel cased by the storage layer) — the SAME table the
 * `@smithers-orchestrator/memory` MemoryStore writes via `setFact` and the
 * `smithers memory list` CLI reads. `listMemoryFacts` returns every namespace's
 * facts (or one namespace when filtered), so consumers key by the per-namespace
 * unique `key`.
 *
 * Field provenance (verified against
 * `packages/db/src/internal-schema/smithersMemoryFacts.js` + the
 * `listMemoryFacts` handler in `packages/server/src/gateway.js`):
 *  - `namespace`    — `_smithers_memory_facts.namespace` (PK part).
 *  - `key`          — `_smithers_memory_facts.key` (PK part; unique within ns).
 *  - `valueJson`    — `_smithers_memory_facts.value_json` (stored JSON string).
 *  - `schemaSig`    — `_smithers_memory_facts.schema_sig` (null when untyped).
 *  - `createdAtMs`  — `_smithers_memory_facts.created_at_ms`.
 *  - `updatedAtMs`  — `_smithers_memory_facts.updated_at_ms`.
 *  - `ttlMs`        — `_smithers_memory_facts.ttl_ms` (null when non-expiring).
 */
export type GatewayMemoryFactRow = GatewayMemoryFact;
