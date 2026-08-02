import * as ai from 'ai';
import * as _smithers_orchestrator_errors_SmithersError from '@smthrs/errors/SmithersError';
import { SmithersError as SmithersError$1 } from '@smthrs/errors/SmithersError';
import { Effect } from 'effect';
import { spawn } from 'node:child_process';

type BaseCliAgentOptions$2 = {
    id?: string;
    model?: string;
    systemPrompt?: string;
    instructions?: string;
    cwd?: string;
    env?: Record<string, string>;
    /**
     * Whether spawned CLI processes inherit `process.env` before applying the
     * agent, task-context, and command-specific environment layers.
     *
     * Defaults to `true` for backwards compatibility. Set to `false` when an
     * agent must receive only explicitly supplied environment variables.
     */
    inheritEnv?: boolean;
    yolo?: boolean;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    maxOutputBytes?: number;
    extraArgs?: string[];
};

type RunCommandResult$2 = {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    /** True when captured stdout exceeded maxOutputBytes and was truncated. */
    stdoutTruncated?: boolean;
    /** True when captured stderr exceeded maxOutputBytes and was truncated. */
    stderrTruncated?: boolean;
};

type PiExtensionUiResponse$2 = {
    type: "extension_ui_response";
    id: string;
    value?: string;
    cancelled?: boolean;
    [key: string]: unknown;
};

type PiExtensionUiRequest$2 = {
    type: "extension_ui_request";
    id: string;
    method: string;
    title?: string;
    placeholder?: string;
    [key: string]: unknown;
};

type CodexConfigOverrides$2 = Record<string, string | number | boolean | object | null> | string[];

type NormalizedTokenUsage$2 = {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
};

type CliUsageInfo$2 = {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
};

type AgentCliActionKind$2 = "turn" | "command" | "tool" | "file_change" | "web_search" | "todo_list" | "reasoning" | "warning" | "note";

type AgentCliActionPhase$1 = "started" | "updated" | "completed";
type AgentCliEventLevel$1 = "debug" | "info" | "warning" | "error";
type AgentCliStartedEvent$1 = {
    type: "started";
    engine: string;
    title: string;
    resume?: string;
    detail?: Record<string, unknown>;
};
type AgentCliActionEvent$1 = {
    type: "action";
    engine: string;
    phase: AgentCliActionPhase$1;
    entryType?: "thought" | "message";
    action: {
        id: string;
        kind: AgentCliActionKind$2;
        title: string;
        detail?: Record<string, unknown>;
    };
    message?: string;
    ok?: boolean;
    level?: AgentCliEventLevel$1;
};
type AgentCliCompletedEvent$1 = {
    type: "completed";
    engine: string;
    ok: boolean;
    answer?: string;
    error?: string;
    resume?: string;
    usage?: Record<string, unknown>;
};
type AgentCliEvent$1 = AgentCliStartedEvent$1 | AgentCliActionEvent$1 | AgentCliCompletedEvent$1;

type CliOutputInterpreter$2 = {
    onStdoutLine?: (line: string) => AgentCliEvent$1[] | AgentCliEvent$1 | null | undefined;
    onStderrLine?: (line: string) => AgentCliEvent$1[] | AgentCliEvent$1 | null | undefined;
    onExit?: (result: RunCommandResult$2) => AgentCliEvent$1[] | AgentCliEvent$1 | null | undefined;
};

/**
 * Loosely-typed generation options. The AI SDK passes a dynamic shape here
 * (GenerateTextOptions / StreamTextOptions and provider-specific extensions)
 * so we keep this permissive but avoid raw `any`.
 */
type AgentGenerateOptions$2 = {
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
    onProcess?: (event: {
        phase: "started" | "exited";
        pid: number | undefined;
    }) => void;
    retry?: unknown;
    isRetry?: unknown;
    retryAttempt?: unknown;
    schemaRetry?: unknown;
    /**
     * Run context for the task this agent invocation belongs to. Surfaced to the
     * spawned agent process (and its subprocesses) as SMITHERS_RUN_ID / NODE_ID /
     * ITERATION / ATTEMPT so the agent can address its own run — e.g. to raise a
     * blocking `smithers ask-human` request.
     */
    taskContext?: {
        runId?: string;
        nodeId?: string;
        iteration?: number;
        attempt?: number;
    };
    [key: string]: unknown;
};

/**
 * @typedef {number | { totalMs?: number; idleMs?: number; } | undefined} TimeoutInput
 */
/**
 * @param {TimeoutInput} timeout
 * @param {{ totalMs?: number; idleMs?: number }} [fallback]
 * @returns {{ totalMs?: number; idleMs?: number }}
 */
declare function resolveTimeouts(timeout: TimeoutInput, fallback?: {
    totalMs?: number;
    idleMs?: number;
}): {
    totalMs?: number;
    idleMs?: number;
};
type TimeoutInput = number | {
    totalMs?: number;
    idleMs?: number;
} | undefined;

/**
 * @param {Array<string | undefined>} parts
 * @returns {string | undefined}
 */
declare function combineNonEmpty(parts: Array<string | undefined>): string | undefined;

/**
 * @param {unknown} options
 * @returns {PromptParts}
 */
declare function extractPrompt(options: unknown): PromptParts;
type PromptParts = {
    prompt: string;
    systemFromMessages?: string;
};

/**
 * @param {string} text
 * @returns {unknown | undefined}
 */
declare function tryParseJson(text: string): unknown | undefined;

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
declare function extractTextFromJsonValue(value: unknown): string | undefined;

/**
 * @param {unknown} usage
 * @returns {NormalizedTokenUsage | null}
 */
declare function normalizeTokenUsage(usage: unknown): NormalizedTokenUsage$1 | null;
type NormalizedTokenUsage$1 = NormalizedTokenUsage$2;

/**
 * @param {AgentStdoutTextEmitterOptions} options
 * @returns {AgentStdoutTextEmitter}
 */
declare function createAgentStdoutTextEmitter(options: AgentStdoutTextEmitterOptions): AgentStdoutTextEmitter;
type AgentStdoutTextEmitter = {
    push: (chunk: string) => void;
    flush: (finalText?: string) => void;
};
type AgentStdoutTextEmitterOptions = {
    outputFormat?: string;
    onText?: (text: string) => void;
};

/**
 * @param {string} text
 * @param {number} [maxBytes]
 * @returns {string}
 */
declare function truncateToBytes(text: string, maxBytes?: number): string;

/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
/** @typedef {import("ai").LanguageModelUsage} LanguageModelUsage */
/**
 * @param {string} text
 * @param {unknown} output
 * @param {string} modelId
 * @param {LanguageModelUsage} [usage]
 * @returns {GenerateTextResult<Record<string, never>, unknown>}
 */
declare function buildGenerateResult(text: string, output: unknown, modelId: string, usage?: LanguageModelUsage): GenerateTextResult$1<Record<string, never>, unknown>;
type GenerateTextResult$1 = ai.GenerateTextResult<any, any, any>;
type LanguageModelUsage = ai.LanguageModelUsage;

/**
 * @typedef {{ cwd: string; env: Record<string, string>; input?: string; timeoutMs?: number; idleTimeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number; truncateKeep?: "head" | "tail"; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; onProcess?: (event: { phase: "started" | "exited"; pid: number | undefined }) => void; }} RunCommandOptions
 */
/** @typedef {import("./RunCommandResult.ts").RunCommandResult} RunCommandResult */
/** @typedef {import("@smthrs/errors/SmithersError").SmithersError} SmithersError */
/**
 * @param {string} command
 * @param {string[]} args
 * @param {RunCommandOptions} options
 * @returns {Effect.Effect<RunCommandResult, SmithersError>}
 */
declare function runCommandEffect(command: string, args: string[], options: RunCommandOptions): Effect.Effect<RunCommandResult$1, SmithersError>;
type RunCommandOptions = {
    cwd: string;
    env: Record<string, string>;
    input?: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
    truncateKeep?: "head" | "tail";
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    onProcess?: (event: {
        phase: "started" | "exited";
        pid: number | undefined;
    }) => void;
};
type RunCommandResult$1 = RunCommandResult$2;
type SmithersError = _smithers_orchestrator_errors_SmithersError.SmithersError;

/**
 * @param {string} command
 * @param {string[]} args
 * @param {RunRpcCommandOptions} options
 * @returns {Effect.Effect<{ text: string; output: unknown; stderr: string; exitCode: number | null; usage?: any; }, SmithersError>}
 */
declare function runRpcCommandEffect(command: string, args: string[], options: RunRpcCommandOptions): Effect.Effect<{
    text: string;
    output: unknown;
    stderr: string;
    exitCode: number | null;
    usage?: any;
}, SmithersError$1>;
type PiExtensionUiResponse$1 = PiExtensionUiResponse$2;
type PiExtensionUiRequest$1 = PiExtensionUiRequest$2;
type RunRpcCommandOptions = {
    cwd: string;
    env: Record<string, string>;
    prompt: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    onProcess?: (event: {
        phase: "started" | "exited";
        pid: number | undefined;
    }) => void;
    onJsonEvent?: (event: Record<string, unknown>) => Promise<void> | void;
    onExtensionUiRequest?: (request: PiExtensionUiRequest$1) => Promise<PiExtensionUiResponse$1 | null> | PiExtensionUiResponse$1 | null;
    spawnFn?: typeof spawn;
};

/**
 * @param {string[]} args
 * @param {string} flag
 * @param {string | number | boolean} [value]
 */
declare function pushFlag(args: string[], flag: string, value?: string | number | boolean): void;

/**
 * @param {string[]} args
 * @param {string} flag
 * @param {string[]} [values]
 */
declare function pushList(args: string[], flag: string, values?: string[]): void;

/** @typedef {import("./CodexConfigOverrides.ts").CodexConfigOverrides} CodexConfigOverrides */
/**
 * @param {CodexConfigOverrides} [config]
 * @returns {string[]}
 */
declare function normalizeCodexConfig(config?: CodexConfigOverrides$1): string[];
type CodexConfigOverrides$1 = CodexConfigOverrides$2;

/** @typedef {import("./AgentCliEvent.ts").AgentCliEvent} AgentCliEvent */
/** @typedef {import("./AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */
/** @typedef {import("./BaseCliAgentOptions.ts").BaseCliAgentOptions} BaseCliAgentOptions */
/** @typedef {import("./CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./CliUsageInfo.ts").CliUsageInfo} CliUsageInfo */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
/** @typedef {import("ai").StreamTextResult} StreamTextResult */
/** @typedef {import("ai").LanguageModelUsage} LanguageModelUsage */
/**
 * @typedef {"generate" | "stream"} AgentInvocationOperation
 */
/**
 * @typedef {Record<string, string | undefined>} AgentInvocationTags
 */
/**
 * @typedef {{
 *   inputTokens?: number;
 *   outputTokens?: number;
 *   cacheReadTokens?: number;
 *   cacheWriteTokens?: number;
 *   reasoningTokens?: number;
 *   totalTokens?: number;
 * }} AgentTokenTotals
 */
/**
 * @template A
 * @param {Effect.Effect<A, SmithersError, never>} effect
 * @returns {Promise<A>}
 */
declare function runAgentPromise<A>(effect: Effect.Effect<A, SmithersError$1, never>): Promise<A>;
/**
 * @param {string} raw
 * @returns {CliUsageInfo | undefined}
 */
declare function extractUsageFromOutput(raw: string): CliUsageInfo$1 | undefined;
declare class BaseCliAgent {
    /**
     * @param {BaseCliAgentOptions} opts
     */
    constructor(opts: BaseCliAgentOptions$1);
    version: string;
    /** @type {Record<string, unknown>} */
    tools: Record<string, unknown>;
    capabilities: any;
    id: string;
    model: string | undefined;
    systemPrompt: string | undefined;
    cwd: string | undefined;
    env: Record<string, string> | undefined;
    inheritEnv: boolean;
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
    runGenerateEffect(options: AgentGenerateOptions$1 | undefined, operation: AgentInvocationOperation): Effect.Effect<GenerateTextResult<Record<string, never>, unknown>, SmithersError$1>;
    /**
     * @param {AgentGenerateOptions} [options]
     * @returns {Promise<void>}
     */
    preflight(options?: AgentGenerateOptions$1): Promise<void>;
    /**
     * @param {AgentGenerateOptions} [options]
     * @returns {Promise<GenerateTextResult<Record<string, never>, unknown>>}
     */
    generate(options?: AgentGenerateOptions$1): Promise<GenerateTextResult<Record<string, never>, unknown>>;
    /**
     * @param {AgentGenerateOptions} [options]
     * @returns {Promise<StreamTextResult<Record<string, never>, unknown>>}
     */
    stream(options?: AgentGenerateOptions$1): Promise<StreamTextResult<Record<string, never>, unknown>>;
    /**
     * @returns {CliOutputInterpreter | undefined}
     */
    createOutputInterpreter(): CliOutputInterpreter$1 | undefined;
    /**
     * @returns {{ provider?: string; model?: string } | undefined}
     */
    diagnosticHints(): {
        provider?: string;
        model?: string;
    } | undefined;
}
type AgentGenerateOptions$1 = AgentGenerateOptions$2;
type BaseCliAgentOptions$1 = BaseCliAgentOptions$2;
type CliOutputInterpreter$1 = CliOutputInterpreter$2;
type CliUsageInfo$1 = CliUsageInfo$2;
type GenerateTextResult = ai.GenerateTextResult<any, any, any>;
type StreamTextResult = ai.StreamTextResult<any, any, any>;
type AgentInvocationOperation = "generate" | "stream";

/** @typedef {import("./AgentCliActionKind.ts").AgentCliActionKind} AgentCliActionKind */
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
declare function isRecord(value: unknown): value is Record<string, unknown>;
/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
declare function asString(value: unknown): string | undefined;
/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
declare function asNumber(value: unknown): number | undefined;
/**
 * @param {string} value
 * @param {number} [maxLength]
 * @returns {string}
 */
declare function truncate(value: string, maxLength?: number): string;
/**
 * @param {string | undefined} name
 * @param {ReadonlyArray<readonly [string[], AgentCliActionKind]>} [extraRules]
 * @returns {AgentCliActionKind}
 */
declare function toolKindFromName(name: string | undefined, extraRules?: ReadonlyArray<readonly [string[], AgentCliActionKind$1]>): AgentCliActionKind$1;
/**
 * @param {string} value
 * @returns {boolean}
 */
declare function isLikelyRuntimeMetadata(value: string): boolean;
/**
 * @param {string} line
 * @returns {boolean}
 */
declare function shouldSurfaceUnparsedStdout(line: string): boolean;
/**
 * @returns {(prefix: string) => string}
 */
declare function createSyntheticIdGenerator(): (prefix: string) => string;
type AgentCliActionKind$1 = AgentCliActionKind$2;

type AgentCliActionEvent = AgentCliActionEvent$1;
type AgentCliActionKind = AgentCliActionKind$2;
type AgentCliActionPhase = AgentCliActionPhase$1;
type AgentCliCompletedEvent = AgentCliCompletedEvent$1;
type AgentCliEvent = AgentCliEvent$1;
type AgentCliEventLevel = AgentCliEventLevel$1;
type AgentCliStartedEvent = AgentCliStartedEvent$1;
type AgentGenerateOptions = AgentGenerateOptions$2;
type BaseCliAgentOptions = BaseCliAgentOptions$2;
type CliOutputInterpreter = CliOutputInterpreter$2;
type CliUsageInfo = CliUsageInfo$2;
type NormalizedTokenUsage = NormalizedTokenUsage$2;
type CodexConfigOverrides = CodexConfigOverrides$2;
type PiExtensionUiRequest = PiExtensionUiRequest$2;
type PiExtensionUiResponse = PiExtensionUiResponse$2;
type RunCommandResult = RunCommandResult$2;

export { type AgentGenerateOptions$2 as A, type BaseCliAgentOptions$2 as B, type CliOutputInterpreter$2 as C, extractTextFromJsonValue as D, extractUsageFromOutput as E, isLikelyRuntimeMetadata as F, isRecord as G, normalizeCodexConfig as H, normalizeTokenUsage as I, pushFlag as J, pushList as K, resolveTimeouts as L, runAgentPromise as M, type NormalizedTokenUsage as N, runCommandEffect as O, type PiExtensionUiRequest$2 as P, runRpcCommandEffect as Q, type RunCommandResult as R, shouldSurfaceUnparsedStdout as S, toolKindFromName as T, truncate as U, truncateToBytes as V, tryParseJson as W, type BaseCliAgentOptions as a, type PiExtensionUiResponse$2 as b, BaseCliAgent as c, type CodexConfigOverrides$2 as d, type AgentCliEvent$1 as e, type CliOutputInterpreter as f, type AgentCliActionKind$2 as g, type AgentCliActionEvent as h, type AgentCliActionKind as i, type AgentCliActionPhase as j, type AgentCliCompletedEvent as k, type AgentCliEvent as l, type AgentCliEventLevel as m, type AgentCliStartedEvent as n, type AgentGenerateOptions as o, type CliUsageInfo as p, type CodexConfigOverrides as q, type PiExtensionUiRequest as r, type PiExtensionUiResponse as s, asNumber as t, asString as u, buildGenerateResult as v, combineNonEmpty as w, createAgentStdoutTextEmitter as x, createSyntheticIdGenerator as y, extractPrompt as z };
