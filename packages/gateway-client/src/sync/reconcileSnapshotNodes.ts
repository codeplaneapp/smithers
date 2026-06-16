import { deepEquals } from "@tanstack/db";
import type { GatewayRunNode } from "./GatewayRunNode.ts";

function withoutVirtualFields(row: GatewayRunNode): GatewayRunNode {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("$") && value !== undefined) {
      out[key] = value;
    }
  }
  return out as GatewayRunNode;
}

export function reconcileSnapshotNodes(
  previous: Iterable<GatewayRunNode> | ReadonlyMap<string, GatewayRunNode>,
  next: readonly GatewayRunNode[],
) {
  const previousRows = "get" in previous && "has" in previous
    ? previous
    : new Map(Array.from(previous, (row) => [row.id, row] as const));
  const nextRows = new Map(next.map((row) => [row.id, row]));
  const writes: Array<
    | { type: "insert" | "update"; value: GatewayRunNode }
    | { type: "delete"; key: string }
  > = [];

  for (const row of next) {
    const current = previousRows.get(row.id);
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
