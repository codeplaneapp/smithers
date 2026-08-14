/**
 * Decoders for the gateway's public run-event vocabulary (`task.output`,
 * `agent.trace`, `agent.session`, `agent.event`, `node.*`, `run.*`). Pure and
 * framework-free so workflow UIs, gateway-ui, and plain scripts can all share
 * one implementation.
 */
import type { GatewayEventFrame } from "@smthrs/gateway-client";
import { asArray, asString, isRecord } from "./rows.ts";

/** A run-event frame; collection rows may also carry `timestampMs`. */
export type RunEventFrame = GatewayEventFrame & { timestampMs?: number };

/**
 * Run-event frames can be double-wrapped: the real domain event + data live at
 * `frame.payload.event` / `frame.payload.payload`. The gateway's mapEvent
 * remaps engine events to a PUBLIC dotted vocabulary before streaming — e.g.
 * NodeOutput → `task.output` (text under `payload.output`), AgentTraceEvent →
 * `agent.trace` (text under `payload.trace.payload.text`), node.started /
 * finished / failed, run.completed / failed / cancelled, approval.*. The unwrap
 * only triggers when the outer payload has a string `event` field, so a flat
 * payload like `{ nodeId, output }` passes through untouched.
 */
function frameEnvelope(frame: RunEventFrame): { event: string; payload: Record<string, unknown> } | null {
  const outerPayload = isRecord(frame.payload) ? frame.payload : {};
  const wrappedEvent = typeof outerPayload.event === "string" ? outerPayload.event : asString(outerPayload.type);
  if (wrappedEvent) {
    return {
      event: wrappedEvent,
      payload: isRecord(outerPayload.payload) ? outerPayload.payload : outerPayload,
    };
  }
  const event = typeof frame.event === "string" ? frame.event : "";
  if (!event) return null;
  return { event, payload: outerPayload };
}

function finiteSeq(value: unknown): number {
  const seq = Number(value ?? 0);
  return Number.isFinite(seq) ? seq : 0;
}

/** One raw chat line for the live feed (single best-effort line per frame). */
export function chatLineFromFrame(frame: RunEventFrame): { who: string; text: string } | null {
  const env = frameEnvelope(frame);
  if (!env) return null;
  const { event, payload } = env;
  if (event === "task.output") {
    const text = asString(payload.output);
    if (text.trim()) return { who: asString(payload.nodeId) || "node", text };
  }
  if (event === "agent.trace" || event === "AgentTraceEvent") {
    const trace = isRecord(payload.trace) ? payload.trace : undefined;
    const tracePayload = trace && isRecord(trace.payload) ? trace.payload : undefined;
    const text = tracePayload ? asString(tracePayload.text) : "";
    if (text.trim()) return { who: asString(payload.nodeId) || "agent", text };
  }
  if (event === "AgentEvent" || event === "agent.event") {
    const agentEvent = isRecord(payload.event) ? payload.event : undefined;
    const text = agentEvent ? asString(agentEvent.message) : "";
    if (text.trim()) return { who: asString(payload.nodeId) || asString(payload.engine) || "agent", text };
  }
  if (event === "NodeOutput" || event === "TaskOutput") {
    const text = asString(payload.output ?? payload.text);
    if (text.trim()) return { who: asString(payload.nodeId) || "node", text };
  }
  return null;
}

/**
 * A single rendered conversation line. `kind` distinguishes a real chat message
 * (assistant/user/system/tool transcript turn or streaming assistant text) from
 * raw node `output` text and tool-activity lines.
 */
export type ChatLine = { who: string; role?: string; text: string; kind: "message" | "tool" | "output" };

// agent.event `event.type` values that carry conversational assistant text.
const TEXT_EVENT_TYPES = new Set(["text", "message", "assistant_message", "output_text", "reasoning"]);

/**
 * Flatten one transcript-message `content` (a string OR an array of blocks like
 * `{type:"text",text}` / tool_use / tool_result / reasoning) into display text:
 * concatenate text/reasoning blocks, summarize tool-use blocks, drop tool results.
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  const parts: string[] = [];
  for (const block of asArray(content)) {
    if (!isRecord(block)) {
      const raw = asString(block);
      if (raw.trim()) parts.push(raw);
      continue;
    }
    const type = asString(block.type);
    if (type === "text" || type === "output_text" || type === "reasoning" || type === "thinking") {
      const text = asString(block.text) || asString(block.thinking);
      if (text.trim()) parts.push(text);
    } else if (type === "tool_use" || type === "tool-use" || type === "tool_call") {
      parts.push(`↗ ${asString(block.name) || "tool"}`);
    } else if (type === "tool_result" || type === "tool-result") {
      // Tool results are noisy/long; the live log already surfaces tool activity.
    } else {
      const text = asString(block.text);
      if (text.trim()) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Conversational view of a frame: ZERO-OR-MORE chat lines. Unlike
 * {@link chatLineFromFrame} (one raw line, used by the live feed), this expands
 * an `agent.session` transcript into one line per message and ignores tool /
 * command activity so the chat panel reads like the agent's actual conversation.
 */
export function chatLinesFromFrame(frame: RunEventFrame): ChatLine[] {
  const env = frameEnvelope(frame);
  if (!env) return [];
  const { event, payload } = env;
  const lines: ChatLine[] = [];

  if (event === "agent.session" || event === "AgentSessionEvent") {
    for (const message of asArray(payload.transcript)) {
      if (!isRecord(message)) continue;
      const role = asString(message.role);
      const text = contentToText(message.content);
      if (!text) continue;
      lines.push({ who: role || "agent", role: role || undefined, text, kind: "message" });
    }
    return lines;
  }

  if (event === "agent.event" || event === "AgentEvent") {
    const agentEvent = isRecord(payload.event) ? payload.event : undefined;
    if (!agentEvent) return lines;
    const type = asString(agentEvent.type);
    const who = asString(payload.engine) || asString(agentEvent.engine) || asString(payload.nodeId) || "agent";
    const action = isRecord(agentEvent.action) ? agentEvent.action : undefined;
    const kind = action ? asString(action.kind) : "";
    const detailType = action && isRecord(action.detail) ? asString(action.detail.type) : "";
    const title = action ? asString(action.title) : "";
    const entryType = asString(agentEvent.entryType);

    // CLI agents (codex/claude-code) wrap everything in an `action` envelope
    // where the conversational text lives in `.message`, the real category in
    // `action.kind` / `entryType` / `action.detail.type`. The assistant's words
    // arrive as an `agent_message` (entryType "message"); command/tool/turn /
    // warning activity stays in the live log so the chat reads like a real
    // conversation.
    if (type === "action") {
      const message = asString(agentEvent.message);
      const isAssistantMessage = detailType === "agent_message" || title === "assistant" || entryType === "message";
      if (isAssistantMessage && message.trim()) {
        lines.push({ who, role: "assistant", text: message, kind: "message" });
      } else if (kind === "reasoning" && message.trim()) {
        lines.push({ who, role: "reasoning", text: message, kind: "message" });
      }
      return lines;
    }

    // A CLI turn's final answer ({ type: "completed", answer }). De-dup in
    // buildChatLines drops it when an identical agent_message already rendered.
    if (type === "completed") {
      const answer = asString(agentEvent.answer) || asString(agentEvent.message);
      if (answer.trim()) lines.push({ who, role: "assistant", text: answer, kind: "message" });
      return lines;
    }

    // Other engines: discrete conversational text/reasoning events.
    const text = asString(agentEvent.text) || asString(agentEvent.message) || asString(agentEvent.delta);
    if ((TEXT_EVENT_TYPES.has(type) || (!type && text.trim())) && text.trim()) {
      lines.push({ who, role: type === "reasoning" ? "reasoning" : "assistant", text, kind: "message" });
    }
    return lines;
  }

  if (event === "task.output" || event === "NodeOutput" || event === "TaskOutput") {
    const text = asString(payload.output ?? payload.text);
    if (text.trim()) lines.push({ who: asString(payload.nodeId) || "node", text, kind: "output" });
    return lines;
  }

  if (event === "agent.trace" || event === "AgentTraceEvent") {
    const trace = isRecord(payload.trace) ? payload.trace : undefined;
    const tracePayload = trace && isRecord(trace.payload) ? trace.payload : undefined;
    const text = tracePayload ? asString(tracePayload.text) : "";
    if (text.trim()) lines.push({ who: asString(payload.nodeId) || "agent", role: "assistant", text, kind: "message" });
    return lines;
  }

  return lines;
}

function normalizeChatText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function sourceKeyFromPayload(payload: Record<string, unknown>, fallback: string): string {
  const sessionRecord = isRecord(payload.session) ? payload.session : {};
  const node = asString(payload.nodeId ?? payload.node_id ?? payload.node ?? payload.taskId ?? payload.task_id);
  const session = asString(payload.sessionId ?? payload.session_id ?? sessionRecord.id ?? payload.id);
  const engine = asString(payload.engine);
  return [node, session, engine].filter(Boolean).join(":") || fallback;
}

function chatSourceKey(frame: RunEventFrame, fallbackPrefix: string): string {
  const env = frameEnvelope(frame);
  if (!env) return `${fallbackPrefix}:unknown`;
  return `${fallbackPrefix}:${sourceKeyFromPayload(env.payload, "global")}`;
}

/**
 * Build a clean, de-duplicated conversation from a run's event frames.
 *
 * `agent.session` events fire repeatedly, each carrying that node/session's
 * cumulative transcript, and a run can host several sessions (audit, work,
 * review, ...), so de-dupe per node/session instead of picking one global best
 * transcript. Non-session lines (streaming fragments, completed answers) are
 * dropped when their text already appears in the matching session transcript.
 */
export function buildChatLines(frames: RunEventFrame[]): ChatLine[] {
  const sessionEventOf = (frame: RunEventFrame): string => {
    return frameEnvelope(frame)?.event ?? "";
  };
  const isSession = (frame: RunEventFrame): boolean => {
    const event = sessionEventOf(frame);
    return event === "agent.session" || event === "AgentSessionEvent";
  };

  const sessions = new Map<string, { firstSeq: number; seq: number; lines: ChatLine[] }>();
  for (const frame of frames) {
    if (!isSession(frame)) continue;
    const candidate = chatLinesFromFrame(frame);
    const seq = finiteSeq(frame.seq);
    const key = chatSourceKey(frame, "session");
    const best = sessions.get(key);
    if (!best || candidate.length > best.lines.length || (candidate.length === best.lines.length && seq > best.seq)) {
      sessions.set(key, { firstSeq: best ? Math.min(best.firstSeq, seq) : seq, seq, lines: candidate });
    } else if (seq < best.firstSeq) {
      sessions.set(key, { ...best, firstSeq: seq });
    }
  }

  const result: ChatLine[] = [];
  const seenBySource = new Map<string, Set<string>>();
  const sessionBlobBySource = new Map<string, string>();
  const allSessionBlobs: string[] = [];
  for (const [source, session] of [...sessions.entries()].sort((left, right) => left[1].firstSeq - right[1].firstSeq)) {
    const seen = seenBySource.get(source) ?? new Set<string>();
    seenBySource.set(source, seen);
    const sessionParts: string[] = [];
    for (const line of session.lines) {
      const key = normalizeChatText(line.text);
      if (!key || seen.has(key)) continue;
      result.push(line);
      seen.add(key);
      sessionParts.push(key);
    }
    const blob = sessionParts.join("\n");
    sessionBlobBySource.set(source, blob);
    if (blob) allSessionBlobs.push(blob);
  }
  for (const frame of frames) {
    if (isSession(frame)) continue;
    const source = chatSourceKey(frame, "session");
    const seen = seenBySource.get(source) ?? new Set<string>();
    seenBySource.set(source, seen);
    const sourceBlob = sessionBlobBySource.get(source) ?? "";
    for (const line of chatLinesFromFrame(frame)) {
      const key = normalizeChatText(line.text);
      if (!key || seen.has(key)) continue;
      if (sourceBlob && sourceBlob.includes(key)) continue; // streaming fragment already in this transcript
      if (!sourceBlob && allSessionBlobs.some((blob) => blob.includes(key))) continue;
      seen.add(key);
      result.push(line);
    }
  }
  return result;
}

// --- live-log line -----------------------------------------------------------

function normalizeStatus(status: string | undefined): string {
  return asString(status).trim().toLowerCase().replaceAll("_", "-");
}

function formatStatus(status: string | undefined): string {
  const normalized = normalizeStatus(status);
  if (!normalized) return "";
  const labels: Record<string, string> = {
    ok: "Complete",
    success: "Complete",
    fixed: "Fixed",
    ready: "Ready",
    done: "Done",
    finished: "Finished",
    running: "Running",
    pending: "Pending",
    queued: "Queued",
    waiting: "Waiting",
    "waiting-approval": "Waiting for approval",
    "waiting-event": "Waiting for event",
    "waiting-timer": "Waiting on timer",
    partial: "Partial",
    "missing-tests": "Missing e2e",
    missing: "Missing",
    broken: "Broken",
    blocked: "Blocked",
    failed: "Failed",
    error: "Error",
    cancelled: "Cancelled",
    canceled: "Cancelled",
    skipped: "Skipped",
    todo: "Todo",
    open: "Open",
    closed: "Closed",
  };
  return (
    labels[normalized] ??
    normalized
      .split("-")
      .map((part) => (part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part))
      .join(" ")
  );
}

function statusClass(status: string | undefined): string {
  const normalized = normalizeStatus(status);
  if (["fixed", "ready", "done", "finished", "success", "ok", "complete", "completed", "closed"].includes(normalized))
    return "ok";
  if (["broken", "blocked", "failed", "failure", "error"].includes(normalized)) return "bad";
  if (
    [
      "partial",
      "missing-tests",
      "missing",
      "running",
      "pending",
      "queued",
      "waiting",
      "cancelled",
      "canceled",
      "todo",
      "open",
    ].includes(normalized) ||
    normalized.startsWith("waiting-")
  )
    return "warn";
  return "muted";
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  } catch {
    return String(Math.trunc(value));
  }
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  const label = Math.abs(count) === 1 ? singular : plural;
  return `${formatNumber(count)} ${label}`;
}

function formatDuration(ms: unknown): string {
  const value = Number(ms ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder ? `${minutes} min ${remainder} s` : `${minutes} min`;
}

function shortText(value: string, limit = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function parseStructuredText(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function summarizeStructured(value: unknown): string {
  if (Array.isArray(value)) return formatCount(value.length, "item");
  if (!isRecord(value)) return shortText(asString(value));

  const row = isRecord(value.row) ? value.row : value;
  const parts: string[] = [];
  const status = asString(row.status);
  const summary = asString(row.summary) || asString(row.message) || asString(row.title);
  if (status) parts.push(formatStatus(status));
  if (summary && summary !== status) parts.push(shortText(summary, 140));

  const countFields: Array<[string, string, string]> = [
    ["selected", "slot", "slots"],
    ["tickets", "ticket", "tickets"],
    ["ticketPaths", "ticket", "tickets"],
    ["featuresUpdated", "feature", "features"],
    ["findings", "finding", "findings"],
    ["confirmed", "confirmed", "confirmed"],
    ["rejected", "rejected", "rejected"],
    ["changedFiles", "file", "files"],
    ["files", "file", "files"],
  ];
  for (const [key, singular, plural] of countFields) {
    const count = asArray(row[key]).length;
    if (count > 0) parts.push(formatCount(count, singular, plural));
  }

  if (typeof row.buildPassed === "boolean") parts.push(row.buildPassed ? "build passed" : "build failed");
  if (typeof row.docsBuildPassed === "boolean")
    parts.push(row.docsBuildPassed ? "docs build passed" : "docs build failed");
  const duration = formatDuration(row.durationMs ?? row.elapsedMs ?? row.elapsed_ms);
  if (duration) parts.push(duration);

  if (parts.length > 0) return parts.join(" · ");
  return formatCount(Object.keys(row).length, "field");
}

function summarizeEventValue(value: unknown): string {
  if (typeof value === "string") {
    const structured = parseStructuredText(value);
    return structured === null ? shortText(value) : summarizeStructured(structured);
  }
  if (isRecord(value) || Array.isArray(value)) return summarizeStructured(value);
  return shortText(asString(value));
}

/** Event tone for the live feed: failures read red, waits/retries amber. */
function logToneFor(event: string, status: string): "ok" | "warn" | "bad" | "" {
  const verb = event.split(".").at(-1) ?? "";
  if (/fail|error|reject|crash|abort/i.test(verb)) return "bad";
  const statusTone = status ? statusClass(status) : "";
  if (statusTone === "bad") return "bad";
  if (/retry|retrying|timeout|stall|degrad/i.test(verb)) return "warn";
  if (/complete|finish|success|done|resolved/i.test(verb) || statusTone === "ok") return "ok";
  if (statusTone === "warn") return "warn";
  return "";
}

/** One toned line of the live log for any run event. */
export type LogLine = { seq: number; event: string; node: string; detail: string; tone: "ok" | "warn" | "bad" | "" };

/**
 * Generic one-line view of any run event for the live log (the `smithers up
 * --interactive` style feed). Renders every public event, not just agent text;
 * heartbeats and unidentifiable frames return null.
 */
export function logLineFromFrame(frame: RunEventFrame): LogLine | null {
  const env = frameEnvelope(frame);
  if (!env) return null;
  const { event, payload } = env;
  if (!event || event === "run.heartbeat" || event === "task.heartbeat") return null;
  const node = asString(payload.nodeId ?? payload.node ?? payload.id);
  const trace = isRecord(payload.trace) ? payload.trace : undefined;
  const tracePayload = trace && isRecord(trace.payload) ? trace.payload : undefined;
  const agentEvent = isRecord(payload.event) ? payload.event : undefined;
  let detail = "";

  if (event === "task.output" || event === "NodeOutput" || event === "TaskOutput") {
    detail = summarizeEventValue(payload.output ?? payload.text);
  } else if (event === "agent.session" || event === "AgentSessionEvent") {
    detail = formatCount(asArray(payload.transcript).length, "message");
  } else if (event === "agent.event" || event === "AgentEvent") {
    const type = agentEvent ? asString(agentEvent.type) : "";
    const action = agentEvent && isRecord(agentEvent.action) ? agentEvent.action : undefined;
    const actionKind = action ? asString(action.kind) || asString(action.title) : "";
    if (type === "completed")
      detail = `Completed${asString(agentEvent?.answer) ? `: ${shortText(asString(agentEvent?.answer), 160)}` : ""}`;
    else if (type === "action")
      detail = [formatStatus(actionKind) || "Action", shortText(asString(agentEvent?.message), 160)]
        .filter(Boolean)
        .join(": ");
    else
      detail = [
        formatStatus(type),
        shortText(asString(agentEvent?.message ?? agentEvent?.text ?? agentEvent?.delta), 160),
      ]
        .filter(Boolean)
        .join(": ");
  } else if (event === "agent.trace" || event === "AgentTraceEvent") {
    detail = shortText(tracePayload ? asString(tracePayload.text) : "");
  } else if (event.startsWith("node.")) {
    const verb = event.split(".").at(-1) ?? "event";
    const duration = formatDuration(payload.durationMs ?? payload.elapsedMs ?? payload.elapsed_ms);
    detail = [
      formatStatus(verb),
      formatStatus(asString(payload.status)),
      duration,
      shortText(asString(payload.message), 120),
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (event.startsWith("run.")) {
    const verb = event.split(".").at(-1) ?? "event";
    const duration = formatDuration(payload.durationMs ?? payload.elapsedMs ?? payload.elapsed_ms);
    detail = [
      formatStatus(asString(payload.status)) || formatStatus(verb),
      duration,
      shortText(asString(payload.message), 120),
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (payload.output !== undefined || payload.text !== undefined) {
    detail = summarizeEventValue(payload.output ?? payload.text);
  } else {
    detail =
      [formatStatus(asString(payload.status)), shortText(asString(payload.message), 180)].filter(Boolean).join(" · ") ||
      summarizeStructured(payload);
  }

  const tone = logToneFor(event, asString(payload.status));
  return { seq: finiteSeq(frame.seq), event, node, detail: shortText(detail, 260), tone };
}
