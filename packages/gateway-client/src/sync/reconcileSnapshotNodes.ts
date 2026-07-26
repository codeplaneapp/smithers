import { withoutVirtualFields } from "./withoutVirtualFields.ts";
import { deepEquals } from "@tanstack/db";
import { runNodeKey, type GatewayRunNode } from "./GatewayRunNode.ts";

export function reconcileSnapshotNodes(
  previous: Iterable<GatewayRunNode> | ReadonlyMap<string, GatewayRunNode>,
  next: readonly GatewayRunNode[],
) {
  // Identity is the unique row `key` (not the logical `id`), matching the
  // collection's `getKey`, so loop/retry attempts sharing an `id` reconcile as
  // distinct rows instead of clobbering each other.
  const previousRows =
    "get" in previous && "has" in previous
      ? previous
      : new Map(Array.from(previous, (row) => [runNodeKey(row), row] as const));
  const nextRows = new Map(next.map((row) => [runNodeKey(row), row]));
  const writes: Array<{ type: "insert" | "update"; value: GatewayRunNode } | { type: "delete"; key: string }> = [];

  for (const row of next) {
    const current = previousRows.get(runNodeKey(row));
    if (!current) {
      writes.push({ type: "insert", value: row });
      continue;
    }
    if (!deepEquals(withoutVirtualFields(current), row)) {
      writes.push({ type: "update", value: row });
    }
  }

  for (const key of previousRows.keys()) {
    if (!nextRows.has(key)) {
      writes.push({ type: "delete", key });
    }
  }

  return writes;
}
