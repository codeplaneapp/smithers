// src/agentTraceVector.ts
import { readFileSync } from "fs";
import { extname } from "path";
var AGENT_TRACE_VECTOR_VERSION = 1;
function parseAgentTraceVector(raw, path) {
  const loc = path ? ` (${path})` : "";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`Agent trace vector must be an object${loc}`);
  }
  const o = raw;
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
    engineHint: typeof o.engineHint === "string" ? o.engineHint : void 0,
    turns
  };
}
function parseTurn(raw, loc) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`Turn must be an object${loc}`);
  }
  const t = raw;
  if (!t.result || typeof t.result !== "object" || Array.isArray(t.result)) {
    throw new TypeError(`Turn requires result${loc}`);
  }
  const result = parseResult(t.result, loc);
  let stream;
  if (t.stream !== void 0) {
    if (!Array.isArray(t.stream)) {
      throw new TypeError(`Turn stream must be an array${loc}`);
    }
    stream = t.stream.map((ev, j) => parseStreamEvent(ev, `${loc} stream[${j}]`));
  }
  let when;
  if (t.when !== void 0) {
    if (!t.when || typeof t.when !== "object" || Array.isArray(t.when)) {
      throw new TypeError(`Turn when must be an object${loc}`);
    }
    const w = t.when;
    when = {};
    for (const key of ["callIndex", "attempt", "iteration"]) {
      if (w[key] !== void 0 && (!Number.isSafeInteger(w[key]) || w[key] < 0)) {
        throw new TypeError(`when.${key} must be a non-negative safe integer${loc}`);
      }
      if (typeof w[key] === "number") when[key] = w[key];
    }
    if (w.promptIncludes !== void 0 && typeof w.promptIncludes !== "string") {
      throw new TypeError(`when.promptIncludes must be a string${loc}`);
    }
    if (typeof w.promptIncludes === "string") when.promptIncludes = w.promptIncludes;
  }
  return { when, stream, result };
}
function parseResult(raw, loc) {
  const r = raw;
  const kind = r.kind;
  if (kind === "ok") {
    let files;
    if (r.files !== void 0) {
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
      text: typeof r.text === "string" ? r.text : void 0,
      files
    };
  }
  if (kind === "fail") {
    if (typeof r.error !== "string" || r.error === "") {
      throw new TypeError(`fail result requires error string${loc}`);
    }
    return { kind: "fail", error: r.error, retryable: r.retryable === true };
  }
  if (kind === "hang") {
    return { kind: "hang", ms: typeof r.ms === "number" ? r.ms : void 0 };
  }
  throw new TypeError(`Unknown result.kind ${String(kind)}${loc}`);
}
function parseStreamEvent(raw, loc) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`Stream event must be an object${loc}`);
  }
  const e = raw;
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
function loadAgentTraceVector(path) {
  const text = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  if (ext === ".jsonl") {
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (lines.length === 0) {
      throw new TypeError(`Empty JSONL agent trace vector: ${path}`);
    }
    return parseAgentTraceVector(JSON.parse(lines[0]), path);
  }
  return parseAgentTraceVector(JSON.parse(text), path);
}
function flattenGeneratePrompt(args) {
  if (!args) return "";
  if (typeof args.prompt === "string") return args.prompt;
  if (Array.isArray(args.messages)) {
    return args.messages.map((m) => {
      if (!m || typeof m !== "object") return "";
      const c = m.content;
      return typeof c === "string" ? c : JSON.stringify(c ?? "");
    }).join("\n");
  }
  if (args.prompt != null) return JSON.stringify(args.prompt);
  return "";
}
function selectTurn(vector, used, ctx) {
  for (let i = 0; i < vector.turns.length; i++) {
    if (used.has(i)) continue;
    const turn = vector.turns[i];
    const w = turn.when;
    if (!w || Object.keys(w).length === 0) continue;
    if (w.callIndex !== void 0 && w.callIndex !== ctx.callIndex) continue;
    if (w.attempt !== void 0 && w.attempt !== ctx.attempt) continue;
    if (w.iteration !== void 0 && w.iteration !== ctx.iteration) continue;
    if (w.promptIncludes !== void 0 && !ctx.promptText.includes(w.promptIncludes)) continue;
    return { index: i, turn };
  }
  for (let i = 0; i < vector.turns.length; i++) {
    if (used.has(i)) continue;
    const turn = vector.turns[i];
    if (turn.when && Object.keys(turn.when).length > 0) continue;
    return { index: i, turn };
  }
  throw new Error(
    `Agent trace vector "${vector.id}": no matching unused turn for callIndex=${ctx.callIndex}` + (ctx.attempt !== void 0 ? ` attempt=${ctx.attempt}` : "") + (ctx.iteration !== void 0 ? ` iteration=${ctx.iteration}` : "") + (ctx.promptText ? ` promptExcerpt=${JSON.stringify(ctx.promptText.slice(0, 80))}` : "")
  );
}
export {
  AGENT_TRACE_VECTOR_VERSION,
  flattenGeneratePrompt,
  loadAgentTraceVector,
  parseAgentTraceVector,
  selectTurn
};
