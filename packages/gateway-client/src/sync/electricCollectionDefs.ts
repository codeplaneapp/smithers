import type { ListMemoryFactsRequest } from "@smithers-orchestrator/gateway/rpc";
import { gatewayKeys } from "./gatewayKeys.ts";
import type { GatewayMemoryFactRow } from "./GatewayMemoryFactRow.ts";
import type { ElectricCollectionDef, ElectricRawRow } from "./createElectricCollection.ts";

/**
 * Cloud-Electric collection defs — the source-switch siblings of
 * `gatewayCollectionDefs`. Each entry carries the same `SyncKey` (so the same
 * collection-id fingerprint) and the same `getKey` as its gateway twin, plus the
 * Postgres table + a `mapRow` that decodes the Electric wire format for that
 * table into the gateway's typed Row.
 *
 * Extending to a new surface (runs/approvals/…) is one entry here: the table
 * name + a row mapper. The registry switch then wires the matching collection to
 * Electric whenever the cloud source is selected.
 */

/** Coerce an Electric int8 column (delivered as a decimal string) to a number. */
function asMs(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** Coerce a nullable Electric int8 column to `number | null`. */
function asMsOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asMs(value);
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Map one raw `_smithers_memory_facts` Electric row onto the gateway's
 * `GatewayMemoryFactRow`. The column names are snake_case on the wire and the
 * gateway Row is camelCase; `*_ms` int8 columns arrive as strings (→ numbers);
 * `value_json` is the stored JSON STRING and is preserved verbatim (the surface
 * parses it itself, exactly as it does for the gateway RPC row). Drops a row
 * missing either PK part — it could never be keyed.
 */
export function mapMemoryFactRow(raw: ElectricRawRow): GatewayMemoryFactRow | undefined {
  const namespace = raw.namespace;
  const key = raw.key;
  const valueJson = raw.value_json;
  if (typeof namespace !== "string" || typeof key !== "string" || typeof valueJson !== "string") {
    return undefined;
  }
  return {
    namespace,
    key,
    valueJson,
    schemaSig: asStringOrNull(raw.schema_sig),
    createdAtMs: asMs(raw.created_at_ms),
    updatedAtMs: asMs(raw.updated_at_ms),
    ttlMs: asMsOrNull(raw.ttl_ms),
  };
}

export const electricCollectionDefs = {
  memoryFacts: (
    params: ListMemoryFactsRequest = {},
  ): ElectricCollectionDef<GatewayMemoryFactRow, string> => ({
    key: gatewayKeys.memoryFacts(params),
    // Same composite PK as `gatewayCollectionDefs.memoryFacts` — `(namespace,
    // key)`; `key` alone is not unique across namespaces.
    getKey: (row: GatewayMemoryFactRow) => `${row.namespace}:${row.key}`,
    table: "_smithers_memory_facts",
    // Scope the shape server-side when a namespace filter is set, mirroring the
    // gateway RPC's `namespace` param. Single-quote per Postgres; the namespace
    // is a smithers identifier (no quotes), so this is safe for the e2e path.
    ...(params.namespace ? { where: `namespace = '${params.namespace}'` } : {}),
    mapRow: mapMemoryFactRow,
  }),
} as const;
