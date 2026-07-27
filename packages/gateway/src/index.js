// @smithers-type-exports-begin
/** @typedef {import("./auth/scopes.js").GatewayScope} GatewayScope */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").SmithersApiVersion} SmithersApiVersion */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").JsonSchema} JsonSchema */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayRpcErrorCode} GatewayRpcErrorCode */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayRpcErrorDefinition} GatewayRpcErrorDefinition */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayRpcDefinition} GatewayRpcDefinition */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayRpcMethod} GatewayRpcMethod */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").LaunchRunRequest} LaunchRunRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").LaunchRunResponse} LaunchRunResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ResumeRunRequest} ResumeRunRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ResumeRunResponse} ResumeRunResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").CancelRunRequest} CancelRunRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").CancelRunResponse} CancelRunResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").PauseRunRequest} PauseRunRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").PauseRunResponse} PauseRunResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").HijackRunRequest} HijackRunRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").HijackRunResponse} HijackRunResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").RewindRunRequest} RewindRunRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").SubmitApprovalRequest} SubmitApprovalRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").SubmitApprovalResponse} SubmitApprovalResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").SubmitSignalRequest} SubmitSignalRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GetRunRequest} GetRunRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListRunsRequest} ListRunsRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayRunSummary} GatewayRunSummary */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListRunsResponse} ListRunsResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListRunDescendantsRequest} ListRunDescendantsRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayRunDescendant} GatewayRunDescendant */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListRunDescendantsResponse} ListRunDescendantsResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GetSchemaSignatureRequest} GetSchemaSignatureRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GetSchemaSignatureResponse} GetSchemaSignatureResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayWorkflowSummary} GatewayWorkflowSummary */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListWorkflowsRequest} ListWorkflowsRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListWorkflowsResponse} ListWorkflowsResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayApprovalSummary} GatewayApprovalSummary */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListApprovalsRequest} ListApprovalsRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListApprovalsResponse} ListApprovalsResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayDocRow} GatewayDocRow */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListDocsRequest} ListDocsRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListDocsResponse} ListDocsResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").StreamRunEventsRequest} StreamRunEventsRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").StreamRunEventsResponse} StreamRunEventsResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").StreamDevToolsRequest} StreamDevToolsRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GetDevToolsSnapshotRequest} GetDevToolsSnapshotRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GetDevToolsSnapshotResponse} GetDevToolsSnapshotResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").NodeRequest} NodeRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").CronListRequest} CronListRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").CronCreateRequest} CronCreateRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").CronDeleteRequest} CronDeleteRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").CronRunRequest} CronRunRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayAccount} GatewayAccount */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListAccountsRequest} ListAccountsRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListAccountsResponse} ListAccountsResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayMemoryFact} GatewayMemoryFact */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListMemoryFactsRequest} ListMemoryFactsRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListMemoryFactsResponse} ListMemoryFactsResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayPrompt} GatewayPrompt */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListPromptsRequest} ListPromptsRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListPromptsResponse} ListPromptsResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayScoreRow} GatewayScoreRow */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListScoresRequest} ListScoresRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListScoresResponse} ListScoresResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayComparisonScoreRow} GatewayComparisonScoreRow */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListScoresForRunsRequest} ListScoresForRunsRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListScoresForRunsResponse} ListScoresForRunsResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GetScoreDetailRequest} GetScoreDetailRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayScoreDetail} GatewayScoreDetail */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GetScoreDetailResponse} GetScoreDetailResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayDocKind} GatewayDocKind */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").GatewayTicketRow} GatewayTicketRow */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListTicketsRequest} ListTicketsRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").ListTicketsResponse} ListTicketsResponse */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").CreateTicketRequest} CreateTicketRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").UpdateTicketRequest} UpdateTicketRequest */
/** @typedef {import("./rpc/gatewayRpcTypes.ts").DeleteTicketRequest} DeleteTicketRequest */
// @smithers-type-exports-end

export {
  SMITHERS_API_VERSION,
  GATEWAY_EVENT_WINDOW_DEFAULT,
  anyJsonSchema,
  GATEWAY_RPC_ERRORS,
  GATEWAY_RPC_LEGACY_METHOD_ALIASES,
  GATEWAY_RPC_DEFINITIONS,
  canonicalGatewayRpcMethod,
  getGatewayRpcDefinition,
  getRequiredScopeForGatewayMethod,
  listGatewayRpcMethods,
  isGatewayRpcMethod,
  getGatewayScopeValues,
} from "./rpc/index.js";
export {
  apiCollectionNames,
  serializeAccountRow,
  serializeApprovalRow,
  serializeCronRow,
  serializeDocRow,
  serializeMemoryFactRow,
  serializePromptRow,
  serializeRunEventRow,
  serializeRunRow,
  serializeComparisonScoreRow,
  serializeScoreDetailRow,
  serializeScoreRow,
  serializeTicketRow,
  serializeWorkflowRow,
} from "./api/index.js";
export { GATEWAY_SCOPE_VALUES, GATEWAY_SCOPE_DESCRIPTIONS, isGatewayScope, hasGatewayScope } from "./auth/scopes.js";
