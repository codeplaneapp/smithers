import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { Cause, Effect, Exit, Metric } from "effect";
import { toSmithersError } from "@smthrs/errors/toSmithersError";
import { logDebug, logInfo, logWarning } from "@smthrs/observability/logging";
import {
  agentDurationMs,
  agentErrorsTotal,
  agentInvocationsTotal,
  agentRetriesTotal,
  agentTokensTotal,
} from "@smthrs/observability/metrics";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { nextWallClockInZone } from "./nextWallClockInZone.js";
import { launchDiagnostics, enrichReportWithErrorAnalysis, formatDiagnosticSummary } from "../diagnostics/index.js";
import { extractPrompt } from "./extractPrompt.js";
import { resolveTimeouts } from "./resolveTimeouts.js";
import { combineNonEmpty } from "./combineNonEmpty.js";
import { tryParseJson } from "./tryParseJson.js";
import { extractTextFromJsonValue } from "./extractTextFromJsonValue.js";
import { createAgentStdoutTextEmitter } from "./createAgentStdoutTextEmitter.js";
import { buildGenerateResult } from "./buildGenerateResult.js";
import { runCommandEffect } from "./runCommandEffect.js";
import { sanitizeCliArgs } from "./sanitizeCliArgs.js";
import { taskContextEnv } from "./taskContextEnv.js";
import { assertKnownCliAgentOptions } from "./agentOptionKeys.js";
import { runAgentLikeHarness } from "../harness-adapter.js";

const QUOTA_PATTERNS = [
  /\bhit\s+your\s+(usage|session|weekly|daily|monthly|rate)\s+limit\b/i,
  /\busage\s+limit\s+exceeded\b/i,
  /\bquota\s+exceeded\b/i,
  /\brate\s+limit\s+exceeded\b/i,
  /\byou('ve| have)\s+reached\s+(your\s+)?(usage|rate|quota|session|weekly|daily|monthly)\s+(limit|exceeded|cap|ceiling)\b/i,
  /\b(usage|quota|rate|session|weekly|daily|monthly)\s+(cap|ceiling|limit)\s+(reached|exceeded|hit)\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\b(429|rate.limit)\b[\s\S]{0,100}?try\s+again\b/i,
  // Claude/Fable subscription banners (arrive on stdout, exit 0).
  /\bout\s+of\s+usage\s+credits\b/i,
  /\brun\s+\/usage-credits\b/i,
  // Machine tokens: claude-code stream-json rate_limit_event lines and API
  // payloads carry underscored identifiers (e.g. "overageDisabledReason":
  // "out_of_credits", codex 429 bodies with "usage_limit_reached") that the
  // prose patterns above never match.
  /\bout_of_credits\b/i,
  /\busage_limit_reached\b/i,
  // Require the request's own status to be rejected. A bare "rejected" match
  // false-positives on {"status":"allowed","overageStatus":"rejected"} lines
  // that healthy streams emit when the org has overage disabled; the
  // out_of_credits / usage_limit_reached tokens above still catch shapes
  // without a status field.
  /"rate_limit_event"[\s\S]{0,300}?"status"\s*:\s*"rejected"/i,
];

/**
 * Detects provider quota/rate-limit errors and returns a SmithersError with
 * AGENT_QUOTA_EXCEEDED code. The reset time is parsed when present.
 *
 * @param {string} message
 * @param {string} command
 * @param {{ agentId?: string; agentModel?: string; agentEngine?: string; nowMs?: () => number }} [context]
 * @returns {SmithersError | null}
 */
export function classifyQuotaError(message, command, context = {}) {
  if (!message) return null;
  const isQuota = QUOTA_PATTERNS.some((re) => re.test(message));
  if (!isQuota) return null;
  const { agentId, agentModel, agentEngine, nowMs = () => Date.now() } = context;
  const now = nowMs();
  let quotaResetAtMs;
  let resetHint;
  // Format: "try again at Jun 18th, 2026 9:54 AM" — strip ordinal suffix before parsing
  const dateMatch = /try again at\s+([A-Z][a-z]+ \d+(?:st|nd|rd|th)?,?\s+\d{4}\s+\d+:\d+\s+(?:AM|PM))/i.exec(message);
  // Format: "resets 1:30am (America/New_York)" or "reset at 4pm
  // (Asia/Kolkata)" — next occurrence of that wall-clock time in the named
  // zone (Claude/Fable session-limit banner). Accepts singular "reset",
  // optional "at", and an optional ":mm".
  const clockMatch = /\breset(?:s)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(message);
  if (dateMatch) {
    const normalized = dateMatch[1].replace(/(\d+)(st|nd|rd|th)\b/gi, "$1");
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed) && parsed > now) {
      quotaResetAtMs = parsed;
    }
    resetHint = dateMatch[0];
  } else if (clockMatch) {
    const meridiem = clockMatch[3].toLowerCase();
    const hour = (Number(clockMatch[1]) % 12) + (meridiem === "pm" ? 12 : 0);
    const minute = clockMatch[2] ? Number(clockMatch[2]) : 0;
    const parsed = nextWallClockInZone({ hour, minute, timeZone: clockMatch[4].trim(), fromMs: now });
    if (parsed != null && parsed > now) {
      quotaResetAtMs = parsed;
    }
    resetHint = clockMatch[0];
  } else {
    // Format: "retry after N seconds"
    const secondsMatch = /retry after\s+(\d+)\s+second/i.exec(message);
    if (secondsMatch) {
      const deltaMs = Number(secondsMatch[1]) * 1000;
      if (deltaMs > 0) {
        quotaResetAtMs = now + deltaMs;
      }
      resetHint = secondsMatch[0];
    }
  }
  const modelLabel = agentModel ?? "<unset>";
  const idLabel = agentId ?? "<anonymous>";
  const summary = `Agent "${idLabel}" (${command}, model=${modelLabel}) hit a provider usage/quota limit: ${message.slice(0, 300)}.${resetHint ? ` ${resetHint}.` : ""} Retries are preserved; the run will pause until the quota resets.`;
  return new SmithersError("AGENT_QUOTA_EXCEEDED", summary, {
    failureQuota: true,
    agentId: idLabel,
    agentEngine: agentEngine ?? "unknown",
    agentModel: modelLabel,
    command,
    underlying: message.slice(0, 500),
    ...(quotaResetAtMs != null ? { quotaResetAtMs } : {}),
  });
}

// Config/auth errors where retrying cannot help — fail fast with a fix hint.
const NON_RETRYABLE_AGENT_ERROR_PATTERNS = [
  { re: /\bLLM not set\b/i, hint: "the agent's model name is not present in the CLI's configured providers" },
  { re: /\bLLM not supported\b/i, hint: "the agent's model is not supported by this CLI build" },
  { re: /\bmodel\s+['"]?[^'"\s]+['"]?\s+not found\b/i, hint: "the requested model is not registered with the CLI" },
  { re: /\bunknown model\b/i, hint: "the requested model is not registered with the CLI" },
  {
    re: /\b401\b[\s\S]{0,200}?(invalid[_\s-]?authentication|unauthorized|invalid[_\s-]?api[_\s-]?key)/i,
    hint: `the CLI's stored credentials are invalid or expired — re-authenticate (e.g. for kimi run \`kimi login\`)`,
  },
  {
    re: /\bAPI\s*Key\b[\s\S]{0,120}?(invalid|expired|may have expired)/i,
    hint: `the CLI's stored credentials are invalid or expired — re-authenticate (e.g. for kimi run \`kimi login\`)`,
  },
  {
    re: /\b(access|auth(entication)?|oauth|bearer)\s+token\b[\s\S]{0,80}?(expired|invalid|revoked)/i,
    hint: `the CLI's auth token is no longer valid — re-authenticate (e.g. for kimi run \`kimi login\`)`,
  },
  {
    re: /\binvalid[_\s-]?authentication[_\s-]?error\b/i,
    hint: `the CLI's stored credentials are invalid — re-authenticate (e.g. for kimi run \`kimi login\`)`,
  },
];

/**
 * Detects non-retryable configuration/auth errors and returns a SmithersError
 * with AGENT_CONFIG_INVALID code so the engine fails fast instead of retrying.
 *
 * @param {string} message
 * @param {string} command
 * @param {{ agentId?: string; agentModel?: string; agentEngine?: string }} [context]
 * @returns {SmithersError | null}
 */
function classifyNonRetryableAgentError(message, command, context = {}) {
  if (!message) return null;
  const { agentId, agentModel, agentEngine } = context;
  for (const { re, hint } of NON_RETRYABLE_AGENT_ERROR_PATTERNS) {
    if (re.test(message)) {
      const modelLabel = agentModel ?? "<unset>";
      const idLabel = agentId ?? "<anonymous>";
      const summary = `Agent "${idLabel}" (${command}, model=${modelLabel}) failed with non-retryable configuration error: ${message.slice(0, 300)}. Hint: ${hint}. Fix the agent's model in .smithers/agents.ts (or the CLI's config) — retrying will not help.`;
      return new SmithersError("AGENT_CONFIG_INVALID", summary, {
        failureRetryable: false,
        agentId: idLabel,
        agentEngine,
        agentModel: modelLabel,
        command,
        underlying: message.slice(0, 500),
      });
    }
  }
  return null;
}

/**
 * Detect CLI session-loss: the persisted resume/session id points at a
 * conversation that no longer exists, so every retry that reuses it fails
 * deterministically (and instantly) with the same error. Return a typed
 * error whose `discardResumeSession: true` tells the engine retry path to
 * DROP the dead id and mint a fresh conversation on the next attempt —
 * without it a one-time timeout dead-loops through every retry AND every
 * `--resume` of the whole run (issue-swarm run-1784095071179, 2026-07-15).
 *
 * - kimi: crashes mid-stream printing `To resume this session: kimi -r <uuid>`;
 *   re-running `--session <same-uuid>` reproduces the crash.
 * - claude: `--resume <id>` of a killed/relocated conversation prints
 *   `No conversation found with session ID: <id>` (isolated jj worktrees can
 *   relocate the cwd its conversation store is keyed by).
 * - codex: when the response stream drops before the rollout is recorded, the
 *   thread id was captured but never persisted, so `exec resume <id>` fails
 *   `thread/resume failed: no rollout found for thread id <id> (code -32600)`.
 *   The disconnect is transient; without discarding the id the retry resumes
 *   the same non-existent thread and the run burns its whole attempt budget
 *   before failing over.
 * - grok: a deleted or relocated session reports `Session does not exist` (or
 *   the title-resolution equivalent) when `--resume` is reused.
 *
 * `hadResumeSession` says whether THIS invocation actually resumed a prior
 * session. When it did not — the session that broke was already freshly
 * minted — "retry will start a fresh session" is a false promise: the CLI is
 * failing to establish sessions at all, and only failing over to another
 * agent can help. The error still carries `discardResumeSession: true` (the
 * heartbeat may have captured the broken id as agentResume) plus
 * `freshSessionFailure: true` and an honest message (issue #1480).
 */
export function classifySessionLoss(command, errorText, rawStderr, hadResumeSession = true) {
  const kimiMatch =
    command === "kimi"
      ? rawStderr.match(/kimi -r ([0-9a-f-]{8,})/i) || errorText.match(/kimi -r ([0-9a-f-]{8,})/i)
      : null;
  if (kimiMatch) {
    return new SmithersError(
      "AGENT_SESSION_LOST",
      hadResumeSession
        ? `Kimi session ${kimiMatch[1]} is broken. Retry will start a fresh session.`
        : `Kimi session ${kimiMatch[1]} is broken even though this attempt started a FRESH session — the kimi CLI is failing to establish sessions; retrying it will not help. Failing over to the next agent in the chain (if any).`,
      {
        failureRetryable: true,
        discardResumeSession: true,
        freshSessionFailure: !hadResumeSession,
        command: "kimi",
        kimiSessionId: kimiMatch[1],
      },
    );
  }
  const codexMatch =
    command === "codex"
      ? errorText.match(/no rollout found for thread id\s+([0-9a-z-]{8,})/i) ||
        rawStderr.match(/no rollout found for thread id\s+([0-9a-z-]{8,})/i)
      : null;
  if (codexMatch) {
    return new SmithersError(
      "AGENT_SESSION_LOST",
      hadResumeSession
        ? `Codex thread ${codexMatch[1]} has no recorded rollout; the persisted resume id is dead. Retry will start a fresh session.`
        : `Codex thread ${codexMatch[1]} has no recorded rollout even though this attempt started a FRESH session — the codex CLI is failing to record rollouts; retrying it will not help. Failing over to the next agent in the chain (if any).`,
      {
        failureRetryable: true,
        discardResumeSession: true,
        freshSessionFailure: !hadResumeSession,
        command: "codex",
        codexThreadId: codexMatch[1],
      },
    );
  }
  const claudeMatch =
    command === "claude"
      ? errorText.match(/No conversation found with session ID:?\s*([0-9a-f-]{8,})?/i) ||
        rawStderr.match(/No conversation found with session ID:?\s*([0-9a-f-]{8,})?/i)
      : null;
  if (claudeMatch) {
    const lostId = claudeMatch[1] ? ` ${claudeMatch[1]}` : "";
    return new SmithersError(
      "AGENT_SESSION_LOST",
      hadResumeSession
        ? `Claude conversation${lostId} no longer exists; the persisted resume id is dead. Retry will start a fresh session.`
        : `Claude conversation${lostId} was not found even though this attempt started a FRESH session — the claude CLI is failing to establish sessions on this account; retrying it will not help. Failing over to the next agent in the chain (if any).`,
      {
        failureRetryable: true,
        discardResumeSession: true,
        freshSessionFailure: !hadResumeSession,
        command: "claude",
      },
    );
  }
  const grokMatch =
    command === "grok"
      ? errorText.match(/Session does not exist|no session id or title matched/i) ||
        rawStderr.match(/Session does not exist|no session id or title matched/i)
      : null;
  if (grokMatch) {
    return new SmithersError(
      "AGENT_SESSION_LOST",
      hadResumeSession
        ? "Grok session no longer exists; the persisted resume id is dead. Retry will start a fresh session."
        : "Grok session was not found even though this attempt started a FRESH session — the grok CLI is failing to establish sessions; retrying it will not help. Failing over to the next agent in the chain (if any).",
      {
        failureRetryable: true,
        discardResumeSession: true,
        freshSessionFailure: !hadResumeSession,
        command: "grok",
      },
    );
  }
  return null;
}

/**
 * @param {string} stderr
 * @param {ReadonlyArray<RegExp>} [extraPatterns]
 * @returns {string}
 */
function filterBenignStderr(stderr, extraPatterns) {
  const benignPatterns = [
    /^.*state db missing rollout path.*$/gm,
    /^.*codex_core::rollout::list.*$/gm,
    /^.*failed to record rollout items: failed to queue rollout items: channel closed.*$/gim,
    /^.*Failed to shutdown rollout recorder.*$/gm,
    /^.*failed to renew cache TTL: Operation not permitted.*$/gim,
  ];
  let filtered = stderr;
  for (const pattern of benignPatterns) {
    filtered = filtered.replace(pattern, "");
  }
  if (extraPatterns?.length) {
    for (const pattern of extraPatterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      filtered = filtered.replace(regex, "");
    }
  }
  // Clean up extra blank lines
  return filtered.replace(/\n{3,}/g, "\n\n").trim();
}
/** @typedef {import("./AgentCliEvent.ts").AgentCliEvent} AgentCliEvent */

/** @typedef {import("./AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */
/** @typedef {import("./BaseCliAgentOptions.ts").BaseCliAgentOptions} BaseCliAgentOptions */
/** @typedef {import("./CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./CliUsageInfo.ts").CliUsageInfo} CliUsageInfo */
/** @typedef {import("../GenerateResult.ts").GenerateTextResult} GenerateTextResult */
/** @typedef {import("../GenerateResult.ts").StreamTextResult} StreamTextResult */
/** @typedef {import("../GenerateResult.ts").LanguageModelUsage} LanguageModelUsage */
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
export async function runAgentPromise(effect) {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag === "Some") {
    throw failure.value;
  }
  throw Cause.squash(exit.cause);
}
/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeMetricTag(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
/**
 * @template A
 * @param {A} metric
 * @param {Record<string, string | undefined>} tags
 * @returns {A}
 */
function taggedMetric(metric, tags) {
  let tagged = metric;
  for (const [key, value] of Object.entries(tags)) {
    if (!value) continue;
    tagged = Metric.withAttributes(tagged, { [key]: String(value) });
  }
  return tagged;
}
/**
 * @param {BaseCliAgent} agent
 * @param {string} [fallbackCommand]
 * @returns {string}
 */
function resolveAgentEngineTag(agent, fallbackCommand) {
  return (
    normalizeMetricTag(agent.cliEngine) ??
    normalizeMetricTag(agent.model) ??
    normalizeMetricTag(fallbackCommand) ??
    normalizeMetricTag(agent.constructor?.name) ??
    "unknown"
  );
}
/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function asFiniteTokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
/**
 * @param {unknown} usage
 * @returns {AgentTokenTotals}
 */
function extractAgentTokenTotals(usage) {
  if (!usage || typeof usage !== "object") {
    return {};
  }
  const u = /** @type {Record<string, unknown>} */ (usage);
  const inputDetails = /** @type {Record<string, unknown> | undefined} */ (
    u.inputTokenDetails && typeof u.inputTokenDetails === "object" ? u.inputTokenDetails : undefined
  );
  const outputDetails = /** @type {Record<string, unknown> | undefined} */ (
    u.outputTokenDetails && typeof u.outputTokenDetails === "object" ? u.outputTokenDetails : undefined
  );
  const inputTokens =
    asFiniteTokenCount(u.inputTokens) ?? asFiniteTokenCount(u.input_tokens) ?? asFiniteTokenCount(u.prompt_tokens);
  const outputTokens =
    asFiniteTokenCount(u.outputTokens) ??
    asFiniteTokenCount(u.output_tokens) ??
    asFiniteTokenCount(u.completion_tokens);
  const cacheReadTokens =
    asFiniteTokenCount(u.cacheReadTokens) ??
    asFiniteTokenCount(u.cached_input_tokens) ??
    asFiniteTokenCount(u.cache_read_input_tokens) ??
    asFiniteTokenCount(inputDetails?.cacheReadTokens);
  const cacheWriteTokens =
    asFiniteTokenCount(u.cacheWriteTokens) ??
    asFiniteTokenCount(u.cache_creation_input_tokens) ??
    asFiniteTokenCount(inputDetails?.cacheWriteTokens);
  const reasoningTokens =
    asFiniteTokenCount(u.reasoningTokens) ??
    asFiniteTokenCount(u.reasoning_tokens) ??
    asFiniteTokenCount(outputDetails?.reasoningTokens);
  const totalTokens =
    asFiniteTokenCount(u.totalTokens) ??
    asFiniteTokenCount(
      (inputTokens ?? 0) +
        (outputTokens ?? 0) +
        (cacheReadTokens ?? 0) +
        (cacheWriteTokens ?? 0) +
        (reasoningTokens ?? 0),
    );
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
  };
}
/**
 * @param {AgentInvocationTags} tags
 * @param {AgentTokenTotals} totals
 * @returns {Effect.Effect<void>}
 */
function recordAgentTokenMetrics(tags, totals) {
  const effects = [];
  /**
   * @param {string} kind
   * @param {number | undefined} value
   */
  const pushMetric = (kind, value) => {
    if (!value || value <= 0) return;
    effects.push(
      Metric.update(
        taggedMetric(agentTokensTotal, {
          ...tags,
          kind,
        }),
        value,
      ),
    );
  };
  pushMetric("input", totals.inputTokens);
  pushMetric("output", totals.outputTokens);
  pushMetric("cache_read", totals.cacheReadTokens);
  pushMetric("cache_write", totals.cacheWriteTokens);
  pushMetric("reasoning", totals.reasoningTokens);
  pushMetric("total", totals.totalTokens);
  return effects.length > 0 ? Effect.all(effects, { discard: true }) : Effect.void;
}
/**
 * @param {unknown} options
 * @returns {{ isRetry: boolean; reason?: string }}
 */
function resolveRetryHint(options) {
  if (!options || typeof options !== "object") return { isRetry: false };
  const o = /** @type {Record<string, unknown>} */ (options);
  if (o.retry === true) return { isRetry: true, reason: "retry" };
  if (o.isRetry === true) return { isRetry: true, reason: "is_retry" };
  if (typeof o.retryAttempt === "number" && o.retryAttempt > 0) {
    return { isRetry: true, reason: "retry_attempt" };
  }
  if (typeof o.schemaRetry === "number" && o.schemaRetry > 0) {
    return { isRetry: true, reason: "schema_retry" };
  }
  return { isRetry: false };
}
/**
 * @param {AgentCliEvent} event
 * @param {Record<string, unknown>} annotations
 * @param {string} span
 */
function logAgentCliEvent(event, annotations, span) {
  switch (event.type) {
    case "started":
      logInfo(
        "agent session started",
        {
          ...annotations,
          eventType: event.type,
          eventEngine: event.engine,
          title: event.title,
          resume: event.resume ?? null,
        },
        span,
      );
      return;
    case "action":
      logDebug(
        "agent action event",
        {
          ...annotations,
          eventType: event.type,
          eventEngine: event.engine,
          phase: event.phase,
          actionId: event.action.id,
          actionKind: event.action.kind,
          actionTitle: event.action.title,
          entryType: event.entryType ?? null,
          level: event.level ?? null,
          ok: event.ok ?? null,
        },
        span,
      );
      return;
    case "completed":
      (event.ok ? logInfo : logWarning)(
        event.ok ? "agent session completed" : "agent session failed",
        {
          ...annotations,
          eventType: event.type,
          eventEngine: event.engine,
          ok: event.ok,
          resume: event.resume ?? null,
          error: event.error ?? null,
          hasUsage: Boolean(event.usage),
        },
        span,
      );
      return;
  }
}
/**
 * @param {string} raw
 * @returns {string | undefined}
 */
function extractTextFromJsonPayload(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return extractTextFromJsonValue(parsed);
  } catch {
    // Possibly JSONL
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const parsedLines = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      parsedLines.push(parsed);
    } catch {
      continue;
    }
  }
  for (let i = parsedLines.length - 1; i >= 0; i--) {
    const parsed = parsedLines[i];
    const type = typeof parsed?.type === "string" ? parsed.type : "";
    if ((type === "turn_end" || type === "message_end") && parsed?.message?.role === "assistant") {
      const text = extractTextFromJsonValue(parsed.message);
      if (text) return text;
    }
    if (type === "agent_end" && Array.isArray(parsed?.messages)) {
      for (let j = parsed.messages.length - 1; j >= 0; j--) {
        const message = parsed.messages[j];
        if (message?.role !== "assistant") continue;
        const text = extractTextFromJsonValue(message);
        if (text) return text;
      }
    }
    // OpenCode-style CLIs emit a final "finish" or "done" event with the
    // complete response text directly on the payload. Prefer this over
    // concatenating all text_delta chunks which would duplicate content.
    if (type === "finish" || type === "done") {
      const text = typeof parsed?.text === "string" ? parsed.text : undefined;
      if (text) return text;
    }
    // OpenCode nd-JSON format: "text" events carry part.text with finalized
    // text chunks. Accumulate these as a fallback when the interpreter's
    // completed event isn't surfaced properly.
    if (type === "text" && parsed?.part?.text) {
      // Don't return early — accumulate via the chunks path below
    }
  }
  const chunks = [];
  for (const parsed of parsedLines) {
    if (typeof parsed?.role === "string" && parsed.role !== "assistant") continue;
    let text;
    if (parsed?.type === "text" && typeof parsed?.part?.text === "string") {
      text = parsed.part.text;
    } else {
      text = extractTextFromJsonValue(parsed);
    }
    if (text) chunks.push(text);
  }
  return chunks.length ? chunks.join("") : undefined;
}
/**
 * Choose the agent's final answer text from the available sources, in priority:
 *   1. A dedicated final-message file that parsed as JSON — the CLI's
 *      authoritative output channel (e.g. codex --output-last-message).
 *   2. For `stream-json`, the interpreter's parsed final answer whenever it is
 *      present, on INTACT runs too. `extractTextFromJsonPayload` concatenates
 *      every assistant turn for Claude Code NDJSON — its reverse-scan matches no
 *      terminal message type (Claude emits `assistant`/`result`, not
 *      `turn_end`/`agent_end`/`finish`), so it falls to the chunk-join path and
 *      duplicates content while splicing in tool-result noise. The interpreter's
 *      answer is the clean terminal `result`. (#277 originally kept intact runs
 *      on the concatenation path; that silently corrupted every stream-json step.)
 *   3. On truncation or empty extraction, the interpreter answer, then the
 *      extracted stdout, then the raw text.
 *   4. Otherwise the historical stdout extraction (json / plain-text formats).
 *
 * @param {{
 *   outputFileJson: unknown,
 *   outputFileText: string | undefined,
 *   streamedAnswer: string | undefined,
 *   extractedFromStdout: string | undefined,
 *   rawText: string,
 *   stdoutTruncated: boolean,
 *   outputFormat: string | undefined,
 * }} sources
 * @returns {string}
 */
export function resolveAgentAnswerText(sources) {
  const {
    outputFileJson,
    outputFileText,
    streamedAnswer,
    extractedFromStdout,
    rawText,
    stdoutTruncated,
    outputFormat,
  } = sources;
  if (outputFileJson != null) {
    return outputFileText ?? rawText;
  }
  if (outputFormat === "stream-json" && streamedAnswer != null) {
    return streamedAnswer;
  }
  if (stdoutTruncated || extractedFromStdout == null || extractedFromStdout.trim() === "") {
    return streamedAnswer ?? extractedFromStdout ?? rawText;
  }
  return extractedFromStdout;
}
/**
 * @param {string} raw
 * @returns {string}
 */
function stripOscSequences(raw) {
  return raw.replace(/\x1b\]0;[^\x07]*\x07/g, "");
}
/**
 * @param {string} raw
 * @returns {string | undefined}
 */
function extractErrorFromJsonPayload(raw) {
  const trimmed = stripOscSequences(raw).trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      // codex emits {"type":"turn.failed","error":{"message":...}} or a
      // top-level {"type":"error","message":...}; claude nests the
      // message under error.data/error. Accept all of these shapes so
      // the distilled provider message wins over raw stderr log noise.
      if (parsed?.type !== "error" && parsed?.type !== "turn.failed") continue;
      const message = parsed?.error?.data?.message ?? parsed?.error?.message ?? parsed?.message ?? parsed?.error?.name;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

const CLI_FAILURE_PREVIEW_CHARS = 200;

/**
 * Keep structured stdout useful when it is the only failure signal without
 * copying an arbitrarily large provider event into the durable error/log line.
 *
 * @param {string} raw
 * @returns {string}
 */
function summarizeStructuredFailureOutput(raw) {
  const trimmed = stripOscSequences(raw).trim();
  if (!trimmed) return "";
  const metadataPrefix = trimmed.slice(0, 4_096);
  const type = /"type"\s*:\s*"([^"\\]{1,80})"/.exec(metadataPrefix)?.[1];
  const subtype = /"subtype"\s*:\s*"([^"\\]{1,80})"/.exec(metadataPrefix)?.[1];
  const event = type ? (subtype ? `${type}/${subtype}` : type) : "unknown";
  const preview = trimmed.slice(0, CLI_FAILURE_PREVIEW_CHARS).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  const suffix = trimmed.length > CLI_FAILURE_PREVIEW_CHARS ? "…" : "";
  return `CLI stdout fallback (event=${event}, bytes=${Buffer.byteLength(trimmed, "utf8")}, preview=${preview}${suffix})`;
}
/**
 * @param {string[]} args
 * @returns {string | undefined}
 */
function inferOutputFormatFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output-format" || arg === "--mode") {
      return args[i + 1];
    }
  }
  return undefined;
}
function emptyUsage() {
  return {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens: undefined,
  };
}
/**
 * @template T
 * @param {AsyncIterable<T>} iterable
 * @returns {ReadableStream<T> & AsyncIterable<T>}
 */
function asyncIterableToStream(iterable) {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const item of iterable) {
          controller.enqueue(item);
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
  });
  stream[Symbol.asyncIterator] = iterable[Symbol.asyncIterator].bind(iterable);
  return stream;
}
/**
 * @param {GenerateTextResult<Record<string, never>, unknown>} result
 * @returns {StreamTextResult<Record<string, never>, unknown>}
 */
function buildStreamResult(result) {
  const text = result.text ?? "";
  const content = result.content ?? [];
  const steps = result.steps ?? [];
  const usage = result.usage ?? emptyUsage();
  const totalUsage = result.totalUsage ?? usage;
  const response = result.response ?? {
    id: randomUUID(),
    timestamp: new Date(),
    modelId: "unknown",
    messages: [],
  };
  const request = result.request ?? {};
  const textStream = asyncIterableToStream(
    (async function* () {
      if (text) yield text;
    })(),
  );
  const fullStream = asyncIterableToStream(
    (async function* () {
      const id = randomUUID();
      yield { type: "text-start", id };
      if (text) {
        yield { type: "text-delta", id, text };
      }
      yield { type: "text-end", id };
    })(),
  );
  return {
    content: Promise.resolve(content),
    text: Promise.resolve(text),
    reasoning: Promise.resolve(result.reasoning ?? []),
    reasoningText: Promise.resolve(result.reasoningText),
    files: Promise.resolve(result.files ?? []),
    sources: Promise.resolve(result.sources ?? []),
    toolCalls: Promise.resolve(result.toolCalls ?? []),
    staticToolCalls: Promise.resolve(result.staticToolCalls ?? []),
    dynamicToolCalls: Promise.resolve(result.dynamicToolCalls ?? []),
    staticToolResults: Promise.resolve(result.staticToolResults ?? []),
    dynamicToolResults: Promise.resolve(result.dynamicToolResults ?? []),
    toolResults: Promise.resolve(result.toolResults ?? []),
    finishReason: Promise.resolve(result.finishReason ?? "stop"),
    rawFinishReason: Promise.resolve(result.rawFinishReason),
    usage: Promise.resolve(usage),
    totalUsage: Promise.resolve(totalUsage),
    warnings: Promise.resolve(result.warnings),
    steps: Promise.resolve(steps),
    request: Promise.resolve(request),
    response: Promise.resolve(response),
    providerMetadata: Promise.resolve(result.providerMetadata),
    textStream: textStream,
    stream: fullStream,
    fullStream: fullStream,
  };
}
/**
 * Fallback when truncated stdout lost the per-message usage events: the
 * interpreter's completed event carries the harness usage summary (#277).
 * @param {{ usage?: unknown } | null} completedEvent
 * @returns {CliUsageInfo | undefined}
 */
function usageFromCompletedEvent(completedEvent) {
  const u = completedEvent?.usage;
  if (!u || typeof u !== "object" || Array.isArray(u)) return undefined;
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const usage = {
    inputTokens: num(u.input_tokens) ?? num(u.inputTokens),
    outputTokens: num(u.output_tokens) ?? num(u.outputTokens),
    cacheReadTokens: num(u.cache_read_input_tokens) ?? num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens) ?? num(u.cacheWriteTokens),
    reasoningTokens: num(u.reasoning_tokens) ?? num(u.reasoningTokens) ?? num(u.outputTokenDetails?.reasoningTokens),
    totalTokens: num(u.total_tokens) ?? num(u.totalTokens),
  };
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined;
}
/**
 * @param {string} raw
 * @returns {CliUsageInfo | undefined}
 */
export function extractUsageFromOutput(raw) {
  const lines = stripOscSequences(raw).split(/\r?\n/).filter(Boolean);
  const usage = {};
  let found = false;
  let countedIncremental = false;
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    if (parsed.type === "message_start" && parsed.message?.usage) {
      const u = parsed.message.usage;
      usage.inputTokens = (usage.inputTokens ?? 0) + (u.input_tokens ?? 0);
      if (u.cache_read_input_tokens) {
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + u.cache_read_input_tokens;
      }
      if (u.cache_creation_input_tokens) {
        usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + u.cache_creation_input_tokens;
      }
      found = true;
      countedIncremental = true;
      continue;
    }
    if (parsed.type === "message_delta" && parsed.usage) {
      if (parsed.usage.output_tokens) {
        usage.outputTokens = (usage.outputTokens ?? 0) + parsed.usage.output_tokens;
      }
      found = true;
      countedIncremental = true;
      continue;
    }
    if (parsed.type === "result") {
      // Claude Code stream-json emits a terminal "result" event whose
      // top-level usage summarizes tokens already accumulated from the
      // per-message message_start/message_delta events. If we counted
      // those incrementally, skip this event to avoid double-counting.
      // Otherwise fall through so the usage is still captured.
      if (countedIncremental) {
        continue;
      }
    }
    if (parsed.type === "turn.completed" && parsed.usage) {
      const u = parsed.usage;
      if (u.input_tokens) {
        usage.inputTokens = (usage.inputTokens ?? 0) + u.input_tokens;
      }
      if (u.output_tokens) {
        usage.outputTokens = (usage.outputTokens ?? 0) + u.output_tokens;
      }
      if (u.cached_input_tokens) {
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + u.cached_input_tokens;
      }
      found = true;
      continue;
    }
    if (parsed.type === "step_finish" && parsed.part?.tokens && typeof parsed.part.tokens === "object") {
      const tokens = parsed.part.tokens;
      const input = tokens.input ?? 0;
      const output = tokens.output ?? 0;
      const total = tokens.total ?? 0;
      const reasoning = tokens.reasoning ?? 0;
      const cacheRead = tokens.cache?.read ?? 0;
      const cacheWrite = tokens.cache?.write ?? 0;
      if (input > 0 || output > 0 || total > 0 || reasoning > 0 || cacheRead > 0 || cacheWrite > 0) {
        usage.inputTokens = (usage.inputTokens ?? 0) + input;
        usage.outputTokens = (usage.outputTokens ?? 0) + output;
        usage.totalTokens = (usage.totalTokens ?? 0) + total;
        usage.reasoningTokens = (usage.reasoningTokens ?? 0) + reasoning;
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cacheRead;
        usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + cacheWrite;
        found = true;
        continue;
      }
    }
    if (parsed.usage && typeof parsed.usage === "object") {
      const u = parsed.usage;
      const inTok = u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0;
      const outTok = u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0;
      if (inTok > 0 || outTok > 0) {
        usage.inputTokens = (usage.inputTokens ?? 0) + inTok;
        usage.outputTokens = (usage.outputTokens ?? 0) + outTok;
        if (u.cache_read_input_tokens || u.cacheReadTokens || u.cached_input_tokens) {
          usage.cacheReadTokens =
            (usage.cacheReadTokens ?? 0) +
            (u.cache_read_input_tokens ?? u.cacheReadTokens ?? u.cached_input_tokens ?? 0);
        }
        if (u.reasoning_tokens ?? u.reasoningTokens ?? u.outputTokenDetails?.reasoningTokens) {
          usage.reasoningTokens =
            (usage.reasoningTokens ?? 0) +
            (u.reasoning_tokens ?? u.reasoningTokens ?? u.outputTokenDetails?.reasoningTokens ?? 0);
        }
        found = true;
        continue;
      }
    }
  }
  if (!found) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed?.stats?.models && typeof parsed.stats.models === "object") {
        for (const data of Object.values(parsed.stats.models)) {
          if (data?.tokens) {
            usage.inputTokens = (usage.inputTokens ?? 0) + (data.tokens.input ?? data.tokens.prompt ?? 0);
            usage.outputTokens = (usage.outputTokens ?? 0) + (data.tokens.output ?? 0);
            found = true;
          }
        }
      }
    } catch {
      // not single JSON
    }
  }
  return found ? usage : undefined;
}
export class BaseCliAgent {
  version = "agent-v1";
  /** @type {Record<string, unknown>} */
  tools = {};
  capabilities;
  id;
  model;
  systemPrompt;
  cwd;
  env;
  inheritEnv;
  yolo;
  timeoutMs;
  idleTimeoutMs;
  maxOutputBytes;
  extraArgs;
  onQuotaExceeded;
  /**
   * @param {BaseCliAgentOptions} opts
   * @param {string} [agentName]
   */
  constructor(opts, agentName = "BaseCliAgent") {
    assertKnownCliAgentOptions(opts, agentName);
    this.id = opts.id ?? randomUUID();
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt ?? opts.instructions;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.inheritEnv = opts.inheritEnv ?? true;
    this.yolo = opts.yolo ?? true;
    this.timeoutMs = opts.timeoutMs;
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.maxOutputBytes = opts.maxOutputBytes;
    this.extraArgs = opts.extraArgs;
    this.onQuotaExceeded = opts.onQuotaExceeded;
  }
  /**
   * Execute this CLI adapter through the flows Harness contract.
   * @param {import("@flows/harness/AgentStep").AgentStep} step
   * @param {import("@flows/harness/AgentStep").HostLike} host
   */
  run(step, host) {
    return runAgentLikeHarness(this, step, host);
  }
  /**
   * @param {AgentGenerateOptions | undefined} options
   * @param {AgentInvocationOperation} operation
   * @returns {Effect.Effect<GenerateTextResult<Record<string, never>, unknown>, SmithersError>}
   */
  runGenerateEffect(options, operation) {
    const invocationStart = performance.now();
    const { prompt, systemFromMessages } = extractPrompt(options);
    const callTimeouts = resolveTimeouts(options?.timeout, {
      totalMs: this.timeoutMs,
      idleMs: this.idleTimeoutMs,
    });
    const cwd = this.cwd ?? options?.rootDir ?? process.cwd();
    const env = {
      ...(this.inheritEnv ? process.env : {}),
      ...this.env,
      ...taskContextEnv(options?.taskContext),
    };
    const combinedSystem = combineNonEmpty([this.systemPrompt, systemFromMessages]);
    const retryHint = resolveRetryHint(options);
    const span = `agent.${operation}`;
    let metricTags = {
      source: "adapter",
      engine: resolveAgentEngineTag(this),
      operation,
      model: normalizeMetricTag(this.model),
    };
    const spanAnnotations = {
      agentEngine: metricTags.engine,
      agentOperation: operation,
      agentModel: metricTags.model ?? "unknown",
      cwd,
      timeoutMs: callTimeouts.totalMs ?? null,
      idleTimeoutMs: callTimeouts.idleMs ?? null,
      hasMessages: Array.isArray(options?.messages),
      hasResumeSession: typeof options?.resumeSession === "string",
      promptBytes: Buffer.byteLength(prompt, "utf8"),
      systemPromptBytes: combinedSystem ? Buffer.byteLength(combinedSystem, "utf8") : 0,
    };
    let diagnosticsPromise;
    let stdoutEmitter;
    let cleanup;
    let commandLogAnnotations = {};
    const recordDurationMetric = () =>
      Effect.sync(() => performance.now() - invocationStart).pipe(
        Effect.flatMap((durationMs) => Metric.update(taggedMetric(agentDurationMs, metricTags), durationMs)),
      );
    const agentCtx = { agentId: this.id, agentModel: this.model, agentEngine: resolveAgentEngineTag(this) };
    const classifyQuota = (message, command) => {
      const quota = classifyQuotaError(message, command, agentCtx);
      if (quota && this.onQuotaExceeded) {
        try {
          this.onQuotaExceeded(/** @type {any} */ (quota.details ?? {}));
        } catch {
          // Quota persistence is best-effort and must not mask the provider error.
        }
      }
      return quota;
    };
    const program = Effect.all(
      [
        Metric.update(taggedMetric(agentInvocationsTotal, metricTags), 1),
        ...(retryHint.isRetry
          ? [
              Metric.update(
                taggedMetric(agentRetriesTotal, {
                  ...metricTags,
                  reason: retryHint.reason ?? "explicit",
                }),
                1,
              ),
            ]
          : []),
        Effect.logDebug("agent invocation started").pipe(
          Effect.annotateLogs({
            ...spanAnnotations,
            retryReason: retryHint.reason ?? null,
          }),
        ),
      ],
      { discard: true },
    )
      .pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () =>
              this.buildCommand({
                prompt,
                systemPrompt: combinedSystem,
                cwd,
                options,
              }),
            catch: (cause) => toSmithersError(cause, "build agent command"),
          }),
        ),
        Effect.flatMap((commandSpec) => {
          cleanup = commandSpec.cleanup;
          metricTags = {
            ...metricTags,
            engine: resolveAgentEngineTag(this, commandSpec.command),
            model: normalizeMetricTag(this.model ?? commandSpec.command),
          };
          const outputFormat = commandSpec.outputFormat ?? inferOutputFormatFromArgs(commandSpec.args);
          commandLogAnnotations = {
            ...spanAnnotations,
            agentEngine: metricTags.engine,
            agentModel: metricTags.model ?? "unknown",
            agentCommand: commandSpec.command,
            agentArgs: sanitizeCliArgs(commandSpec.args).join(" "),
            outputFormat: outputFormat ?? "text",
          };
          const commandEnv = commandSpec.env ? { ...env, ...commandSpec.env } : env;
          stdoutEmitter = createAgentStdoutTextEmitter({
            outputFormat,
            onText: options?.onStdout,
          });
          const interpreter = this.createOutputInterpreter();
          let stdoutBuffer = "";
          let stderrBuffer = "";
          let completedEvent = null;
          let lastStructuredFailureOutput = "";
          /**
           * @param {AgentCliEvent[] | AgentCliEvent | null | undefined} eventPayload
           */
          const emitEvents = (eventPayload) => {
            if (!eventPayload) return;
            const events = Array.isArray(eventPayload) ? eventPayload : [eventPayload];
            for (const event of events) {
              if (event?.type === "completed") {
                completedEvent = event;
              }
              logAgentCliEvent(event, commandLogAnnotations, span);
              if (!options?.onEvent) continue;
              void Promise.resolve(options.onEvent(event)).catch(() => undefined);
            }
          };
          /**
           * @param {"stdout" | "stderr"} stream
           * @param {boolean} includePartial
           */
          const flushBufferedLines = (stream, includePartial) => {
            if (!interpreter) return;
            let buffer = stream === "stdout" ? stdoutBuffer : stderrBuffer;
            const lines = buffer.split("\n");
            if (!includePartial) {
              buffer = lines.pop() ?? "";
            } else {
              buffer = "";
            }
            for (const line of lines) {
              if (!line) continue;
              if (stream === "stdout" && (outputFormat === "json" || outputFormat === "stream-json")) {
                lastStructuredFailureOutput = summarizeStructuredFailureOutput(line);
              }
              emitEvents(stream === "stdout" ? interpreter.onStdoutLine?.(line) : interpreter.onStderrLine?.(line));
            }
            if (stream === "stdout") {
              stdoutBuffer = buffer;
            } else {
              stderrBuffer = buffer;
            }
          };
          /**
           * @param {"stdout" | "stderr"} stream
           * @param {string} chunk
           */
          const handleInterpreterChunk = (stream, chunk) => {
            if (!interpreter || !chunk) return;
            if (stream === "stdout") {
              stdoutBuffer += chunk;
            } else {
              stderrBuffer += chunk;
            }
            flushBufferedLines(stream, false);
          };
          diagnosticsPromise = launchDiagnostics(commandSpec.command, commandEnv, cwd, this.diagnosticHints?.());
          return Effect.gen({ self: this }, function* () {
            const result = yield* runCommandEffect(commandSpec.command, commandSpec.args, {
              cwd,
              env: commandEnv,
              input: commandSpec.stdin,
              timeoutMs: callTimeouts.totalMs,
              idleTimeoutMs: callTimeouts.idleMs,
              signal: options?.abortSignal,
              maxOutputBytes: this.maxOutputBytes ?? options?.maxOutputBytes,
              // CLI harnesses emit their final result event at the END of
              // the stream; if the capture cap trips, the tail is the part
              // that must survive (#277).
              truncateKeep: "tail",
              onStdout: (chunk) => {
                stdoutEmitter?.push(chunk);
                handleInterpreterChunk("stdout", chunk);
              },
              onStderr: (chunk) => {
                options?.onStderr?.(chunk);
                handleInterpreterChunk("stderr", chunk);
              },
              onProcess: options?.onProcess,
            });
            flushBufferedLines("stdout", true);
            flushBufferedLines("stderr", true);
            emitEvents(interpreter?.onExit?.(result));
            if (result.stdoutTruncated) {
              emitEvents({
                type: "action",
                engine: commandSpec.command,
                phase: "completed",
                entryType: "thought",
                action: {
                  id: `stdout-truncated-${randomUUID()}`,
                  kind: "warning",
                  title: "captured stdout truncated",
                  detail: {},
                },
                message:
                  "Captured stdout exceeded maxOutputBytes; kept the stream tail. The streamed interpreter answer is used as the result text.",
                ok: true,
                level: "warning",
              });
            }
            const outputFileText = commandSpec.outputFile
              ? yield* Effect.tryPromise({
                  try: () => fs.readFile(commandSpec.outputFile, "utf8"),
                  catch: (cause) => toSmithersError(cause, "read output file"),
                }).pipe(Effect.catch(() => Effect.succeed(null)))
              : null;
            const stdout = typeof outputFileText === "string" ? outputFileText : result.stdout;
            if (result.exitCode && result.exitCode !== 0) {
              const filteredStderr = filterBenignStderr(result.stderr, commandSpec.benignStderrPatterns);
              if (!(commandSpec.command === "codex" && filteredStderr.length === 0)) {
                const structuredError =
                  outputFormat === "json" || outputFormat === "stream-json"
                    ? extractErrorFromJsonPayload(result.stdout)
                    : undefined;
                // Prefer a distilled error over the raw stdout tail: a
                // stream-json stdout tail is usually an init line or
                // token-usage event, not the failure. The interpreter's
                // completed event already carries the distilled error
                // when the stream surfaced one.
                const rawInterpreterError =
                  completedEvent?.ok === false && typeof completedEvent.error === "string"
                    ? completedEvent.error.trim()
                    : "";
                // The interpreter's generic onExit fallback ("<CLI>
                // exited with code N") carries less signal than stderr;
                // only a real distilled message may outrank it.
                const interpreterError = /exited with code/i.test(rawInterpreterError) ? "" : rawInterpreterError;
                const rawStdout = result.stdout.trim();
                const stdoutFallback =
                  outputFormat === "json" || outputFormat === "stream-json"
                    ? lastStructuredFailureOutput || summarizeStructuredFailureOutput(rawStdout)
                    : rawStdout;
                const errorText =
                  structuredError ||
                  interpreterError ||
                  filteredStderr ||
                  stdoutFallback ||
                  `CLI exited with code ${result.exitCode}`;
                const quota = classifyQuota(errorText, commandSpec.command);
                if (quota) {
                  return yield* Effect.fail(quota);
                }
                const nonRetryable = classifyNonRetryableAgentError(errorText, commandSpec.command, agentCtx);
                if (nonRetryable) {
                  return yield* Effect.fail(nonRetryable);
                }
                const rawStderr = result.stderr ?? "";
                const sessionLoss = classifySessionLoss(
                  commandSpec.command,
                  errorText,
                  rawStderr,
                  typeof options?.resumeSession === "string",
                );
                if (sessionLoss) {
                  return yield* Effect.fail(sessionLoss);
                }
                return yield* Effect.fail(new SmithersError("AGENT_CLI_ERROR", errorText));
              }
            }
            if (completedEvent?.ok === false) {
              const completedError = completedEvent.error || "CLI agent reported an error";
              const completedQuota = classifyQuota(completedError, commandSpec.command);
              if (completedQuota) {
                return yield* Effect.fail(completedQuota);
              }
              // Session loss can surface through the CLI's structured result
              // (a `completed ok:false` event) instead of a non-zero exit —
              // claude-code reports "No conversation found" this way. Same
              // treatment: drop the dead id, retry fresh.
              const completedSessionLoss = classifySessionLoss(
                commandSpec.command,
                completedError,
                result.stderr ?? "",
                typeof options?.resumeSession === "string",
              );
              if (completedSessionLoss) {
                return yield* Effect.fail(completedSessionLoss);
              }
              return yield* Effect.fail(new SmithersError("AGENT_CLI_ERROR", completedError));
            }
            // Some CLIs may print extra banners to stdout. Allow individual agents
            // to provide patterns so this logic stays opt-in and agent-specific.
            const stdoutBannerPatterns = commandSpec.stdoutBannerPatterns ?? [];
            let cleanedStdout = stdout;
            for (const pattern of stdoutBannerPatterns) {
              const regex = new RegExp(pattern.source, pattern.flags);
              cleanedStdout = cleanedStdout.replace(regex, "");
            }
            const rawText = cleanedStdout.trim();
            // Optionally treat "banner-only" output as an error when requested.
            if (commandSpec.errorOnBannerOnly && !rawText && stdout.trim()) {
              return yield* Effect.fail(
                new SmithersError(
                  "AGENT_CLI_ERROR",
                  "CLI agent error (stdout): output was only a banner with no model response",
                ),
              );
            }
            // Some CLIs report failures on stdout even with exit code 0. Keep
            // detection patterns opt-in so normal model text is not misclassified.
            const stdoutErrorPatterns = commandSpec.stdoutErrorPatterns ?? [];
            if (rawText && !rawText.startsWith("{") && !rawText.startsWith("[")) {
              for (const pattern of stdoutErrorPatterns) {
                const regex = new RegExp(pattern.source, pattern.flags);
                if (regex.test(rawText)) {
                  const stdoutErrText = `CLI agent error (stdout): ${rawText.slice(0, 500)}`;
                  const nonRetryable = classifyNonRetryableAgentError(rawText, commandSpec.command, agentCtx);
                  return yield* Effect.fail(nonRetryable ?? new SmithersError("AGENT_CLI_ERROR", stdoutErrText));
                }
              }
            }
            const extractedFromStdout =
              outputFormat === "json" || outputFormat === "stream-json" ? extractTextFromJsonPayload(rawText) : rawText;
            // The interpreter parses the live stream line-by-line BEFORE the
            // capture cap applies, so its completed answer survives stdout
            // truncation. Prefer it whenever the captured stdout was
            // truncated or yields no final message; otherwise keep the
            // historical extraction so intact runs are unchanged (#277).
            const streamedAnswer =
              typeof completedEvent?.answer === "string" && completedEvent.answer.trim().length > 0
                ? completedEvent.answer
                : undefined;
            // A dedicated final-message file (e.g. codex --output-last-message)
            // is the CLI's authoritative output channel: it holds the complete
            // final message and is immune to the stdout byte cap and to
            // line-by-line stream interpretation. When it parsed as JSON, trust
            // it over the truncation/stream fallbacks, which otherwise surface a
            // short `message` field instead of the full structured object.
            const outputFileJson =
              typeof outputFileText === "string" && outputFileText.trim() !== "" ? tryParseJson(outputFileText) : null;
            const extractedText = resolveAgentAnswerText({
              outputFileJson,
              outputFileText,
              streamedAnswer,
              extractedFromStdout,
              rawText,
              stdoutTruncated: result.stdoutTruncated,
              outputFormat,
            });
            const output = outputFileJson ?? tryParseJson(extractedText);
            // Extract token usage from raw stdout before text extraction strips it.
            // Each CLI harness embeds usage differently (NDJSON events, JSON stats, etc.)
            const cliUsage = extractUsageFromOutput(result.stdout) ?? usageFromCompletedEvent(completedEvent);
            const usage = cliUsage
              ? {
                  inputTokens: cliUsage.inputTokens,
                  inputTokenDetails: {
                    noCacheTokens: undefined,
                    cacheReadTokens: cliUsage.cacheReadTokens,
                    cacheWriteTokens: cliUsage.cacheWriteTokens,
                  },
                  outputTokens: cliUsage.outputTokens,
                  outputTokenDetails: {
                    textTokens: undefined,
                    reasoningTokens: cliUsage.reasoningTokens,
                  },
                  totalTokens:
                    cliUsage.totalTokens ?? ((cliUsage.inputTokens ?? 0) + (cliUsage.outputTokens ?? 0) || undefined),
                }
              : undefined;
            const tokenTotals = extractAgentTokenTotals(usage);
            stdoutEmitter?.flush(extractedText);
            yield* recordAgentTokenMetrics(metricTags, tokenTotals);
            const durationMs = performance.now() - invocationStart;
            yield* Effect.logDebug("agent invocation completed").pipe(
              Effect.annotateLogs({
                ...commandLogAnnotations,
                durationMs,
                textBytes: Buffer.byteLength(extractedText, "utf8"),
                stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
                inputTokens: tokenTotals.inputTokens ?? 0,
                outputTokens: tokenTotals.outputTokens ?? 0,
                totalTokens: tokenTotals.totalTokens ?? 0,
              }),
            );
            return buildGenerateResult(extractedText, output, this.model ?? commandSpec.command, usage);
          });
        }),
      )
      .pipe(
        Effect.tapError((err) =>
          Effect.all(
            [
              Metric.update(taggedMetric(agentErrorsTotal, metricTags), 1),
              Effect.logWarning("agent invocation failed").pipe(
                Effect.annotateLogs({
                  ...commandLogAnnotations,
                  ...spanAnnotations,
                  error: err.message,
                  durationMs: performance.now() - invocationStart,
                }),
              ),
              Effect.tryPromise({
                try: async () => {
                  // An explicit abort already explains the invocation failure.
                  // Probe results are concurrent observations and can be stale or
                  // unrelated, so do not attach or log them as follow-up causes.
                  if (!diagnosticsPromise || (err instanceof SmithersError && err.code === "PROCESS_ABORTED")) return;
                  const report = await diagnosticsPromise.catch(() => null);
                  if (report && err instanceof SmithersError) {
                    enrichReportWithErrorAnalysis(report, err.message);
                    err.details = { ...err.details, diagnostics: report };
                    logWarning(formatDiagnosticSummary(report), {}, span);
                  }
                },
                catch: (cause) => toSmithersError(cause, "enrich diagnostics"),
              }).pipe(Effect.ignore),
            ],
            { discard: true },
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            stdoutEmitter?.flush();
          }),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            const cleanupFn = cleanup;
            return cleanupFn
              ? Effect.tryPromise({
                  try: () => cleanupFn(),
                  catch: (cause) => toSmithersError(cause, "agent cleanup"),
                }).pipe(Effect.ignore)
              : Effect.void;
          }),
        ),
        Effect.ensuring(recordDurationMetric()),
        Effect.annotateLogs(spanAnnotations),
        Effect.withLogSpan(span),
      );
    return program;
  }
  /**
   * @param {AgentGenerateOptions} [options]
   * @returns {Promise<void>}
   */
  async preflight(options) {
    const cwd = this.cwd ?? options?.rootDir ?? process.cwd();
    const env = {
      ...(this.inheritEnv ? process.env : {}),
      ...this.env,
      ...taskContextEnv(options?.taskContext),
    };
    const { systemFromMessages } = extractPrompt(options);
    const combinedSystem = combineNonEmpty([this.systemPrompt, systemFromMessages]);
    const agentId = this.id ?? "<anonymous>";
    const agentModel = this.model ?? "<unset>";
    let cleanup;
    let command = resolveAgentEngineTag(this);
    try {
      const commandSpec = await this.buildCommand({
        prompt: "",
        systemPrompt: combinedSystem,
        cwd,
        options,
      });
      cleanup = commandSpec.cleanup;
      command = commandSpec.command;
      const commandEnv = commandSpec.env ? { ...env, ...commandSpec.env } : env;
      const report = await launchDiagnostics(commandSpec.command, commandEnv, cwd, this.diagnosticHints?.());
      if (!report) {
        logDebug(
          "agent preflight skipped; no diagnostics strategy",
          {
            agentId,
            agentEngine: commandSpec.command,
            agentModel,
            cwd,
          },
          "agent.preflight",
        );
        return;
      }
      const failed = report.checks.filter((check) => check.status === "fail");
      const errored = report.checks.filter((check) => check.status === "error");
      if (failed.length > 0) {
        const summary = formatDiagnosticSummary(report);
        logWarning(
          summary,
          {
            agentId,
            agentEngine: commandSpec.command,
            agentModel,
            cwd,
          },
          "agent.preflight",
        );
        throw new SmithersError(
          "AGENT_CONFIG_INVALID",
          `Agent "${agentId}" (${commandSpec.command}, model=${agentModel}) failed preflight: ${summary}`,
          {
            failureRetryable: false,
            preflight: true,
            agentId,
            agentEngine: commandSpec.command,
            agentModel,
            command: commandSpec.command,
            diagnostics: report,
          },
        );
      }
      if (errored.length > 0) {
        logWarning(
          `Agent preflight diagnostics had non-blocking errors: ${formatDiagnosticSummary(report)}`,
          {
            agentId,
            agentEngine: commandSpec.command,
            agentModel,
            cwd,
          },
          "agent.preflight",
        );
      } else {
        logDebug(
          "agent preflight passed",
          {
            agentId,
            agentEngine: commandSpec.command,
            agentModel,
            cwd,
            durationMs: Math.round(report.durationMs),
          },
          "agent.preflight",
        );
      }
    } catch (cause) {
      if (cause instanceof SmithersError && cause.details?.preflight === true) {
        throw cause;
      }
      const normalized =
        cause instanceof SmithersError
          ? cause
          : toSmithersError(cause, "build agent preflight command", {
              code: "AGENT_CONFIG_INVALID",
              details: {
                failureRetryable: false,
                preflight: true,
                agentId,
                agentEngine: command,
                agentModel,
                command,
              },
            });
      throw new SmithersError(
        normalized.code ?? "AGENT_CONFIG_INVALID",
        `Agent "${agentId}" (${command}, model=${agentModel}) failed preflight: ${normalized.summary ?? normalized.message}`,
        {
          ...normalized.details,
          failureRetryable: false,
          preflight: true,
          agentId,
          agentEngine: normalized.details?.agentEngine ?? command,
          agentModel,
          command: normalized.details?.command ?? command,
        },
        { cause: normalized },
      );
    } finally {
      if (cleanup) {
        try {
          await cleanup();
        } catch (error) {
          logWarning(
            "agent preflight cleanup failed",
            {
              agentId,
              agentEngine: command,
              error: error instanceof Error ? error.message : String(error),
            },
            "agent.preflight",
          );
        }
      }
    }
  }
  /**
   * @param {AgentGenerateOptions} [options]
   * @returns {Promise<GenerateTextResult<Record<string, never>, unknown>>}
   */
  async generate(options) {
    return runAgentPromise(this.runGenerateEffect(options, "generate"));
  }
  /**
   * @param {AgentGenerateOptions} [options]
   * @returns {Promise<StreamTextResult<Record<string, never>, unknown>>}
   */
  async stream(options) {
    const result = await runAgentPromise(
      this.runGenerateEffect(options, "stream").pipe(Effect.map((generateResult) => buildStreamResult(generateResult))),
    );
    return result;
  }
  /**
   * @returns {CliOutputInterpreter | undefined}
   */
  createOutputInterpreter() {
    return undefined;
  }
  /**
   * @returns {{ provider?: string; model?: string } | undefined}
   */
  diagnosticHints() {
    return undefined;
  }
}
