import { SmithersApiVersion as SmithersApiVersion$1, GatewayRpcMethod as GatewayRpcMethod$1, GatewayRpcErrorCode as GatewayRpcErrorCode$1, BrowserActRequest as BrowserActRequest$1, BrowserActResponse as BrowserActResponse$1, BrowserAction as BrowserAction$1, BrowserActivityEvent as BrowserActivityEvent$1, BrowserActor as BrowserActor$1, BrowserClickAction as BrowserClickAction$1, BrowserContextRequest as BrowserContextRequest$1, BrowserContextResponse as BrowserContextResponse$1, BrowserContextSlice as BrowserContextSlice$1, BrowserFrameEvent as BrowserFrameEvent$1, BrowserJournalEntry as BrowserJournalEntry$1, BrowserLocator as BrowserLocator$1, BrowserModifier as BrowserModifier$1, BrowserOutcome as BrowserOutcome$1, BrowserPickRequest as BrowserPickRequest$1, BrowserPickResponse as BrowserPickResponse$1, BrowserPoint as BrowserPoint$1, BrowserRectangle as BrowserRectangle$1, BrowserRedaction as BrowserRedaction$1, BrowserScreenshot as BrowserScreenshot$1, BrowserSelection as BrowserSelection$1, BrowserSnapshot as BrowserSnapshot$1, BrowserSource as BrowserSource$1, BrowserSummary as BrowserSummary$1, BrowserViewport as BrowserViewport$1, CancelRunRequest as CancelRunRequest$1, CancelRunResponse as CancelRunResponse$1, CloseBrowserSessionRequest as CloseBrowserSessionRequest$1, CloseBrowserSessionResponse as CloseBrowserSessionResponse$1, CreateBrowserSessionRequest as CreateBrowserSessionRequest$1, CreateBrowserSessionResponse as CreateBrowserSessionResponse$1, CreateTicketRequest as CreateTicketRequest$1, CronCreateRequest as CronCreateRequest$1, CronDeleteRequest as CronDeleteRequest$1, CronListRequest as CronListRequest$1, CronRunRequest as CronRunRequest$1, DeleteTicketRequest as DeleteTicketRequest$1, GatewayAccount as GatewayAccount$1, GatewayApprovalSummary as GatewayApprovalSummary$1, GatewayComparisonScoreRow as GatewayComparisonScoreRow$1, GatewayDiffBundle as GatewayDiffBundle$1, GatewayDiffPatch as GatewayDiffPatch$1, GatewayDocKind as GatewayDocKind$1, GatewayDocRow as GatewayDocRow$1, GatewayMemoryFact as GatewayMemoryFact$1, GatewayPrompt as GatewayPrompt$1, GatewayScoreDetail as GatewayScoreDetail$1, GatewayScoreRow as GatewayScoreRow$1, GatewayTicketRow as GatewayTicketRow$1, GatewayWorkflowSummary as GatewayWorkflowSummary$1, GetDevToolsSnapshotRequest as GetDevToolsSnapshotRequest$1, GetDevToolsSnapshotResponse as GetDevToolsSnapshotResponse$1, GetRunDiffOversizedResponse as GetRunDiffOversizedResponse$1, GetRunDiffRequest as GetRunDiffRequest$1, GetRunDiffResponse as GetRunDiffResponse$1, GetRunRequest as GetRunRequest$1, GetSchemaSignatureRequest as GetSchemaSignatureRequest$1, GetSchemaSignatureResponse as GetSchemaSignatureResponse$1, GetScoreDetailRequest as GetScoreDetailRequest$1, GetScoreDetailResponse as GetScoreDetailResponse$1, HijackRunRequest as HijackRunRequest$1, HijackRunResponse as HijackRunResponse$1, LaunchRunRequest as LaunchRunRequest$1, LaunchRunResponse as LaunchRunResponse$1, ListAccountsRequest as ListAccountsRequest$1, ListAccountsResponse as ListAccountsResponse$1, ListApprovalsRequest as ListApprovalsRequest$1, ListApprovalsResponse as ListApprovalsResponse$1, ListBrowserSessionsResponse as ListBrowserSessionsResponse$1, ListDocsRequest as ListDocsRequest$1, ListDocsResponse as ListDocsResponse$1, ListMemoryFactsRequest as ListMemoryFactsRequest$1, ListMemoryFactsResponse as ListMemoryFactsResponse$1, ListPromptsRequest as ListPromptsRequest$1, ListPromptsResponse as ListPromptsResponse$1, ListRunTokenUsageRequest as ListRunTokenUsageRequest$1, ListRunTokenUsageResponse as ListRunTokenUsageResponse$1, ListRunsRequest as ListRunsRequest$1, ListScoresForRunsRequest as ListScoresForRunsRequest$1, ListScoresForRunsResponse as ListScoresForRunsResponse$1, ListScoresRequest as ListScoresRequest$1, ListScoresResponse as ListScoresResponse$1, ListTicketsRequest as ListTicketsRequest$1, ListTicketsResponse as ListTicketsResponse$1, ListWorkflowsRequest as ListWorkflowsRequest$1, ListWorkflowsResponse as ListWorkflowsResponse$1, NodeRequest as NodeRequest$1, PauseRunRequest as PauseRunRequest$1, PauseRunResponse as PauseRunResponse$1, ResumeRunRequest as ResumeRunRequest$1, ResumeRunResponse as ResumeRunResponse$1, RewindRunRequest as RewindRunRequest$1, RunTokenUsageEvent as RunTokenUsageEvent$1, StreamDevToolsRequest as StreamDevToolsRequest$1, StreamRunEventsRequest as StreamRunEventsRequest$1, StreamRunEventsResponse as StreamRunEventsResponse$1, SubmitApprovalRequest as SubmitApprovalRequest$1, SubmitApprovalResponse as SubmitApprovalResponse$1, SubmitSignalRequest as SubmitSignalRequest$1, UpdateTicketRequest as UpdateTicketRequest$1, WhatHappenedRequest as WhatHappenedRequest$1, WhatHappenedResponse as WhatHappenedResponse$1 } from '@smithers-orchestrator/protocol/gateway-rpc';

/** @typedef {(typeof GATEWAY_SCOPE_VALUES)[number]} GatewayScope */
declare const GATEWAY_SCOPE_VALUES: readonly ["run:read", "run:write", "run:admin", "approval:submit", "signal:submit", "cron:read", "cron:write", "account:read", "memory:read", "prompt:read", "score:read", "ticket:read", "ticket:write", "observability:read"];
type GatewayScope$1 = (typeof GATEWAY_SCOPE_VALUES)[number];

/**
 * Gateway-owned RPC catalog metadata plus compatibility re-exports for the
 * protocol-owned wire contract.
 *
 * This file deliberately does not share a basename with `index.js`: a
 * same-basename `.js`/`.ts` pair both compile to one `.d.ts` and the type-only
 * twin silently drops every value export from the `.js`.
 */

type JsonSchema$1 = {
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
    readonly items?: JsonSchema$1;
    readonly properties?: Record<string, JsonSchema$1>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean | JsonSchema$1;
    readonly oneOf?: readonly JsonSchema$1[];
    readonly anyOf?: readonly JsonSchema$1[];
};
type GatewayRpcErrorDefinition$1 = {
    readonly version: SmithersApiVersion$1;
    readonly code: GatewayRpcErrorCode$1;
    readonly httpStatus: number;
    readonly description: string;
};
type GatewayRpcDefinition$1 = {
    readonly version: SmithersApiVersion$1;
    readonly method: GatewayRpcMethod$1;
    readonly title: string;
    readonly description: string;
    readonly maturity: "stable";
    readonly transport: "http" | "websocket" | "http+websocket";
    readonly requiredScope: GatewayScope$1;
    readonly requestSchema: JsonSchema$1;
    readonly responseSchema: JsonSchema$1;
    readonly errors: readonly GatewayRpcErrorCode$1[];
    readonly exampleRequest: unknown;
    readonly exampleResponse: unknown;
};

/**
 * @param {string} method
 * @returns {GatewayRpcMethod | undefined}
 */
declare function canonicalGatewayRpcMethod(method: string): GatewayRpcMethod | undefined;
/**
 * @param {string} method
 * @returns {GatewayRpcDefinition | undefined}
 */
declare function getGatewayRpcDefinition(method: string): GatewayRpcDefinition | undefined;
/**
 * @param {string} method
 * @returns {GatewayScope | undefined}
 */
declare function getRequiredScopeForGatewayMethod(method: string): GatewayScope | undefined;
/**
 * @returns {readonly GatewayRpcMethod[]}
 */
declare function listGatewayRpcMethods(): readonly GatewayRpcMethod[];
/**
 * @param {string} method
 * @returns {method is GatewayRpcMethod}
 */
declare function isGatewayRpcMethod(method: string): method is GatewayRpcMethod;
/**
 * @returns {readonly GatewayScope[]}
 */
declare function getGatewayScopeValues(): readonly GatewayScope[];
declare const SMITHERS_API_VERSION: SmithersApiVersion;
declare const GATEWAY_EVENT_WINDOW_DEFAULT: 10000;
/** @type {JsonSchema} */
declare const anyJsonSchema: JsonSchema;
/** @type {Record<GatewayRpcErrorCode, GatewayRpcErrorDefinition>} */
declare const GATEWAY_RPC_ERRORS: Record<GatewayRpcErrorCode, GatewayRpcErrorDefinition>;
/** @type {Record<string, GatewayRpcMethod>} */
declare const GATEWAY_RPC_LEGACY_METHOD_ALIASES: Record<string, GatewayRpcMethod>;
/** @type {readonly GatewayRpcDefinition[]} */
declare const GATEWAY_RPC_DEFINITIONS: readonly GatewayRpcDefinition[];
type SmithersApiVersion = SmithersApiVersion$1;
type JsonSchema = JsonSchema$1;
type GatewayRpcErrorCode = GatewayRpcErrorCode$1;
type GatewayRpcErrorDefinition = GatewayRpcErrorDefinition$1;
type GatewayRpcDefinition = GatewayRpcDefinition$1;
type GatewayRpcMethod = GatewayRpcMethod$1;
type LaunchRunRequest = LaunchRunRequest$1;
type LaunchRunResponse = LaunchRunResponse$1;
type ResumeRunRequest = ResumeRunRequest$1;
type ResumeRunResponse = ResumeRunResponse$1;
type CancelRunRequest = CancelRunRequest$1;
type CancelRunResponse = CancelRunResponse$1;
type PauseRunRequest = PauseRunRequest$1;
type PauseRunResponse = PauseRunResponse$1;
type HijackRunRequest = HijackRunRequest$1;
type HijackRunResponse = HijackRunResponse$1;
type RewindRunRequest = RewindRunRequest$1;
type SubmitApprovalRequest = SubmitApprovalRequest$1;
type SubmitApprovalResponse = SubmitApprovalResponse$1;
type SubmitSignalRequest = SubmitSignalRequest$1;
type GetRunRequest = GetRunRequest$1;
type RunTokenUsageEvent = RunTokenUsageEvent$1;
type ListRunTokenUsageRequest = ListRunTokenUsageRequest$1;
type ListRunTokenUsageResponse = ListRunTokenUsageResponse$1;
type GetRunDiffRequest = GetRunDiffRequest$1;
type GetRunDiffResponse = GetRunDiffResponse$1;
type GetRunDiffOversizedResponse = GetRunDiffOversizedResponse$1;
type GatewayDiffBundle = GatewayDiffBundle$1;
type GatewayDiffPatch = GatewayDiffPatch$1;
type ListRunsRequest = ListRunsRequest$1;
type GetSchemaSignatureRequest = GetSchemaSignatureRequest$1;
type GetSchemaSignatureResponse = GetSchemaSignatureResponse$1;
type GatewayWorkflowSummary = GatewayWorkflowSummary$1;
type ListWorkflowsRequest = ListWorkflowsRequest$1;
type ListWorkflowsResponse = ListWorkflowsResponse$1;
type GatewayApprovalSummary = GatewayApprovalSummary$1;
type ListApprovalsRequest = ListApprovalsRequest$1;
type ListApprovalsResponse = ListApprovalsResponse$1;
type GatewayDocRow = GatewayDocRow$1;
type ListDocsRequest = ListDocsRequest$1;
type ListDocsResponse = ListDocsResponse$1;
type StreamRunEventsRequest = StreamRunEventsRequest$1;
type StreamRunEventsResponse = StreamRunEventsResponse$1;
type StreamDevToolsRequest = StreamDevToolsRequest$1;
type GetDevToolsSnapshotRequest = GetDevToolsSnapshotRequest$1;
type GetDevToolsSnapshotResponse = GetDevToolsSnapshotResponse$1;
type NodeRequest = NodeRequest$1;
type WhatHappenedRequest = WhatHappenedRequest$1;
type WhatHappenedResponse = WhatHappenedResponse$1;
type CronListRequest = CronListRequest$1;
type CronCreateRequest = CronCreateRequest$1;
type CronDeleteRequest = CronDeleteRequest$1;
type CronRunRequest = CronRunRequest$1;
type GatewayAccount = GatewayAccount$1;
type ListAccountsRequest = ListAccountsRequest$1;
type ListAccountsResponse = ListAccountsResponse$1;
type GatewayMemoryFact = GatewayMemoryFact$1;
type ListMemoryFactsRequest = ListMemoryFactsRequest$1;
type ListMemoryFactsResponse = ListMemoryFactsResponse$1;
type GatewayPrompt = GatewayPrompt$1;
type ListPromptsRequest = ListPromptsRequest$1;
type ListPromptsResponse = ListPromptsResponse$1;
type GatewayScoreRow = GatewayScoreRow$1;
type ListScoresRequest = ListScoresRequest$1;
type ListScoresResponse = ListScoresResponse$1;
type GatewayComparisonScoreRow = GatewayComparisonScoreRow$1;
type ListScoresForRunsRequest = ListScoresForRunsRequest$1;
type ListScoresForRunsResponse = ListScoresForRunsResponse$1;
type GetScoreDetailRequest = GetScoreDetailRequest$1;
type GatewayScoreDetail = GatewayScoreDetail$1;
type GetScoreDetailResponse = GetScoreDetailResponse$1;
type GatewayDocKind = GatewayDocKind$1;
type GatewayTicketRow = GatewayTicketRow$1;
type ListTicketsRequest = ListTicketsRequest$1;
type ListTicketsResponse = ListTicketsResponse$1;
type CreateTicketRequest = CreateTicketRequest$1;
type UpdateTicketRequest = UpdateTicketRequest$1;
type DeleteTicketRequest = DeleteTicketRequest$1;
type BrowserSource = BrowserSource$1;
type BrowserLocator = BrowserLocator$1;
type BrowserSnapshot = BrowserSnapshot$1;
type BrowserAction = BrowserAction$1;
type CreateBrowserSessionRequest = CreateBrowserSessionRequest$1;
type BrowserActRequest = BrowserActRequest$1;
type BrowserContextRequest = BrowserContextRequest$1;
type BrowserPickRequest = BrowserPickRequest$1;
type CloseBrowserSessionRequest = CloseBrowserSessionRequest$1;
type CreateBrowserSessionResponse = CreateBrowserSessionResponse$1;
type BrowserActResponse = BrowserActResponse$1;
type BrowserContextResponse = BrowserContextResponse$1;
type BrowserPickResponse = BrowserPickResponse$1;
type CloseBrowserSessionResponse = CloseBrowserSessionResponse$1;
type ListBrowserSessionsResponse = ListBrowserSessionsResponse$1;
type BrowserActor = BrowserActor$1;
type BrowserViewport = BrowserViewport$1;
type BrowserPoint = BrowserPoint$1;
type BrowserRectangle = BrowserRectangle$1;
type BrowserModifier = BrowserModifier$1;
type BrowserRedaction = BrowserRedaction$1;
type BrowserOutcome = BrowserOutcome$1;
type BrowserJournalEntry = BrowserJournalEntry$1;
type BrowserContextSlice = BrowserContextSlice$1;
type BrowserSummary = BrowserSummary$1;
type BrowserClickAction = BrowserClickAction$1;
type BrowserFrameEvent = BrowserFrameEvent$1;
type BrowserActivityEvent = BrowserActivityEvent$1;
type BrowserScreenshot = BrowserScreenshot$1;
type BrowserSelection = BrowserSelection$1;
type GatewayScope = GatewayScope$1;

export { type BrowserActRequest, type BrowserActResponse, type BrowserAction, type BrowserActivityEvent, type BrowserActor, type BrowserClickAction, type BrowserContextRequest, type BrowserContextResponse, type BrowserContextSlice, type BrowserFrameEvent, type BrowserJournalEntry, type BrowserLocator, type BrowserModifier, type BrowserOutcome, type BrowserPickRequest, type BrowserPickResponse, type BrowserPoint, type BrowserRectangle, type BrowserRedaction, type BrowserScreenshot, type BrowserSelection, type BrowserSnapshot, type BrowserSource, type BrowserSummary, type BrowserViewport, type CancelRunRequest, type CancelRunResponse, type CloseBrowserSessionRequest, type CloseBrowserSessionResponse, type CreateBrowserSessionRequest, type CreateBrowserSessionResponse, type CreateTicketRequest, type CronCreateRequest, type CronDeleteRequest, type CronListRequest, type CronRunRequest, type DeleteTicketRequest, GATEWAY_EVENT_WINDOW_DEFAULT, GATEWAY_RPC_DEFINITIONS, GATEWAY_RPC_ERRORS, GATEWAY_RPC_LEGACY_METHOD_ALIASES, type GatewayAccount, type GatewayApprovalSummary, type GatewayComparisonScoreRow, type GatewayDiffBundle, type GatewayDiffPatch, type GatewayDocKind, type GatewayDocRow, type GatewayMemoryFact, type GatewayPrompt, type GatewayRpcDefinition, type GatewayRpcErrorCode, type GatewayRpcErrorDefinition, type GatewayRpcMethod, type GatewayScope, type GatewayScoreDetail, type GatewayScoreRow, type GatewayTicketRow, type GatewayWorkflowSummary, type GetDevToolsSnapshotRequest, type GetDevToolsSnapshotResponse, type GetRunDiffOversizedResponse, type GetRunDiffRequest, type GetRunDiffResponse, type GetRunRequest, type GetSchemaSignatureRequest, type GetSchemaSignatureResponse, type GetScoreDetailRequest, type GetScoreDetailResponse, type HijackRunRequest, type HijackRunResponse, type JsonSchema, type LaunchRunRequest, type LaunchRunResponse, type ListAccountsRequest, type ListAccountsResponse, type ListApprovalsRequest, type ListApprovalsResponse, type ListBrowserSessionsResponse, type ListDocsRequest, type ListDocsResponse, type ListMemoryFactsRequest, type ListMemoryFactsResponse, type ListPromptsRequest, type ListPromptsResponse, type ListRunTokenUsageRequest, type ListRunTokenUsageResponse, type ListRunsRequest, type ListScoresForRunsRequest, type ListScoresForRunsResponse, type ListScoresRequest, type ListScoresResponse, type ListTicketsRequest, type ListTicketsResponse, type ListWorkflowsRequest, type ListWorkflowsResponse, type NodeRequest, type PauseRunRequest, type PauseRunResponse, type ResumeRunRequest, type ResumeRunResponse, type RewindRunRequest, type RunTokenUsageEvent, SMITHERS_API_VERSION, type SmithersApiVersion, type StreamDevToolsRequest, type StreamRunEventsRequest, type StreamRunEventsResponse, type SubmitApprovalRequest, type SubmitApprovalResponse, type SubmitSignalRequest, type UpdateTicketRequest, type WhatHappenedRequest, type WhatHappenedResponse, anyJsonSchema, canonicalGatewayRpcMethod, getGatewayRpcDefinition, getGatewayScopeValues, getRequiredScopeForGatewayMethod, isGatewayRpcMethod, listGatewayRpcMethods };
