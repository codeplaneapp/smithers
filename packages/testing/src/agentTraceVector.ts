/**
 * Agent Trace Vector v1 — JSON/JSONL fixtures for deterministic agent simulation.
 * No LLM: multi-turn scripts with optional stream events and virtual-time delays.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";

export const AGENT_TRACE_VECTOR_VERSION = 1 as const;

export type AgentTraceStreamEvent =
  | { t: "delay"; ms: number }
  | { t: "text"; text: string }
  | { t: "tool_start"; name: string; input?: unknown }
  | { t: "tool_end"; name: string; output?: unknown }
  | { t: "progress"; message: string };

export type AgentTraceTurnWhen = {
  /** 0-based generate call index for this agent instance. */
  callIndex?: number;
  /** Engine attempt number (1-based when present on taskContext). */
  attempt?: number;
  /** Loop iteration (0-based). */
  iteration?: number;
  /** Match if flattened prompt/messages contain this substring (steer inject). */
  promptIncludes?: string;
};

export type AgentTraceTurnResult =
  | { kind: "ok"; output?: unknown; text?: string; files?: Record<string, string> }
  | { kind: "fail"; error: string; retryable?: boolean }
  | { kind: "hang"; ms?: number };

export type AgentTraceTurn = {
  when?: AgentTraceTurnWhen;
  stream?: AgentTraceStreamEvent[];
  result: AgentTraceTurnResult;
};

export type AgentTraceVector = {
  /** Schema version; must be 1. */
  version: typeof AGENT_TRACE_VECTOR_VERSION;
  /** Stable fixture id. */
  id: string;
  engineHint?: string;
  turns: AgentTraceTurn[];
};

export type AgentTraceVectorLoadError = {
  path?: string;
  message: string;
};

/**
 * Validate and normalize an unknown JSON value into AgentTraceVector.
 * Throws TypeError with a clear message on failure.
 */
export function parseAgentTraceVector(raw: unknown, path?: string): AgentTraceVector {
  const loc = path ? ` (${path})` : "";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`Agent trace vector must be an object${loc}`);
  }
  const o = raw as Record<string, unknown>;
  const version = o.version;
  if (version !== 1 && version !== "1") {
    throw new TypeError(`Agent trace vector version must be 1${loc}, got ${String(version)}`);
  }
  if (typeof o.id !== "string" || o.id === "") {
    throw new TypeError(`Agent trace vector requires non-empty string id${loc}`);
  }
  if (!Array.isArray(o.turns) || o.turns.length === 0) {
    throw new TypeError(`Agent trace vector "${o.id}" requires a non-empty turns array${loc}`);
  }
  const turns = o.turns.map((turn, i) => parseTurn(turn, `${loc} turn[${i}]`));
  return {
    version: 1,
    id: o.id,
    engineHint: typeof o.engineHint === "string" ? o.engineHint : undefined,
    turns,
  };
}

function parseTurn(raw: unknown, loc: string): AgentTraceTurn {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`Turn must be an object${loc}`);
  }
  const t = raw as Record<string, unknown>;
  if (!t.result || typeof t.result !== "object" || Array.isArray(t.result)) {
    throw new TypeError(`Turn requires result${loc}`);
  }
  const result = parseResult(t.result, loc);
  /** @type {AgentTraceStreamEvent[] | undefined} */
  let stream: AgentTraceStreamEvent[] | undefined;
  if (t.stream !== undefined) {
    if (!Array.isArray(t.stream)) {
      throw new TypeError(`Turn stream must be an array${loc}`);
    }
    stream = t.stream.map((ev, j) => parseStreamEvent(ev, `${loc} stream[${j}]`));
  }
  let when: AgentTraceTurnWhen | undefined;
  if (t.when !== undefined) {
    if (!t.when || typeof t.when !== "object" || Array.isArray(t.when)) {
      throw new TypeError(`Turn when must be an object${loc}`);
    }
    const w = t.when as Record<string, unknown>;
    when = {};
    for (const key of ["callIndex", "attempt", "iteration"] as const) {
      if (w[key] !== undefined && (!Number.isSafeInteger(w[key]) || (w[key] as number) < 0)) {
        throw new TypeError(`when.${key} must be a non-negative safe integer${loc}`);
      }
      if (typeof w[key] === "number") when[key] = w[key];
    }
    if (w.promptIncludes !== undefined && typeof w.promptIncludes !== "string") {
      throw new TypeError(`when.promptIncludes must be a string${loc}`);
    }
    if (typeof w.promptIncludes === "string") when.promptIncludes = w.promptIncludes;
  }
  return { when, stream, result };
}

function parseResult(raw: unknown, loc: string): AgentTraceTurnResult {
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (kind === "ok") {
    let files: Record<string, string> | undefined;
    if (r.files !== undefined) {
      if (!r.files || typeof r.files !== "object" || Array.isArray(r.files)) {
        throw new TypeError(`ok result files must be an object${loc}`);
      }
      files = {};
      for (const [name, contents] of Object.entries(r.files)) {
        if (typeof contents !== "string") throw new TypeError(`ok result file ${name} must be a string${loc}`);
        files[name] = contents;
      }
    }
    return {
      kind: "ok",
      output: r.output,
      text: typeof r.text === "string" ? r.text : undefined,
      files,
    };
  }
  if (kind === "fail") {
    if (typeof r.error !== "string" || r.error === "") {
      throw new TypeError(`fail result requires error string${loc}`);
    }
    return { kind: "fail", error: r.error, retryable: r.retryable === true };
  }
  if (kind === "hang") {
    return { kind: "hang", ms: typeof r.ms === "number" ? r.ms : undefined };
  }
  throw new TypeError(`Unknown result.kind ${String(kind)}${loc}`);
}

function parseStreamEvent(raw: unknown, loc: string): AgentTraceStreamEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`Stream event must be an object${loc}`);
  }
  const e = raw as Record<string, unknown>;
  const t = e.t;
  if (t === "delay") {
    if (typeof e.ms !== "number") throw new TypeError(`delay requires ms${loc}`);
    return { t: "delay", ms: e.ms };
  }
  if (t === "text") {
    if (typeof e.text !== "string") throw new TypeError(`text requires text${loc}`);
    return { t: "text", text: e.text };
  }
  if (t === "tool_start") {
    if (typeof e.name !== "string") throw new TypeError(`tool_start requires name${loc}`);
    return { t: "tool_start", name: e.name, input: e.input };
  }
  if (t === "tool_end") {
    if (typeof e.name !== "string") throw new TypeError(`tool_end requires name${loc}`);
    return { t: "tool_end", name: e.name, output: e.output };
  }
  if (t === "progress") {
    if (typeof e.message !== "string") throw new TypeError(`progress requires message${loc}`);
    return { t: "progress", message: e.message };
  }
  throw new TypeError(`Unknown stream event t=${String(t)}${loc}`);
}

/**
 * Load a vector from a JSON file (single object) or JSONL (first object, or
 * lines each a full vector — returns the first valid vector).
 */
export function loadAgentTraceVector(path: string): AgentTraceVector {
  const text = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  if (ext === ".jsonl") {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    if (lines.length === 0) {
      throw new TypeError(`Empty JSONL agent trace vector: ${path}`);
    }
    // Prefer a full vector object on line 1; multi-vector files use first line.
    return parseAgentTraceVector(JSON.parse(lines[0]!), path);
  }
  return parseAgentTraceVector(JSON.parse(text), path);
}

/**
 * Flatten prompt/messages args into a single searchable string for when.promptIncludes.
 */
export function flattenGeneratePrompt(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  if (typeof args.prompt === "string") return args.prompt;
  if (Array.isArray(args.messages)) {
    return args.messages
      .map((m) => {
        if (!m || typeof m !== "object") return "";
        const c = (m as { content?: unknown }).content;
        return typeof c === "string" ? c : JSON.stringify(c ?? "");
      })
      .join("\n");
  }
  if (args.prompt != null) return JSON.stringify(args.prompt);
  return "";
}

/**
 * Pick the first unused turn whose `when` matches this generate call.
 * Falls back to first unused turn with no `when` constraints.
 * Throws if none match.
 */
export function selectTurn(
  vector: AgentTraceVector,
  used: Set<number>,
  ctx: {
    callIndex: number;
    attempt?: number;
    iteration?: number;
    promptText: string;
  },
): { index: number; turn: AgentTraceTurn } {
  // Pass 1: constrained matches
  for (let i = 0; i < vector.turns.length; i++) {
    if (used.has(i)) continue;
    const turn = vector.turns[i]!;
    const w = turn.when;
    if (!w || Object.keys(w).length === 0) continue;
    if (w.callIndex !== undefined && w.callIndex !== ctx.callIndex) continue;
    if (w.attempt !== undefined && w.attempt !== ctx.attempt) continue;
    if (w.iteration !== undefined && w.iteration !== ctx.iteration) continue;
    if (w.promptIncludes !== undefined && !ctx.promptText.includes(w.promptIncludes)) continue;
    return { index: i, turn };
  }
  // Pass 2: unconstrained unused turns in order (no when / empty when)
  for (let i = 0; i < vector.turns.length; i++) {
    if (used.has(i)) continue;
    const turn = vector.turns[i]!;
    if (turn.when && Object.keys(turn.when).length > 0) continue;
    return { index: i, turn };
  }
  // Do NOT silently consume a constrained turn that failed to match — that
  // hides steer/retry scripting bugs.
  throw new Error(
    `Agent trace vector "${vector.id}": no matching unused turn for callIndex=${ctx.callIndex}` +
      (ctx.attempt !== undefined ? ` attempt=${ctx.attempt}` : "") +
      (ctx.iteration !== undefined ? ` iteration=${ctx.iteration}` : "") +
      (ctx.promptText ? ` promptExcerpt=${JSON.stringify(ctx.promptText.slice(0, 80))}` : ""),
  );
}
