import * as ai from 'ai';
import * as _smthrs_errors_SmithersError from '@smthrs/errors/SmithersError';
import { SmithersError as SmithersError$1 } from '@smthrs/errors/SmithersError';
import { Effect } from 'effect';
import { spawn } from 'node:child_process';

/**
 * Normalized cross-harness file-change record. See
 * `research/file-change-contract.md` for the design rationale.
 */
type AgentFileChangeKind = "created" | "modified" | "deleted" | "renamed";
type AgentFileChange$1 = {
    path: string;
    kind: AgentFileChangeKind;
    /** Set when `kind === "renamed"`. */
    oldPath?: string;
    /** Full `git diff`-style unified patch, when available. */
    unifiedDiff?: string;
    /** Did the harness report the diff, or did we build it from tool input? */
    source: "reported" | "reconstructed";
};

type AgentCheckpointJsonPrimitive = null | boolean | number | string;
type AgentCheckpointJsonArray = AgentCheckpointJsonValue[];
type AgentCheckpointJsonObject = {
    [key: string]: AgentCheckpointJsonValue;
};
/** A strict, recursively JSON-serializable value. */
type AgentCheckpointJsonValue = AgentCheckpointJsonPrimitive | AgentCheckpointJsonArray | AgentCheckpointJsonObject;
/**
 * Versioned state returned by an agent and supplied to a later generation.
 * Smithers validates and persists `payload` as JSON but never interprets it.
 */
type AgentCheckpoint = {
    codec: string;
    version: number;
    payload: AgentCheckpointJsonValue;
};
/** Identifies why a saved checkpoint is being supplied to `generate()`. */
type AgentCheckpointMode = "resume" | "fork";
/**
 * Declares one checkpoint format an agent can consume. Versions and modes are
 * exact; isolated fork support must always be explicit.
 */
type AgentCheckpointCapability = {
    codec: string;
    versions: readonly number[];
    modes: readonly AgentCheckpointMode[];
};
/** Declares checkpoint formats an agent can produce. */
type AgentCheckpointFormat = {
    codec: string;
    versions: readonly number[];
};
/**
 * A durability fence supplied to `generate()`. The agent must await the
 * returned promise before treating the checkpoint as published. Resolution
 * means the runtime durably stored the checkpoint while it still owned the
 * invocation; rejection means publication failed or ownership was lost.
 */
type AgentCheckpointPublisher = (checkpoint: AgentCheckpoint) => Promise<void>;
/** Optional checkpoint extension carried by an agent generation result. */
type AgentCheckpointResult = {
    checkpoint?: AgentCheckpoint;
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

/**
 * Loosely-typed generation options. The AI SDK passes a dynamic shape here
 * (GenerateTextOptions / StreamTextOptions and provider-specific extensions)
 * so we keep this permissive but avoid raw `any`.
 */
type AgentGenerateOptionsBase = {
    prompt?: unknown;
    messages?: unknown;
    timeout?: unknown;
    abortSignal?: AbortSignal;
    rootDir?: string;
    /** Awaited durability fence for publishing checkpoints during generation. */
    onCheckpoint?: AgentCheckpointPublisher;
    /** Effective per-run checkpoint ceiling, never above Smithers's system maximum. */
    maxAgentCheckpointBytes?: number;
    maxOutputBytes?: number;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    onEvent?: (event: AgentCliEvent$1) => unknown;
    onProcess?: (event: {
        phase: "started" | "exited";
        pid: number | undefined;
        exitCode?: number | null;
        signal?: string | null;
    }) => void;
    onToolExecutionStart?: (event: {
        callId?: string;
        toolCall?: {
            toolCallId?: string;
        };
    }) => unknown;
    onToolExecutionEnd?: (event: {
        callId?: string;
        toolCall?: {
            toolCallId?: string;
        };
    }) => unknown;
    retry?: unknown;
    isRetry?: unknown;
    retryAttempt?: unknown;
    schemaRetry?: unknown;
    /**
     * Run context for the task this agent invocation belongs to. Surfaced to the
     * spawned agent process (and its subprocesses) as SMITHERS_RUN_ID / NODE_ID /
     * ITERATION / ATTEMPT so the agent can address its own run — e.g. to raise a
     * blocking `smithers ask-human` request. It also sets SMITHERS_INSIDE_RUN,
     * the recursion marker telling the agent's own skills that it is already
     * executing inside a run and must not launch or steer Smithers runs.
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
 * Continuation inputs are discriminated so a checkpoint always has an
 * explicit mode and cannot be combined with a provider session id.
 */
type AgentCheckpointContinuationOptions = {
    /** State captured from an earlier generation. */
    resumeCheckpoint: AgentCheckpoint;
    /** Whether the checkpoint continues one session or seeds an isolated fork. */
    checkpointMode: AgentCheckpointMode;
    resumeSession?: never;
} | {
    resumeCheckpoint?: never;
    checkpointMode?: never;
    resumeSession?: string;
};
type AgentGenerateOptions$2 = AgentGenerateOptionsBase & AgentCheckpointContinuationOptions;

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
    /** Called after a provider quota error is classified. */
    onQuotaExceeded?: (details: {
        agentId?: string;
        agentEngine?: string;
        agentModel?: string;
        quotaResetAtMs?: number;
        underlying?: string;
    }) => void;
    /**
     * First-class reasoning effort, shared across every CLI adapter so a workflow
     * can request it uniformly and the engine can persist/display it per attempt.
     *
     * The declared ladder is `low | medium | high | xhigh | max`; the `| string`
     * escape hatch keeps provider-specific values valid. Each adapter translates
     * the value onto its own knob (explicit adapter-specific config always wins):
     * - ClaudeCodeAgent → merged into `--settings` as `{ effortLevel }`.
     * - CodexAgent → `config.model_reasoning_effort` (Codex historically accepts
     *   only `minimal | low | medium | high`, `xhigh` on newer gpt-5-codex; it is
     *   a documented pass-through with that ceiling — `max` is not a Codex value).
     * - OpenCodeAgent → the provider-defined `--variant` string (OpenCode has no
     *   fixed effort ladder), else unsupported for that adapter.
     */
    effort?: "low" | "medium" | "high" | "xhigh" | "max" | string;
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

type CliOutputInterpreter$2 = {
    onStdoutLine?: (line: string) => AgentCliEvent$1[] | AgentCliEvent$1 | null | undefined;
    onStderrLine?: (line: string) => AgentCliEvent$1[] | AgentCliEvent$1 | null | undefined;
    onExit?: (result: RunCommandResult$2) => AgentCliEvent$1[] | AgentCliEvent$1 | null | undefined;
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
 * @typedef {{ cwd: string; env: Record<string, string>; input?: string; timeoutMs?: number; idleTimeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number; truncateKeep?: "head" | "tail"; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; onProcess?: (event: { phase: "started" | "exited"; pid: number | undefined; exitCode?: number | null; signal?: string | null }) => void; }} RunCommandOptions
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
        exitCode?: number | null;
        signal?: string | null;
    }) => void;
};
type RunCommandResult$1 = RunCommandResult$2;
type SmithersError = _smthrs_errors_SmithersError.SmithersError;

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
        exitCode?: number | null;
        signal?: string | null;
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

/**
 * Emit one flag/value pair per entry: `--flag a --flag b`.
 *
 * Use this for vendor flags whose parser accepts exactly one value per
 * occurrence (clap `Vec<T>` without `num_args`, commander accumulating
 * `argParser`). `pushList` would emit `--flag a b`, and the vendor then
 * parses `b` as a positional argument.
 *
 * @param {string[]} args
 * @param {string} flag
 * @param {string[]} [values]
 */
declare function pushRepeated(args: string[], flag: string, values?: string[]): void;

/** @typedef {import("./CodexConfigOverrides.ts").CodexConfigOverrides} CodexConfigOverrides */
/**
 * @param {CodexConfigOverrides} [config]
 * @returns {string[]}
 */
declare function normalizeCodexConfig(config?: CodexConfigOverrides$1): string[];
type CodexConfigOverrides$1 = CodexConfigOverrides$2;

/**
 * @param {string} path
 * @param {string} oldText
 * @param {string} newText
 * @returns {string | undefined} unified diff, or undefined when texts are identical
 */
declare function reconstructUnifiedDiff(path: string, oldText: string, newText: string): string | undefined;

/** @typedef {import("../agent-contract/AgentFileChange.ts").AgentFileChange} AgentFileChange */
/**
 * Shared `parseFileChanges` logic for harnesses that share Claude Code's
 * Anthropic-style `tool_use` shape: `Edit`/`MultiEdit`
 * carry `old_string`/`new_string`/`file_path` verbatim in the tool input;
 * `Write` carries only the new full-file `content`, so a diff can only be
 * reconstructed when the caller separately knows the prior content (pass
 * `options.priorContent` — e.g. `""` once the tool result confirms the file
 * was newly created). Without that knowledge a `Write` stays paths-only: an
 * empty-old diff over an EXISTING file would be fabricated.
 * `NotebookEdit` carries `new_source`; only `edit_mode: "insert"` has a
 * genuinely empty old cell, so only inserts reconstruct a diff.
 *
 * @param {unknown} toolTitle - the tool_use block's `name` (e.g. "Edit")
 * @param {unknown} input - the tool_use block's `input`
 * @param {{ priorContent?: string }} [options] - known prior file content (Write only)
 * @returns {AgentFileChange[] | undefined}
 */
declare function parseAnthropicStyleFileChanges(toolTitle: unknown, input: unknown, options?: {
    priorContent?: string;
}): AgentFileChange[] | undefined;
type AgentFileChange = AgentFileChange$1;

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
 * @param {{ extractResultUsage?: (payload: Record<string, unknown>) => CliUsageInfo | null | undefined }} [options]
 * @returns {CliUsageInfo | undefined}
 */
declare function extractUsageFromOutput(raw: string, options?: {
    extractResultUsage?: (payload: Record<string, unknown>) => CliUsageInfo$1 | null | undefined;
}): CliUsageInfo$1 | undefined;
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

export { pushFlag as $, type AgentGenerateOptions$2 as A, type BaseCliAgentOptions$2 as B, type CliOutputInterpreter$2 as C, type AgentCliStartedEvent as D, type AgentGenerateOptions as E, type CliUsageInfo as F, type CodexConfigOverrides as G, type NormalizedTokenUsage as H, type PiExtensionUiRequest as I, type PiExtensionUiResponse as J, asNumber as K, asString as L, buildGenerateResult as M, type NormalizedTokenUsage$2 as N, combineNonEmpty as O, type PiExtensionUiRequest$2 as P, createAgentStdoutTextEmitter as Q, type RunCommandResult as R, createSyntheticIdGenerator as S, extractPrompt as T, extractTextFromJsonValue as U, extractUsageFromOutput as V, isLikelyRuntimeMetadata as W, isRecord as X, normalizeCodexConfig as Y, normalizeTokenUsage as Z, parseAnthropicStyleFileChanges as _, type AgentCheckpoint as a, pushList as a0, pushRepeated as a1, reconstructUnifiedDiff as a2, resolveTimeouts as a3, runAgentPromise as a4, runCommandEffect as a5, runRpcCommandEffect as a6, shouldSurfaceUnparsedStdout as a7, toolKindFromName as a8, truncate as a9, truncateToBytes as aa, tryParseJson as ab, type AgentFileChange$1 as b, type AgentCheckpointCapability as c, type AgentCheckpointFormat as d, type BaseCliAgentOptions as e, type PiExtensionUiResponse$2 as f, BaseCliAgent as g, type CodexConfigOverrides$2 as h, type AgentCliEvent$1 as i, type CliOutputInterpreter as j, type AgentCheckpointResult as k, type AgentCheckpointMode as l, type AgentCliActionKind$2 as m, type AgentCheckpointContinuationOptions as n, type AgentCheckpointJsonArray as o, type AgentCheckpointJsonObject as p, type AgentCheckpointJsonPrimitive as q, type AgentCheckpointJsonValue as r, type AgentCheckpointPublisher as s, type AgentFileChangeKind as t, type AgentCliActionEvent as u, type AgentCliActionKind as v, type AgentCliActionPhase as w, type AgentCliCompletedEvent as x, type AgentCliEvent as y, type AgentCliEventLevel as z };
