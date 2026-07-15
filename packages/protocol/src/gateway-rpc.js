// @smithers-type-exports-begin
/** @typedef {import("./gatewayRpcTypes.ts").SmithersApiVersion} SmithersApiVersion */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayRpcErrorCode} GatewayRpcErrorCode */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayRpcMethod} GatewayRpcMethod */
/** @typedef {import("./gatewayRpcTypes.ts").LaunchRunRequest} LaunchRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").LaunchRunResponse} LaunchRunResponse */
/** @typedef {import("./gatewayRpcTypes.ts").ResumeRunRequest} ResumeRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ResumeRunResponse} ResumeRunResponse */
/** @typedef {import("./gatewayRpcTypes.ts").CancelRunRequest} CancelRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").CancelRunResponse} CancelRunResponse */
/** @typedef {import("./gatewayRpcTypes.ts").PauseRunRequest} PauseRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").PauseRunResponse} PauseRunResponse */
/** @typedef {import("./gatewayRpcTypes.ts").HijackRunRequest} HijackRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").HijackRunResponse} HijackRunResponse */
/** @typedef {import("./gatewayRpcTypes.ts").RewindRunRequest} RewindRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").SubmitApprovalRequest} SubmitApprovalRequest */
/** @typedef {import("./gatewayRpcTypes.ts").SubmitApprovalResponse} SubmitApprovalResponse */
/** @typedef {import("./gatewayRpcTypes.ts").SubmitSignalRequest} SubmitSignalRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GetRunRequest} GetRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListRunsRequest} ListRunsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GetSchemaSignatureRequest} GetSchemaSignatureRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GetSchemaSignatureResponse} GetSchemaSignatureResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayWorkflowSummary} GatewayWorkflowSummary */
/** @typedef {import("./gatewayRpcTypes.ts").ListWorkflowsRequest} ListWorkflowsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListWorkflowsResponse} ListWorkflowsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayApprovalSummary} GatewayApprovalSummary */
/** @typedef {import("./gatewayRpcTypes.ts").ListApprovalsRequest} ListApprovalsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListApprovalsResponse} ListApprovalsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayDocRow} GatewayDocRow */
/** @typedef {import("./gatewayRpcTypes.ts").ListDocsRequest} ListDocsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListDocsResponse} ListDocsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").StreamRunEventsRequest} StreamRunEventsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").StreamRunEventsResponse} StreamRunEventsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").StreamDevToolsRequest} StreamDevToolsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GetDevToolsSnapshotRequest} GetDevToolsSnapshotRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GetDevToolsSnapshotResponse} GetDevToolsSnapshotResponse */
/** @typedef {import("./gatewayRpcTypes.ts").NodeRequest} NodeRequest */
/** @typedef {import("./gatewayRpcTypes.ts").WhatHappenedRequest} WhatHappenedRequest */
/** @typedef {import("./gatewayRpcTypes.ts").WhatHappenedResponse} WhatHappenedResponse */
/** @typedef {import("./gatewayRpcTypes.ts").CronListRequest} CronListRequest */
/** @typedef {import("./gatewayRpcTypes.ts").CronCreateRequest} CronCreateRequest */
/** @typedef {import("./gatewayRpcTypes.ts").CronDeleteRequest} CronDeleteRequest */
/** @typedef {import("./gatewayRpcTypes.ts").CronRunRequest} CronRunRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayAccount} GatewayAccount */
/** @typedef {import("./gatewayRpcTypes.ts").ListAccountsRequest} ListAccountsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListAccountsResponse} ListAccountsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayMemoryFact} GatewayMemoryFact */
/** @typedef {import("./gatewayRpcTypes.ts").ListMemoryFactsRequest} ListMemoryFactsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListMemoryFactsResponse} ListMemoryFactsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayPrompt} GatewayPrompt */
/** @typedef {import("./gatewayRpcTypes.ts").ListPromptsRequest} ListPromptsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListPromptsResponse} ListPromptsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayScoreRow} GatewayScoreRow */
/** @typedef {import("./gatewayRpcTypes.ts").ListScoresRequest} ListScoresRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListScoresResponse} ListScoresResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayComparisonScoreRow} GatewayComparisonScoreRow */
/** @typedef {import("./gatewayRpcTypes.ts").ListScoresForRunsRequest} ListScoresForRunsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListScoresForRunsResponse} ListScoresForRunsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GetScoreDetailRequest} GetScoreDetailRequest */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayScoreDetail} GatewayScoreDetail */
/** @typedef {import("./gatewayRpcTypes.ts").GetScoreDetailResponse} GetScoreDetailResponse */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayDocKind} GatewayDocKind */
/** @typedef {import("./gatewayRpcTypes.ts").GatewayTicketRow} GatewayTicketRow */
/** @typedef {import("./gatewayRpcTypes.ts").ListTicketsRequest} ListTicketsRequest */
/** @typedef {import("./gatewayRpcTypes.ts").ListTicketsResponse} ListTicketsResponse */
/** @typedef {import("./gatewayRpcTypes.ts").CreateTicketRequest} CreateTicketRequest */
/** @typedef {import("./gatewayRpcTypes.ts").UpdateTicketRequest} UpdateTicketRequest */
/** @typedef {import("./gatewayRpcTypes.ts").DeleteTicketRequest} DeleteTicketRequest */
/**
 * @template [Payload=unknown]
 * @typedef {import("./gatewayRpcTypes.ts").GatewayEventFrame<Payload>} GatewayEventFrame
 */
/**
 * @template [Payload=unknown]
 * @typedef {import("./gatewayRpcTypes.ts").GatewayResponseFrame<Payload>} GatewayResponseFrame
 */
// @smithers-type-exports-end

export {};
