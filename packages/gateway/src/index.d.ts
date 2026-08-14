import { SmithersApiVersion as SmithersApiVersion$2, GatewayRpcMethod as GatewayRpcMethod$2, GatewayRpcErrorCode as GatewayRpcErrorCode$2, GatewayComparisonScoreRow as GatewayComparisonScoreRow$2, GatewayScoreDetail as GatewayScoreDetail$2, CancelRunRequest as CancelRunRequest$1, CancelRunResponse as CancelRunResponse$1, CreateTicketRequest as CreateTicketRequest$1, CronCreateRequest as CronCreateRequest$1, CronDeleteRequest as CronDeleteRequest$1, CronListRequest as CronListRequest$1, CronRunRequest as CronRunRequest$1, DeleteTicketRequest as DeleteTicketRequest$1, GatewayAccount as GatewayAccount$1, GatewayApprovalSummary as GatewayApprovalSummary$1, GatewayDocKind as GatewayDocKind$1, GatewayDocRow as GatewayDocRow$1, GatewayMemoryFact as GatewayMemoryFact$1, GatewayPrompt as GatewayPrompt$1, GatewayRunDescendant as GatewayRunDescendant$1, GatewayRunSummary as GatewayRunSummary$1, GatewayScoreRow as GatewayScoreRow$1, GatewayTicketRow as GatewayTicketRow$1, GatewayWorkflowSummary as GatewayWorkflowSummary$1, GetDevToolsSnapshotRequest as GetDevToolsSnapshotRequest$1, GetDevToolsSnapshotResponse as GetDevToolsSnapshotResponse$1, GetRunRequest as GetRunRequest$1, GetSchemaSignatureRequest as GetSchemaSignatureRequest$1, GetSchemaSignatureResponse as GetSchemaSignatureResponse$1, GetScoreDetailRequest as GetScoreDetailRequest$1, GetScoreDetailResponse as GetScoreDetailResponse$1, HijackRunRequest as HijackRunRequest$1, HijackRunResponse as HijackRunResponse$1, LaunchRunRequest as LaunchRunRequest$1, LaunchRunResponse as LaunchRunResponse$1, ListAccountsRequest as ListAccountsRequest$1, ListAccountsResponse as ListAccountsResponse$1, ListApprovalsRequest as ListApprovalsRequest$1, ListApprovalsResponse as ListApprovalsResponse$1, ListDocsRequest as ListDocsRequest$1, ListDocsResponse as ListDocsResponse$1, ListMemoryFactsRequest as ListMemoryFactsRequest$1, ListMemoryFactsResponse as ListMemoryFactsResponse$1, ListPromptsRequest as ListPromptsRequest$1, ListPromptsResponse as ListPromptsResponse$1, ListRunDescendantsRequest as ListRunDescendantsRequest$1, ListRunDescendantsResponse as ListRunDescendantsResponse$1, ListRunsRequest as ListRunsRequest$1, ListRunsResponse as ListRunsResponse$1, ListScoresForRunsRequest as ListScoresForRunsRequest$1, ListScoresForRunsResponse as ListScoresForRunsResponse$1, ListScoresRequest as ListScoresRequest$1, ListScoresResponse as ListScoresResponse$1, ListTicketsRequest as ListTicketsRequest$1, ListTicketsResponse as ListTicketsResponse$1, ListWorkflowsRequest as ListWorkflowsRequest$1, ListWorkflowsResponse as ListWorkflowsResponse$1, NodeRequest as NodeRequest$1, PauseRunRequest as PauseRunRequest$1, PauseRunResponse as PauseRunResponse$1, ResumeRunRequest as ResumeRunRequest$1, ResumeRunResponse as ResumeRunResponse$1, RewindRunRequest as RewindRunRequest$1, StreamDevToolsRequest as StreamDevToolsRequest$1, StreamRunEventsRequest as StreamRunEventsRequest$1, StreamRunEventsResponse as StreamRunEventsResponse$1, SubmitApprovalRequest as SubmitApprovalRequest$1, SubmitApprovalResponse as SubmitApprovalResponse$1, SubmitSignalRequest as SubmitSignalRequest$1, UpdateTicketRequest as UpdateTicketRequest$1 } from '@smthrs/protocol/gateway-rpc';

/**
 * @param {string} scope
 * @returns {scope is GatewayScope}
 */
declare function isGatewayScope(scope: string): scope is GatewayScope$2;
/**
 * @param {readonly string[]} grantedScopes
 * @param {GatewayScope} requiredScope
 * @param {string} [methodName]
 * @returns {boolean}
 */
declare function hasGatewayScope(grantedScopes: readonly string[], requiredScope: GatewayScope$2, methodName?: string): boolean;
/** @typedef {(typeof GATEWAY_SCOPE_VALUES)[number]} GatewayScope */
declare const GATEWAY_SCOPE_VALUES: readonly ["run:read", "run:write", "run:admin", "approval:submit", "signal:submit", "cron:read", "cron:write", "account:read", "memory:read", "prompt:read", "score:read", "ticket:read", "ticket:write", "observability:read"];
/** @type {Record<GatewayScope, string>} */
declare const GATEWAY_SCOPE_DESCRIPTIONS: Record<GatewayScope$2, string>;
type GatewayScope$2 = (typeof GATEWAY_SCOPE_VALUES)[number];

/**
 * Gateway-owned RPC catalog metadata plus compatibility re-exports for the
 * protocol-owned wire contract.
 *
 * This file deliberately does not share a basename with `index.js`: a
 * same-basename `.js`/`.ts` pair both compile to one `.d.ts` and the type-only
 * twin silently drops every value export from the `.js`.
 */

type JsonSchema$2 = {
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
    readonly items?: JsonSchema$2;
    readonly properties?: Record<string, JsonSchema$2>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean | JsonSchema$2;
    readonly oneOf?: readonly JsonSchema$2[];
    readonly anyOf?: readonly JsonSchema$2[];
};
type GatewayRpcErrorDefinition$2 = {
    readonly version: SmithersApiVersion$2;
    readonly code: GatewayRpcErrorCode$2;
    readonly httpStatus: number;
    readonly description: string;
};
type GatewayRpcDefinition$2 = {
    readonly version: SmithersApiVersion$2;
    readonly method: GatewayRpcMethod$2;
    readonly title: string;
    readonly description: string;
    readonly maturity: "stable";
    readonly transport: "http" | "websocket" | "http+websocket";
    readonly requiredScope: GatewayScope$2;
    readonly requestSchema: JsonSchema$2;
    readonly responseSchema: JsonSchema$2;
    readonly errors: readonly GatewayRpcErrorCode$2[];
    readonly exampleRequest: unknown;
    readonly exampleResponse: unknown;
};

/**
 * @param {string} method
 * @returns {GatewayRpcMethod | undefined}
 */
declare function canonicalGatewayRpcMethod(method: string): GatewayRpcMethod$1 | undefined;
/**
 * @param {string} method
 * @returns {GatewayRpcDefinition | undefined}
 */
declare function getGatewayRpcDefinition(method: string): GatewayRpcDefinition$1 | undefined;
/**
 * @param {string} method
 * @returns {GatewayScope | undefined}
 */
declare function getRequiredScopeForGatewayMethod(method: string): GatewayScope$1 | undefined;
/**
 * @returns {readonly GatewayRpcMethod[]}
 */
declare function listGatewayRpcMethods(): readonly GatewayRpcMethod$1[];
/**
 * @param {string} method
 * @returns {method is GatewayRpcMethod}
 */
declare function isGatewayRpcMethod(method: string): method is GatewayRpcMethod$1;
/**
 * @returns {readonly GatewayScope[]}
 */
declare function getGatewayScopeValues(): readonly GatewayScope$1[];
declare const SMITHERS_API_VERSION: SmithersApiVersion$1;
declare const GATEWAY_EVENT_WINDOW_DEFAULT: 10000;
/** @type {JsonSchema} */
declare const anyJsonSchema: JsonSchema$1;
/** @type {Record<GatewayRpcErrorCode, GatewayRpcErrorDefinition>} */
declare const GATEWAY_RPC_ERRORS: Record<GatewayRpcErrorCode$1, GatewayRpcErrorDefinition$1>;
/** @type {Record<string, GatewayRpcMethod>} */
declare const GATEWAY_RPC_LEGACY_METHOD_ALIASES: Record<string, GatewayRpcMethod$1>;
/** @type {readonly GatewayRpcDefinition[]} */
declare const GATEWAY_RPC_DEFINITIONS: readonly GatewayRpcDefinition$1[];
type SmithersApiVersion$1 = SmithersApiVersion$2;
type JsonSchema$1 = JsonSchema$2;
type GatewayRpcErrorCode$1 = GatewayRpcErrorCode$2;
type GatewayRpcErrorDefinition$1 = GatewayRpcErrorDefinition$2;
type GatewayRpcDefinition$1 = GatewayRpcDefinition$2;
type GatewayRpcMethod$1 = GatewayRpcMethod$2;
type GatewayScope$1 = GatewayScope$2;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeAccountRow<Row extends Record<string, unknown>>(row: Row): Row;

declare const apiCollectionNames: readonly ["runs", "run_events", "nodes", "node_outputs", "approvals", "crons", "tickets", "docs"];

/**
 * @param {Record<string, unknown>} row
 * @returns {{
 *   runId: unknown,
 *   workflowKey?: unknown,
 *   nodeId: unknown,
 *   iteration: unknown,
 *   requestTitle: unknown,
 *   requestSummary: unknown,
 *   requestedAtMs: unknown,
 *   approvalMode: unknown,
 *   options: unknown,
 *   allowedScopes: unknown,
 *   allowedUsers: unknown,
 *   autoApprove: unknown,
 * }}
 */
declare function serializeApprovalRow(row: Record<string, unknown>): {
    runId: unknown;
    workflowKey?: unknown;
    nodeId: unknown;
    iteration: unknown;
    requestTitle: unknown;
    requestSummary: unknown;
    requestedAtMs: unknown;
    approvalMode: unknown;
    options: unknown;
    allowedScopes: unknown;
    allowedUsers: unknown;
    autoApprove: unknown;
};

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeCronRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeDocRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeMemoryFactRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializePromptRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeRunEventRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeRunRow<Row extends Record<string, unknown>>(row: Row): Row;

/** @typedef {import("../rpc/gatewayRpcTypes.ts").GatewayComparisonScoreRow} GatewayComparisonScoreRow */
/**
 * @param {Record<string, unknown>} row
 * @returns {GatewayComparisonScoreRow}
 */
declare function serializeComparisonScoreRow(row: Record<string, unknown>): GatewayComparisonScoreRow$1;
type GatewayComparisonScoreRow$1 = GatewayComparisonScoreRow$2;

/** @typedef {import("../rpc/gatewayRpcTypes.ts").GatewayScoreDetail} GatewayScoreDetail */
/**
 * Serialize an already-decoded score detail row. JSON parsing deliberately
 * stays in the server so malformed persistence can fail explicitly instead of
 * being hidden by a wire serializer.
 * @param {Record<string, unknown>} row
 * @returns {GatewayScoreDetail}
 */
declare function serializeScoreDetailRow(row: Record<string, unknown>): GatewayScoreDetail$1;
type GatewayScoreDetail$1 = GatewayScoreDetail$2;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeScoreRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeTicketRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeWorkflowRow<Row extends Record<string, unknown>>(row: Row): Row;

type GatewayScope = GatewayScope$2;
type SmithersApiVersion = SmithersApiVersion$2;
type JsonSchema = JsonSchema$2;
type GatewayRpcErrorCode = GatewayRpcErrorCode$2;
type GatewayRpcErrorDefinition = GatewayRpcErrorDefinition$2;
type GatewayRpcDefinition = GatewayRpcDefinition$2;
type GatewayRpcMethod = GatewayRpcMethod$2;
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
type ListRunsRequest = ListRunsRequest$1;
type GatewayRunSummary = GatewayRunSummary$1;
type ListRunsResponse = ListRunsResponse$1;
type ListRunDescendantsRequest = ListRunDescendantsRequest$1;
type GatewayRunDescendant = GatewayRunDescendant$1;
type ListRunDescendantsResponse = ListRunDescendantsResponse$1;
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
type GatewayComparisonScoreRow = GatewayComparisonScoreRow$2;
type ListScoresForRunsRequest = ListScoresForRunsRequest$1;
type ListScoresForRunsResponse = ListScoresForRunsResponse$1;
type GetScoreDetailRequest = GetScoreDetailRequest$1;
type GatewayScoreDetail = GatewayScoreDetail$2;
type GetScoreDetailResponse = GetScoreDetailResponse$1;
type GatewayDocKind = GatewayDocKind$1;
type GatewayTicketRow = GatewayTicketRow$1;
type ListTicketsRequest = ListTicketsRequest$1;
type ListTicketsResponse = ListTicketsResponse$1;
type CreateTicketRequest = CreateTicketRequest$1;
type UpdateTicketRequest = UpdateTicketRequest$1;
type DeleteTicketRequest = DeleteTicketRequest$1;

export { type CancelRunRequest, type CancelRunResponse, type CreateTicketRequest, type CronCreateRequest, type CronDeleteRequest, type CronListRequest, type CronRunRequest, type DeleteTicketRequest, GATEWAY_EVENT_WINDOW_DEFAULT, GATEWAY_RPC_DEFINITIONS, GATEWAY_RPC_ERRORS, GATEWAY_RPC_LEGACY_METHOD_ALIASES, GATEWAY_SCOPE_DESCRIPTIONS, GATEWAY_SCOPE_VALUES, type GatewayAccount, type GatewayApprovalSummary, type GatewayComparisonScoreRow, type GatewayDocKind, type GatewayDocRow, type GatewayMemoryFact, type GatewayPrompt, type GatewayRpcDefinition, type GatewayRpcErrorCode, type GatewayRpcErrorDefinition, type GatewayRpcMethod, type GatewayRunDescendant, type GatewayRunSummary, type GatewayScope, type GatewayScoreDetail, type GatewayScoreRow, type GatewayTicketRow, type GatewayWorkflowSummary, type GetDevToolsSnapshotRequest, type GetDevToolsSnapshotResponse, type GetRunRequest, type GetSchemaSignatureRequest, type GetSchemaSignatureResponse, type GetScoreDetailRequest, type GetScoreDetailResponse, type HijackRunRequest, type HijackRunResponse, type JsonSchema, type LaunchRunRequest, type LaunchRunResponse, type ListAccountsRequest, type ListAccountsResponse, type ListApprovalsRequest, type ListApprovalsResponse, type ListDocsRequest, type ListDocsResponse, type ListMemoryFactsRequest, type ListMemoryFactsResponse, type ListPromptsRequest, type ListPromptsResponse, type ListRunDescendantsRequest, type ListRunDescendantsResponse, type ListRunsRequest, type ListRunsResponse, type ListScoresForRunsRequest, type ListScoresForRunsResponse, type ListScoresRequest, type ListScoresResponse, type ListTicketsRequest, type ListTicketsResponse, type ListWorkflowsRequest, type ListWorkflowsResponse, type NodeRequest, type PauseRunRequest, type PauseRunResponse, type ResumeRunRequest, type ResumeRunResponse, type RewindRunRequest, SMITHERS_API_VERSION, type SmithersApiVersion, type StreamDevToolsRequest, type StreamRunEventsRequest, type StreamRunEventsResponse, type SubmitApprovalRequest, type SubmitApprovalResponse, type SubmitSignalRequest, type UpdateTicketRequest, anyJsonSchema, apiCollectionNames, canonicalGatewayRpcMethod, getGatewayRpcDefinition, getGatewayScopeValues, getRequiredScopeForGatewayMethod, hasGatewayScope, isGatewayRpcMethod, isGatewayScope, listGatewayRpcMethods, serializeAccountRow, serializeApprovalRow, serializeComparisonScoreRow, serializeCronRow, serializeDocRow, serializeMemoryFactRow, serializePromptRow, serializeRunEventRow, serializeRunRow, serializeScoreDetailRow, serializeScoreRow, serializeTicketRow, serializeWorkflowRow };
