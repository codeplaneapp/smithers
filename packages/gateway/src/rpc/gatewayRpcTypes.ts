/**
 * Gateway-owned RPC catalog metadata plus compatibility re-exports for the
 * protocol-owned wire contract.
 *
 * This file deliberately does not share a basename with `index.js`: a
 * same-basename `.js`/`.ts` pair both compile to one `.d.ts` and the type-only
 * twin silently drops every value export from the `.js`.
 */
import type {
  GatewayRpcErrorCode,
  GatewayRpcMethod,
  SmithersApiVersion,
} from "@smithers-orchestrator/protocol/gateway-rpc";
import type { GatewayScope } from "../auth/scopes.js";

export type {
  CancelRunRequest,
  CancelRunResponse,
  CreateTicketRequest,
  CronCreateRequest,
  CronDeleteRequest,
  CronListRequest,
  CronRunRequest,
  DeleteTicketRequest,
  GatewayAccount,
  GatewayApprovalSummary,
  GatewayComparisonScoreRow,
  GatewayDocKind,
  GatewayDocRow,
  GatewayEventFrame,
  GatewayMemoryFact,
  GatewayPrompt,
  GatewayResponseFrame,
  GatewayRpcErrorCode,
  GatewayRpcMethod,
  GatewayScoreDetail,
  GatewayScoreRow,
  GatewayTicketRow,
  GatewayWorkflowSummary,
  GetDevToolsSnapshotRequest,
  GetDevToolsSnapshotResponse,
  GetRunRequest,
  GetRunDiffRequest,
  GetRunDiffResponse,
  GetRunDiffOversizedResponse,
  GatewayDiffBundle,
  GatewayDiffPatch,
  GetSchemaSignatureRequest,
  GetSchemaSignatureResponse,
  GetScoreDetailRequest,
  GetScoreDetailResponse,
  HijackRunRequest,
  HijackRunResponse,
  LaunchRunRequest,
  LaunchRunResponse,
  ListAccountsRequest,
  ListAccountsResponse,
  ListApprovalsRequest,
  ListApprovalsResponse,
  ListDocsRequest,
  ListDocsResponse,
  ListMemoryFactsRequest,
  ListMemoryFactsResponse,
  ListPromptsRequest,
  ListPromptsResponse,
  ListRunsRequest,
  ListScoresForRunsRequest,
  ListScoresForRunsResponse,
  ListScoresRequest,
  ListScoresResponse,
  ListTicketsRequest,
  ListTicketsResponse,
  ListWorkflowsRequest,
  ListWorkflowsResponse,
  NodeRequest,
  PauseRunRequest,
  PauseRunResponse,
  ResumeRunRequest,
  ResumeRunResponse,
  RewindRunRequest,
  SmithersApiVersion,
  StreamDevToolsRequest,
  StreamRunEventsRequest,
  StreamRunEventsResponse,
  SubmitApprovalRequest,
  SubmitApprovalResponse,
  SubmitSignalRequest,
  UpdateTicketRequest,
  WhatHappenedRequest,
  WhatHappenedResponse,
  RunRecapRequest,
  RunRecapResponse,
} from "@smithers-orchestrator/protocol/gateway-rpc";

export type JsonSchema = {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly default?: unknown;
  readonly nullable?: boolean;
  readonly items?: JsonSchema;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
};

export type GatewayRpcErrorDefinition = {
  readonly version: SmithersApiVersion;
  readonly code: GatewayRpcErrorCode;
  readonly httpStatus: number;
  readonly description: string;
};

export type GatewayRpcDefinition = {
  readonly version: SmithersApiVersion;
  readonly method: GatewayRpcMethod;
  readonly title: string;
  readonly description: string;
  readonly maturity: "stable";
  readonly transport: "http" | "websocket" | "http+websocket";
  readonly requiredScope: GatewayScope;
  readonly requestSchema: JsonSchema;
  readonly responseSchema: JsonSchema;
  readonly errors: readonly GatewayRpcErrorCode[];
  readonly exampleRequest: unknown;
  readonly exampleResponse: unknown;
};
