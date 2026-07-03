import * as zod from 'zod';
import { z } from 'zod';
import * as effect from 'effect';
import { Schema, Effect, Context, Layer } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';
import { W as WebhookRequest$1, E as ExternalEvent$1, b as MakeWebhookSourceOptions, c as WebhookSource } from './EventSourceTypes-BAOYWyD3.js';
import React__default from 'react';
import * as zod_v4_core from 'zod/v4/core';

declare const GitHubUserSchema: z.ZodObject<{
    login: z.ZodString;
    id: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
declare const GitHubRepositorySchema: z.ZodObject<{
    full_name: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    owner: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    default_branch: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
declare const GitHubPullRequestSchema: z.ZodObject<{
    number: z.ZodNumber;
    title: z.ZodOptional<z.ZodString>;
    state: z.ZodOptional<z.ZodString>;
    html_url: z.ZodOptional<z.ZodString>;
    body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    draft: z.ZodOptional<z.ZodBoolean>;
    merged: z.ZodOptional<z.ZodBoolean>;
    user: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    head: z.ZodOptional<z.ZodObject<{
        ref: z.ZodString;
        sha: z.ZodString;
    }, z.core.$loose>>;
    base: z.ZodOptional<z.ZodObject<{
        ref: z.ZodString;
        sha: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$loose>;
declare const GitHubIssueSchema: z.ZodObject<{
    number: z.ZodNumber;
    title: z.ZodOptional<z.ZodString>;
    state: z.ZodOptional<z.ZodString>;
    html_url: z.ZodOptional<z.ZodString>;
    body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    user: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
    labels: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
}, z.core.$loose>;
declare const GitHubCommentSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodNumber>;
    body: z.ZodOptional<z.ZodString>;
    html_url: z.ZodOptional<z.ZodString>;
    user: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** `pull_request` webhook payload (validated fields only; rest passthrough). */
declare const GitHubPullRequestEventSchema: z.ZodObject<{
    action: z.ZodString;
    number: z.ZodOptional<z.ZodNumber>;
    pull_request: z.ZodObject<{
        number: z.ZodNumber;
        title: z.ZodOptional<z.ZodString>;
        state: z.ZodOptional<z.ZodString>;
        html_url: z.ZodOptional<z.ZodString>;
        body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        draft: z.ZodOptional<z.ZodBoolean>;
        merged: z.ZodOptional<z.ZodBoolean>;
        user: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        head: z.ZodOptional<z.ZodObject<{
            ref: z.ZodString;
            sha: z.ZodString;
        }, z.core.$loose>>;
        base: z.ZodOptional<z.ZodObject<{
            ref: z.ZodString;
            sha: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
    repository: z.ZodObject<{
        full_name: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        owner: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        default_branch: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    sender: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** `issues` webhook payload. */
declare const GitHubIssuesEventSchema: z.ZodObject<{
    action: z.ZodString;
    issue: z.ZodObject<{
        number: z.ZodNumber;
        title: z.ZodOptional<z.ZodString>;
        state: z.ZodOptional<z.ZodString>;
        html_url: z.ZodOptional<z.ZodString>;
        body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        user: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        labels: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    }, z.core.$loose>;
    repository: z.ZodObject<{
        full_name: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        owner: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        default_branch: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    sender: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** `issue_comment` webhook payload. */
declare const GitHubIssueCommentEventSchema: z.ZodObject<{
    action: z.ZodString;
    issue: z.ZodObject<{
        number: z.ZodNumber;
        title: z.ZodOptional<z.ZodString>;
        state: z.ZodOptional<z.ZodString>;
        html_url: z.ZodOptional<z.ZodString>;
        body: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        user: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        labels: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    }, z.core.$loose>;
    comment: z.ZodObject<{
        id: z.ZodOptional<z.ZodNumber>;
        body: z.ZodOptional<z.ZodString>;
        html_url: z.ZodOptional<z.ZodString>;
        user: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
    repository: z.ZodObject<{
        full_name: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        owner: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        default_branch: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    sender: z.ZodOptional<z.ZodObject<{
        login: z.ZodString;
        id: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** `push` webhook payload. */
declare const GitHubPushEventSchema: z.ZodObject<{
    ref: z.ZodString;
    before: z.ZodOptional<z.ZodString>;
    after: z.ZodOptional<z.ZodString>;
    repository: z.ZodObject<{
        full_name: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        owner: z.ZodOptional<z.ZodObject<{
            login: z.ZodString;
            id: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
        default_branch: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    commits: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        message: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>>;
    pusher: z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$loose>;
/** Fallback payload schema for `OnWebhook` when no schema prop is given. */
declare const GitHubWebhookPayloadSchema: z.ZodObject<{}, z.core.$loose>;
declare const GitHubCommentOutputSchema: z.ZodObject<{
    id: z.ZodNumber;
    url: z.ZodString;
}, z.core.$strip>;
declare const GitHubIssueOutputSchema: z.ZodObject<{
    number: z.ZodNumber;
    url: z.ZodString;
}, z.core.$strip>;
declare const GitHubPullRequestOutputSchema: z.ZodObject<{
    number: z.ZodNumber;
    url: z.ZodString;
}, z.core.$strip>;
declare const GitHubLabelsOutputSchema: z.ZodObject<{
    labels: z.ZodString;
}, z.core.$strip>;
declare const GitHubCommitStatusOutputSchema: z.ZodObject<{
    state: z.ZodString;
    url: z.ZodString;
}, z.core.$strip>;

/**
 * Configuration for the GitHub integration: outbound REST client + webhook
 * ingress. All fields are optional at the type level; each consumer resolves
 * what it needs through `resolveGitHubConfig` (explicit → `configureGitHub`
 * registry → environment) and fails loudly when a required value is missing.
 */
type GitHubConfig$2 = {
    /**
     * Personal access token / installation token used for outbound REST calls.
     * Falls back to `SMITHERS_GITHUB_TOKEN` then `GITHUB_TOKEN`. Never logged.
     */
    token?: string;
    /**
     * REST API base URL. Defaults to `https://api.github.com`; override to
     * point at GitHub Enterprise or a test fixture server
     * (`SMITHERS_GITHUB_API_BASE_URL`).
     */
    apiBaseUrl?: string;
    /**
     * HMAC secret for `X-Hub-Signature-256` webhook verification
     * (`SMITHERS_GITHUB_WEBHOOK_SECRET`).
     */
    webhookSecret?: string;
    /** Max retries for 429/secondary-rate-limit/5xx responses. @default 3 */
    maxRetries?: number;
};

/**
 * Register process-wide GitHub credentials for outbound components and the
 * webhook source. A bound `createSmithers` instance (later phase) can instead
 * pass config explicitly per component via the non-public `__config` prop —
 * explicit config always wins over this registry, which wins over env vars.
 *
 * @param {GitHubConfig | null | undefined} config Pass `null` to clear.
 */
declare function configureGitHub(config: GitHubConfig$1 | null | undefined): void;
/** @typedef {import("./GitHubConfig.ts").GitHubConfig} GitHubConfig */
/** @typedef {import("./GitHubConfig.ts").ResolvedGitHubConfig} ResolvedGitHubConfig */
declare const DEFAULT_GITHUB_API_BASE_URL: "https://api.github.com";
type GitHubConfig$1 = GitHubConfig$2;

type GitHubRequestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type GitHubRequestOptions<A = unknown> = {
    /** Effect Schema to validate/decode the response body with. */
    schema?: Schema.Schema<A, any>;
    /** Extra query params appended to the path. */
    query?: Record<string, string | number | boolean | undefined>;
};
/**
 * Minimal Effect-native GitHub REST client: `request` performs a single
 * REST call (with built-in retry on 429 / secondary-rate-limit / 5xx that
 * honors `Retry-After` and `x-ratelimit-reset`); `paginate` follows RFC 5988
 * `Link: rel="next"` headers and concatenates array pages.
 */
type GitHubClientService$1 = {
    request: <A = unknown>(method: GitHubRequestMethod, path: string, body?: unknown, options?: GitHubRequestOptions<A>) => Effect.Effect<A, SmithersError>;
    paginate: (path: string, options?: {
        perPage?: number;
        maxPages?: number;
    }) => Effect.Effect<unknown[], SmithersError>;
};

/**
 * Parse RFC 5988 `Link` header for the `rel="next"` URL.
 * @param {string | null} linkHeader
 * @returns {string | null}
 */
declare function nextPageUrl(linkHeader: string | null): string | null;
/**
 * Build a GitHub REST client bound to `config` (explicit → `configureGitHub`
 * registry → env). The token is only ever written into the Authorization
 * header — never into errors, logs, or details.
 *
 * @param {GitHubConfig} [config]
 * @returns {GitHubClientService}
 */
declare function makeGitHubClient(config?: GitHubConfig): GitHubClientService;
/**
 * Live Layer for {@link GitHubClient}.
 * @param {GitHubConfig} [config]
 */
declare function githubClientLayer(config?: GitHubConfig): Layer.Layer<GitHubClientTag, never, never>;
/**
 * Context tag for the GitHub REST client. Provide it with
 * `githubClientLayer(config)` (or `Layer.succeed(GitHubClient, makeGitHubClient(...))`).
 * @type {Context.TagClass<GitHubClientTag, "GitHubClient", GitHubClientService>}
 */
declare const GitHubClient: Context.TagClass<GitHubClientTag, "GitHubClient", GitHubClientService>;
type GitHubClientTag = {
    readonly _: unique symbol;
};
type GitHubClientService = GitHubClientService$1;
type GitHubConfig = GitHubConfig$2;

type MakeGitHubWebhookSourceOptions$1 = GitHubConfig$2 & {
    /** Source id used for ingress routing + dedupe. @default "github" */
    id?: string;
    /** Bounded ingress queue capacity. @default 256 */
    capacity?: number;
};

/**
 * Decode one GitHub webhook delivery into ExternalEvents.
 *
 * A single delivery fans out into one event per (name, correlation) variant
 * so a listener parked on ANY of the forms wakes — `findRunsAwaitingEvent`
 * matches signal name + correlationId exactly, so each variant must exist as
 * its own signal:
 * - names: base (`integration:github:pull_request`) and, when the payload has
 *   an `action`, the per-action variant (`integration:github:pull_request.opened`);
 * - correlations: `<owner>/<repo>#<number>` (when the payload carries a
 *   number), `<owner>/<repo>`, and `null` (repo-agnostic listeners).
 *
 * dedupeKeys embed the variant (`<deliveryId>:<name>:<correlation>`) so a
 * webhook REdelivery dedupes per variant while one delivery's own variants
 * never collide with each other.
 *
 * @param {WebhookRequest} request
 * @param {number} [receivedAtMs]
 * @returns {ExternalEvent[]}
 */
declare function decodeGitHubWebhook(request: WebhookRequest, receivedAtMs?: number): ExternalEvent[];
/**
 * GitHub webhook EventSource: verifies `X-Hub-Signature-256` (HMAC-SHA256,
 * `sha256=` prefix) against the resolved webhook secret and fans each
 * delivery out per {@link decodeGitHubWebhook}. Plug the result into
 * `makeIntegrationRuntime({ webhookSources: [...] })` — or build it yourself
 * and pass `source`/`offer` around.
 *
 * @param {MakeGitHubWebhookSourceOptions} [options]
 * @returns {import("effect").Effect.Effect<import("../core/EventSourceTypes.ts").WebhookSource, never>}
 */
declare function makeGitHubWebhookSource(options?: MakeGitHubWebhookSourceOptions): effect.Effect.Effect<WebhookSource, never>;
/**
 * Config for `makeIntegrationRuntime({ webhookSources })`: same verification
 * and fan-out as {@link makeGitHubWebhookSource} but as a plain options
 * object (the runtime constructs the queue itself).
 *
 * @param {MakeGitHubWebhookSourceOptions} [options]
 * @returns {import("../core/EventSourceTypes.ts").MakeWebhookSourceOptions}
 */
declare function githubWebhookSourceConfig(options?: MakeGitHubWebhookSourceOptions): MakeWebhookSourceOptions;
/** @typedef {import("../core/EventSourceTypes.ts").WebhookRequest} WebhookRequest */
/** @typedef {import("../core/ExternalEventTypes.ts").ExternalEvent} ExternalEvent */
declare const GITHUB_SOURCE_ID: "github";
type MakeGitHubWebhookSourceOptions = MakeGitHubWebhookSourceOptions$1;
type WebhookRequest = WebhookRequest$1;
type ExternalEvent = ExternalEvent$1;

/**
 * Props for the generic GitHub listener. Compiles to the existing
 * `smithers:wait-for-event` intrinsic: event name
 * `integration:github:<event>[.<action>]`, correlationId
 * `<repo>#<number>` | `<repo>` | none.
 */
type OnWebhookProps$1<Schema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = {
    id: string;
    /** GitHub webhook event name, e.g. `pull_request`, `issues`, `push`. */
    event: string;
    /** Optional action filter, e.g. `opened` — waits on the per-action signal. */
    action?: string;
    /** `owner/repo` correlation filter. */
    repo?: string;
    /** Entity number filter (requires `repo`). */
    number?: number;
    /** Zod schema for the payload (loose/passthrough). */
    schema?: Schema;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    /** Do not block unrelated downstream flow while waiting. */
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
    children?: (payload: z.infer<Schema>) => React__default.ReactNode;
    smithersContext?: React__default.Context<any>;
};
/** Sugar-listener props: everything generic except `event`/`action`/`schema`. */
type GitHubSugarListenerProps$1<Schema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = Omit<OnWebhookProps$1<Schema>, "event">;

/**
 * Correlation id for a GitHub listener: most specific form the props allow.
 * @param {string | undefined} repo
 * @param {number | undefined} number
 * @returns {string | undefined}
 */
declare function githubCorrelationId(repo: string | undefined, number: number | undefined): string | undefined;
/**
 * Generic declarative GitHub listener (Signal.js pattern over WaitForEvent).
 * Waits durably for `integration:github:<event>[.<action>]` with the most
 * specific correlation the props allow; the webhook source emits one signal
 * per (name, correlation) variant, so every combination of
 * `event`/`action`/`repo`/`number` has a matching signal.
 *
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {OnWebhookProps<Schema>} props
 */
declare function OnWebhook<Schema extends zod.ZodObject<zod.ZodRawShape>>(props: OnWebhookProps<Schema>): React__default.FunctionComponentElement<{
    id: string;
    event: string;
    correlationId?: string;
    output: string | zod.ZodObject<Readonly<{
        [k: string]: zod_v4_core.$ZodType<unknown, unknown, zod_v4_core.$ZodTypeInternals<unknown, unknown>>;
    }>, zod_v4_core.$strip> | {
        $inferSelect: Record<string, unknown>;
    };
    outputSchema?: zod.ZodObject<zod.ZodRawShape>;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
}> | React__default.FunctionComponentElement<React__default.FragmentProps> | null;
/**
 * Wait for a `pull_request` event (optionally a specific `action`, repo, PR).
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {GitHubSugarListenerProps<Schema> & { action?: string }} props
 */
declare function OnPullRequest<Schema extends zod.ZodObject<zod.ZodRawShape>>(props: GitHubSugarListenerProps<Schema> & {
    action?: string;
}): React__default.FunctionComponentElement<{
    id: string;
    event: string;
    correlationId?: string;
    output: string | zod.ZodObject<Readonly<{
        [k: string]: zod_v4_core.$ZodType<unknown, unknown, zod_v4_core.$ZodTypeInternals<unknown, unknown>>;
    }>, zod_v4_core.$strip> | {
        $inferSelect: Record<string, unknown>;
    };
    outputSchema?: zod.ZodObject<zod.ZodRawShape>;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
}> | React__default.FunctionComponentElement<React__default.FragmentProps> | null;
/**
 * Wait for `issues.opened`.
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {GitHubSugarListenerProps<Schema>} props
 */
declare function OnIssueOpened<Schema extends zod.ZodObject<zod.ZodRawShape>>(props: GitHubSugarListenerProps<Schema>): React__default.FunctionComponentElement<{
    id: string;
    event: string;
    correlationId?: string;
    output: string | zod.ZodObject<Readonly<{
        [k: string]: zod_v4_core.$ZodType<unknown, unknown, zod_v4_core.$ZodTypeInternals<unknown, unknown>>;
    }>, zod_v4_core.$strip> | {
        $inferSelect: Record<string, unknown>;
    };
    outputSchema?: zod.ZodObject<zod.ZodRawShape>;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
}> | React__default.FunctionComponentElement<React__default.FragmentProps> | null;
/**
 * Wait for an issue/PR comment (`issue_comment`, default action `created`).
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {GitHubSugarListenerProps<Schema> & { action?: string }} props
 */
declare function OnIssueComment<Schema extends zod.ZodObject<zod.ZodRawShape>>(props: GitHubSugarListenerProps<Schema> & {
    action?: string;
}): React__default.FunctionComponentElement<{
    id: string;
    event: string;
    correlationId?: string;
    output: string | zod.ZodObject<Readonly<{
        [k: string]: zod_v4_core.$ZodType<unknown, unknown, zod_v4_core.$ZodTypeInternals<unknown, unknown>>;
    }>, zod_v4_core.$strip> | {
        $inferSelect: Record<string, unknown>;
    };
    outputSchema?: zod.ZodObject<zod.ZodRawShape>;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
}> | React__default.FunctionComponentElement<React__default.FragmentProps> | null;
/**
 * Wait for a `push` event (push deliveries carry no `action`).
 * @template {import("zod").ZodObject<import("zod").ZodRawShape>} Schema
 * @param {GitHubSugarListenerProps<Schema>} props
 */
declare function OnPush<Schema extends zod.ZodObject<zod.ZodRawShape>>(props: GitHubSugarListenerProps<Schema>): React__default.FunctionComponentElement<{
    id: string;
    event: string;
    correlationId?: string;
    output: string | zod.ZodObject<Readonly<{
        [k: string]: zod_v4_core.$ZodType<unknown, unknown, zod_v4_core.$ZodTypeInternals<unknown, unknown>>;
    }>, zod_v4_core.$strip> | {
        $inferSelect: Record<string, unknown>;
    };
    outputSchema?: zod.ZodObject<zod.ZodRawShape>;
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
}> | React__default.FunctionComponentElement<React__default.FragmentProps> | null;
type OnWebhookProps<Schema> = OnWebhookProps$1<Schema>;
type GitHubSugarListenerProps<Schema> = GitHubSugarListenerProps$1<Schema>;

/**
 * A prop that is either a literal value or derived from resolved deps
 * (`deps` prop): the component resolves deps itself, then calls the function.
 */
type FromDeps<T> = T | ((deps: Record<string, any>) => T);
/** Retry policy shape accepted by `Task` (mirrored, kept loose). */
type OutboundRetryPolicy = {
    maxAttempts?: number;
    backoffMs?: number;
    maxBackoffMs?: number;
    [key: string]: unknown;
};
/** Props shared by every outbound GitHub compute-Task component. */
type GitHubOutboundBaseProps = {
    id: string;
    /** Output table target (from `createSmithers({ outputs })`). */
    output: unknown;
    /** `owner/repo`. */
    repo: FromDeps<string>;
    /** Upstream outputs to derive prop values from (Task-style deps spec). */
    deps?: Record<string, unknown>;
    needs?: Record<string, string>;
    dependsOn?: string[];
    retryPolicy?: OutboundRetryPolicy;
    timeoutMs?: number;
    async?: boolean;
    skipIf?: boolean;
    label?: string;
    key?: string;
    /**
     * Non-public: explicit config injected by a bound createSmithers instance.
     * Wins over `configureGitHub()` and env.
     */
    __config?: GitHubConfig$2;
    smithersContext?: React__default.Context<any>;
};
type CommentProps$1 = GitHubOutboundBaseProps & {
    /** Issue or PR number. */
    number: FromDeps<number>;
    body: FromDeps<string>;
};
type CreateIssueProps$1 = GitHubOutboundBaseProps & {
    title: FromDeps<string>;
    body?: FromDeps<string | undefined>;
    labels?: FromDeps<string[] | undefined>;
    assignees?: FromDeps<string[] | undefined>;
};
type CreatePullRequestProps$1 = GitHubOutboundBaseProps & {
    title: FromDeps<string>;
    /** Source branch. */
    head: FromDeps<string>;
    /** Target branch. */
    base: FromDeps<string>;
    body?: FromDeps<string | undefined>;
    draft?: FromDeps<boolean | undefined>;
};
type AddLabelsProps$1 = GitHubOutboundBaseProps & {
    number: FromDeps<number>;
    labels: FromDeps<string[]>;
};
type SetCommitStatusProps$1 = GitHubOutboundBaseProps & {
    sha: FromDeps<string>;
    state: FromDeps<"error" | "failure" | "pending" | "success">;
    context?: FromDeps<string | undefined>;
    description?: FromDeps<string | undefined>;
    targetUrl?: FromDeps<string | undefined>;
};

/**
 * Split `owner/repo`, failing loudly on malformed input (ported from
 * Eliza plugin-github's `splitRepo`).
 * @param {string} repo
 * @returns {{ owner: string; name: string }}
 */
declare function splitRepo(repo: string): {
    owner: string;
    name: string;
};
/**
 * Comment on an issue or pull request
 * (`POST /repos/{owner}/{repo}/issues/{number}/comments`; GitHub uses the
 * issues endpoint for PR conversation comments too). Output row:
 * `{ id, url }` (see `GitHubCommentOutputSchema`).
 * @param {CommentProps} props
 */
declare function Comment(props: CommentProps): React__default.ReactElement<any, string | React__default.JSXElementConstructor<any>> | null;
/**
 * Create an issue (`POST /repos/{owner}/{repo}/issues`). Output row:
 * `{ number, url }` (see `GitHubIssueOutputSchema`).
 * @param {CreateIssueProps} props
 */
declare function CreateIssue(props: CreateIssueProps): React__default.ReactElement<any, string | React__default.JSXElementConstructor<any>> | null;
/**
 * Open a pull request (`POST /repos/{owner}/{repo}/pulls`). Output row:
 * `{ number, url }` (see `GitHubPullRequestOutputSchema`).
 * @param {CreatePullRequestProps} props
 */
declare function CreatePullRequest(props: CreatePullRequestProps): React__default.ReactElement<any, string | React__default.JSXElementConstructor<any>> | null;
/**
 * Add labels to an issue/PR
 * (`POST /repos/{owner}/{repo}/issues/{number}/labels`). Output row:
 * `{ labels }` — comma-joined label names (see `GitHubLabelsOutputSchema`).
 * @param {AddLabelsProps} props
 */
declare function AddLabels(props: AddLabelsProps): React__default.ReactElement<any, string | React__default.JSXElementConstructor<any>> | null;
/**
 * Set a commit status (`POST /repos/{owner}/{repo}/statuses/{sha}`). Output
 * row: `{ state, url }` (see `GitHubCommitStatusOutputSchema`).
 * @param {SetCommitStatusProps} props
 */
declare function SetCommitStatus(props: SetCommitStatusProps): React__default.ReactElement<any, string | React__default.JSXElementConstructor<any>> | null;
type CommentProps = CommentProps$1;
type CreateIssueProps = CreateIssueProps$1;
type CreatePullRequestProps = CreatePullRequestProps$1;
type AddLabelsProps = AddLabelsProps$1;
type SetCommitStatusProps = SetCommitStatusProps$1;

export { AddLabels, Comment, CreateIssue, CreatePullRequest, DEFAULT_GITHUB_API_BASE_URL, GITHUB_SOURCE_ID, GitHubClient, GitHubCommentOutputSchema, GitHubCommentSchema, GitHubCommitStatusOutputSchema, GitHubIssueCommentEventSchema, GitHubIssueOutputSchema, GitHubIssueSchema, GitHubIssuesEventSchema, GitHubLabelsOutputSchema, GitHubPullRequestEventSchema, GitHubPullRequestOutputSchema, GitHubPullRequestSchema, GitHubPushEventSchema, GitHubRepositorySchema, GitHubUserSchema, GitHubWebhookPayloadSchema, OnIssueComment, OnIssueOpened, OnPullRequest, OnPush, OnWebhook, SetCommitStatus, configureGitHub, decodeGitHubWebhook, githubClientLayer, githubCorrelationId, githubWebhookSourceConfig, makeGitHubClient, makeGitHubWebhookSource, nextPageUrl, splitRepo };
