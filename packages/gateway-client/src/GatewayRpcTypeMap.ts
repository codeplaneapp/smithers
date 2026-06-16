import type {
  CancelRunRequest,
  CancelRunResponse,
  CronCreateRequest,
  CronDeleteRequest,
  CronListRequest,
  CronRunRequest,
  GatewayRpcMethod,
  GetSchemaSignatureRequest,
  GetSchemaSignatureResponse,
  HijackRunRequest,
  HijackRunResponse,
  LaunchRunRequest,
  LaunchRunResponse,
  ListApprovalsRequest,
  ListApprovalsResponse,
  ListDocsRequest,
  ListDocsResponse,
  ListRunsRequest,
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
  getSchemaSignature: GetSchemaSignatureRequest;
  listWorkflows: ListWorkflowsRequest;
  listApprovals: ListApprovalsRequest;
  listDocs: ListDocsRequest;
  streamRunEvents: StreamRunEventsRequest;
  streamDevTools: StreamDevToolsRequest;
  getNodeOutput: NodeRequest;
  getNodeDiff: NodeRequest;
  cronList: CronListRequest;
  cronCreate: CronCreateRequest;
  cronDelete: CronDeleteRequest;
  cronRun: CronRunRequest;
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
  getSchemaSignature: GetSchemaSignatureResponse;
  listWorkflows: ListWorkflowsResponse;
  listApprovals: ListApprovalsResponse;
  listDocs: ListDocsResponse;
  streamRunEvents: StreamRunEventsResponse;
  streamDevTools: Record<string, unknown>;
  getNodeOutput: Record<string, unknown>;
  getNodeDiff: Record<string, unknown>;
  cronList: Array<Record<string, unknown>>;
  cronCreate: Record<string, unknown>;
  cronDelete: Record<string, unknown>;
  cronRun: LaunchRunResponse;
};

export type GatewayRpcParams<Method extends GatewayRpcMethod> = GatewayRpcRequestMap[Method];

export type GatewayRpcPayload<Method extends GatewayRpcMethod> = GatewayRpcResponseMap[Method];
