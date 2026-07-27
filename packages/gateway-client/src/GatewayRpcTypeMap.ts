import type {
  CancelRunRequest,
  CancelRunResponse,
  PauseRunRequest,
  PauseRunResponse,
  CronCreateRequest,
  CronDeleteRequest,
  CronListRequest,
  CronRunRequest,
  GatewayRpcMethod,
  HijackRunRequest,
  HijackRunResponse,
  LaunchRunRequest,
  LaunchRunResponse,
  ListAccountsRequest,
  ListAccountsResponse,
  ListApprovalsRequest,
  ListApprovalsResponse,
  ListMemoryFactsRequest,
  ListMemoryFactsResponse,
  ListPromptsRequest,
  ListPromptsResponse,
  ListScoresForRunsRequest,
  ListScoresForRunsResponse,
  GetScoreDetailRequest,
  GetScoreDetailResponse,
  ListRunsRequest,
  ListRunsResponse,
  ListRunDescendantsRequest,
  ListRunDescendantsResponse,
  ListScoresRequest,
  ListScoresResponse,
  ListTicketsRequest,
  ListTicketsResponse,
  CreateTicketRequest,
  UpdateTicketRequest,
  DeleteTicketRequest,
  ListWorkflowsRequest,
  ListWorkflowsResponse,
  NodeRequest,
  RewindRunRequest,
  RewindRunResponse,
  ResumeRunRequest,
  ResumeRunResponse,
  StreamDevToolsRequest,
  StreamRunEventsRequest,
  StreamRunEventsResponse,
  SubmitApprovalRequest,
  SubmitApprovalResponse,
  SubmitSignalRequest,
  WhatHappenedRequest,
  WhatHappenedResponse,
  GetRunRequest,
  ListRunTokenUsageRequest,
  ListRunTokenUsageResponse,
  GetRunDiffRequest,
  GetRunDiffResponse,
  GetDevToolsSnapshotRequest,
  GetDevToolsSnapshotResponse,
  GetSchemaSignatureRequest,
  GetSchemaSignatureResponse,
  ListDocsRequest,
  ListDocsResponse,
  GatewayTicketRow,
  CreateBrowserSessionRequest,
  BrowserActRequest,
  BrowserContextRequest,
  BrowserPickRequest,
  CloseBrowserSessionRequest,
  CreateBrowserSessionResponse,
  BrowserActResponse,
  BrowserContextResponse,
  BrowserPickResponse,
  CloseBrowserSessionResponse,
  ListBrowserSessionsResponse,
} from "@smithers-orchestrator/protocol/gateway-rpc";
import type { GatewayCronRow } from "./sync/GatewayCronRow.ts";
import type { UsageReport, UsageWindow } from "@smithers-orchestrator/usage";

export type { UsageReport, UsageWindow } from "@smithers-orchestrator/usage";
export type { RunStartedBy } from "@smithers-orchestrator/protocol/gateway-rpc";

export type ListUsageReportsRequest = { fresh?: boolean };

export type GatewayRpcRequestMap = {
  launchRun: LaunchRunRequest;
  resumeRun: ResumeRunRequest;
  cancelRun: CancelRunRequest;
  pauseRun: PauseRunRequest;
  hijackRun: HijackRunRequest;
  rewindRun: RewindRunRequest;
  submitApproval: SubmitApprovalRequest;
  submitSignal: SubmitSignalRequest;
  getRun: GetRunRequest;
  listRunTokenUsage: ListRunTokenUsageRequest;
  listRuns: ListRunsRequest;
  listRunDescendants: ListRunDescendantsRequest;
  listWorkflows: ListWorkflowsRequest;
  listApprovals: ListApprovalsRequest;
  streamRunEvents: StreamRunEventsRequest;
  streamDevTools: StreamDevToolsRequest;
  getDevToolsSnapshot: GetDevToolsSnapshotRequest;
  getNodeOutput: NodeRequest;
  getNodeDiff: NodeRequest;
  getRunDiff: GetRunDiffRequest;
  whatHappened: WhatHappenedRequest;
  cronList: CronListRequest;
  cronCreate: CronCreateRequest;
  cronDelete: CronDeleteRequest;
  cronRun: CronRunRequest;
  listAccounts: ListAccountsRequest;
  listUsageReports: ListUsageReportsRequest;
  listMemoryFacts: ListMemoryFactsRequest;
  listPrompts: ListPromptsRequest;
  listScores: ListScoresRequest;
  listScoresForRuns: ListScoresForRunsRequest;
  getScoreDetail: GetScoreDetailRequest;
  listTickets: ListTicketsRequest;
  createTicket: CreateTicketRequest;
  updateTicket: UpdateTicketRequest;
  deleteTicket: DeleteTicketRequest;
  getSchemaSignature: GetSchemaSignatureRequest;
  listDocs: ListDocsRequest;
  createBrowserSession: CreateBrowserSessionRequest;
  browserAct: BrowserActRequest;
  browserContext: BrowserContextRequest;
  browserPick: BrowserPickRequest;
  closeBrowserSession: CloseBrowserSessionRequest;
  listBrowserSessions: Record<string, never>;
};

export type GatewayRpcResponseMap = {
  launchRun: LaunchRunResponse;
  resumeRun: ResumeRunResponse;
  cancelRun: CancelRunResponse;
  pauseRun: PauseRunResponse;
  hijackRun: HijackRunResponse;
  rewindRun: RewindRunResponse;
  submitApproval: SubmitApprovalResponse;
  submitSignal: Record<string, unknown>;
  getRun: Record<string, unknown>;
  listRunTokenUsage: ListRunTokenUsageResponse;
  listRuns: ListRunsResponse;
  listRunDescendants: ListRunDescendantsResponse;
  listWorkflows: ListWorkflowsResponse;
  listApprovals: ListApprovalsResponse;
  streamRunEvents: StreamRunEventsResponse;
  streamDevTools: Record<string, unknown>;
  getDevToolsSnapshot: GetDevToolsSnapshotResponse;
  getNodeOutput: Record<string, unknown>;
  getNodeDiff: Record<string, unknown>;
  getRunDiff: GetRunDiffResponse;
  whatHappened: WhatHappenedResponse;
  cronList: GatewayCronRow[];
  cronCreate: Record<string, unknown>;
  cronDelete: Record<string, unknown>;
  cronRun: LaunchRunResponse;
  listAccounts: ListAccountsResponse;
  listUsageReports: UsageReport[];
  listMemoryFacts: ListMemoryFactsResponse;
  listPrompts: ListPromptsResponse;
  listScores: ListScoresResponse;
  listScoresForRuns: ListScoresForRunsResponse;
  getScoreDetail: GetScoreDetailResponse;
  listTickets: ListTicketsResponse;
  createTicket: GatewayTicketRow;
  updateTicket: GatewayTicketRow;
  deleteTicket: { path: string; deleted: boolean };
  getSchemaSignature: GetSchemaSignatureResponse;
  listDocs: ListDocsResponse;
  createBrowserSession: CreateBrowserSessionResponse;
  browserAct: BrowserActResponse;
  browserContext: BrowserContextResponse;
  browserPick: BrowserPickResponse;
  closeBrowserSession: CloseBrowserSessionResponse;
  listBrowserSessions: ListBrowserSessionsResponse;
};

export type GatewayRpcParams<Method extends GatewayRpcMethod> = GatewayRpcRequestMap[Method];

export type GatewayRpcPayload<Method extends GatewayRpcMethod> = GatewayRpcResponseMap[Method];
