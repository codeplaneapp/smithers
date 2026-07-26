/// <reference path="../types/bun-test-shim.d.ts" />
/**
 * Agent Trace Vector v1 — JSON/JSONL fixtures for deterministic agent simulation.
 * No LLM: multi-turn scripts with optional stream events and virtual-time delays.
 */
declare const AGENT_TRACE_VECTOR_VERSION: 1;
type AgentTraceStreamEvent = {
    t: "delay";
    ms: number;
} | {
    t: "text";
    text: string;
} | {
    t: "tool_start";
    name: string;
    input?: unknown;
} | {
    t: "tool_end";
    name: string;
    output?: unknown;
} | {
    t: "progress";
    message: string;
};
type AgentTraceTurnWhen = {
    /** 0-based generate call index for this agent instance. */
    callIndex?: number;
    /** Engine attempt number (1-based when present on taskContext). */
    attempt?: number;
    /** Loop iteration (0-based). */
    iteration?: number;
    /** Match if flattened prompt/messages contain this substring (steer inject). */
    promptIncludes?: string;
};
type AgentTraceTurnResult = {
    kind: "ok";
    output?: unknown;
    text?: string;
    files?: Record<string, string>;
} | {
    kind: "fail";
    error: string;
    retryable?: boolean;
} | {
    kind: "hang";
    ms?: number;
};
type AgentTraceTurn = {
    when?: AgentTraceTurnWhen;
    stream?: AgentTraceStreamEvent[];
    result: AgentTraceTurnResult;
};
type AgentTraceVector = {
    /** Schema version; must be 1. */
    version: typeof AGENT_TRACE_VECTOR_VERSION;
    /** Stable fixture id. */
    id: string;
    engineHint?: string;
    turns: AgentTraceTurn[];
};
type AgentTraceVectorLoadError = {
    path?: string;
    message: string;
};
/**
 * Validate and normalize an unknown JSON value into AgentTraceVector.
 * Throws TypeError with a clear message on failure.
 */
declare function parseAgentTraceVector(raw: unknown, path?: string): AgentTraceVector;
/**
 * Load a vector from a JSON file (single object) or JSONL (first object, or
 * lines each a full vector — returns the first valid vector).
 */
declare function loadAgentTraceVector(path: string): AgentTraceVector;
/**
 * Flatten prompt/messages args into a single searchable string for when.promptIncludes.
 */
declare function flattenGeneratePrompt(args: Record<string, unknown> | undefined): string;
/**
 * Pick the first unused turn whose `when` matches this generate call.
 * Falls back to first unused turn with no `when` constraints.
 * Throws if none match.
 */
declare function selectTurn(vector: AgentTraceVector, used: Set<number>, ctx: {
    callIndex: number;
    attempt?: number;
    iteration?: number;
    promptText: string;
}): {
    index: number;
    turn: AgentTraceTurn;
};

export { AGENT_TRACE_VECTOR_VERSION, type AgentTraceStreamEvent, type AgentTraceTurn, type AgentTraceTurnResult, type AgentTraceTurnWhen, type AgentTraceVector, type AgentTraceVectorLoadError, flattenGeneratePrompt, loadAgentTraceVector, parseAgentTraceVector, selectTurn };
