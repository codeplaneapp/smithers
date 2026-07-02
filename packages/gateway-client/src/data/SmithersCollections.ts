import type { Collection } from "@tanstack/db";
import type {
  CronListRequest,
  ListApprovalsRequest,
  ListDocsRequest,
  ListMemoryFactsRequest,
  ListRunsRequest,
  ListScoresRequest,
  ListTicketsRequest,
  ListWorkflowsRequest,
} from "@smithers-orchestrator/gateway/rpc";
import type { GatewayApprovalRow } from "../sync/GatewayApprovalRow.ts";
import type { GatewayCronRow } from "../sync/GatewayCronRow.ts";
import type { GatewayMemoryFactRow } from "../sync/GatewayMemoryFactRow.ts";
import type { GatewayPromptRow } from "../sync/GatewayPromptRow.ts";
import type { GatewayRunEventRow } from "../sync/GatewayRunEventRow.ts";
import type { GatewayRunNode } from "../sync/GatewayRunNode.ts";
import type { GatewayRunRow } from "../sync/GatewayRunRow.ts";
import type { GatewayRunSummaryRow } from "../sync/GatewayRunSummaryRow.ts";
import type { GatewayScoreRow } from "../sync/GatewayScoreRow.ts";
import type { GatewayTicketRow } from "../sync/GatewayTicketRow.ts";
import type { GatewayWorkflowRow } from "../sync/GatewayWorkflowRow.ts";
import type { GatewayDocRow } from "./GatewayDocRow.ts";
import type { SmithersDataClient } from "./SmithersDataClient.ts";

export type SmithersCollections = {
  client: SmithersDataClient;
  runs(params?: ListRunsRequest): Collection<GatewayRunSummaryRow, string>;
  run(runId: string): Collection<GatewayRunRow, string>;
  runTree(runId: string): Collection<GatewayRunNode, string>;
  events(runId: string, maxRows?: number): Collection<GatewayRunEventRow, string>;
  approvals(params?: ListApprovalsRequest): Collection<GatewayApprovalRow, string>;
  workflows(params?: ListWorkflowsRequest): Collection<GatewayWorkflowRow, string>;
  docs(params?: ListDocsRequest): Collection<GatewayDocRow, string>;
  prompts(): Collection<GatewayPromptRow, string>;
  scores(params?: ListScoresRequest): Collection<GatewayScoreRow, string>;
  tickets(params?: ListTicketsRequest): Collection<GatewayTicketRow, string>;
  memoryFacts(params?: ListMemoryFactsRequest): Collection<GatewayMemoryFactRow, string>;
  crons(params?: CronListRequest): Collection<GatewayCronRow, string>;
  nodes(runId: string): Collection<GatewayRunNode, string>;
  runEvents(runId: string, maxRows?: number): Collection<GatewayRunEventRow, string>;
  invalidate(collections?: readonly string[]): Promise<void>;
  connect(): void;
  close(): void;
};
