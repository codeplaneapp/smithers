import * as ai from 'ai';
import { Tool as Tool$1, ToolSet, ToolLoopAgentSettings, LanguageModel, ToolLoopAgent } from 'ai';
import { A as AgentGenerateOptions$4, a as AgentCheckpoint$1, b as AgentFileChange$1, c as AgentCheckpointCapability$1, d as AgentCheckpointFormat$1, B as BaseCliAgentOptions, e as BaseCliAgentOptions$1, P as PiExtensionUiRequest$1, f as PiExtensionUiResponse$1, g as BaseCliAgent, C as CliOutputInterpreter$e, h as CodexConfigOverrides, i as AgentCliEvent$1, j as CliOutputInterpreter$f, k as AgentCheckpointResult$1, l as AgentCheckpointMode$1, m as AgentCliActionKind, n as AgentCheckpointContinuationOptions$1, o as AgentCheckpointJsonArray$1, p as AgentCheckpointJsonObject$1, q as AgentCheckpointJsonPrimitive$1, r as AgentCheckpointJsonValue$1, s as AgentCheckpointPublisher$1, t as AgentFileChangeKind$1 } from './index-x_3Jpc_H.js';
import * as zod from 'zod';
import '@smthrs/errors/SmithersError';
import 'effect';
import 'node:child_process';

type TranscriptionProvider$1 = "whisper" | "deepgram";
type TranscriptionToolInput$1 = {
    audioUrl?: string;
    audioBase64?: string;
    mimeType?: string;
    language?: string;
    prompt?: string;
};
type TranscriptionToolResult$1 = {
    text: string;
    language?: string;
    durationSeconds?: number;
    provider: TranscriptionProvider$1;
};
type ResolvedAudioAddress$1 = {
    address: string;
    family?: 4 | 6;
};
type AudioHostResolver$1 = (hostname: string, options: {
    signal?: AbortSignal;
}) => Promise<ResolvedAudioAddress$1[]> | ResolvedAudioAddress$1[];
type PinnedAudioTransportRequest$1 = {
    url: URL;
    address: string;
    family: 4 | 6;
    signal?: AbortSignal;
};
type PinnedAudioTransport$1 = (request: PinnedAudioTransportRequest$1) => Promise<Response> | Response;
type CreateTranscriptionToolOptions$1 = {
    provider: TranscriptionProvider$1;
    apiKey: string;
    model?: string;
    baseUrl?: string;
    description?: string;
    /** Provider API fetch implementation. Never used for local Whisper audio downloads. */
    fetch?: typeof fetch;
    /**
     * Maximum response-body bytes buffered from a remote audio URL before a
     * Whisper upload. Defaults to 25 MiB and must be a positive safe integer.
     */
    maxResponseBodyBytes?: number;
    /**
     * Maximum bytes accepted from a transcription provider response. For
     * compatibility, this also caps a remote audio URL when
     * `maxResponseBodyBytes` is omitted. Defaults to 25 MiB. This remains the
     * compatibility fallback for the audio cap when the canonical option is
     * omitted.
     */
    maxResponseBytes?: number;
    /**
     * Hosts an agent-supplied `audioUrl` may use. When set, only these hosts are
     * allowed and the private/loopback guard is bypassed for them. Use to permit
     * an internal audio store on purpose.
     */
    allowedAudioHosts?: string[];
    /**
     * Bypass the host/address policy and let `audioUrl` name private or loopback
     * addresses. HTTP(S) scheme checks, per-hop address pinning, redirect limits,
     * and abort handling remain enforced. Off by default.
     */
    allowPrivateAudioUrl?: boolean;
    /**
     * Trusted DNS seam for local Whisper `audioUrl` downloads. The resolver must
     * return every A and AAAA answer. Smithers validates the entire result set
     * and pins one accepted address into `audioUrlTransport`.
     */
    audioUrlResolver?: AudioHostResolver$1;
    /**
     * Trusted transport seam for local Whisper `audioUrl` downloads. A custom
     * transport must connect only to `request.address`, preserve the URL host for
     * HTTP Host and TLS SNI/certificate checks, disable pooling, follow no
     * redirects, and honor `request.signal`.
     */
    audioUrlTransport?: PinnedAudioTransport$1;
    /** Maximum local Whisper download redirects. Defaults to 5; maximum 20. */
    audioUrlMaxRedirects?: number;
};
declare function createTranscriptionTool(options: CreateTranscriptionToolOptions$1): Tool$1;

type HttpToolOutput$1 = {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
};

type HttpToolAuth$1 = {
    type: "bearer";
    token: string;
} | {
    type: "basic";
    username: string;
    password: string;
} | {
    type: "header";
    name: string;
    value: string;
};

type HttpToolInput$1 = {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
    auth?: HttpToolAuth$1;
    timeoutMs?: number;
};

type CreateHttpToolOptions$2 = {
    description?: string;
    /**
     * Maximum number of response-body bytes the tool will buffer. Responses
     * larger than this are rejected to prevent model-selected endpoints from
     * exhausting process memory. Defaults to 1,048,576 bytes (1 MiB) and must
     * be a positive safe integer.
     */
    maxResponseBodyBytes?: number;
    /**
     * Backward-compatible alias for `maxResponseBodyBytes`. The canonical option
     * takes precedence when both are provided.
     *
     * @deprecated Use `maxResponseBodyBytes`.
     */
    maxResponseBytes?: number;
    /**
     * Headers merged into every request the tool makes. The model picks the
     * request URL, so when these carry secrets (API keys, cookies) pin them to
     * trusted hosts with `baseUrl`/`allowedHosts`; otherwise a model could point
     * the tool at an attacker host and leak them.
     */
    defaultHeaders?: Record<string, string>;
    /**
     * The API's absolute HTTP(S) base URL. Its host joins the allowlist that
     * gates `defaultHeaders`, so configured secrets ride only to this host (and
     * any `allowedHosts`). Invalid values are rejected when the tool is created.
     */
    baseUrl?: string;
    /**
     * Extra hosts allowed to receive `defaultHeaders`, alongside `baseUrl`'s
     * host. Each entry is a bare host (`api.example.com`, `api.example.com:8443`)
     * or a full URL, matched as WHATWG `url.host`. When neither this nor `baseUrl`
     * is set the default headers are sent to every host (no restriction).
     *
     * The same allowlist gates redirect hops: caller headers, auth, and default
     * headers follow a redirect only when the hop stays on the original
     * request's origin or lands on an allowlisted host — any other cross-origin
     * hop is sent with no headers at all.
     */
    allowedHosts?: string[];
};

type ImageGenerationToolOptions$1 = {
    /** Tool name used when returning a toolset. */
    name?: string;
    /** Description shown to the model. */
    description?: string;
    /** Provider model to use when the agent does not specify one. */
    model?: string;
    /** Return `{ [name]: tool }` for direct mounting on an agent. */
    asToolset?: boolean;
};

type ImageGenerationResult$1 = {
    provider?: string;
    model?: string;
    images: Array<{
        url?: string;
        base64?: string;
        mimeType?: string;
        revisedPrompt?: string;
    }>;
};

type ImageGenerationRequest$1 = {
    prompt: string;
    model?: string;
    size?: string;
    count?: number;
    seed?: number;
    style?: string;
};

type ImageGenerationProvider$1 = {
    name?: string;
    generateImage(request: ImageGenerationRequest$1): Promise<ImageGenerationResult$1> | ImageGenerationResult$1;
};

type CliAgentCapabilityAdapterId$1 = "claude" | "amp" | "antigravity" | "codex" | "cursor" | "forge" | "hermes" | "kimi" | "opencode" | "openclaw" | "pi" | "omp" | "pool" | "vibe";

type CliAgentSurfaceOptionMapping$1 = {
    option: string;
    flag?: string;
    env?: string;
    notes?: string;
};
type CliAgentUnsupportedFlag$1 = {
    flag: string;
    replacement?: string;
    reason: string;
};
type CliAgentSurfaceResumeContract$1 = {
    kind: "flag" | "subcommand" | "env" | "none";
    emitted: string[];
    notes: string;
};
type CliAgentSurfaceManifestEntry$2 = {
    id: CliAgentCapabilityAdapterId$1;
    displayName: string;
    binary: string;
    packageExport: string;
    defaultOutputFormat: "text" | "json" | "stream-json" | "rpc";
    docsUrls: string[];
    emittedFlags: string[];
    supportedFlags: string[];
    unsupportedFlags: CliAgentUnsupportedFlag$1[];
    optionMappings: CliAgentSurfaceOptionMapping$1[];
    resume: CliAgentSurfaceResumeContract$1;
};

type AgentToolDescriptor$1 = {
    description?: string;
    source?: "builtin" | "mcp" | "extension" | "skill" | "runtime";
};

type AgentCapabilityRegistry$c = {
    version: 1;
    engine: "claude-code" | "codex" | "cursor" | "antigravity" | "gemini" | "kimi" | "pi" | "omp" | "amp" | "forge" | "hermes" | "opencode" | "openclaw" | "pool" | "vibe";
    runtimeTools: Record<string, AgentToolDescriptor$1>;
    mcp: {
        bootstrap: "inline-config" | "project-config" | "allow-list" | "unsupported";
        supportsProjectScope: boolean;
        supportsUserScope: boolean;
    };
    skills: {
        supportsSkills: boolean;
        installMode?: "files" | "dir" | "plugin";
        smithersSkillIds: string[];
    };
    humanInteraction: {
        supportsUiRequests: boolean;
        methods: string[];
    };
    fileChanges: {
        /** Can this engine identify file-mutating tool calls at all? */
        supportsFileChanges: boolean;
        /** Can it produce (report or reconstruct) full diff content? */
        supportsUnifiedDiff: boolean;
    };
    builtIns: string[];
};

/**
 * @param {AgentCapabilityRegistry | null | undefined} registry
 * @returns {string}
 */
declare function hashCapabilityRegistry(registry: AgentCapabilityRegistry$b | null | undefined): string;
type AgentCapabilityRegistry$b = AgentCapabilityRegistry$c;

type AgentCapabilityRegistry$a = AgentCapabilityRegistry$c;

type CliAgentCapabilityReportEntry$3 = {
    id: CliAgentCapabilityAdapterId$1;
    binary: string;
    fingerprint: string;
    capabilities: AgentCapabilityRegistry$a;
    surface: CliAgentSurfaceManifestEntry$2;
};

type CliAgentCapabilityIssue$1 = {
    code: string;
    message: string;
    severity: "error" | "warning";
};
type CliAgentCapabilityDoctorEntry$1 = CliAgentCapabilityReportEntry$3 & {
    ok: boolean;
    issues: CliAgentCapabilityIssue$1[];
};
type CliAgentCapabilityDoctorReport$3 = {
    ok: boolean;
    issueCount: number;
    agents: CliAgentCapabilityDoctorEntry$1[];
};

type SmithersToolSurface$2 = "raw" | "semantic";

type SmithersListedTool$2 = {
    name: string;
    description?: string | null;
};

type SmithersAgentToolCategory$1 = "runs" | "approvals" | "workflows" | "debug" | "admin";

type SmithersAgentContractTool$1 = {
    name: string;
    description: string;
    destructive: boolean;
    category: SmithersAgentToolCategory$1;
};

type SmithersAgentContract$3 = {
    toolSurface: SmithersToolSurface$2;
    serverName: string;
    tools: SmithersAgentContractTool$1[];
    promptGuidance: string;
    docsGuidance: string;
};

type NanocodexApiKeyAuth = {
    mode: "api-key-env";
    environmentVariable: string;
};
type NanocodexChatGptAuth = {
    mode: "chatgpt";
    /** Absolute Unicode scalar managed-auth path without NUL, at most 4,096 UTF-16 code units. */
    authFile?: string;
};
type NanocodexAuth$1 = NanocodexApiKeyAuth | NanocodexChatGptAuth;
type NanocodexThinking$1 = "none" | "low" | "medium" | "high" | "xhigh" | "max";
type NanocodexReasoningMode$1 = "standard" | "pro";
/**
 * Per-call options accepted by {@link NanocodexAgent.generate}. Protocol v1
 * supports same-session checkpoint resume only and does not accept provider
 * session identifiers.
 */
type NanocodexGenerateOptions$1 = AgentGenerateOptions$4 & {
    /** Nanocodex always uses its stock native tool set. */
    tools?: never;
    /** Provider options are configured on the agent, not per call. */
    options?: never;
    resumeCheckpoint?: AgentCheckpoint$1;
    checkpointMode?: "resume";
    resumeSession?: never;
};
/**
 * Configuration for one stock, headless Nanocodex worker per generate call.
 * Native Code Mode remains enabled; JavaScript tools, MCP, subagents, custom
 * endpoints, and workspace relocation are intentionally not configurable.
 * Protocol v1 requires Linux x86_64, glibc >=2.35, and a working Bubblewrap
 * installation.
 */
type NanocodexAgentOptions$2 = {
    id?: string;
    /** Absolute path or executable name resolved from the effective PATH. */
    binary?: string;
    cwd?: string;
    auth?: NanocodexAuth$1;
    /** Complete instruction replacement, at most 4 MiB encoded as UTF-8. */
    instructions?: string;
    thinking?: NanocodexThinking$1;
    reasoningMode?: NanocodexReasoningMode$1;
    fastMode?: boolean;
    env?: Record<string, string>;
    inheritEnv?: boolean;
    /** Total timeout in milliseconds. Must not exceed 2^31 - 1. */
    timeoutMs?: number;
    /** Idle timeout in milliseconds. Must not exceed 2^31 - 1. */
    idleTimeoutMs?: number;
    /** Grace period for protocol cancellation. Must not exceed 2^31 - 1. */
    cancellationGraceMs?: number;
    maxCheckpointBytes?: number;
};

/**
 * Represents an entity capable of generating responses or actions based on prompts.
 * This is typically an AI agent interface.
 */
type AgentLike$2 = {
    /** Optional unique identifier for the agent */
    id?: string;
    /** Available tools the agent can use */
    tools?: Record<string, unknown>;
    /** Optional structured capability registry for cache and diagnostics */
    capabilities?: AgentCapabilityRegistry$a;
    /** True when the agent consumes outputSchema through a native structured-output API. */
    supportsNativeStructuredOutput?: boolean;
    /** Optional harness-specific file-change normalizer. */
    parseFileChanges?: (rawEvent: unknown) => AgentFileChange$1[] | undefined;
    /** Version- and mode-aware checkpoint formats this agent can consume. */
    checkpointCapabilities?: readonly AgentCheckpointCapability$1[];
    /** Checkpoint formats this agent may return or publish during generation. */
    checkpointFormats?: readonly AgentCheckpointFormat$1[];
    /**
     * Performs deterministic startup checks before the first generation call in a
     * workflow run. A rejected promise fails the task without retrying.
     */
    preflight?: (args?: AgentGenerateOptions$4) => Promise<void>;
    /**
     * Generates a response or action based on the provided arguments.
     *
     * @param args - The arguments for generation
     * @param args.options - Optional provider-specific configuration
     * @param args.abortSignal - Signal to abort the generation request
     * @param args.prompt - The input text prompt to generate from
     * @param args.timeout - Optional timeout configuration in milliseconds
     * @param args.onStdout - Callback for streaming standard output text
     * @param args.onStderr - Callback for streaming standard error text
     * @param args.outputSchema - Optional Zod schema defining the expected structured output format
     * @returns A promise resolving to the generated output. Results may include
     * an optional `checkpoint: AgentCheckpoint` for a later resume or fork.
     */
    generate: (args?: AgentGenerateOptions$4) => Promise<unknown>;
};

/**
 * Providers `fallbackAgents` knows how to turn into a CLI agent instance.
 * Subscription providers use the account's `configDir`; API providers use the
 * account's `apiKey`.
 */
type FallbackAgentProvider$1 = "claude-code" | "codex" | "kimi" | "antigravity" | "anthropic-api" | "openai-api";
type FallbackAgentsOptions$2 = {
    /**
     * Which registered account providers to include in the chain. Defaults to
     * `["claude-code", "codex"]` (every Claude and Codex subscription). Pass
     * `"all"` to include every provider fallbackAgents can construct.
     */
    providers?: FallbackAgentProvider$1[] | "all";
    /**
     * The "normal" agent(s) appended after the registered accounts, and returned
     * alone when no matching accounts exist (fresh machine, CI, corrupt
     * registry). Defaults to a stock agent for the first requested provider
     * family (Claude Code unless `providers` starts with a Codex-family
     * provider). Pass `[]` to disable the tail entirely.
     */
    fallback?: AgentLike$2 | AgentLike$2[];
    /**
     * Per-provider model override, e.g. `{ codex: "gpt-5.6-sol" }`. Wins over
     * the account's registered `model`. Absent both, the CLI's own default
     * model is used.
     */
    models?: Partial<Record<FallbackAgentProvider$1, string>>;
    /**
     * Per-provider constructor options applied to every pooled rung of that
     * provider, e.g. `{ codex: { sandbox: "read-only" } }`. Use it to keep a
     * task's intended authority (read-only sandbox, restricted tools, provider
     * config) when a single hardcoded agent becomes a pool. Account identity
     * (`configDir`, `apiKey`, `id`) is always applied last and cannot be
     * overridden, so a rung can never be repointed at another subscription.
     */
    agentOptions?: Partial<Record<FallbackAgentProvider$1, Record<string, unknown>>>;
    /**
     * Randomly order the registered accounts (default `true`). Each
     * `fallbackAgents()` call draws a fresh order, so load spreads across
     * subscriptions while the engine's quota failover walks the chain in order.
     * Set `false` to keep registration order.
     */
    shuffle?: boolean;
    /**
     * RNG used by the shuffle (default `Math.random`). Inject a seeded function
     * for deterministic ordering in tests or replay-stable workflows.
     */
    random?: () => number;
    /**
     * Convenience alternative to `random`: derive a deterministic shuffle from
     * this value. Pass the run id (`seed: ctx.runId`) so the chain is stable
     * across every render and retry of one run (keeping the engine's
     * per-rung quota skipping precise) while still varying run to run.
     * Ignored when `random` is provided.
     */
    seed?: string | number;
    /** Environment used to locate the registry (honors `SMITHERS_HOME`). */
    env?: NodeJS.ProcessEnv;
};

type VibeAgentOptions$2 = BaseCliAgentOptions & {
    agent?: string;
    maxTurns?: number;
    maxPrice?: number;
    maxTokens?: number;
    enabledTools?: string[];
    sessionId?: string;
    continueSession?: boolean;
};

type PoolAgentOptions$2 = BaseCliAgentOptions & {
    /** Agent name to use (e.g., "default", or a custom configured agent) */
    agentName?: string;
    /** Model to use */
    model?: string;
    /** Sandbox mode: "required" or "disabled" */
    sandbox?: "required" | "disabled";
    /** Continue a previous conversation by Run ID */
    continue?: string;
    /** Resume a previous session by ID */
    resume?: string;
    /** Session id for continuation (preferred over continue) */
    resumeSession?: string;
};

/**
 * Configuration options for the OpenCodeAgent.
 */
type OpenCodeAgentOptions$2 = BaseCliAgentOptions$1 & {
    /** Model identifier (e.g., "anthropic/claude-opus-4-8", "openai/gpt-5.6-luna") */
    model?: string;
    /** OpenCode agent name (maps to --agent flag, selects predefined agent config) */
    agentName?: string;
    /** Files to attach to the prompt via -f flags */
    attachFiles?: string[];
    /** Continue a previous session */
    continueSession?: boolean;
    /** Resume a specific session by ID */
    sessionId?: string;
    /** Provider-specific model variant/reasoning effort level */
    variant?: string;
};

type CursorAgentOptions$2 = BaseCliAgentOptions & {
    apiKey?: string;
    header?: string[];
    model?: string;
    mode?: "plan" | "ask";
    plan?: boolean;
    resume?: string | boolean;
    continueSession?: boolean;
    force?: boolean;
    autoReview?: boolean;
    sandbox?: "enabled" | "disabled";
    approveMcps?: boolean;
    trust?: boolean;
    workspace?: string;
    pluginDir?: string[];
    worktree?: string | boolean;
    worktreeBase?: string;
    skipWorktreeSetup?: boolean;
    streamPartialOutput?: boolean;
};

type PiAgentOptions$2 = BaseCliAgentOptions & {
    provider?: string;
    model?: string;
    apiKey?: string;
    systemPrompt?: string;
    appendSystemPrompt?: string;
    mode?: "text" | "json" | "rpc";
    print?: boolean;
    continue?: boolean;
    resume?: boolean;
    session?: string;
    sessionDir?: string;
    noSession?: boolean;
    models?: string | string[];
    listModels?: boolean | string;
    tools?: string[];
    noTools?: boolean;
    extension?: string[];
    noExtensions?: boolean;
    skill?: string[];
    noSkills?: boolean;
    promptTemplate?: string[];
    noPromptTemplates?: boolean;
    theme?: string[];
    noThemes?: boolean;
    thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    export?: string;
    files?: string[];
    verbose?: boolean;
    onExtensionUiRequest?: (request: PiExtensionUiRequest$1) => Promise<PiExtensionUiResponse$1 | null> | PiExtensionUiResponse$1 | null;
};

/**
 * Options for {@link OpenClawAgent}.
 *
 * Drives the `openclaw` binary through the gateway-backed one-shot agent CLI:
 * `openclaw agent --agent <id> --message <prompt> --json`. Use this when a
 * workflow `<Task>` should delegate to OpenClaw itself.
 */
type OpenClawAgentOptions$2 = BaseCliAgentOptions & {
    /** OpenClaw agent id. Defaults to OpenClaw's configured default agent. */
    agent?: string;
    /** Session id to route the message into. Emits OpenClaw's `--session-id` flag. */
    sessionId?: string;
    /** Legacy alias for sessionId. */
    session?: string;
    /** Workspace/root directory to expose to OpenClaw, when supported by the installed CLI. */
    workspace?: string;
    /** Request JSON output from OpenClaw. Defaults to true. */
    json?: boolean;
    /** Continue an existing/default conversation, when supported by the installed CLI. */
    continueSession?: boolean;
};

/**
 * Options for {@link HermesCliAgent}.
 *
 * Drives the `hermes` binary (Nous Research's Hermes Agent CLI) in its headless
 * one-shot mode (`hermes -z "<prompt>"`). Distinct from {@link HermesAgent},
 * which talks to the Hermes *model* over an OpenAI-compatible HTTP API. Use this
 * when you want a workflow `<Task>` to delegate to the Hermes agent itself.
 */
type HermesCliAgentOptions$2 = BaseCliAgentOptions & {
    /**
     * Force a specific provider backend (e.g. `openrouter`, `anthropic`,
     * `deepseek`). Emitted as `--provider`.
     */
    provider?: string;
    /**
     * Resume the most recent session, or a named session when a string is given.
     * Emitted as `-c`/`--continue`. Overridden by a per-call `resumeSession`.
     */
    continueSession?: string | boolean;
};

type SdkAgentOptions<CALL_OPTIONS = never, TOOLS extends ToolSet = {}, MODEL = any> = Omit<ToolLoopAgentSettings<CALL_OPTIONS, TOOLS, any, never>, "model"> & {
    /**
     * Either a provider model id string or a preconstructed AI SDK language model.
     * Passing a model instance is mainly useful for tests and advanced provider setup.
     */
    model: string | MODEL;
};

/**
 * Options for {@link HermesAgent}.
 *
 * Hermes (Nous Research) exposes an OpenAI-compatible HTTP API
 * (`/v1/chat/completions`), so a Hermes agent is reached the same way as any
 * OpenAI-compatible endpoint: point `baseURL` at the Hermes server. These mirror
 * the string-model form of `OpenAIAgentOptions`.
 */
type HermesAgentOptions$2<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = Omit<SdkAgentOptions<CALL_OPTIONS, TOOLS, LanguageModel>, "model"> & {
    /**
     * Model name exposed by your Hermes server. Defaults to `"hermes"`; override
     * with whatever model id the server advertises.
     */
    model?: string;
    /**
     * Base URL of the Hermes OpenAI-compatible API, e.g. `http://127.0.0.1:5123/v1`.
     * Falls back to the `HERMES_BASE_URL` environment variable.
     */
    baseURL?: string;
    /**
     * API key sent to the Hermes server. Falls back to `HERMES_API_KEY`, then
     * `"hermes"` (local servers commonly ignore the value).
     */
    apiKey?: string;
    /**
     * Enable AI SDK native structured output. Off by default because a local
     * Hermes server may not honor JSON-schema response formats — leaving it off
     * makes Smithers fall back to prompt-based JSON extraction.
     */
    nativeStructuredOutput?: boolean;
};

type OpenAIAgentCommonOptions<CALL_OPTIONS, TOOLS extends ToolSet> = Omit<SdkAgentOptions<CALL_OPTIONS, TOOLS, LanguageModel>, "model"> & {
    /**
     * Disable AI SDK native structured output and let Smithers use prompt-based JSON extraction.
     * Useful for OpenAI-compatible local servers that do not honor JSON schema response formats.
     */
    nativeStructuredOutput?: boolean;
};
type OpenAIAgentStringModelOptions = {
    model: string;
    /**
     * Base URL for OpenAI-compatible API calls, e.g. a local llama.cpp server.
     */
    baseURL?: string;
    /**
     * API key sent to OpenAI-compatible endpoints. Local servers often accept "none".
     */
    apiKey?: string;
    /**
     * Which OpenAI API surface serves the string model. The provider default
     * ("responses") targets the `/responses` endpoint, which most OpenAI-compatible
     * servers (Gemini's compat layer, llama.cpp, vLLM, ...) do not implement — set
     * "chat" to call `/chat/completions` on those endpoints.
     */
    api?: "responses" | "chat";
};
type OpenAIAgentPrebuiltModelOptions = {
    model: LanguageModel;
    baseURL?: never;
    apiKey?: never;
    api?: never;
};
type OpenAIAgentOptions$2<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = OpenAIAgentCommonOptions<CALL_OPTIONS, TOOLS> & (OpenAIAgentStringModelOptions | OpenAIAgentPrebuiltModelOptions);

type AnthropicAgentOptions$2<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = SdkAgentOptions<CALL_OPTIONS, TOOLS, LanguageModel>;

/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */
/**
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 * @typedef {import("./AnthropicAgentOptions.ts").AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} AnthropicAgentOptions
 */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("ai").ToolSet]
 * @extends {ToolLoopAgent<CALL_OPTIONS, TOOLS, any, never>}
 */
declare class AnthropicAgent<CALL_OPTIONS = never, TOOLS = ai.ToolSet> extends ToolLoopAgent<CALL_OPTIONS, TOOLS, any, never> {
    /**
     * @param {AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} opts
     */
    constructor(opts: AnthropicAgentOptions$1<CALL_OPTIONS, TOOLS>);
    hijackEngine: string;
    supportsNativeStructuredOutput: boolean;
    /**
     * @param {AgentGenerateOptions} [args]
     * @returns {Promise<GenerateTextResult<TOOLS, never>>}
     */
    generate(args?: AgentGenerateOptions$3): Promise<GenerateTextResult$2<TOOLS, never>>;
}
type AgentGenerateOptions$3 = AgentGenerateOptions$4;
type AnthropicAgentOptions$1<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = AnthropicAgentOptions$2<CALL_OPTIONS, TOOLS>;
type GenerateTextResult$2 = ai.GenerateTextResult<any, any, any>;

/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
/**
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 * @typedef {import("./OpenAIAgentOptions.ts").OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} OpenAIAgentOptions
 */
/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("ai").ToolSet]
 * @extends {ToolLoopAgent<CALL_OPTIONS, TOOLS, any, never>}
 */
declare class OpenAIAgent<CALL_OPTIONS = never, TOOLS = ai.ToolSet> extends ToolLoopAgent<CALL_OPTIONS, TOOLS, any, never> {
    /**
     * @param {OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} opts
     */
    constructor(opts: OpenAIAgentOptions$1<CALL_OPTIONS, TOOLS>);
    hijackEngine: string;
    supportsNativeStructuredOutput: boolean;
    /**
     * @param {AgentGenerateOptions} [args]
     * @returns {Promise<GenerateTextResult<TOOLS, never>>}
     */
    generate(args?: AgentGenerateOptions$2): Promise<GenerateTextResult$1<TOOLS, never>>;
}
type AgentGenerateOptions$2 = AgentGenerateOptions$4;
type GenerateTextResult$1 = ai.GenerateTextResult<any, any, any>;
type OpenAIAgentOptions$1<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = OpenAIAgentOptions$2<CALL_OPTIONS, TOOLS>;

/**
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 * @typedef {import("./HermesAgentOptions.ts").HermesAgentOptions<CALL_OPTIONS, TOOLS>} HermesAgentOptions
 */
/**
 * Hermes (Nous Research) agent, reached over its OpenAI-compatible HTTP API.
 *
 * A thin wrapper over {@link OpenAIAgent}: it points the OpenAI-compatible
 * provider at the Hermes server (`baseURL` / `HERMES_BASE_URL`) and disables AI
 * SDK native structured output by default, since a local Hermes server may not
 * honor JSON-schema response formats. Everything else — tool loops, streaming,
 * prompt-based structured output — comes from the shared OpenAI path.
 *
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 */
declare class HermesAgent<CALL_OPTIONS = never, TOOLS = ai.ToolSet> extends OpenAIAgent<never, ai.ToolSet> {
    /**
     * @param {HermesAgentOptions<CALL_OPTIONS, TOOLS>} [opts]
     */
    constructor(opts?: HermesAgentOptions$1<CALL_OPTIONS, TOOLS>);
}
type HermesAgentOptions$1<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = HermesAgentOptions$2<CALL_OPTIONS, TOOLS>;

/**
 * Configuration options for the AmpAgent.
 */
type AmpAgentOptions$1 = BaseCliAgentOptions & {
    /**
     * Thread id to continue. When set (or when a task passes
     * `options.resumeSession`), buildCommand emits `amp threads continue <id>`
     * instead of starting a fresh thread.
     */
    resume?: string;
    /** Visibility setting for the new thread (e.g., private, public) */
    visibility?: "private" | "public" | "workspace" | "group";
    /** Path to a specific MCP configuration file */
    mcpConfig?: string;
    /** Path to a specific settings file */
    settingsFile?: string;
    /** Logging severity level */
    logLevel?: "error" | "warn" | "info" | "debug" | "audit";
    /** File path to write logs to */
    logFile?: string;
    /**
     * If true, dangerously allows all commands without asking for permission.
     * Equivalent to yolo mode but explicit.
     */
    dangerouslyAllowAll?: boolean;
    /** Whether to enable IDE integrations (disabled by default in AmpAgent) */
    ide?: boolean;
    /** Whether to enable JetBrains IDE integration */
    jetbrains?: boolean;
};

/**
 * Agent implementation that wraps the 'amp' CLI executable.
 * It translates generation requests into CLI arguments and executes the process.
 */
declare class AmpAgent extends BaseCliAgent {
    /**
     * Initializes a new AmpAgent with the given options.
     *
     * @param {AmpAgentOptions} [opts] - Configuration options for the agent
     */
    constructor(opts?: AmpAgentOptions);
    opts: AmpAgentOptions$1;
    /** @type {AgentCapabilityRegistry} */
    capabilities: AgentCapabilityRegistry$9;
    cliEngine: string;
    /**
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$d;
    /**
     * Normalize a `file_change` action (as emitted by {@link createOutputInterpreter})
     * into {@link AgentFileChange} records. `action` is `{ title, detail: { input } }`.
     *
     * @param {unknown} action
     * @returns {import("./agent-contract/AgentFileChange.ts").AgentFileChange[] | undefined}
     */
    parseFileChanges(action: unknown): AgentFileChange$1[] | undefined;
    /**
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any }} params
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: any[];
        outputFormat: string;
    }>;
}
type AgentCapabilityRegistry$9 = AgentCapabilityRegistry$c;
type CliOutputInterpreter$d = CliOutputInterpreter$e;
type AmpAgentOptions = AmpAgentOptions$1;

type AntigravityAgentOptions$1 = BaseCliAgentOptions & {
    model?: string;
    sandbox?: boolean;
    yolo?: boolean;
    dangerouslySkipPermissions?: boolean;
    allowedMcpServerNames?: string[];
    allowedTools?: string[];
    /**
     * @deprecated Antigravity renamed extensions to plugins and manages them via
     * `agy plugin`; launch-time extension flags are rejected at runtime.
     */
    extensions?: string[];
    /**
     * @deprecated Use `agy plugin list` outside Smithers. This option is rejected
     * at runtime because current `agy` builds no longer accept it during launch.
     */
    listExtensions?: boolean;
    /**
     * Native Antigravity conversation id. Smithers emits `--conversation`.
     */
    conversation?: string;
    /**
     * Continue the latest Antigravity conversation. Smithers emits `--continue`.
     */
    continue?: boolean;
    /**
     * @deprecated Use `conversation`; Smithers still maps this to
     * `--conversation` for compatibility.
     */
    resume?: string;
    /**
     * @deprecated Conversation listing is interactive via `/resume`; this option
     * is rejected at runtime.
     */
    listSessions?: boolean;
    /**
     * @deprecated Conversation deletion is not a supported non-interactive
     * launch flag; this option is rejected at runtime.
     */
    deleteSession?: string;
    includeDirectories?: string[];
    /**
     * @deprecated Current `agy` builds do not expose `--screen-reader`; this
     * option is rejected at runtime.
     */
    screenReader?: boolean;
    /**
     * @deprecated Current `agy` builds do not expose `--output-format`; Smithers
     * reads Antigravity stdout as text.
     */
    outputFormat?: "text" | "json" | "stream-json";
    /**
     * @deprecated Current `agy` builds do not expose `--debug`; this option is
     * rejected at runtime.
     */
    debug?: boolean;
    /**
     * Antigravity CLI binary to execute. The official CLI currently installs
     * `agy`; this exists for test harnesses and future binary renames.
     */
    binary?: string;
    /**
     * Path to an isolated Google CLI config root. Smithers passes it as
     * `--gemini_dir` and `GEMINI_DIR` so Antigravity reads/writes
     * `<configDir>/antigravity-cli/...` instead of the user's default
     * `~/.gemini/antigravity-cli/...`.
     */
    configDir?: string;
    /**
     * Explicit alias for `configDir` when matching the Antigravity CLI flag name.
     */
    geminiDir?: string;
    /**
     * Google API key for API-billed invocations when supported by the CLI.
     */
    apiKey?: string;
};

declare class AntigravityAgent extends BaseCliAgent {
    /**
     * @param {AntigravityAgentOptions} [opts]
     */
    constructor(opts?: AntigravityAgentOptions);
    opts: AntigravityAgentOptions$1;
    capabilities: AgentCapabilityRegistry$c;
    cliEngine: string;
    /**
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$c;
    /**
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: string;
        env: {
            GEMINI_DIR: string | undefined;
            GEMINI_API_KEY: string;
        } | undefined;
    }>;
}
type CliOutputInterpreter$c = CliOutputInterpreter$e;
type AntigravityAgentOptions = AntigravityAgentOptions$1;

type ClaudeCodeAgentOptions$1 = BaseCliAgentOptions & {
    addDir?: string[];
    agent?: string;
    agents?: Record<string, {
        description?: string;
        prompt?: string;
    }> | string;
    allowDangerouslySkipPermissions?: boolean;
    allowedTools?: string[];
    appendSystemPrompt?: string;
    /**
     * Path to an isolated Claude Code config directory. Sets `CLAUDE_CONFIG_DIR`
     * on the spawned process so this invocation uses that directory's
     * credentials (instead of the user's default `~/.claude/`): the CLI stores
     * them at `<configDir>/.credentials.json`, or on macOS in a per-config-dir
     * Keychain item suffixed with the first 8 hex chars of sha256(configDir).
     *
     * Use this to run multiple Claude Code subscriptions side-by-side. Set up
     * the directory by running `CLAUDE_CONFIG_DIR=<path> claude` once and
     * completing `/login` interactively, or via
     * `smithers agents add --provider claude-code --label <name> --tmux`.
     */
    configDir?: string;
    /**
     * Anthropic API key for billing this invocation against the API instead of
     * a Claude Pro/Max subscription. When set, ClaudeCodeAgent stops unsetting
     * `ANTHROPIC_API_KEY` (which it normally clears so subscription auth wins).
     */
    apiKey?: string;
    betas?: string[];
    chrome?: boolean;
    continue?: boolean;
    dangerouslySkipPermissions?: boolean;
    debug?: boolean | string;
    debugFile?: string;
    disableSlashCommands?: boolean;
    disallowedTools?: string[];
    fallbackModel?: string;
    file?: string[];
    forkSession?: boolean;
    fromPr?: string;
    ide?: boolean;
    includePartialMessages?: boolean;
    inputFormat?: "text" | "stream-json";
    jsonSchema?: string;
    maxBudgetUsd?: number;
    mcpConfig?: string[];
    mcpDebug?: boolean;
    model?: string;
    noChrome?: boolean;
    noSessionPersistence?: boolean;
    outputFormat?: "text" | "json" | "stream-json";
    permissionMode?: "acceptEdits" | "bypassPermissions" | "default" | "delegate" | "dontAsk" | "plan";
    pluginDir?: string[];
    replayUserMessages?: boolean;
    resume?: string;
    sessionId?: string;
    settingSources?: string;
    settings?: string;
    strictMcpConfig?: boolean;
    systemPrompt?: string;
    tools?: string[] | "default" | "";
    verbose?: boolean;
};

declare class ClaudeCodeAgent extends BaseCliAgent {
    /**
     * @param {ClaudeCodeAgentOptions} [opts]
     */
    constructor(opts?: ClaudeCodeAgentOptions);
    opts: ClaudeCodeAgentOptions$1;
    capabilities: AgentCapabilityRegistry$c;
    cliEngine: string;
    /**
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$b;
    /**
     * Normalize a `file_change` action (as emitted by {@link createOutputInterpreter})
     * into {@link AgentFileChange} records. `action` is `{ title, detail: { input } }`.
     *
     * @param {unknown} action
     * @returns {import("./agent-contract/AgentFileChange.ts").AgentFileChange[] | undefined}
     */
    parseFileChanges(action: unknown): AgentFileChange$1[] | undefined;
    /**
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        cleanup?: (() => Promise<void>) | undefined;
        command: string;
        args: string[];
        outputFormat: "text" | "json" | "stream-json";
        env: {
            SMITHERS_SNAPSHOT_SOCK: any;
            CLAUDE_CONFIG_DIR: string;
            ANTHROPIC_API_KEY: string;
        } | undefined;
    }>;
}
type ClaudeCodeAgentOptions = ClaudeCodeAgentOptions$1;
type CliOutputInterpreter$b = CliOutputInterpreter$e;

type CodexAgentOptions$1 = BaseCliAgentOptions & {
    config?: CodexConfigOverrides;
    enable?: string[];
    disable?: string[];
    image?: string[];
    model?: string;
    oss?: boolean;
    localProvider?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    profile?: string;
    fullAuto?: boolean;
    dangerouslyBypassApprovalsAndSandbox?: boolean;
    cd?: string;
    skipGitRepoCheck?: boolean;
    addDir?: string[];
    outputSchema?: string;
    /**
     * Opt in to Codex's native structured output (`codex exec --output-schema`).
     *
     * Defaults to `false`. Native structured output makes the model emit only the
     * final JSON and refuse tool calls, so it BREAKS agentic tasks (read/edit/run) —
     * Codex returns `blocked` with no changes. Left off, Smithers treats Codex like
     * the other CLI engines: it prompt-injects the schema and extracts JSON from the
     * agent's final message, so tool use stays intact. Enable only for pure, tool-free
     * extraction tasks that need strict schema enforcement.
     */
    nativeStructuredOutput?: boolean;
    color?: "always" | "never" | "auto";
    json?: boolean;
    outputLastMessage?: string;
    /**
     * Path to an isolated Codex CLI config directory. Sets `CODEX_HOME` on the
     * spawned process so this invocation uses the credentials stored at
     * `<configDir>/auth.json` (instead of the user's default `~/.codex/`).
     *
     * Use this to run multiple Codex / ChatGPT subscriptions side-by-side. Set
     * up the directory by running `CODEX_HOME=<path> codex login` once.
     */
    configDir?: string;
    /**
     * Sets `OPENAI_API_KEY` on the spawned process. Codex CLI >= 0.144 ignores
     * that variable for auth/billing selection when subscription login is
     * present, so this option is effectively inert on current CLIs.
     */
    apiKey?: string;
};

declare class CodexAgent extends BaseCliAgent {
    /**
     * @param {CodexAgentOptions} [opts]
     */
    constructor(opts?: CodexAgentOptions);
    opts: CodexAgentOptions$1;
    capabilities: AgentCapabilityRegistry$c;
    cliEngine: string;
    supportsNativeStructuredOutput: boolean;
    /**
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$a;
    /**
     * Normalize a `file_change` action (as emitted by {@link createOutputInterpreter})
     * into {@link AgentFileChange} records. `action.detail.changes` is codex's
     * native `{path, kind}[]` — no diff content in the protocol.
     *
     * @param {unknown} action
     * @returns {import("./agent-contract/AgentFileChange.ts").AgentFileChange[] | undefined}
     */
    parseFileChanges(action: unknown): AgentFileChange$1[] | undefined;
    /**
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        stdin: string;
        outputFile: string;
        outputFormat: string;
        env: {
            CODEX_HOME: string;
            OPENAI_API_KEY: string;
        } | undefined;
        stdoutBannerPatterns: RegExp[];
        cleanup: () => Promise<void>;
    }>;
}
type CliOutputInterpreter$a = CliOutputInterpreter$e;
type CodexAgentOptions = CodexAgentOptions$1;

declare class CursorAgent extends BaseCliAgent {
    /**
     * @param {CursorAgentOptions} [opts]
     */
    constructor(opts?: CursorAgentOptions$1);
    /** @type {CursorAgentOptions} */
    opts: CursorAgentOptions$1;
    /** @type {AgentCapabilityRegistry} */
    capabilities: AgentCapabilityRegistry$8;
    /** @type {"cursor"} */
    cliEngine: "cursor";
    /**
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$9;
    /**
     * Normalize a `file_change` action (as emitted by {@link createOutputInterpreter})
     * into {@link AgentFileChange} records. `action` is
     * `{ title, detail: { arguments } }` where `arguments` is the tool call's
     * protobuf `args` object.
     *
     * @param {unknown} action
     * @returns {import("./agent-contract/AgentFileChange.ts").AgentFileChange[] | undefined}
     */
    parseFileChanges(action: unknown): AgentFileChange$1[] | undefined;
    /**
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any }} params
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: string;
        env: {
            CURSOR_API_KEY: string;
        } | undefined;
    }>;
}
type AgentCapabilityRegistry$8 = AgentCapabilityRegistry$c;
type CliOutputInterpreter$9 = CliOutputInterpreter$e;
type CursorAgentOptions$1 = CursorAgentOptions$2;

/**
 * @deprecated Gemini CLI support has been sunset. Use AntigravityAgentOptions
 * with the Antigravity CLI (`agy`) for Google CLI integrations.
 */
type GeminiAgentOptions$1 = BaseCliAgentOptions & {
    debug?: boolean;
    model?: string;
    sandbox?: boolean;
    yolo?: boolean;
    approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
    experimentalAcp?: boolean;
    allowedMcpServerNames?: string[];
    allowedTools?: string[];
    extensions?: string[];
    listExtensions?: boolean;
    resume?: string;
    listSessions?: boolean;
    deleteSession?: string;
    includeDirectories?: string[];
    screenReader?: boolean;
    outputFormat?: "text" | "json" | "stream-json";
    /**
     * Legacy option retained only so old constructor calls type-check.
     */
    configDir?: string;
    /**
     * Legacy option retained only so old constructor calls type-check.
     */
    apiKey?: string;
};

/**
 * @deprecated Gemini CLI support has been sunset. Use AntigravityAgent with
 * Google's `agy` CLI instead.
 */
declare class GeminiAgent extends BaseCliAgent {
    /**
     * @param {GeminiAgentOptions} [opts]
     */
    constructor(opts?: GeminiAgentOptions);
    opts: GeminiAgentOptions$1;
    capabilities: AgentCapabilityRegistry$c;
    cliEngine: string;
    /**
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$8;
    generate(): Promise<void>;
    buildCommand(): Promise<void>;
}
type CliOutputInterpreter$8 = CliOutputInterpreter$e;
type GeminiAgentOptions = GeminiAgentOptions$1;

declare class PiAgent extends BaseCliAgent {
    /**
     * @param {PiAgentOptions} [opts]
     */
    constructor(opts?: PiAgentOptions$1);
    opts: PiAgentOptions$2;
    capabilities: AgentCapabilityRegistry$c;
    cliEngine: string;
    issuedSessionRef: any;
    /**
     * @param {PiGenerateOptions} [options]
     * @returns {PiMode}
     */
    resolveMode(options?: PiGenerateOptions): PiMode;
    /**
     * @param {{ prompt: string; cwd: string; options?: PiGenerateOptions; mode: PiMode; }} params
     * @returns {string[]}
     */
    buildArgs(params: {
        prompt: string;
        cwd: string;
        options?: PiGenerateOptions;
        mode: PiMode;
    }): string[];
    /**
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$7;
    /**
     * @param {PiGenerateOptions} [options]
     * @returns {Promise<GenerateTextResult>}
     */
    generate(options?: PiGenerateOptions): Promise<GenerateTextResult>;
    /**
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options?: PiGenerateOptions; }} params
     * @returns {Promise<{ command: string; args: string[]; stdin?: string; outputFormat?: string; outputFile?: string; cleanup?: () => Promise<void>; }>}
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options?: PiGenerateOptions;
    }): Promise<{
        command: string;
        args: string[];
        stdin?: string;
        outputFormat?: string;
        outputFile?: string;
        cleanup?: () => Promise<void>;
    }>;
    /**
     * @returns {{ provider?: string; model?: string; apiKey?: string }}
     */
    diagnosticHints(): {
        provider?: string;
        model?: string;
        apiKey?: string;
    };
}
type CliOutputInterpreter$7 = CliOutputInterpreter$e;
type AgentCliEvent = AgentCliEvent$1;
type GenerateTextResult = ai.GenerateTextResult<Record<string, never>, unknown, any>;
type PiAgentOptions$1 = PiAgentOptions$2;
type PiMode = "text" | "json" | "stream-json" | "rpc";
type PiGenerateOptions = {
    prompt?: unknown;
    messages?: unknown;
    onEvent?: (event: AgentCliEvent) => unknown;
    resumeSession?: unknown;
    rootDir?: string;
    timeout?: unknown;
    abortSignal?: AbortSignal;
    maxOutputBytes?: number;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    [key: string]: unknown;
};

type KimiAgentOptions$1 = BaseCliAgentOptions & {
    workDir?: string;
    session?: string;
    continue?: boolean;
    thinking?: boolean;
    outputFormat?: "text" | "stream-json";
    finalMessageOnly?: boolean;
    quiet?: boolean;
    agent?: "default" | "okabe";
    agentFile?: string;
    mcpConfigFile?: string[];
    mcpConfig?: string[];
    skillsDir?: string;
    maxStepsPerTurn?: number;
    maxRetriesPerStep?: number;
    maxRalphIterations?: number;
    verbose?: boolean;
    debug?: boolean;
    /**
     * Path to an isolated Kimi share directory. Sets `KIMI_SHARE_DIR` on the
     * spawned process so this invocation reads/writes credentials at
     * `<configDir>/credentials` (instead of the user's default `~/.kimi/`).
     * Equivalent to passing `env: { KIMI_SHARE_DIR: <path> }` but uniform with
     * the other agents' `configDir` option.
     */
    configDir?: string;
};

declare class KimiAgent extends BaseCliAgent {
    /**
     * @param {KimiAgentOptions} [opts]
     */
    constructor(opts?: KimiAgentOptions);
    opts: KimiAgentOptions$1;
    capabilities: AgentCapabilityRegistry$c;
    cliEngine: string;
    issuedSessionId: any;
    /**
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$6;
    /**
     * Normalize a `file_change` action (as emitted by {@link createOutputInterpreter})
     * into {@link AgentFileChange} records. `action.detail.arguments` is the raw
     * JSON-string function-call arguments (OpenAI-style tool calls).
     *
     * @param {unknown} action
     * @returns {import("./agent-contract/AgentFileChange.ts").AgentFileChange[] | undefined}
     */
    parseFileChanges(action: unknown): AgentFileChange$1[] | undefined;
    /**
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: "text" | "stream-json";
        env: {
            KIMI_SHARE_DIR: string;
        } | undefined;
        cleanup: (() => Promise<void>) | undefined;
        stdoutBannerPatterns: RegExp[];
        stdoutErrorPatterns: RegExp[];
        benignStderrPatterns: RegExp[];
        errorOnBannerOnly: boolean;
    }>;
}
type CliOutputInterpreter$6 = CliOutputInterpreter$e;
type KimiAgentOptions = KimiAgentOptions$1;

type ForgeAgentOptions$1 = BaseCliAgentOptions & {
    directory?: string;
    provider?: string;
    agent?: string;
    conversationId?: string;
    sandbox?: string;
    restricted?: boolean;
    verbose?: boolean;
    workflow?: string;
    event?: string;
    conversation?: string;
};

declare class ForgeAgent extends BaseCliAgent {
    /**
     * @param {ForgeAgentOptions} [opts]
     */
    constructor(opts?: ForgeAgentOptions);
    opts: ForgeAgentOptions$1;
    /** @type {AgentCapabilityRegistry} */
    capabilities: AgentCapabilityRegistry$7;
    cliEngine: string;
    issuedConversationId: any;
    /**
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$5;
    /**
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: string;
    }>;
}
type AgentCapabilityRegistry$7 = AgentCapabilityRegistry$c;
type CliOutputInterpreter$5 = CliOutputInterpreter$e;
type ForgeAgentOptions = ForgeAgentOptions$1;

/**
 * CLI agent wrapper for OpenCode (https://opencode.ai).
 *
 * Shells out to `opencode run` in non-interactive mode with `--format json`
 * for streaming nd-JSON output. Parses AgentCliEvents from the JSON stream.
 *
 * Usage:
 *   const agent = new OpenCodeAgent({
 *     model: "anthropic/claude-opus-4-8",
 *     yolo: true,
 *   });
 *   const result = await agent.generate({
 *     messages: [{ role: "user", content: "Fix the bug" }],
 *   });
 */
declare class OpenCodeAgent extends BaseCliAgent {
    /**
     * @param {OpenCodeAgentOptions} [opts]
     */
    constructor(opts?: OpenCodeAgentOptions$1);
    /** @type {OpenCodeAgentOptions} */
    opts: OpenCodeAgentOptions$1;
    /** @type {AgentCapabilityRegistry} */
    capabilities: AgentCapabilityRegistry$6;
    /** @type {"opencode"} */
    cliEngine: "opencode";
    /**
     * Create an output interpreter that parses OpenCode's nd-JSON streaming format.
     *
     * OpenCode `--format json` emits one JSON object per line (verified from source:
     * packages/opencode/src/cli/cmd/run.ts). The envelope is:
     *
     *   { type, timestamp: number, sessionID: string, ...payload }
     *
     * Event types:
     *   step_start  → { part: { type:"step-start", id, sessionID, messageID } }
     *   text        → { part: { type:"text", text, time: { start, end } } }
     *   tool_use    → { part: { type:"tool", tool, callID, state: { status, ... } } }
     *   step_finish → { part: { type:"step-finish", reason, tokens, cost } }
     *   reasoning   → { part: { type:"reasoning", text } }
     *   error       → { error: { name, data: { message } } }
     *
     * We map these to Smithers' AgentCliEvent union (started | action | completed).
     *
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$4;
    /**
     * Normalize a `file_change` action (as emitted by {@link createOutputInterpreter})
     * into {@link AgentFileChange} records. `action` is `{ title, detail: { input } }`.
     *
     * @param {unknown} action
     * @returns {import("./agent-contract/AgentFileChange.ts").AgentFileChange[] | undefined}
     */
    parseFileChanges(action: unknown): AgentFileChange$1[] | undefined;
    /**
     * Build the CLI command spec for `opencode run`.
     *
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any }} params
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: string;
        env: {
            OPENCODE_PERMISSION: string;
        } | undefined;
        stdoutBannerPatterns: RegExp[];
        stdoutErrorPatterns: RegExp[];
    }>;
}
type AgentCapabilityRegistry$6 = AgentCapabilityRegistry$a;
type OpenCodeAgentOptions$1 = OpenCodeAgentOptions$2;
type CliOutputInterpreter$4 = CliOutputInterpreter$f;

declare class VibeAgent extends BaseCliAgent {
    /**
     * @param {VibeAgentOptions} [opts]
     */
    constructor(opts?: VibeAgentOptions$1);
    /** @type {VibeAgentOptions} */
    opts: VibeAgentOptions$1;
    /** @type {AgentCapabilityRegistry} */
    capabilities: AgentCapabilityRegistry$5;
    /** @type {"vibe"} */
    cliEngine: "vibe";
    /** @type {string | undefined} */
    issuedSessionId: string | undefined;
    /**
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$3;
    /**
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any }} params
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: string;
    }>;
}
type AgentCapabilityRegistry$5 = AgentCapabilityRegistry$c;
type CliOutputInterpreter$3 = CliOutputInterpreter$e;
type VibeAgentOptions$1 = VibeAgentOptions$2;

/**
 * Build a failover chain over every registered account (`smithers agents add`)
 * so a `<Task agent={fallbackAgents()}>` spreads load across all of the
 * user's Claude/Codex subscriptions: the accounts are randomly ordered per
 * call and the engine's quota failover walks the chain when a rung is
 * rate-limited. The "normal" agent (`options.fallback`, defaulting to a stock
 * agent for the first requested family) is appended as the last rung, and is
 * returned alone when the global registry is missing, empty, or unreadable —
 * a workflow using this helper degrades to single-agent behavior on machines
 * with no registered accounts.
 *
 * @param {FallbackAgentsOptions} [options]
 * @returns {AgentLike[]}
 */
declare function fallbackAgents(options?: FallbackAgentsOptions$1): AgentLike$1[];
type AgentLike$1 = AgentLike$2;
type FallbackAgentsOptions$1 = FallbackAgentsOptions$2;

/**
 * Focused Smithers adapter for one stock Nanocodex agent in one headless
 * bridge process per generate call.
 */
declare class NanocodexAgent {
    /** @param {NanocodexAgentOptions} [opts] */
    constructor(opts?: NanocodexAgentOptions$1);
    /** @type {string} */
    id: string;
    model: string;
    supportsNativeStructuredOutput: boolean;
    checkpointFormats: readonly AgentCheckpointFormat$1[];
    checkpointCapabilities: readonly AgentCheckpointCapability$1[];
    /** @type {NanocodexAgentOptions} */
    opts: NanocodexAgentOptions$1;
    /**
     * Side-effect-free binary/protocol compatibility check. No agent, workspace
     * tool runtime, authentication request, or provider connection is created.
     *
     * @param {AgentGenerateOptions} [args]
     */
    preflight(args?: AgentGenerateOptions$1): Promise<void>;
    /**
     * Generic `AgentLike` compatibility signature. The impossible receiver keeps
     * broad continuation options from becoming callable on a concrete instance.
     *
     * @overload
     * @this {never}
     * @param {AgentGenerateOptions} [args]
     * @returns {Promise<unknown>}
     */
    generate(this: never, args?: AgentGenerateOptions$4 | undefined): Promise<unknown>;
    /**
     * @overload
     * @this {NanocodexAgent}
     * @param {NanocodexGenerateOptions} [args]
     * @returns {Promise<import("ai").GenerateTextResult<Record<string, never>, Record<string, unknown>, import("ai").Output.Output<string, string, never>> & import("./AgentCheckpoint.ts").AgentCheckpointResult>}
     */
    generate(this: NanocodexAgent, args?: NanocodexGenerateOptions$1 | undefined): Promise<ai.GenerateTextResult<Record<string, never>, Record<string, unknown>, ai.Output.Output<string, string, never>> & AgentCheckpointResult$1>;
    /**
     * Publish recovery carried by a process-cleanup failure without making the
     * bridge snapshot part of the durable error surface.
     *
     * @private
     * @param {unknown} error
     * @param {{ args: AgentGenerateOptions; maxCheckpointBytes: number; policyFingerprint: string; workspace: string }} context
     */
    private recoverProcessCheckpoint;
    /**
     * @private
     * @param {NanocodexServerRecord} terminal
     * @param {{ args: AgentGenerateOptions; maxCheckpointBytes: number; policyFingerprint: string; workspace: string }} context
     */
    private finishTerminal;
    /**
     * @private
     * @param {import("../internal/nanocodex/protocol-types.ts").NanocodexCompletedData} completed
     * @param {{ args: AgentGenerateOptions; maxCheckpointBytes: number; policyFingerprint: string; workspace: string }} context
     */
    private completedResult;
    /**
     * @private
     * @param {import("../internal/nanocodex/protocol-types.ts").NanocodexRecoveryData} completed
     * @param {{ args: AgentGenerateOptions; maxCheckpointBytes: number; policyFingerprint: string; workspace: string }} context
     */
    private publishCheckpoint;
    /** @private */
    private binary;
    /** @private */
    private auth;
    /** @private @param {AgentGenerateOptions | undefined} args */
    private environment;
}
type NanocodexAgentOptions$1 = NanocodexAgentOptions$2;
type AgentGenerateOptions$1 = AgentGenerateOptions$4;

/**
 * @param {CreateSmithersAgentContractOptions} options
 * @returns {SmithersAgentContract}
 */
declare function createSmithersAgentContract(options: CreateSmithersAgentContractOptions): SmithersAgentContract$2;
type SmithersListedTool$1 = SmithersListedTool$2;
type SmithersToolSurface$1 = SmithersToolSurface$2;
type CreateSmithersAgentContractOptions = {
    toolSurface?: SmithersToolSurface$1;
    serverName?: string;
    tools: SmithersListedTool$1[];
};
type SmithersAgentContract$2 = SmithersAgentContract$3;

/**
 * @param {SmithersAgentContract} contract
 * @param {RenderGuidanceOptions} [options]
 */
declare function renderSmithersAgentPromptGuidance(contract: SmithersAgentContract$1, options?: RenderGuidanceOptions): string;
type RenderGuidanceOptions = {
    available?: boolean;
    toolNamePrefix?: string;
};
type SmithersAgentContract$1 = SmithersAgentContract$3;

declare function createImageGenerationTool(
  provider: ImageGenerationProvider$1,
  options: ImageGenerationToolOptions$1 & { asToolset: true },
): Record<string, Tool$1>;

declare function createImageGenerationTool(
  provider: ImageGenerationProvider$1,
  options?: ImageGenerationToolOptions$1,
): Tool$1;

/**
 * Create an AI SDK tool that can call any REST API without an OpenAPI spec.
 *
 * @param {CreateHttpToolOptions} [options]
 * @returns {Tool}
 */
declare function createHttpTool(options?: CreateHttpToolOptions$1): Tool;
type Tool = ai.Tool;
type CreateHttpToolOptions$1 = CreateHttpToolOptions$2;

/**
 * Convert a Zod schema to an OpenAI-safe JSON Schema object.
 *
 * Usage:
 * ```ts
 * import { zodToOpenAISchema } from "./zodToOpenAISchema";
 * const jsonSchema = zodToOpenAISchema(myZodSchema);
 * ```
 *
 * @param {import("zod").ZodTypeAny} zodSchema
 * @returns {Promise<Record<string, unknown>>}
 */
declare function zodToOpenAISchema(zodSchema: zod.ZodTypeAny): Promise<Record<string, unknown>>;

/**
 * Sanitize a JSON Schema for OpenAI's structured-output API.
 *
 * OpenAI's `response_format` imposes constraints beyond standard JSON Schema:
 *
 * 1. Every object node **must** include `"type": "object"`.
 * 2. Structured output object nodes must set `additionalProperties: false`.
 * 3. When `additionalProperties: false`, every key in `properties` must also
 *    appear in `required` (strict mode treats all listed properties as
 *    required; truly-optional fields should be modeled as nullable).
 *
 * Zod v4's `toJSONSchema()` can violate these rules when loose/passthrough
 * objects are used. Codex rejects those schemas unless they are strict.
 *
 * This function fixes these issues in-place so any agent (Codex, future
 * OpenAI-backed agents, etc.) can safely use a JSON Schema for OpenAI.
 *
 * @param {unknown} node - JSON Schema node; mutated in place.
 * @returns {void}
 */
declare function sanitizeForOpenAI(node: unknown): void;

type ElevenLabsTextToSpeechToolOptions = {
    apiKey: string;
    defaultVoiceId?: string;
    defaultModelId?: string;
    baseUrl?: string;
    fetch?: typeof fetch;
};
type ElevenLabsTextToSpeechToolset = {
    tools: Record<"elevenlabs_text_to_speech", Tool$1>;
    toolNames: ["elevenlabs_text_to_speech"];
};
declare function createElevenLabsTextToSpeechTool(options: ElevenLabsTextToSpeechToolOptions): ElevenLabsTextToSpeechToolset;

/**
 * Hash the semantic checkpoint production and consumption declarations.
 * Declaration order, repeated entries, and repeated values are ignored.
 *
 * @param {{ checkpointFormats?: readonly import("./AgentCheckpoint.ts").AgentCheckpointFormat[]; checkpointCapabilities?: readonly import("./AgentCheckpoint.ts").AgentCheckpointCapability[] } | null | undefined} agent
 * @returns {string}
 */
declare function hashAgentCheckpointCapabilities(agent: {
    checkpointFormats?: readonly AgentCheckpointFormat$1[];
    checkpointCapabilities?: readonly AgentCheckpointCapability$1[];
} | null | undefined): string;
/**
 * Test whether an agent declares support for a checkpoint version and use.
 * @param {{ checkpointCapabilities?: readonly import("./AgentCheckpoint.ts").AgentCheckpointCapability[] } | null | undefined} agent
 * @param {{ codec: string; version: number }} checkpoint
 * @param {import("./AgentCheckpoint.ts").AgentCheckpointMode} mode
 */
declare function agentSupportsCheckpoint(agent: {
    checkpointCapabilities?: readonly AgentCheckpointCapability$1[];
} | null | undefined, checkpoint: {
    codec: string;
    version: number;
}, mode: AgentCheckpointMode$1): boolean;
/**
 * Test whether an agent declares that it can produce a checkpoint format.
 * Production is intentionally independent from resume and fork consumption.
 * @param {{ checkpointFormats?: readonly import("./AgentCheckpoint.ts").AgentCheckpointFormat[] } | null | undefined} agent
 * @param {{ codec: string; version: number }} checkpoint
 */
declare function agentProducesCheckpoint(agent: {
    checkpointFormats?: readonly AgentCheckpointFormat$1[];
} | null | undefined, checkpoint: {
    codec: string;
    version: number;
}): boolean;
/**
 * Validate, serialize, and clone an agent checkpoint.
 *
 * The JSON walk is intentionally stricter than JSON.stringify: values that
 * JSON.stringify would silently omit or coerce are rejected.
 *
 * @param {import("./AgentCheckpoint.ts").AgentCheckpoint} checkpoint
 * @param {number} [maxBytes]
 * @returns {import("./AgentCheckpoint.ts").AgentCheckpoint}
 */
declare function cloneAgentCheckpoint(checkpoint: AgentCheckpoint$1, maxBytes?: number): AgentCheckpoint$1;
/** Maximum encoded checkpoint size accepted by default (16 MiB). */
declare const DEFAULT_AGENT_CHECKPOINT_MAX_BYTES: number;

/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./HermesCliAgentOptions.ts").HermesCliAgentOptions} HermesCliAgentOptions */
/**
 * Capability registry for the Hermes Agent CLI.
 *
 * @returns {AgentCapabilityRegistry}
 */
declare function createHermesCliCapabilityRegistry(): AgentCapabilityRegistry$4;
/**
 * Hermes Agent (Nous Research) driven through its `hermes` CLI.
 *
 * Uses the headless one-shot entry point `hermes -z "<prompt>"`: a single prompt
 * in, the agent's final response text out, nothing else on stdout/stderr. This
 * is the CLI coding agent, a peer of Claude Code / Codex — not the Hermes model
 * API (see {@link HermesAgent} for that). Reach for this to make a workflow
 * `<Task>` delegate to Hermes itself.
 */
declare class HermesCliAgent extends BaseCliAgent {
    /**
     * @param {HermesCliAgentOptions} [opts]
     */
    constructor(opts?: HermesCliAgentOptions$1);
    opts: HermesCliAgentOptions$2;
    /** @type {AgentCapabilityRegistry} */
    capabilities: AgentCapabilityRegistry$4;
    cliEngine: string;
    /**
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$2;
    /**
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: string;
    }>;
}
type AgentCapabilityRegistry$4 = AgentCapabilityRegistry$c;
type CliOutputInterpreter$2 = CliOutputInterpreter$e;
type HermesCliAgentOptions$1 = HermesCliAgentOptions$2;

/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./OpenClawAgentOptions.ts").OpenClawAgentOptions} OpenClawAgentOptions */
/**
 * Capability registry for the OpenClaw agent CLI.
 *
 * @returns {AgentCapabilityRegistry}
 */
declare function createOpenClawCapabilityRegistry(): AgentCapabilityRegistry$3;
/**
 * OpenClaw driven through its gateway-backed `openclaw agent` CLI.
 *
 * The command path mirrors OpenClaw's user-facing one-shot agent surface:
 *
 *   openclaw agent --agent <id> --message "<prompt>" --json
 *
 * It sends a Smithers task prompt into an OpenClaw agent session and returns the
 * final reply. OpenClaw itself owns its skills, tools, memory, channel context,
 * and gateway policy.
 */
declare class OpenClawAgent extends BaseCliAgent {
    /**
     * @param {OpenClawAgentOptions} [opts]
     */
    constructor(opts?: OpenClawAgentOptions$1);
    opts: OpenClawAgentOptions$2;
    /** @type {AgentCapabilityRegistry} */
    capabilities: AgentCapabilityRegistry$3;
    cliEngine: string;
    /** @type {string | undefined} */
    issuedSessionId: string | undefined;
    /**
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter$1;
    /**
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: string;
    }>;
}
type AgentCapabilityRegistry$3 = AgentCapabilityRegistry$c;
type CliOutputInterpreter$1 = CliOutputInterpreter$e;
type OpenClawAgentOptions$1 = OpenClawAgentOptions$2;

/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./PoolAgentOptions.ts").PoolAgentOptions} PoolAgentOptions */
/**
 * @param {PoolAgentOptions} [_opts]
 * @returns {AgentCapabilityRegistry}
 */
declare function createPoolCapabilityRegistry(_opts?: PoolAgentOptions$1): AgentCapabilityRegistry$2;
/**
 * Poolside's `pool` agent (Agent Context Protocol / ACP), driven through its CLI.
 *
 * Uses `pool exec -o json --unsafe-auto-allow` for headless, non-interactive
 * execution with streaming NDJSON output. Pool implements the Agent Context Protocol
 * (ACP) and provides built-in tools for file operations, bash, glob, grep, etc.
 *
 * Output format from pool exec -o json:
 *   {"reasoning":"...", "type":"reasoning"} - model thinking
 *   {"thought":"...", "type":"thought"} - assistant thoughts (streaming)
 *   {"args":{...}, "name":"<tool>", "type":"toolCall"} - tool invocation
 *   {"result":"...", "type":"toolCallResult"} - tool result
 *   {"args":{"success":true}, "name":"exit", "type":"toolCall"} - task completion
 */
declare class PoolAgent extends BaseCliAgent {
    /**
     * @param {PoolAgentOptions} [opts]
     */
    constructor(opts?: PoolAgentOptions$1);
    /** @type {PoolAgentOptions} */
    opts: PoolAgentOptions$1;
    /** @type {AgentCapabilityRegistry} */
    capabilities: AgentCapabilityRegistry$2;
    /** @type {"pool"} */
    cliEngine: "pool";
    /**
     * Create an output interpreter that parses Pool's NDJSON streaming format.
     *
     * @returns {CliOutputInterpreter}
     */
    createOutputInterpreter(): CliOutputInterpreter;
    /**
     * Build the CLI command spec for `pool exec`.
     *
     * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any }} params
     */
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: string;
    }>;
}
type AgentCapabilityRegistry$2 = AgentCapabilityRegistry$c;
type CliOutputInterpreter = CliOutputInterpreter$e;
type PoolAgentOptions$1 = PoolAgentOptions$2;

type OmpAgentOptions$1 = BaseCliAgentOptions & {
    provider?: string;
    model?: string;
    apiKey?: string;
    systemPrompt?: string;
    appendSystemPrompt?: string;
    mode?: "text" | "json" | "rpc";
    print?: boolean;
    continueSession?: boolean;
    resume?: string;
    sessionDir?: string;
    noSession?: boolean;
    tools?: string[];
    noTools?: boolean;
    extensions?: string[];
    noExtensions?: boolean;
    skills?: string[];
    noSkills?: boolean;
    thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";
    hideThinking?: boolean;
    printThoughts?: boolean;
    hooks?: string[];
    maxTime?: number | string;
    autoApprove?: boolean;
    approvalMode?: string;
};

/** @typedef {import("./OmpAgentOptions.ts").OmpAgentOptions} OmpAgentOptions */
/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @param {OmpAgentOptions} [opts] @returns {AgentCapabilityRegistry} */
declare function createOmpCapabilityRegistry(opts?: OmpAgentOptions): AgentCapabilityRegistry$1;
declare class OmpAgent extends BaseCliAgent {
    constructor(opts?: {});
    /** @type {OmpAgentOptions} */ opts: OmpAgentOptions;
    /** @type {AgentCapabilityRegistry} */ capabilities: AgentCapabilityRegistry$1;
    cliEngine: string;
    issuedSessionId: any;
    /** @param {{ onEvent?: unknown, files?: unknown[] } | undefined} options @returns {"text" | "json" | "rpc"} */
    resolveMode(options: {
        onEvent?: unknown;
        files?: unknown[];
    } | undefined): "text" | "json" | "rpc";
    resolveCredentialEnv(): {
        [x: string]: string;
    } | undefined;
    buildArgs({ prompt, cwd, options, mode }: {
        prompt: any;
        cwd: any;
        options: any;
        mode: any;
    }): any[];
    createOutputInterpreter(): {
        onStdoutLine: (line: any) => ({
            type: string;
            engine: string;
            phase: string;
            entryType: string;
            action: {
                id: string;
                kind: string;
                title: string;
            };
            message: any;
            ok?: undefined;
            answer?: undefined;
            error?: undefined;
            resume?: undefined;
        } | {
            type: string;
            engine: string;
            phase: string;
            entryType: string;
            action: {
                detail: {
                    args: any;
                };
                id: string;
                kind: AgentCliActionKind;
                title: string;
            } | {
                detail?: undefined;
                id: string;
                kind: AgentCliActionKind;
                title: string;
            };
            message: string;
            ok: boolean;
            answer?: undefined;
            error?: undefined;
            resume?: undefined;
        } | {
            type: string;
            engine: string;
            ok: boolean;
            answer: string | undefined;
            error: any;
            resume: any;
            phase?: undefined;
            entryType?: undefined;
            action?: undefined;
            message?: undefined;
        })[];
        onExit: (result: any) => {
            type: string;
            engine: string;
            ok: boolean;
            answer: string | undefined;
            error: any;
            resume: any;
        }[];
    };
    /** @returns {Promise<{ command: string; args: string[]; env?: Record<string, string>; outputFormat: "text" | "json" | "rpc"; }>} */
    buildCommand({ prompt, cwd, options }: {
        prompt: any;
        cwd: any;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        env?: Record<string, string>;
        outputFormat: "text" | "json" | "rpc";
    }>;
    /**
     * Environment for a persistent RPC session. Mirrors the env BaseCliAgent builds for
     * the one-shot path: `inheritEnv: false` is honored, and the task's `SMITHERS_*`
     * identifiers are forwarded. Streaming defaults to RPC, so an RPC session that
     * dropped those would silently break `smithers ask-human` from inside an omp agent.
     * @param {{ taskContext?: unknown } | undefined} options @returns {Record<string, string>}
     */
    resolveRpcEnv(options: {
        taskContext?: unknown;
    } | undefined): Record<string, string>;
    generate(options?: {}): Promise<any>;
    diagnosticHints(): {
        provider: string | undefined;
        model: string | undefined;
        apiKey: string | undefined;
    };
}
type OmpAgentOptions = OmpAgentOptions$1;
type AgentCapabilityRegistry$1 = AgentCapabilityRegistry$c;

/**
 * @returns {CliAgentCapabilityReportEntry[]}
 */
declare function getCliAgentCapabilityReport(): CliAgentCapabilityReportEntry$2[];
type CliAgentCapabilityReportEntry$2 = CliAgentCapabilityReportEntry$3;

/**
 * @param {CliAgentCapabilityReportEntry[]} [entries]
 * @returns {CliAgentCapabilityDoctorReport}
 */
declare function getCliAgentCapabilityDoctorReport(entries?: CliAgentCapabilityReportEntry$1[]): CliAgentCapabilityDoctorReport$2;
type CliAgentCapabilityDoctorReport$2 = CliAgentCapabilityDoctorReport$3;
type CliAgentCapabilityReportEntry$1 = CliAgentCapabilityReportEntry$3;

/** @typedef {import("./CliAgentCapabilityDoctorReport.ts").CliAgentCapabilityDoctorReport} CliAgentCapabilityDoctorReport */
/**
 * @param {CliAgentCapabilityDoctorReport} report
 * @returns {string}
 */
declare function formatCliAgentCapabilityDoctorReport(report: CliAgentCapabilityDoctorReport$1): string;
type CliAgentCapabilityDoctorReport$1 = CliAgentCapabilityDoctorReport$3;

/**
 * @param {string} id
 * @returns {CliAgentSurfaceManifestEntry | undefined}
 */
declare function getCliAgentSurfaceManifestEntry(id: string): CliAgentSurfaceManifestEntry$1 | undefined;
/**
 * @returns {CliAgentSurfaceManifestEntry[]}
 */
declare function listCliAgentSurfaceManifests(): CliAgentSurfaceManifestEntry$1[];
/** @typedef {import("./CliAgentSurfaceTypes.ts").CliAgentSurfaceManifestEntry} CliAgentSurfaceManifestEntry */
/**
 * Compatibility contract for CLI-backed agents. Keep this list focused on the
 * command surface Smithers emits directly; user-supplied extraArgs remain an
 * escape hatch and are intentionally not modeled here.
 *
 * @type {readonly CliAgentSurfaceManifestEntry[]}
 */
declare const CLI_AGENT_SURFACE_MANIFEST: readonly CliAgentSurfaceManifestEntry$1[];
type CliAgentSurfaceManifestEntry$1 = CliAgentSurfaceManifestEntry$2;

type GroundedWebSearchToolset$1 = {
    tools: Record<"grounded_web_search", Tool$1>;
    toolNames: ["grounded_web_search"];
};

type GroundedWebSearchProviderKind = "semantic" | "fresh";
type GroundedWebSearchProviderName = "exa" | "tavily" | "brave" | "serper";
type GroundedWebSearchResult = {
    title: string;
    url: string;
    snippet?: string;
    publishedDate?: string;
    score?: number;
};
type GroundedWebSearchProvider$5 = {
    name: GroundedWebSearchProviderName;
    kind: GroundedWebSearchProviderKind;
    search(input: {
        query: string;
        maxResults: number;
        freshness?: "day" | "week" | "month" | "year";
    }): Promise<GroundedWebSearchResult[]>;
};

/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */
/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchResult} GroundedWebSearchResult */
/** @typedef {import("./GroundedWebSearchToolset.ts").GroundedWebSearchToolset} GroundedWebSearchToolset */
/**
 * @param {{ providers: GroundedWebSearchProvider[]; maxResultsPerProvider?: number }} options
 * @returns {GroundedWebSearchToolset}
 */
declare function createGroundedWebSearchToolset(options: {
    providers: GroundedWebSearchProvider$4[];
    maxResultsPerProvider?: number;
}): GroundedWebSearchToolset;
type GroundedWebSearchProvider$4 = GroundedWebSearchProvider$5;
type GroundedWebSearchToolset = GroundedWebSearchToolset$1;

/**
 * @param {{ apiKey: string; baseUrl?: string; fetch?: typeof fetch }} options
 * @returns {GroundedWebSearchProvider}
 */
declare function createExaSearchProvider(options: {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
}): GroundedWebSearchProvider$3;
type GroundedWebSearchProvider$3 = GroundedWebSearchProvider$5;

/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */
/**
 * @param {{ apiKey: string; baseUrl?: string; fetch?: typeof fetch }} options
 * @returns {GroundedWebSearchProvider}
 */
declare function createTavilySearchProvider(options: {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
}): GroundedWebSearchProvider$2;
type GroundedWebSearchProvider$2 = GroundedWebSearchProvider$5;

/**
 * @param {{ apiKey: string; baseUrl?: string; fetch?: typeof fetch }} options
 * @returns {GroundedWebSearchProvider}
 */
declare function createBraveSearchProvider(options: {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
}): GroundedWebSearchProvider$1;
type GroundedWebSearchProvider$1 = GroundedWebSearchProvider$5;

/**
 * @param {{ apiKey: string; baseUrl?: string; fetch?: typeof fetch }} options
 * @returns {GroundedWebSearchProvider}
 */
declare function createSerperSearchProvider(options: {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
}): GroundedWebSearchProvider;
type GroundedWebSearchProvider = GroundedWebSearchProvider$5;

type AgentCapabilityRegistry = AgentCapabilityRegistry$c;
type AgentGenerateOptions = AgentGenerateOptions$4;
type AgentLike = AgentLike$2;
type AgentCheckpoint = AgentCheckpoint$1;
type AgentCheckpointCapability = AgentCheckpointCapability$1;
type AgentCheckpointFormat = AgentCheckpointFormat$1;
type AgentCheckpointJsonArray = AgentCheckpointJsonArray$1;
type AgentCheckpointJsonObject = AgentCheckpointJsonObject$1;
type AgentCheckpointJsonPrimitive = AgentCheckpointJsonPrimitive$1;
type AgentCheckpointJsonValue = AgentCheckpointJsonValue$1;
type AgentCheckpointMode = AgentCheckpointMode$1;
type AgentCheckpointPublisher = AgentCheckpointPublisher$1;
type AgentCheckpointResult = AgentCheckpointResult$1;
type AgentCheckpointContinuationOptions = AgentCheckpointContinuationOptions$1;
type AgentToolDescriptor = AgentToolDescriptor$1;
type AnthropicAgentOptions<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = AnthropicAgentOptions$2<CALL_OPTIONS, TOOLS>;
type OpenAIAgentOptions<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = OpenAIAgentOptions$2<CALL_OPTIONS, TOOLS>;
type HermesAgentOptions<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = HermesAgentOptions$2<CALL_OPTIONS, TOOLS>;
type HermesCliAgentOptions = HermesCliAgentOptions$2;
type OpenClawAgentOptions = OpenClawAgentOptions$2;
type PiAgentOptions = PiAgentOptions$2;
type CursorAgentOptions = CursorAgentOptions$2;
type PiExtensionUiRequest = PiExtensionUiRequest$1;
type PiExtensionUiResponse = PiExtensionUiResponse$1;
type OpenCodeAgentOptions = OpenCodeAgentOptions$2;
type PoolAgentOptions = PoolAgentOptions$2;
type VibeAgentOptions = VibeAgentOptions$2;
type FallbackAgentsOptions = FallbackAgentsOptions$2;
type FallbackAgentProvider = FallbackAgentProvider$1;
type NanocodexAgentOptions = NanocodexAgentOptions$2;
type NanocodexGenerateOptions = NanocodexGenerateOptions$1;
type NanocodexAuth = NanocodexAuth$1;
type NanocodexThinking = NanocodexThinking$1;
type NanocodexReasoningMode = NanocodexReasoningMode$1;
type SmithersAgentContract = SmithersAgentContract$3;
type SmithersAgentContractTool = SmithersAgentContractTool$1;
type SmithersAgentToolCategory = SmithersAgentToolCategory$1;
type SmithersListedTool = SmithersListedTool$2;
type SmithersToolSurface = SmithersToolSurface$2;
type AgentFileChangeKind = AgentFileChangeKind$1;
type AgentFileChange = AgentFileChange$1;
type CliAgentCapabilityAdapterId = CliAgentCapabilityAdapterId$1;
type CliAgentCapabilityDoctorEntry = CliAgentCapabilityDoctorEntry$1;
type CliAgentCapabilityDoctorReport = CliAgentCapabilityDoctorReport$3;
type CliAgentCapabilityIssue = CliAgentCapabilityIssue$1;
type CliAgentCapabilityReportEntry = CliAgentCapabilityReportEntry$3;
type CliAgentSurfaceManifestEntry = CliAgentSurfaceManifestEntry$2;
type CliAgentSurfaceOptionMapping = CliAgentSurfaceOptionMapping$1;
type CliAgentSurfaceResumeContract = CliAgentSurfaceResumeContract$1;
type CliAgentUnsupportedFlag = CliAgentUnsupportedFlag$1;
type ImageGenerationProvider = ImageGenerationProvider$1;
type ImageGenerationRequest = ImageGenerationRequest$1;
type ImageGenerationResult = ImageGenerationResult$1;
type ImageGenerationToolOptions = ImageGenerationToolOptions$1;
type CreateHttpToolOptions = CreateHttpToolOptions$2;
type HttpToolAuth = HttpToolAuth$1;
type HttpToolInput = HttpToolInput$1;
type HttpToolOutput = HttpToolOutput$1;
type AudioHostResolver = AudioHostResolver$1;
type CreateTranscriptionToolOptions = CreateTranscriptionToolOptions$1;
type PinnedAudioTransport = PinnedAudioTransport$1;
type PinnedAudioTransportRequest = PinnedAudioTransportRequest$1;
type ResolvedAudioAddress = ResolvedAudioAddress$1;
type TranscriptionProvider = TranscriptionProvider$1;
type TranscriptionToolInput = TranscriptionToolInput$1;
type TranscriptionToolResult = TranscriptionToolResult$1;

export { type AgentCapabilityRegistry, type AgentCheckpoint, type AgentCheckpointCapability, type AgentCheckpointContinuationOptions, type AgentCheckpointFormat, type AgentCheckpointJsonArray, type AgentCheckpointJsonObject, type AgentCheckpointJsonPrimitive, type AgentCheckpointJsonValue, type AgentCheckpointMode, type AgentCheckpointPublisher, type AgentCheckpointResult, type AgentFileChange, type AgentFileChangeKind, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, AntigravityAgent, type AudioHostResolver, BaseCliAgent, CLI_AGENT_SURFACE_MANIFEST, ClaudeCodeAgent, type CliAgentCapabilityAdapterId, type CliAgentCapabilityDoctorEntry, type CliAgentCapabilityDoctorReport, type CliAgentCapabilityIssue, type CliAgentCapabilityReportEntry, type CliAgentSurfaceManifestEntry, type CliAgentSurfaceOptionMapping, type CliAgentSurfaceResumeContract, type CliAgentUnsupportedFlag, CodexAgent, type CreateHttpToolOptions, type CreateTranscriptionToolOptions, CursorAgent, type CursorAgentOptions, DEFAULT_AGENT_CHECKPOINT_MAX_BYTES, type FallbackAgentProvider, type FallbackAgentsOptions, ForgeAgent, GeminiAgent, HermesAgent, type HermesAgentOptions, HermesCliAgent, type HermesCliAgentOptions, type HttpToolAuth, type HttpToolInput, type HttpToolOutput, type ImageGenerationProvider, type ImageGenerationRequest, type ImageGenerationResult, type ImageGenerationToolOptions, KimiAgent, NanocodexAgent, type NanocodexAgentOptions, type NanocodexAuth, type NanocodexGenerateOptions, type NanocodexReasoningMode, type NanocodexThinking, OmpAgent, OpenAIAgent, type OpenAIAgentOptions, OpenClawAgent, type OpenClawAgentOptions, OpenCodeAgent, type OpenCodeAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type PinnedAudioTransport, type PinnedAudioTransportRequest, PoolAgent, type PoolAgentOptions, type ResolvedAudioAddress, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, type TranscriptionProvider, type TranscriptionToolInput, type TranscriptionToolResult, VibeAgent, type VibeAgentOptions, agentProducesCheckpoint, agentSupportsCheckpoint, cloneAgentCheckpoint, createBraveSearchProvider, createElevenLabsTextToSpeechTool, createExaSearchProvider, createGroundedWebSearchToolset, createHermesCliCapabilityRegistry, createHttpTool, createImageGenerationTool, createOmpCapabilityRegistry, createOpenClawCapabilityRegistry, createPoolCapabilityRegistry, createSerperSearchProvider, createSmithersAgentContract, createTavilySearchProvider, createTranscriptionTool, fallbackAgents, formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, getCliAgentSurfaceManifestEntry, hashAgentCheckpointCapabilities, hashCapabilityRegistry, listCliAgentSurfaceManifests, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
