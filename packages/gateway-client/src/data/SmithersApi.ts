import type {
  CancelRunRequest,
  CancelRunResponse,
  CronCreateRequest,
  CronDeleteRequest,
  CronListRequest,
  CronRunRequest,
  GetRunRequest,
  GetSchemaSignatureResponse,
  HijackRunRequest,
  HijackRunResponse,
  LaunchRunRequest,
  LaunchRunResponse,
  ListApprovalsRequest,
  ListApprovalsResponse,
  ListDocsRequest,
  ListDocsResponse,
  ListMemoryFactsRequest,
  ListPromptsResponse,
  ListRunsRequest,
  ListScoresRequest,
  ListTicketsRequest,
  ListWorkflowsRequest,
  ListWorkflowsResponse,
  NodeRequest,
  CreateTicketRequest,
  UpdateTicketRequest,
  DeleteTicketRequest,
  ResumeRunRequest,
  ResumeRunResponse,
  RewindRunRequest,
  SubmitApprovalRequest,
  SubmitApprovalResponse,
  SubmitSignalRequest,
} from "@smithers-orchestrator/gateway/rpc";
import type { GatewayCronRow } from "../sync/GatewayCronRow.ts";
import type { GatewayMemoryFactRow } from "../sync/GatewayMemoryFactRow.ts";
import type { GatewayPromptRow } from "../sync/GatewayPromptRow.ts";
import type { GatewayRunEventRow } from "../sync/GatewayRunEventRow.ts";
import type { GatewayRunNode } from "../sync/GatewayRunNode.ts";
import type { GatewayRunRow } from "../sync/GatewayRunRow.ts";
import type { GatewayRunSummaryRow } from "../sync/GatewayRunSummaryRow.ts";
import type { GatewayScoreRow } from "../sync/GatewayScoreRow.ts";
import type { GatewayTicketRow } from "../sync/GatewayTicketRow.ts";
import type { ApiMutationResult } from "./ApiMutationResult.ts";

export type SmithersApi = {
  listRuns(params?: ListRunsRequest): Promise<GatewayRunSummaryRow[]>;
  getRun(params: GetRunRequest): Promise<GatewayRunRow>;
  launchRun(params: LaunchRunRequest): Promise<ApiMutationResult<LaunchRunResponse>>;
  resumeRun(params: ResumeRunRequest): Promise<ApiMutationResult<ResumeRunResponse>>;
  cancelRun(params: CancelRunRequest): Promise<ApiMutationResult<CancelRunResponse>>;
  hijackRun(params: HijackRunRequest): Promise<ApiMutationResult<HijackRunResponse>>;
  rewindRun(params: RewindRunRequest): Promise<ApiMutationResult<Record<string, unknown>>>;
  listRunEvents(params: { runId: string; afterSeq?: number; limit?: number }): Promise<GatewayRunEventRow[]>;
  getRunTree(params: { runId: string; frameNo?: number }): Promise<GatewayRunNode[]>;
  getNodeOutput(params: NodeRequest): Promise<Record<string, unknown>>;
  getNodeDiff(params: NodeRequest): Promise<Record<string, unknown>>;
  listApprovals(params?: ListApprovalsRequest): Promise<ListApprovalsResponse>;
  submitApproval(params: SubmitApprovalRequest & { approvalId?: string }): Promise<ApiMutationResult<SubmitApprovalResponse>>;
  submitSignal(params: SubmitSignalRequest): Promise<ApiMutationResult<Record<string, unknown>>>;
  listWorkflows(params?: ListWorkflowsRequest): Promise<ListWorkflowsResponse>;
  getSchemaSignature(): Promise<GetSchemaSignatureResponse>;
  cronList(params?: CronListRequest): Promise<GatewayCronRow[]>;
  cronCreate(params: CronCreateRequest): Promise<ApiMutationResult<GatewayCronRow>>;
  cronDelete(params: CronDeleteRequest): Promise<ApiMutationResult<Record<string, unknown>>>;
  cronRun(params: CronRunRequest): Promise<ApiMutationResult<LaunchRunResponse>>;
  listDocs(params?: ListDocsRequest): Promise<ListDocsResponse>;
  listPrompts(): Promise<ListPromptsResponse>;
  listMemoryFacts(params?: ListMemoryFactsRequest): Promise<GatewayMemoryFactRow[]>;
  listScores(params?: ListScoresRequest): Promise<GatewayScoreRow[]>;
  listTickets(params?: ListTicketsRequest): Promise<GatewayTicketRow[]>;
  createTicket(params: CreateTicketRequest): Promise<ApiMutationResult<GatewayTicketRow>>;
  updateTicket(params: UpdateTicketRequest): Promise<ApiMutationResult<GatewayTicketRow>>;
  deleteTicket(params: DeleteTicketRequest): Promise<ApiMutationResult<{ path: string; deleted: boolean }>>;
};
