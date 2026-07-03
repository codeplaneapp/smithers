import { Effect, Context, Layer } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';
import { b as MakeWebhookSourceOptions, W as WebhookRequest, E as ExternalEvent } from './EventSourceTypes-BAOYWyD3.js';
import React__default, { ReactNode } from 'react';
import { ZodType, z } from 'zod';

/**
 * Linear integration configuration. Explicit values win over values
 * registered via `configureLinear`, which win over the
 * `SMITHERS_LINEAR_API_KEY` / `SMITHERS_LINEAR_WEBHOOK_SECRET` /
 * `SMITHERS_LINEAR_API_BASE_URL` environment variables.
 */
type LinearConfig$2 = {
    /** Linear personal API key (sent raw in `Authorization`). */
    apiKey?: string;
    /** Webhook signing secret for `Linear-Signature` verification. */
    webhookSecret?: string;
    /** GraphQL endpoint override (tests point this at a fixture server). @default "https://api.linear.app/graphql" */
    apiBaseUrl?: string;
};
/** LinearConfig with every layer (explicit/registered/env) merged in. */
type ResolvedLinearConfig$1 = {
    apiKey: string | undefined;
    webhookSecret: string | undefined;
    apiBaseUrl: string;
};

/**
 * Register process-wide Linear configuration (module registry). Components
 * and clients created without an explicit `config` fall back to this, then
 * to the `SMITHERS_LINEAR_*` environment variables. Returns the previous
 * registration so callers (tests) can restore it.
 *
 * @param {LinearConfig} [config]
 * @returns {LinearConfig} the previously registered config
 */
declare function configureLinear(config?: LinearConfig$1): LinearConfig$1;
/**
 * Resolve the effective Linear config: explicit > `configureLinear` >
 * `SMITHERS_LINEAR_API_KEY` / `SMITHERS_LINEAR_WEBHOOK_SECRET` /
 * `SMITHERS_LINEAR_API_BASE_URL` env vars.
 *
 * @param {LinearConfig} [explicit]
 * @returns {ResolvedLinearConfig}
 */
declare function resolveLinearConfig(explicit?: LinearConfig$1): ResolvedLinearConfig;
/** @typedef {import("./LinearConfig.ts").LinearConfig} LinearConfig */
/** @typedef {import("./LinearConfig.ts").ResolvedLinearConfig} ResolvedLinearConfig */
/** Default Linear GraphQL endpoint. */
declare const LINEAR_API_BASE_URL: "https://api.linear.app/graphql";
type LinearConfig$1 = LinearConfig$2;
type ResolvedLinearConfig = ResolvedLinearConfig$1;

/** A Linear priority: 0 none, 1 urgent, 2 high, 3 normal, 4 low — or a name. */
type LinearPriority$1 = number | "none" | "urgent" | "high" | "normal" | "medium" | "low";
type LinearTeamRef$1 = {
    id: string;
    key?: string;
    name?: string;
};
type LinearIssueResult$1 = {
    id: string;
    identifier: string;
    title: string;
    url: string;
    team?: {
        id: string;
        key?: string;
    } | null;
};
type LinearCommentResult$1 = {
    id: string;
    body: string;
    issue?: {
        id: string;
        identifier?: string;
    } | null;
};
type CreateIssueInput$1 = {
    /** Team key like `ENG` (resolved to a team id via lookup). */
    teamKey?: string;
    /** Team id (skips the lookup). One of teamKey/teamId is required. */
    teamId?: string;
    title: string;
    description?: string;
    priority?: LinearPriority$1;
    /** Label names (resolved to label ids per team, cached). */
    labels?: string[];
    /** Raw label ids (skip resolution). */
    labelIds?: string[];
    /** Workflow state name like `In Progress` (resolved per team, cached). */
    stateName?: string;
    stateId?: string;
    assigneeId?: string;
    projectId?: string;
    estimate?: number;
    dueDate?: string;
};
type UpdateIssueFields = {
    title?: string;
    description?: string;
    priority?: LinearPriority$1;
    labels?: string[];
    labelIds?: string[];
    stateName?: string;
    stateId?: string;
    assigneeId?: string;
    projectId?: string;
    estimate?: number;
    dueDate?: string;
};
/**
 * Plain-fetch Linear GraphQL client (no @linear/sdk). All methods are
 * Effects failing with `IntegrationError` (a SmithersError); 429/5xx
 * responses are retried honoring `Retry-After` /
 * `X-RateLimit-Requests-Reset`. The API key is never logged or embedded in
 * error messages.
 */
type LinearClientService$1 = {
    /** Raw GraphQL request; resolves with the `data` payload. */
    query: (gql: string, variables?: Record<string, unknown>) => Effect.Effect<any, SmithersError>;
    /** Resolve a team by key (`ENG`) or pass through an explicit id. Cached. */
    resolveTeam: (ref: {
        teamId?: string;
        teamKey?: string;
    }) => Effect.Effect<LinearTeamRef$1, SmithersError>;
    /** Resolve a workflow-state name to its id for a team. Cached per team. */
    resolveStateId: (teamId: string, stateName: string) => Effect.Effect<string, SmithersError>;
    /** Resolve label names to ids for a team. Cached per team. */
    resolveLabelIds: (teamId: string, names: string[]) => Effect.Effect<string[], SmithersError>;
    /** Fetch an issue by UUID or identifier like `ENG-123`. */
    getIssue: (idOrIdentifier: string) => Effect.Effect<LinearIssueResult$1, SmithersError>;
    createIssue: (input: CreateIssueInput$1) => Effect.Effect<LinearIssueResult$1, SmithersError>;
    updateIssue: (idOrIdentifier: string, fields: UpdateIssueFields) => Effect.Effect<LinearIssueResult$1, SmithersError>;
    commentOnIssue: (idOrIdentifier: string, body: string) => Effect.Effect<LinearCommentResult$1, SmithersError>;
};

/**
 * Layer providing {@link LinearClient} from config (explicit >
 * `configureLinear` > env).
 * @param {LinearConfig} [config]
 */
declare function LinearClientLive(config?: LinearConfig): Layer.Layer<LinearClientService$1, never, never>;
/**
 * Normalize a priority name or number to Linear's 0–4 scale.
 * @param {LinearPriority | undefined} priority
 * @returns {number | undefined}
 */
declare function normalizeLinearPriority(priority: LinearPriority | undefined): number | undefined;
/**
 * Build a plain-fetch Linear GraphQL client. Behaviors ported from
 * eliza's plugin-linear (via @linear/sdk) reimplemented over raw GraphQL:
 * team lookup by key, workflow-state / label name resolution (cached per
 * client), issueCreate/issueUpdate/commentCreate, issue lookup by
 * `ENG-123` identifier, 429/5xx retry honoring rate-limit headers.
 *
 * The API key is only used for the `Authorization` header — never logged
 * and never included in error details.
 *
 * @param {LinearConfig} [config]
 * @returns {LinearClientService}
 */
declare function makeLinearClient(config?: LinearConfig): LinearClientService;
/** Context tag for the Linear GraphQL client service. */
declare const LinearClient: Context.Tag<LinearClientService, LinearClientService>;
type CreateIssueInput = CreateIssueInput$1;
type LinearClientService = LinearClientService$1;
type LinearCommentResult = LinearCommentResult$1;
type LinearIssueResult = LinearIssueResult$1;
type LinearPriority = LinearPriority$1;
type LinearTeamRef = LinearTeamRef$1;
type LinearConfig = LinearConfig$2;

type MakeLinearWebhookSourceOptions$1 = LinearConfig$2 & {
    /** Source id (and `/v1/webhooks/:sourceId` segment). @default "linear" */
    id?: string;
    /** Bounded ingress queue capacity. @default 256 */
    capacity?: number;
    /**
     * Max age of `webhookTimestamp` before a delivery is rejected as stale
     * (replay protection, per Linear's docs). @default 60_000
     */
    maxTimestampSkewMs?: number;
};
/** The webhook-source options object (plugs into core `makeWebhookSource` or `makeIntegrationRuntime({ webhookSources })`). */
type LinearWebhookSourceConfig$1 = MakeWebhookSourceOptions;

/**
 * Verify a Linear webhook request: `Linear-Signature` is the HMAC-SHA256
 * hex digest of the raw body, and `webhookTimestamp` inside the body must
 * be fresh (within `maxTimestampSkewMs`) to block replays.
 *
 * @param {import("../core/EventSourceTypes.ts").WebhookRequest} request
 * @param {string} secret
 * @param {number} [maxTimestampSkewMs]
 * @param {() => number} [now]
 * @returns {boolean}
 */
declare function verifyLinearWebhook(request: WebhookRequest, secret: string, maxTimestampSkewMs?: number, now?: () => number): boolean;
/**
 * Decode a Linear webhook delivery into ExternalEvents.
 *
 * Linear payload shape: `{ action: "create"|"update"|"remove", type:
 * "Issue"|"Comment"|..., data, updatedFrom?, url, webhookId,
 * webhookTimestamp, organizationId }`.
 *
 * Per delivery this emits, for both the action-specific name
 * (`integration:linear:issue.update`) and the base name
 * (`integration:linear:issue`), one event per correlation variant: the
 * issue identifier (`ENG-123`), the team key (`ENG`), and `null` (catch-all
 * listeners). `findRunsAwaitingEvent` matches (eventName, correlationId)
 * pairs exactly, so each variant is required for its listener shape; each
 * gets a distinct dedupeKey suffix so redeliveries of the whole webhook
 * dedupe while sibling variants do not collide.
 *
 * @param {import("../core/EventSourceTypes.ts").WebhookRequest} request
 * @param {string} sourceId
 * @returns {import("../core/ExternalEventTypes.ts").ExternalEvent[]}
 */
declare function decodeLinearWebhook(request: WebhookRequest, sourceId?: string): ExternalEvent[];
/**
 * Build the Linear webhook source config (core `MakeWebhookSourceOptions`):
 * pass it to `makeIntegrationRuntime({ webhookSources: [...] })` or feed it
 * to `makeWebhookSource` directly. Verifies `Linear-Signature`
 * (HMAC-SHA256 hex of the raw body) plus `webhookTimestamp` freshness, and
 * decodes deliveries into `integration:linear:<type>.<action>` /
 * `integration:linear:<type>` events.
 *
 * @param {MakeLinearWebhookSourceOptions} [options]
 * @returns {LinearWebhookSourceConfig}
 */
declare function makeLinearWebhookSource(options?: MakeLinearWebhookSourceOptions): LinearWebhookSourceConfig;
/** Default Linear webhook source id. */
declare const LINEAR_SOURCE_ID: "linear";
/** Reject webhook deliveries whose `webhookTimestamp` is older than this. */
declare const DEFAULT_LINEAR_TIMESTAMP_SKEW_MS: 60000;
type LinearWebhookSourceConfig = LinearWebhookSourceConfig$1;
type MakeLinearWebhookSourceOptions = MakeLinearWebhookSourceOptions$1;

/** Props shared by the Linear listener components (Signal.js pattern). */
type LinearListenerProps$1<Schema extends ZodType = ZodType> = {
    id: string;
    key?: string | number;
    /** Wait for events about this issue (`ENG-123` correlation). */
    issueId?: string;
    /** Wait for events about this team's issues (`ENG` correlation). */
    teamKey?: string;
    /**
     * Registered createSmithers output schema the delivered payload is
     * validated against (see `linearIssueEventSchema` /
     * `linearCommentEventSchema` for the wire shape).
     */
    schema?: Schema;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip";
    async?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    smithersContext?: unknown;
    skipIf?: boolean;
    children?: (payload: any) => ReactNode;
};
/** A prop that is either a value or derived from resolved deps. */
type FromDeps<T> = T | ((deps: Record<string, any>) => T);
type OutboundBaseProps = {
    id: string;
    key?: string | number;
    /** Explicit Linear config; falls back to `configureLinear` then env. */
    config?: LinearConfig$2;
    /** Registered output schema (e.g. `linearIssueOutputSchema`). */
    output?: unknown;
    outputSchema?: unknown;
    retryPolicy?: unknown;
    timeoutMs?: number;
    async?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    /** Upstream outputs; function-valued props receive the resolved values. */
    deps?: Record<string, unknown>;
    smithersContext?: unknown;
    skipIf?: boolean;
};
type CreateIssueProps$1 = OutboundBaseProps & {
    teamKey?: FromDeps<string>;
    teamId?: FromDeps<string>;
    title: FromDeps<string>;
    description?: FromDeps<string | undefined>;
    priority?: FromDeps<LinearPriority$1 | undefined>;
    labels?: FromDeps<string[] | undefined>;
    stateName?: FromDeps<string | undefined>;
    assigneeId?: FromDeps<string | undefined>;
};
type UpdateIssueProps$1 = OutboundBaseProps & {
    /** Issue UUID or identifier like `ENG-123`. */
    issue: FromDeps<string>;
    title?: FromDeps<string | undefined>;
    description?: FromDeps<string | undefined>;
    priority?: FromDeps<LinearPriority$1 | undefined>;
    labels?: FromDeps<string[] | undefined>;
    stateName?: FromDeps<string | undefined>;
    assigneeId?: FromDeps<string | undefined>;
};
type CommentOnIssueProps$1 = OutboundBaseProps & {
    /** Issue UUID or identifier like `ENG-123`. */
    issue: FromDeps<string>;
    body: FromDeps<string>;
};

/**
 * Wait for `integration:linear:issue.update`. Correlate on `issueId`
 * (`ENG-123`) or `teamKey` (`ENG`); omit both for a catch-all listener.
 */
declare const OnIssueUpdate: (props: LinearListenerProps) => React__default.ReactElement | null;
/** Wait for `integration:linear:issue.create`. */
declare const OnIssueCreated: (props: LinearListenerProps) => React__default.ReactElement | null;
/** Wait for `integration:linear:comment.create`. */
declare const OnComment: (props: LinearListenerProps) => React__default.ReactElement | null;
/**
 * Create a Linear issue as a deterministic compute Task. Props may be
 * values or `(resolvedDeps) => value` functions when `deps` is set. Output
 * row shape: `linearIssueOutputSchema`.
 * @type {(props: CreateIssueProps) => React.ReactElement | null}
 */
declare const CreateIssue: (props: CreateIssueProps) => React__default.ReactElement | null;
/**
 * Update a Linear issue (by UUID or `ENG-123` identifier) as a compute
 * Task. Output row shape: `linearIssueOutputSchema`.
 * @type {(props: UpdateIssueProps) => React.ReactElement | null}
 */
declare const UpdateIssue: (props: UpdateIssueProps) => React__default.ReactElement | null;
/**
 * Comment on a Linear issue (by UUID or `ENG-123` identifier) as a compute
 * Task. Output row shape: `linearCommentOutputSchema`.
 * @type {(props: CommentOnIssueProps) => React.ReactElement | null}
 */
declare const CommentOnIssue: (props: CommentOnIssueProps) => React__default.ReactElement | null;
type CommentOnIssueProps = CommentOnIssueProps$1;
type CreateIssueProps = CreateIssueProps$1;
type LinearListenerProps = LinearListenerProps$1;
type UpdateIssueProps = UpdateIssueProps$1;

/** Entity `data` for an Issue webhook (`type: "Issue"`). */
declare const linearIssueDataSchema: z.ZodObject<{
    id: z.ZodString;
    identifier: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    priority: z.ZodOptional<z.ZodNumber>;
    url: z.ZodOptional<z.ZodString>;
    team: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        key: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    state: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** Entity `data` for a Comment webhook (`type: "Comment"`). */
declare const linearCommentDataSchema: z.ZodObject<{
    id: z.ZodString;
    body: z.ZodOptional<z.ZodString>;
    issueId: z.ZodOptional<z.ZodString>;
    issue: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        identifier: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/**
 * Full Linear webhook delivery: `{ action, type, data, updatedFrom?, url?,
 * webhookId?, webhookTimestamp?, organizationId? }`. `updatedFrom` carries
 * the previous values of changed fields on `action: "update"`.
 */
declare const linearWebhookPayloadSchema: z.ZodObject<{
    action: z.ZodString;
    type: z.ZodString;
    data: z.ZodObject<{
        id: z.ZodString;
    }, z.core.$loose>;
    updatedFrom: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    url: z.ZodOptional<z.ZodString>;
    webhookId: z.ZodOptional<z.ZodString>;
    webhookTimestamp: z.ZodOptional<z.ZodNumber>;
    organizationId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/** Issue webhook delivery (listener payload for OnIssueUpdate/OnIssueCreated). */
declare const linearIssueEventSchema: z.ZodObject<{
    action: z.ZodString;
    type: z.ZodString;
    updatedFrom: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    url: z.ZodOptional<z.ZodString>;
    webhookId: z.ZodOptional<z.ZodString>;
    webhookTimestamp: z.ZodOptional<z.ZodNumber>;
    organizationId: z.ZodOptional<z.ZodString>;
    data: z.ZodObject<{
        id: z.ZodString;
        identifier: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        priority: z.ZodOptional<z.ZodNumber>;
        url: z.ZodOptional<z.ZodString>;
        team: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            key: z.ZodOptional<z.ZodString>;
            name: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        state: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
            type: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
}, z.core.$loose>;
/** Comment webhook delivery (listener payload for OnComment). */
declare const linearCommentEventSchema: z.ZodObject<{
    action: z.ZodString;
    type: z.ZodString;
    updatedFrom: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    url: z.ZodOptional<z.ZodString>;
    webhookId: z.ZodOptional<z.ZodString>;
    webhookTimestamp: z.ZodOptional<z.ZodNumber>;
    organizationId: z.ZodOptional<z.ZodString>;
    data: z.ZodObject<{
        id: z.ZodString;
        body: z.ZodOptional<z.ZodString>;
        issueId: z.ZodOptional<z.ZodString>;
        issue: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            identifier: z.ZodOptional<z.ZodString>;
            title: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
}, z.core.$loose>;
/**
 * Output of the outbound CreateIssue/UpdateIssue components (register as a
 * createSmithers output schema). Exactly the columns the compute task
 * writes.
 */
declare const linearIssueOutputSchema: z.ZodObject<{
    id: z.ZodString;
    identifier: z.ZodString;
    title: z.ZodString;
    url: z.ZodString;
}, z.core.$strip>;
/** Output of the outbound CommentOnIssue component. */
declare const linearCommentOutputSchema: z.ZodObject<{
    id: z.ZodString;
    body: z.ZodString;
    issueId: z.ZodString;
    issueIdentifier: z.ZodString;
}, z.core.$strip>;

export { CommentOnIssue, type CommentOnIssueProps, CreateIssue, type CreateIssueInput, type CreateIssueProps, DEFAULT_LINEAR_TIMESTAMP_SKEW_MS, LINEAR_API_BASE_URL, LINEAR_SOURCE_ID, LinearClient, LinearClientLive, type LinearClientService, type LinearCommentResult, type LinearIssueResult, type LinearListenerProps, type LinearPriority, type LinearTeamRef, type LinearWebhookSourceConfig, type MakeLinearWebhookSourceOptions, OnComment, OnIssueCreated, OnIssueUpdate, type ResolvedLinearConfig, UpdateIssue, type UpdateIssueProps, configureLinear, decodeLinearWebhook, linearCommentDataSchema, linearCommentEventSchema, linearCommentOutputSchema, linearIssueDataSchema, linearIssueEventSchema, linearIssueOutputSchema, linearWebhookPayloadSchema, makeLinearClient, makeLinearWebhookSource, normalizeLinearPriority, resolveLinearConfig, verifyLinearWebhook };
