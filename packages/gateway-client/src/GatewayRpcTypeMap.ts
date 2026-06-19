import type {
  CancelRunRequest,
  CancelRunResponse,
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
  ListPromptsRequest,
  ListRunsRequest,
  ListScoresRequest,
  ListTicketsRequest,
  CreateTicketRequest,
  UpdateTicketRequest,
  DeleteTicketRequest,
  ListWorkflowsRequest,
  ListWorkflowsResponse,
  NodeRequest,
  RewindRunRequest,
  ResumeRunRequest,
  ResumeRunResponse,
  StreamDevToolsRequest,
  StreamRunEventsRequest,
  StreamRunEventsResponse,
  SubmitApprovalRequest,
  SubmitApprovalResponse,
  SubmitSignalRequest,
  GetRunRequest,
} from "@smithers-orchestrator/gateway/rpc";
import type { GatewayCronRow } from "./sync/GatewayCronRow.ts";
import type { GatewayMemoryFactRow } from "./sync/GatewayMemoryFactRow.ts";
import type { GatewayPromptRow } from "./sync/GatewayPromptRow.ts";
import type { GatewayScoreRow } from "./sync/GatewayScoreRow.ts";
import type { GatewayTicketRow } from "./sync/GatewayTicketRow.ts";

export type GatewayRpcRequestMap = {
  launchRun: LaunchRunRequest;
  resumeRun: ResumeRunRequest;
  cancelRun: CancelRunRequest;
  hijackRun: HijackRunRequest;
  rewindRun: RewindRunRequest;
  submitApproval: SubmitApprovalRequest;
  submitSignal: SubmitSignalRequest;
  getRun: GetRunRequest;
  listRuns: ListRunsRequest;
  listWorkflows: ListWorkflowsRequest;
  listApprovals: ListApprovalsRequest;
  streamRunEvents: StreamRunEventsRequest;
  streamDevTools: StreamDevToolsRequest;
  getNodeOutput: NodeRequest;
  getNodeDiff: NodeRequest;
  cronList: CronListRequest;
  cronCreate: CronCreateRequest;
  cronDelete: CronDeleteRequest;
  cronRun: CronRunRequest;
  listAccounts: ListAccountsRequest;
  listMemoryFacts: ListMemoryFactsRequest;
  listPrompts: ListPromptsRequest;
  listScores: ListScoresRequest;
  listTickets: ListTicketsRequest;
  createTicket: CreateTicketRequest;
  updateTicket: UpdateTicketRequest;
  deleteTicket: DeleteTicketRequest;
};

export type GatewayRpcResponseMap = {
  launchRun: LaunchRunResponse;
  resumeRun: ResumeRunResponse;
  cancelRun: CancelRunResponse;
  hijackRun: HijackRunResponse;
  rewindRun: Record<string, unknown>;
  submitApproval: SubmitApprovalResponse;
  submitSignal: Record<string, unknown>;
  getRun: Record<string, unknown>;
  listRuns: Array<Record<string, unknown>>;
  listWorkflows: ListWorkflowsResponse;
  listApprovals: ListApprovalsResponse;
  streamRunEvents: StreamRunEventsResponse;
  streamDevTools: Record<string, unknown>;
  getNodeOutput: Record<string, unknown>;
  getNodeDiff: Record<string, unknown>;
  cronList: GatewayCronRow[];
  cronCreate: Record<string, unknown>;
  cronDelete: Record<string, unknown>;
  cronRun: LaunchRunResponse;
  listAccounts: ListAccountsResponse;
  listMemoryFacts: GatewayMemoryFactRow[];
  listPrompts: GatewayPromptRow[];
  listScores: GatewayScoreRow[];
  listTickets: GatewayTicketRow[];
  createTicket: GatewayTicketRow;
  updateTicket: GatewayTicketRow;
  deleteTicket: { path: string; deleted: boolean };
};

export type GatewayRpcParams<Method extends GatewayRpcMethod> = GatewayRpcRequestMap[Method];

export type GatewayRpcPayload<Method extends GatewayRpcMethod> = GatewayRpcResponseMap[Method];
