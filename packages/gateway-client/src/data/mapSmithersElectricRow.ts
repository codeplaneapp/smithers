import {
  serializeApprovalRow,
  serializeCronRow,
  serializeDocRow,
  serializeMemoryFactRow,
  serializeRunEventRow,
  serializeRunRow,
  serializeScoreRow,
  serializeTicketRow,
} from "@smthrs/gateway/api";
import type { GatewayApprovalRow } from "../sync/GatewayApprovalRow.ts";
import type { GatewayCronRow } from "../sync/GatewayCronRow.ts";
import type { GatewayMemoryFactRow } from "../sync/GatewayMemoryFactRow.ts";
import type { GatewayRunEventRow } from "../sync/GatewayRunEventRow.ts";
import type { GatewayRunNode } from "../sync/GatewayRunNode.ts";
import type { GatewayRunRow } from "../sync/GatewayRunRow.ts";
import type { GatewayRunSummaryRow } from "../sync/GatewayRunSummaryRow.ts";
import type { GatewayScoreRow } from "../sync/GatewayScoreRow.ts";
import type { GatewayTicketRow } from "../sync/GatewayTicketRow.ts";
import { toRunStatus } from "../sync/snapshotToGatewayRunNode.ts";
import type { GatewayDocRow } from "./GatewayDocRow.ts";

function valueAt(row: Record<string, unknown>, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake];
}

function numberAt(row: Record<string, unknown>, camel: string, snake: string): number | undefined {
  const value = valueAt(row, camel, snake);
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function stringAt(row: Record<string, unknown>, camel: string, snake: string): string | undefined {
  const value = valueAt(row, camel, snake);
  return typeof value === "string" ? value : undefined;
}

export function mapSmithersElectricRow(collection: "runs", row: Record<string, unknown>): GatewayRunSummaryRow;
export function mapSmithersElectricRow(collection: "run", row: Record<string, unknown>): GatewayRunRow;
export function mapSmithersElectricRow(collection: "events", row: Record<string, unknown>): GatewayRunEventRow;
export function mapSmithersElectricRow(collection: "approvals", row: Record<string, unknown>): GatewayApprovalRow;
export function mapSmithersElectricRow(collection: "docs", row: Record<string, unknown>): GatewayDocRow;
export function mapSmithersElectricRow(collection: "scores", row: Record<string, unknown>): GatewayScoreRow;
export function mapSmithersElectricRow(collection: "tickets", row: Record<string, unknown>): GatewayTicketRow;
export function mapSmithersElectricRow(collection: "memoryFacts", row: Record<string, unknown>): GatewayMemoryFactRow;
export function mapSmithersElectricRow(collection: "crons", row: Record<string, unknown>): GatewayCronRow;
export function mapSmithersElectricRow(collection: "nodes", row: Record<string, unknown>): GatewayRunNode;
export function mapSmithersElectricRow(collection: string, row: Record<string, unknown>) {
  switch (collection) {
    case "runs":
    case "run":
      return serializeRunRow(row);
    case "events":
      return serializeRunEventRow(row);
    case "approvals":
      return serializeApprovalRow(row);
    case "docs":
      return serializeDocRow(row);
    case "scores":
      return serializeScoreRow(row);
    case "tickets":
      return serializeTicketRow(row);
    case "memoryFacts":
      return serializeMemoryFactRow(row);
    case "crons":
      return serializeCronRow(row);
    // Unlike the cases above there is no shared gateway serializer for node
    // rows, so the Electric row is shaped here into the minimal GatewayRunNode
    // the tree UI needs. `childIds: []` is intentional: `_smithers_nodes` rows
    // persist no parent/child linkage, so every row is a root — the tree
    // builder preserves the whole forest beneath a synthetic run root rather
    // than dropping siblings. The persisted `state` vocabulary (`in-progress`,
    // `finished`, `pending`, `waiting-*`, …) is normalized onto the UI's
    // NodeStatus tones so the rows match the local snapshot path.
    case "nodes": {
      const runId = stringAt(row, "runId", "run_id") ?? "";
      const nodeId = stringAt(row, "nodeId", "node_id") ?? "";
      const iteration = numberAt(row, "iteration", "iteration") ?? 0;
      const attempt = numberAt(row, "lastAttempt", "last_attempt");
      const state = stringAt(row, "state", "state") ?? "queued";
      const label = stringAt(row, "label", "label") ?? nodeId;
      const outputTable = stringAt(row, "outputTable", "output_table") ?? "task";
      return {
        key: `${runId}:${nodeId}:${iteration}`,
        id: nodeId,
        name: label,
        cardLabel: label,
        kind: outputTable,
        status: toRunStatus(state),
        iteration,
        ...(attempt !== undefined ? { attempt } : {}),
        childIds: [],
      } satisfies GatewayRunNode;
    }
    default:
      return row;
  }
}
