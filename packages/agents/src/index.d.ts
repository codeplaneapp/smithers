import * as ai from 'ai';
import { ToolLoopAgent, ToolSet, ToolLoopAgentSettings } from 'ai';
import { Effect } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import * as zod_v4_core from 'zod/v4/core';

type CliAgentCapabilityAdapterId$1 = "claude" | "amp" | "antigravity" | "codex" | "forge" | "gemini" | "kimi" | "opencode" | "pi" | "vibe";

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

type AgentCapabilityRegistry$6 = {
    version: 1;
    engine: "claude-code" | "codex" | "antigravity" | "gemini" | "kimi" | "pi" | "amp" | "forge" | "opencode" | "vibe";
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
    builtIns: string[];
};

/**
 * @param {AgentCapabilityRegistry | null | undefined} registry
 * @returns {string}
 */
declare function hashCapabilityRegistry(registry: AgentCapabilityRegistry$5 | null | undefined): string;
type AgentCapabilityRegistry$5 = AgentCapabilityRegistry$6;

type AgentCapabilityRegistry$4 = AgentCapabilityRegistry$6;

type CliAgentCapabilityReportEntry$2 = {
    id: CliAgentCapabilityAdapterId$1;
    binary: string;
    fingerprint: string;
    capabilities: AgentCapabilityRegistry$4;
    surface: CliAgentSurfaceManifestEntry$2;
};

type CliAgentCapabilityIssue$1 = {
    code: string;
    message: string;
    severity: "error" | "warning";
};
type CliAgentCapabilityDoctorEntry$1 = CliAgentCapabilityReportEntry$2 & {
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

type RunCommandResult = {
    stdout: string;
    stderr: string;
    exitCode: number | null;
};

type PiExtensionUiResponse$1 = {
    type: "extension_ui_response";
    id: string;
    value?: string;
    cancelled?: boolean;
    [key: string]: unknown;
};

type PiExtensionUiRequest$1 = {
    type: "extension_ui_request";
    id: string;
    method: string;
    title?: string;
    placeholder?: string;
    [key: string]: unknown;
};

type CodexConfigOverrides = Record<string, string | number | boolean | object | null> | string[];

type AgentCliActionKind = "turn" | "command" | "tool" | "file_change" | "web_search" | "todo_list" | "reasoning" | "warning" | "note";

type AgentCliActionPhase = "started" | "updated" | "completed";
type AgentCliEventLevel = "debug" | "info" | "warning" | "error";
type AgentCliStartedEvent = {
    type: "started";
    engine: string;
    title: string;
    resume?: string;
    detail?: Record<string, unknown>;
};
type AgentCliActionEvent = {
    type: "action";
    engine: string;
    phase: AgentCliActionPhase;
    entryType?: "thought" | "message";
    action: {
        id: string;
        kind: AgentCliActionKind;
        title: string;
        detail?: Record<string, unknown>;
    };
    message?: string;
    ok?: boolean;
    level?: AgentCliEventLevel;
};
type AgentCliCompletedEvent = {
    type: "completed";
    engine: string;
    ok: boolean;
    answer?: string;
    error?: string;
    resume?: string;
    usage?: Record<string, unknown>;
};
type AgentCliEvent$1 = AgentCliStartedEvent | AgentCliActionEvent | AgentCliCompletedEvent;

type CliOutputInterpreter$a = {
    onStdoutLine?: (line: string) => AgentCliEvent$1[] | AgentCliEvent$1 | null | undefined;
    onStderrLine?: (line: string) => AgentCliEvent$1[] | AgentCliEvent$1 | null | undefined;
    onExit?: (result: RunCommandResult) => AgentCliEvent$1[] | AgentCliEvent$1 | null | undefined;
};

type BaseCliAgentOptions$2 = {
    id?: string;
    model?: string;
    systemPrompt?: string;
    instructions?: string;
    cwd?: string;
    env?: Record<string, string>;
    yolo?: boolean;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    maxOutputBytes?: number;
    extraArgs?: string[];
};

/**
 * Loosely-typed generation options. The AI SDK passes a dynamic shape here
 * (GenerateTextOptions / StreamTextOptions and provider-specific extensions)
 * so we keep this permissive but avoid raw `any`.
 */
type AgentGenerateOptions$4 = {
    prompt?: unknown;
    messages?: unknown;
    timeout?: unknown;
    abortSignal?: AbortSignal;
    rootDir?: string;
    resumeSession?: string;
    maxOutputBytes?: number;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    onEvent?: (event: AgentCliEvent$1) => unknown;
    retry?: unknown;
    isRetry?: unknown;
    retryAttempt?: unknown;
    schemaRetry?: unknown;
    [key: string]: unknown;
};

declare class BaseCliAgent {
    /**
   * @param {BaseCliAgentOptions} opts
   */
    constructor(opts: BaseCliAgentOptions$1);
    version: string;
    tools: {};
    capabilities: any;
    id: string;
    model: string | undefined;
    systemPrompt: string | undefined;
    cwd: string | undefined;
    env: Record<string, string> | undefined;
    yolo: boolean;
    timeoutMs: number | undefined;
    idleTimeoutMs: number | undefined;
    maxOutputBytes: number | undefined;
    extraArgs: string[] | undefined;
    /**
   * @param {AgentGenerateOptions | undefined} options
   * @param {AgentInvocationOperation} operation
   * @returns {Effect.Effect<GenerateTextResult<Record<string, never>, unknown>, SmithersError>}
   */
    runGenerateEffect(options: AgentGenerateOptions$3 | undefined, operation: AgentInvocationOperation): Effect.Effect<GenerateTextResult$3<Record<string, never>, unknown>, SmithersError>;
    /**
   * @param {AgentGenerateOptions} [options]
   * @returns {Promise<GenerateTextResult<Record<string, never>, unknown>>}
   */
    generate(options?: AgentGenerateOptions$3): Promise<GenerateTextResult$3<Record<string, never>, unknown>>;
    /**
   * @param {AgentGenerateOptions} [options]
   * @returns {Promise<StreamTextResult<Record<string, never>, unknown>>}
   */
    stream(options?: AgentGenerateOptions$3): Promise<StreamTextResult<Record<string, never>, unknown>>;
    /**
   * @returns {CliOutputInterpreter | undefined}
   */
    createOutputInterpreter(): CliOutputInterpreter$9 | undefined;
}
type AgentGenerateOptions$3 = AgentGenerateOptions$4;
type BaseCliAgentOptions$1 = BaseCliAgentOptions$2;
type CliOutputInterpreter$9 = CliOutputInterpreter$a;
type GenerateTextResult$3 = ai.GenerateTextResult<any, any>;
type StreamTextResult = ai.StreamTextResult<any, any>;
type AgentInvocationOperation = "generate" | "stream";

type BaseCliAgentOptions = BaseCliAgentOptions$2;
type CliOutputInterpreter$8 = CliOutputInterpreter$a;

type OpenCodeAgentOptions$1 = BaseCliAgentOptions & {
    /** Model identifier (e.g., "anthropic/claude-opus-4-20250514", "openai/gpt-5.4") */
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
declare class OpenCodeAgent extends BaseCliAgent {
    private readonly opts;
    readonly capabilities: AgentCapabilityRegistry$4;
    readonly cliEngine: "opencode";
    constructor(opts?: OpenCodeAgentOptions$1);
    createOutputInterpreter(): CliOutputInterpreter$8;
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: "stream-json";
        env?: Record<string, string>;
        stdoutBannerPatterns: RegExp[];
        stdoutErrorPatterns: RegExp[];
    }>;
}

type VibeAgentOptions$1 = BaseCliAgentOptions$2 & {
    agent?: string;
    maxTurns?: number;
    maxPrice?: number;
    maxTokens?: number;
    enabledTools?: string[];
    sessionId?: string;
    continueSession?: boolean;
};
declare class VibeAgent extends BaseCliAgent {
    private readonly opts;
    readonly capabilities: AgentCapabilityRegistry$4;
    readonly cliEngine: "vibe";
    constructor(opts?: VibeAgentOptions$1);
    createOutputInterpreter(): CliOutputInterpreter$8;
    buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: "stream-json";
    }>;
}

type PiAgentOptions$2 = BaseCliAgentOptions$2 & {
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

type SdkAgentOptions<CALL_OPTIONS = never, TOOLS extends ToolSet = {}, MODEL = any> = Omit<ToolLoopAgentSettings<CALL_OPTIONS, TOOLS>, "model"> & {
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
type HermesAgentOptions$2<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = Omit<SdkAgentOptions<CALL_OPTIONS, TOOLS, ReturnType<typeof openai>>, "model"> & {
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

type OpenAIAgentCommonOptions<CALL_OPTIONS, TOOLS extends ToolSet> = Omit<SdkAgentOptions<CALL_OPTIONS, TOOLS, ReturnType<typeof openai>>, "model"> & {
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
};
type OpenAIAgentPrebuiltModelOptions = {
    model: ReturnType<typeof openai>;
    baseURL?: never;
    apiKey?: never;
};
type OpenAIAgentOptions$2<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = OpenAIAgentCommonOptions<CALL_OPTIONS, TOOLS> & (OpenAIAgentStringModelOptions | OpenAIAgentPrebuiltModelOptions);

type AnthropicAgentOptions$2<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = SdkAgentOptions<CALL_OPTIONS, TOOLS, ReturnType<typeof anthropic>>;

/**
 * Represents an entity capable of generating responses or actions based on prompts.
 * This is typically an AI agent interface.
 */
type AgentLike$1 = {
    /** Optional unique identifier for the agent */
    id?: string;
    /** Available tools the agent can use */
    tools?: Record<string, unknown>;
    /** Optional structured capability registry for cache and diagnostics */
    capabilities?: AgentCapabilityRegistry$4;
    /** True when the agent consumes outputSchema through a native structured-output API. */
    supportsNativeStructuredOutput?: boolean;
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
     * @returns A promise resolving to the generated output
     */
    generate: (args?: AgentGenerateOptions$4) => Promise<unknown>;
};

/** @typedef {import("ai").AgentCallParameters} AgentCallParameters */
/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */
/**
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 * @typedef {import("./AnthropicAgentOptions.ts").AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} AnthropicAgentOptions
 */
/**
 * @template CALL_OPTIONS, TOOLS
 * @typedef {AgentCallParameters<CALL_OPTIONS, TOOLS> & { onStdout?: (text: string) => void; onStderr?: (text: string) => void; onEvent?: (event: unknown) => Promise<void> | void; outputSchema?: import("zod").ZodTypeAny; resumeSession?: string; }} ExtendedGenerateArgs
 */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
declare class AnthropicAgent extends ToolLoopAgent<never, any, never> {
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
    generate(args?: AgentGenerateOptions$2): Promise<GenerateTextResult$2<TOOLS, never>>;
}
type AgentGenerateOptions$2 = AgentGenerateOptions$4;
type AnthropicAgentOptions$1<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = AnthropicAgentOptions$2<CALL_OPTIONS, TOOLS>;
type GenerateTextResult$2 = ai.GenerateTextResult<any, any>;

/** @typedef {import("ai").AgentCallParameters} AgentCallParameters */
/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */
/**
 * @template CALL_OPTIONS, TOOLS
 * @typedef {AgentCallParameters<CALL_OPTIONS, TOOLS> & { onStdout?: (text: string) => void; onStderr?: (text: string) => void; onEvent?: (event: unknown) => Promise<void> | void; outputSchema?: import("zod").ZodTypeAny; resumeSession?: string; }} ExtendedGenerateArgs
 */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
/**
 * @template [CALL_OPTIONS=never], [TOOLS=import("ai").ToolSet]
 * @typedef {import("./OpenAIAgentOptions.ts").OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} OpenAIAgentOptions
 */
declare class OpenAIAgent extends ToolLoopAgent<never, any, never> {
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
    generate(args?: AgentGenerateOptions$1): Promise<GenerateTextResult$1<TOOLS, never>>;
}
type AgentGenerateOptions$1 = AgentGenerateOptions$4;
type GenerateTextResult$1 = ai.GenerateTextResult<any, any>;
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
declare class HermesAgent<CALL_OPTIONS = never, TOOLS = ai.ToolSet> extends OpenAIAgent {
    /**
     * @param {HermesAgentOptions<CALL_OPTIONS, TOOLS>} [opts]
     */
    constructor(opts?: HermesAgentOptions$1<CALL_OPTIONS, TOOLS>);
}
type HermesAgentOptions$1<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = HermesAgentOptions$2<CALL_OPTIONS, TOOLS>;

type ClaudeCodeAgentOptions$1 = BaseCliAgentOptions$2 & {
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
     * on the spawned process so this invocation uses the credentials stored at
     * `<configDir>/.credentials.json` (instead of the user's default `~/.claude/`).
     *
     * Use this to run multiple Claude Code subscriptions side-by-side. Set up
     * the directory by running `CLAUDE_CONFIG_DIR=<path> claude` once and
     * completing `/login` interactively.
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
    capabilities: AgentCapabilityRegistry$6;
    cliEngine: string;
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter(): CliOutputInterpreter$7;
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
        outputFormat: "stream-json" | "text" | "json";
        env: {
            CLAUDE_CONFIG_DIR: string;
            ANTHROPIC_API_KEY: string;
        } | undefined;
    }>;
}
type ClaudeCodeAgentOptions = ClaudeCodeAgentOptions$1;
type CliOutputInterpreter$7 = CliOutputInterpreter$a;

type CodexAgentOptions$1 = BaseCliAgentOptions$2 & {
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
     * OpenAI API key for billing this invocation against the API instead of a
     * ChatGPT Plus/Pro subscription. Sets `OPENAI_API_KEY` on the spawned
     * process.
     */
    apiKey?: string;
};

declare class CodexAgent extends BaseCliAgent {
    /**
   * @param {CodexAgentOptions} [opts]
   */
    constructor(opts?: CodexAgentOptions);
    opts: CodexAgentOptions$1;
    capabilities: AgentCapabilityRegistry$6;
    cliEngine: string;
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter(): CliOutputInterpreter$6;
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
type CliOutputInterpreter$6 = CliOutputInterpreter$a;
type CodexAgentOptions = CodexAgentOptions$1;

/**
 * @deprecated Use AntigravityAgentOptions with the Antigravity CLI (`agy`) for
 * new Google CLI integrations. GeminiAgentOptions remains for legacy and
 * enterprise Gemini CLI setups.
 */
type GeminiAgentOptions$1 = BaseCliAgentOptions$2 & {
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
     * Path to an isolated Gemini CLI config directory. Sets `GEMINI_DIR` on the
     * spawned process so this invocation uses the credentials stored at
     * `<configDir>/oauth_creds.json` (instead of the user's default
     * `~/.gemini/`). Use this to run multiple Gemini accounts side-by-side.
     */
    configDir?: string;
    /**
     * Gemini API key. Sets `GEMINI_API_KEY` on the spawned process for
     * API-billed invocations.
     */
    apiKey?: string;
};

/**
 * @deprecated Use AntigravityAgent for new Google CLI integrations. GeminiAgent
 * remains for legacy and enterprise Gemini CLI setups.
 */
declare class GeminiAgent extends BaseCliAgent {
    /**
   * @param {GeminiAgentOptions} [opts]
   */
    constructor(opts?: GeminiAgentOptions);
    opts: GeminiAgentOptions$1;
    capabilities: AgentCapabilityRegistry$6;
    cliEngine: string;
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
        outputFormat: "stream-json" | "text" | "json";
        env: {
            GEMINI_DIR: string;
            GEMINI_API_KEY: string;
        } | undefined;
    }>;
}
type CliOutputInterpreter$5 = CliOutputInterpreter$a;
type GeminiAgentOptions = GeminiAgentOptions$1;

declare class PiAgent extends BaseCliAgent {
    /**
   * @param {PiAgentOptions} [opts]
   */
    constructor(opts?: PiAgentOptions$1);
    opts: PiAgentOptions$2;
    capabilities: AgentCapabilityRegistry$6;
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
    createOutputInterpreter(): CliOutputInterpreter$4;
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
}
type CliOutputInterpreter$4 = CliOutputInterpreter$a;
type AgentCliEvent = AgentCliEvent$1;
type GenerateTextResult = ai.GenerateTextResult<Record<string, never>, unknown>;
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

type KimiAgentOptions$1 = BaseCliAgentOptions$2 & {
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
    capabilities: AgentCapabilityRegistry$6;
    cliEngine: string;
    issuedSessionId: any;
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter(): CliOutputInterpreter$3;
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
        outputFormat: "stream-json" | "text";
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
type CliOutputInterpreter$3 = CliOutputInterpreter$a;
type KimiAgentOptions = KimiAgentOptions$1;

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

/**
 * Convert a Zod schema to an OpenAI-safe JSON Schema object.
 *
 * Usage:
 * ```ts
 * import { zodToOpenAISchema } from "./zodToOpenAISchema";
 * const jsonSchema = zodToOpenAISchema(myZodSchema);
 * ```
 */
declare function zodToOpenAISchema(zodSchema: any): Promise<zod_v4_core.ZodStandardJSONSchemaPayload<any>>;

/**
 * Sanitize a JSON Schema for OpenAI's structured-output API.
 *
 * OpenAI's `response_format` imposes constraints beyond standard JSON Schema:
 *
 * 1. Every object node **must** include `"type": "object"`.
 * 2. Structured output object nodes must set `additionalProperties: false`.
 *
 * Zod v4's `toJSONSchema()` can violate these rules when loose/passthrough
 * objects are used. Codex rejects those schemas unless they are strict.
 *
 * This function fixes these issues in-place so any agent (Codex, future
 * OpenAI-backed agents, etc.) can safely use a JSON Schema for OpenAI.
 */
declare function sanitizeForOpenAI(node: any): void;

/**
 * Configuration options for the AmpAgent.
 */
type AmpAgentOptions$1 = BaseCliAgentOptions$2 & {
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

/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/**
 * @returns {AgentCapabilityRegistry}
 */
declare function createAmpCapabilityRegistry(): AgentCapabilityRegistry$3;
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
    capabilities: AgentCapabilityRegistry$3;
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
type AgentCapabilityRegistry$3 = AgentCapabilityRegistry$6;
type CliOutputInterpreter$2 = CliOutputInterpreter$a;
type AmpAgentOptions = AmpAgentOptions$1;

type AntigravityAgentOptions$1 = BaseCliAgentOptions$2 & {
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

/**
 * @param {AntigravityAgentOptions} [opts]
 * @returns {AgentCapabilityRegistry}
 */
declare function createAntigravityCapabilityRegistry(opts?: AntigravityAgentOptions): AgentCapabilityRegistry$2;
declare class AntigravityAgent extends BaseCliAgent {
    /**
   * @param {AntigravityAgentOptions} [opts]
   */
    constructor(opts?: AntigravityAgentOptions);
    opts: AntigravityAgentOptions$1;
    capabilities: AgentCapabilityRegistry$6;
    cliEngine: string;
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
        env: {
            GEMINI_DIR: string | undefined;
            GEMINI_API_KEY: string;
        } | undefined;
    }>;
}
type AgentCapabilityRegistry$2 = AgentCapabilityRegistry$6;
type CliOutputInterpreter$1 = CliOutputInterpreter$a;
type AntigravityAgentOptions = AntigravityAgentOptions$1;

type ForgeAgentOptions$1 = BaseCliAgentOptions$2 & {
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

/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/BaseCliAgentOptions.ts").BaseCliAgentOptions} BaseCliAgentOptions */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./ForgeAgentOptions.ts").ForgeAgentOptions} ForgeAgentOptions */
/**
 * @returns {AgentCapabilityRegistry}
 */
declare function createForgeCapabilityRegistry(): AgentCapabilityRegistry$1;
declare class ForgeAgent extends BaseCliAgent {
    /**
   * @param {ForgeAgentOptions} [opts]
   */
    constructor(opts?: ForgeAgentOptions);
    opts: ForgeAgentOptions$1;
    /** @type {AgentCapabilityRegistry} */
    capabilities: AgentCapabilityRegistry$1;
    cliEngine: string;
    issuedConversationId: any;
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter(): CliOutputInterpreter;
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
type AgentCapabilityRegistry$1 = AgentCapabilityRegistry$6;
type CliOutputInterpreter = CliOutputInterpreter$a;
type ForgeAgentOptions = ForgeAgentOptions$1;

/**
 * @returns {AgentCapabilityRegistry}
 */
declare function createVibeCapabilityRegistry(opts?: VibeAgentOptions$1): AgentCapabilityRegistry$6;
type VibeAgentOptions = VibeAgentOptions$1;

/**
 * @returns {CliAgentCapabilityReportEntry[]}
 */
declare function getCliAgentCapabilityReport(): CliAgentCapabilityReportEntry$1[];
type CliAgentCapabilityReportEntry$1 = CliAgentCapabilityReportEntry$2;

/**
 * @returns {CliAgentCapabilityDoctorReport}
 */
declare function getCliAgentCapabilityDoctorReport(): CliAgentCapabilityDoctorReport$2;
type CliAgentCapabilityDoctorReport$2 = CliAgentCapabilityDoctorReport$3;

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

type HttpToolAuth = {
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
type HttpToolInput = {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
    auth?: HttpToolAuth;
    timeoutMs?: number;
};
type HttpToolOutput = {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
};
type CreateHttpToolOptions = {
    description?: string;
    defaultHeaders?: Record<string, string>;
};
/**
 * Create an AI SDK tool that can call any REST API without an OpenAPI spec.
 *
 * @param {CreateHttpToolOptions} [options]
 * @returns {Tool}
 */
declare function createHttpTool(options?: CreateHttpToolOptions): ai.Tool;

type AgentCapabilityRegistry = AgentCapabilityRegistry$6;
type AgentGenerateOptions = AgentGenerateOptions$4;
type AgentLike = AgentLike$1;
type AgentToolDescriptor = AgentToolDescriptor$1;
type AnthropicAgentOptions<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = AnthropicAgentOptions$2<CALL_OPTIONS, TOOLS>;
type OpenAIAgentOptions<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = OpenAIAgentOptions$2<CALL_OPTIONS, TOOLS>;
type HermesAgentOptions<CALL_OPTIONS = never, TOOLS = ai.ToolSet> = HermesAgentOptions$2<CALL_OPTIONS, TOOLS>;
type PiAgentOptions = PiAgentOptions$2;
type PiExtensionUiRequest = PiExtensionUiRequest$1;
type PiExtensionUiResponse = PiExtensionUiResponse$1;
type OpenCodeAgentOptions = OpenCodeAgentOptions$1;
type SmithersAgentContract = SmithersAgentContract$3;
type SmithersAgentContractTool = SmithersAgentContractTool$1;
type SmithersAgentToolCategory = SmithersAgentToolCategory$1;
type SmithersListedTool = SmithersListedTool$2;
type SmithersToolSurface = SmithersToolSurface$2;
type CliAgentCapabilityAdapterId = CliAgentCapabilityAdapterId$1;
type CliAgentCapabilityDoctorEntry = CliAgentCapabilityDoctorEntry$1;
type CliAgentCapabilityDoctorReport = CliAgentCapabilityDoctorReport$3;
type CliAgentCapabilityIssue = CliAgentCapabilityIssue$1;
type CliAgentCapabilityReportEntry = CliAgentCapabilityReportEntry$2;
type CliAgentSurfaceManifestEntry = CliAgentSurfaceManifestEntry$2;
type CliAgentSurfaceOptionMapping = CliAgentSurfaceOptionMapping$1;
type CliAgentSurfaceResumeContract = CliAgentSurfaceResumeContract$1;
type CliAgentUnsupportedFlag = CliAgentUnsupportedFlag$1;
<<<<<<<<< HEAD
type ImageGenerationRequest = {
    prompt: string;
    model?: string;
    size?: string;
    count?: number;
    seed?: number;
    style?: string;
};
type ImageGenerationResult = {
    provider?: string;
    model?: string;
    images: Array<{
        url?: string;
        base64?: string;
        mimeType?: string;
        revisedPrompt?: string;
    }>;
};
type ImageGenerationProvider = {
    name?: string;
    generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> | ImageGenerationResult;
};
type ImageGenerationToolOptions = {
    name?: string;
    description?: string;
    model?: string;
    asToolset?: boolean;
};
declare function createImageGenerationTool(provider: ImageGenerationProvider, options: ImageGenerationToolOptions & {
    asToolset: true;
}): Record<string, ai.Tool>;
declare function createImageGenerationTool(provider: ImageGenerationProvider, options?: ImageGenerationToolOptions): ai.Tool;
type TranscriptionProvider = "whisper" | "deepgram";
type TranscriptionToolInput = {
    audioUrl?: string;
    audioBase64?: string;
    mimeType?: string;
    language?: string;
    prompt?: string;
};
type TranscriptionToolResult = {
    text: string;
    language?: string;
    durationSeconds?: number;
    provider: TranscriptionProvider;
};
type CreateTranscriptionToolOptions = {
    provider: TranscriptionProvider;
    apiKey: string;
    model?: string;
    baseUrl?: string;
    description?: string;
    fetch?: typeof fetch;
};
declare function createTranscriptionTool(options: CreateTranscriptionToolOptions): ai.Tool;
=========
type TranscriptionProvider = "whisper" | "deepgram";
type TranscriptionToolInput = {
    audioUrl?: string;
    audioBase64?: string;
    mimeType?: string;
    language?: string;
    prompt?: string;
};
type TranscriptionToolResult = {
    text: string;
    language?: string;
    durationSeconds?: number;
    provider: TranscriptionProvider;
};
type CreateTranscriptionToolOptions = {
    provider: TranscriptionProvider;
    apiKey: string;
    model?: string;
    baseUrl?: string;
    description?: string;
    fetch?: typeof fetch;
};
declare function createTranscriptionTool(options: CreateTranscriptionToolOptions): ai.Tool;
>>>>>>>>> 2cb1d27a (✨ feat(agents): add Whisper and Deepgram transcription tool)
type TranscriptionProvider = "whisper" | "deepgram";
type TranscriptionToolInput = {
    audioUrl?: string;
    audioBase64?: string;
    mimeType?: string;
    language?: string;
    prompt?: string;
};
type TranscriptionToolResult = {
    text: string;
    language?: string;
    durationSeconds?: number;
    provider: TranscriptionProvider;
};
type CreateTranscriptionToolOptions = {
    provider: TranscriptionProvider;
    apiKey: string;
    model?: string;
    baseUrl?: string;
    description?: string;
    fetch?: typeof fetch;
};
declare function createTranscriptionTool(options: CreateTranscriptionToolOptions): ai.Tool;
type GroundedWebSearchProviderKind = "semantic" | "fresh";
type GroundedWebSearchProviderName = "exa" | "tavily" | "brave" | "serper";
type GroundedWebSearchResult = {
    title: string;
    url: string;
    snippet?: string;
    publishedDate?: string;
    score?: number;
};
type GroundedWebSearchProvider = {
    name: GroundedWebSearchProviderName;
    kind: GroundedWebSearchProviderKind;
    search(input: {
        query: string;
        maxResults: number;
        freshness?: "day" | "week" | "month" | "year";
    }): Promise<GroundedWebSearchResult[]>;
};
type GroundedWebSearchToolset = {
    tools: Record<"grounded_web_search", ai.Tool>;
    toolNames: ["grounded_web_search"];
};
declare function createGroundedWebSearchToolset(options: {
    providers: GroundedWebSearchProvider[];
    maxResultsPerProvider?: number;
}): GroundedWebSearchToolset;
declare function createExaSearchProvider(options: {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
}): GroundedWebSearchProvider;
declare function createTavilySearchProvider(options: {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
}): GroundedWebSearchProvider;
declare function createBraveSearchProvider(options: {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
}): GroundedWebSearchProvider;
declare function createSerperSearchProvider(options: {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
}): GroundedWebSearchProvider;

<<<<<<<<< HEAD
export { type AgentCapabilityRegistry, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, AntigravityAgent, BaseCliAgent, CLI_AGENT_SURFACE_MANIFEST, ClaudeCodeAgent, type CliAgentCapabilityAdapterId, type CliAgentCapabilityDoctorEntry, type CliAgentCapabilityDoctorReport, type CliAgentCapabilityIssue, type CliAgentCapabilityReportEntry, type CliAgentSurfaceManifestEntry, type CliAgentSurfaceOptionMapping, type CliAgentSurfaceResumeContract, type CliAgentUnsupportedFlag, CodexAgent, type CreateTranscriptionToolOptions, ForgeAgent, GeminiAgent, HermesAgent, type HermesAgentOptions, type ImageGenerationProvider, type ImageGenerationRequest, type ImageGenerationResult, type ImageGenerationToolOptions, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, OpenCodeAgent, type OpenCodeAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, type TranscriptionProvider, type TranscriptionToolInput, type TranscriptionToolResult, VibeAgent, type VibeAgentOptions, createAmpCapabilityRegistry, createAntigravityCapabilityRegistry, createForgeCapabilityRegistry, createImageGenerationTool, createSmithersAgentContract, createTranscriptionTool, createVibeCapabilityRegistry, formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, getCliAgentSurfaceManifestEntry, hashCapabilityRegistry, listCliAgentSurfaceManifests, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
export { type AgentCapabilityRegistry, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, AntigravityAgent, BaseCliAgent, CLI_AGENT_SURFACE_MANIFEST, ClaudeCodeAgent, type CliAgentCapabilityAdapterId, type CliAgentCapabilityDoctorEntry, type CliAgentCapabilityDoctorReport, type CliAgentCapabilityIssue, type CliAgentCapabilityReportEntry, type CliAgentSurfaceManifestEntry, type CliAgentSurfaceOptionMapping, type CliAgentSurfaceResumeContract, type CliAgentUnsupportedFlag, CodexAgent, ForgeAgent, GeminiAgent, HermesAgent, type HermesAgentOptions, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, OpenCodeAgent, type OpenCodeAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, VibeAgent, type VibeAgentOptions, createAmpCapabilityRegistry, createAntigravityCapabilityRegistry, createForgeCapabilityRegistry, createSmithersAgentContract, createVibeCapabilityRegistry, formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, getCliAgentSurfaceManifestEntry, hashCapabilityRegistry, listCliAgentSurfaceManifests, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
=========
export { type AgentCapabilityRegistry, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, AntigravityAgent, BaseCliAgent, CLI_AGENT_SURFACE_MANIFEST, ClaudeCodeAgent, type CliAgentCapabilityAdapterId, type CliAgentCapabilityDoctorEntry, type CliAgentCapabilityDoctorReport, type CliAgentCapabilityIssue, type CliAgentCapabilityReportEntry, type CliAgentSurfaceManifestEntry, type CliAgentSurfaceOptionMapping, type CliAgentSurfaceResumeContract, type CliAgentUnsupportedFlag, CodexAgent, type CreateTranscriptionToolOptions, ForgeAgent, GeminiAgent, HermesAgent, type HermesAgentOptions, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, OpenCodeAgent, type OpenCodeAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, type TranscriptionProvider, type TranscriptionToolInput, type TranscriptionToolResult, VibeAgent, type VibeAgentOptions, createAmpCapabilityRegistry, createAntigravityCapabilityRegistry, createForgeCapabilityRegistry, createSmithersAgentContract, createTranscriptionTool, createVibeCapabilityRegistry, formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, getCliAgentSurfaceManifestEntry, hashCapabilityRegistry, listCliAgentSurfaceManifests, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
>>>>>>>>> 2cb1d27a (✨ feat(agents): add Whisper and Deepgram transcription tool)
export { type AgentCapabilityRegistry, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, AntigravityAgent, BaseCliAgent, CLI_AGENT_SURFACE_MANIFEST, ClaudeCodeAgent, type CliAgentCapabilityAdapterId, type CliAgentCapabilityDoctorEntry, type CliAgentCapabilityDoctorReport, type CliAgentCapabilityIssue, type CliAgentCapabilityReportEntry, type CliAgentSurfaceManifestEntry, type CliAgentSurfaceOptionMapping, type CliAgentSurfaceResumeContract, type CliAgentUnsupportedFlag, CodexAgent, type CreateTranscriptionToolOptions, ForgeAgent, GeminiAgent, HermesAgent, type HermesAgentOptions, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, OpenCodeAgent, type OpenCodeAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, type TranscriptionProvider, type TranscriptionToolInput, type TranscriptionToolResult, VibeAgent, type VibeAgentOptions, createAmpCapabilityRegistry, createAntigravityCapabilityRegistry, createForgeCapabilityRegistry, createSmithersAgentContract, createTranscriptionTool, createVibeCapabilityRegistry, formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, getCliAgentSurfaceManifestEntry, hashCapabilityRegistry, listCliAgentSurfaceManifests, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
export { type AgentCapabilityRegistry, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, AntigravityAgent, BaseCliAgent, CLI_AGENT_SURFACE_MANIFEST, ClaudeCodeAgent, type CliAgentCapabilityAdapterId, type CliAgentCapabilityDoctorEntry, type CliAgentCapabilityDoctorReport, type CliAgentCapabilityIssue, type CliAgentCapabilityReportEntry, type CliAgentSurfaceManifestEntry, type CliAgentSurfaceOptionMapping, type CliAgentSurfaceResumeContract, type CliAgentUnsupportedFlag, CodexAgent, type CreateHttpToolOptions, type CreateTranscriptionToolOptions, ForgeAgent, GeminiAgent, HermesAgent, type HermesAgentOptions, type HttpToolAuth, type HttpToolInput, type HttpToolOutput, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, OpenCodeAgent, type OpenCodeAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, type TranscriptionProvider, type TranscriptionToolInput, type TranscriptionToolResult, VibeAgent, type VibeAgentOptions, createAmpCapabilityRegistry, createAntigravityCapabilityRegistry, createForgeCapabilityRegistry, createHttpTool, createSmithersAgentContract, createTranscriptionTool, createVibeCapabilityRegistry, formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, getCliAgentSurfaceManifestEntry, hashCapabilityRegistry, listCliAgentSurfaceManifests, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
export { type AgentCapabilityRegistry, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, AntigravityAgent, BaseCliAgent, CLI_AGENT_SURFACE_MANIFEST, ClaudeCodeAgent, type CliAgentCapabilityAdapterId, type CliAgentCapabilityDoctorEntry, type CliAgentCapabilityDoctorReport, type CliAgentCapabilityIssue, type CliAgentCapabilityReportEntry, type CliAgentSurfaceManifestEntry, type CliAgentSurfaceOptionMapping, type CliAgentSurfaceResumeContract, type CliAgentUnsupportedFlag, CodexAgent, ForgeAgent, GeminiAgent, HermesAgent, type HermesAgentOptions, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, OpenCodeAgent, type OpenCodeAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, VibeAgent, type VibeAgentOptions, createAmpCapabilityRegistry, createAntigravityCapabilityRegistry, createForgeCapabilityRegistry, createSmithersAgentContract, createVibeCapabilityRegistry, formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, getCliAgentSurfaceManifestEntry, hashCapabilityRegistry, listCliAgentSurfaceManifests, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
export { type AgentCapabilityRegistry, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, AntigravityAgent, BaseCliAgent, CLI_AGENT_SURFACE_MANIFEST, ClaudeCodeAgent, type CliAgentCapabilityAdapterId, type CliAgentCapabilityDoctorEntry, type CliAgentCapabilityDoctorReport, type CliAgentCapabilityIssue, type CliAgentCapabilityReportEntry, type CliAgentSurfaceManifestEntry, type CliAgentSurfaceOptionMapping, type CliAgentSurfaceResumeContract, type CliAgentUnsupportedFlag, CodexAgent, type CreateTranscriptionToolOptions, ForgeAgent, GeminiAgent, HermesAgent, type HermesAgentOptions, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, OpenCodeAgent, type OpenCodeAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, type TranscriptionProvider, type TranscriptionToolInput, type TranscriptionToolResult, VibeAgent, type VibeAgentOptions, createAmpCapabilityRegistry, createAntigravityCapabilityRegistry, createForgeCapabilityRegistry, createSmithersAgentContract, createTranscriptionTool, createVibeCapabilityRegistry, formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, getCliAgentSurfaceManifestEntry, hashCapabilityRegistry, listCliAgentSurfaceManifests, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
export { type AgentCapabilityRegistry, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, AntigravityAgent, BaseCliAgent, CLI_AGENT_SURFACE_MANIFEST, ClaudeCodeAgent, type CliAgentCapabilityAdapterId, type CliAgentCapabilityDoctorEntry, type CliAgentCapabilityDoctorReport, type CliAgentCapabilityIssue, type CliAgentCapabilityReportEntry, type CliAgentSurfaceManifestEntry, type CliAgentSurfaceOptionMapping, type CliAgentSurfaceResumeContract, type CliAgentUnsupportedFlag, CodexAgent, type CreateTranscriptionToolOptions, ForgeAgent, GeminiAgent, HermesAgent, type HermesAgentOptions, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, OpenCodeAgent, type OpenCodeAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, type TranscriptionProvider, type TranscriptionToolInput, type TranscriptionToolResult, VibeAgent, type VibeAgentOptions, createAmpCapabilityRegistry, createAntigravityCapabilityRegistry, createForgeCapabilityRegistry, createSmithersAgentContract, createTranscriptionTool, createVibeCapabilityRegistry, formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, getCliAgentSurfaceManifestEntry, hashCapabilityRegistry, listCliAgentSurfaceManifests, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
export { type AgentCapabilityRegistry, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, AntigravityAgent, BaseCliAgent, CLI_AGENT_SURFACE_MANIFEST, ClaudeCodeAgent, type CliAgentCapabilityAdapterId, type CliAgentCapabilityDoctorEntry, type CliAgentCapabilityDoctorReport, type CliAgentCapabilityIssue, type CliAgentCapabilityReportEntry, type CliAgentSurfaceManifestEntry, type CliAgentSurfaceOptionMapping, type CliAgentSurfaceResumeContract, type CliAgentUnsupportedFlag, CodexAgent, type CreateHttpToolOptions, type CreateTranscriptionToolOptions, ForgeAgent, GeminiAgent, HermesAgent, type HermesAgentOptions, type HttpToolAuth, type HttpToolInput, type HttpToolOutput, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, OpenCodeAgent, type OpenCodeAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, type TranscriptionProvider, type TranscriptionToolInput, type TranscriptionToolResult, VibeAgent, type VibeAgentOptions, createAmpCapabilityRegistry, createAntigravityCapabilityRegistry, createForgeCapabilityRegistry, createHttpTool, createSmithersAgentContract, createTranscriptionTool, createVibeCapabilityRegistry, formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, getCliAgentSurfaceManifestEntry, hashCapabilityRegistry, listCliAgentSurfaceManifests, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
export { type AgentCapabilityRegistry, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, AntigravityAgent, BaseCliAgent, CLI_AGENT_SURFACE_MANIFEST, ClaudeCodeAgent, type CliAgentCapabilityAdapterId, type CliAgentCapabilityDoctorEntry, type CliAgentCapabilityDoctorReport, type CliAgentCapabilityIssue, type CliAgentCapabilityReportEntry, type CliAgentSurfaceManifestEntry, type CliAgentSurfaceOptionMapping, type CliAgentSurfaceResumeContract, type CliAgentUnsupportedFlag, CodexAgent, type CreateHttpToolOptions, type CreateTranscriptionToolOptions, ForgeAgent, GeminiAgent, HermesAgent, type HermesAgentOptions, type HttpToolAuth, type HttpToolInput, type HttpToolOutput, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, OpenCodeAgent, type OpenCodeAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, type TranscriptionProvider, type TranscriptionToolInput, type TranscriptionToolResult, VibeAgent, type VibeAgentOptions, createAmpCapabilityRegistry, createAntigravityCapabilityRegistry, createForgeCapabilityRegistry, createHttpTool, createSmithersAgentContract, createTranscriptionTool, createVibeCapabilityRegistry, formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, getCliAgentSurfaceManifestEntry, hashCapabilityRegistry, listCliAgentSurfaceManifests, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
export { type AgentCapabilityRegistry, type AgentGenerateOptions, type AgentLike, type AgentToolDescriptor, AmpAgent, AnthropicAgent, type AnthropicAgentOptions, AntigravityAgent, BaseCliAgent, CLI_AGENT_SURFACE_MANIFEST, ClaudeCodeAgent, type CliAgentCapabilityAdapterId, type CliAgentCapabilityDoctorEntry, type CliAgentCapabilityDoctorReport, type CliAgentCapabilityIssue, type CliAgentCapabilityReportEntry, type CliAgentSurfaceManifestEntry, type CliAgentSurfaceOptionMapping, type CliAgentSurfaceResumeContract, type CliAgentUnsupportedFlag, CodexAgent, type CreateHttpToolOptions, type CreateTranscriptionToolOptions, ForgeAgent, GeminiAgent, type GroundedWebSearchProvider, type GroundedWebSearchProviderKind, type GroundedWebSearchProviderName, type GroundedWebSearchResult, type GroundedWebSearchToolset, HermesAgent, type HermesAgentOptions, type HttpToolAuth, type HttpToolInput, type HttpToolOutput, KimiAgent, OpenAIAgent, type OpenAIAgentOptions, OpenCodeAgent, type OpenCodeAgentOptions, PiAgent, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type SmithersAgentContract, type SmithersAgentContractTool, type SmithersAgentToolCategory, type SmithersListedTool, type SmithersToolSurface, type TranscriptionProvider, type TranscriptionToolInput, type TranscriptionToolResult, VibeAgent, type VibeAgentOptions, createAmpCapabilityRegistry, createAntigravityCapabilityRegistry, createBraveSearchProvider, createExaSearchProvider, createForgeCapabilityRegistry, createGroundedWebSearchToolset, createHttpTool, createSerperSearchProvider, createSmithersAgentContract, createTavilySearchProvider, createTranscriptionTool, createVibeCapabilityRegistry, formatCliAgentCapabilityDoctorReport, getCliAgentCapabilityDoctorReport, getCliAgentCapabilityReport, getCliAgentSurfaceManifestEntry, hashCapabilityRegistry, listCliAgentSurfaceManifests, renderSmithersAgentPromptGuidance, sanitizeForOpenAI, zodToOpenAISchema };
