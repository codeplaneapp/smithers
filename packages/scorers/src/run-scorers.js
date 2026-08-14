import { Effect, Metric } from "effect";
import { toSmithersError } from "@smthrs/errors/toSmithersError";
import { scorerDuration, scorersFinished, scorersFailed, scorersStarted } from "./metrics.js";
import { nowMs } from "@smthrs/scheduler/nowMs";
import crypto from "node:crypto";
/** @typedef {{ emit: (eventName: "event", event: unknown) => unknown, emitEventWithPersist?: (event: unknown) => import("effect").Effect.Effect<void, unknown> }} EventBus */
/** @typedef {import("./types.js").ScoreResult} ScoreResult */
/** @typedef {import("./types.js").ScorerContext} ScorerContext */
/** @typedef {import("./types.js").ScorerBinding} ScorerBinding */
/** @typedef {import("./types.js").ScorersMap} ScorersMap */
/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smthrs/errors/SmithersError").SmithersError} SmithersError */

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------
/**
 * Deterministic hash of a scorer's durable identity into the half-open
 * interval [0, 1). Two invocations with the same (runId, nodeId, iteration,
 * attempt, scorerId) always produce the same value, so a ratio-sampled scorer
 * makes the same run/skip decision on the original execution and on every
 * replay/fork of that checkpoint — preserving deterministic replay instead of
 * flipping the decision via global Math.random().
 *
 * @param {ScorerBinding} binding
 * @param {ScorerContext} ctx
 * @returns {number}
 */
function samplingValue(binding, ctx) {
  const seed = [ctx.runId, ctx.nodeId, ctx.iteration, ctx.attempt, binding.scorer.id].join(" "); // Preserve the historical seed format so existing runs replay deterministically.
  const digest = crypto.createHash("sha256").update(seed).digest();
  // Take the first 6 bytes (48 bits) as an integer and normalize to [0, 1).
  const value = digest.readUIntBE(0, 6);
  return value / 2 ** 48;
}
/**
 * @param {ScorerBinding} binding
 * @param {ScorerContext} ctx
 * @returns {boolean}
 */
function shouldRun(binding, ctx) {
  const sampling = binding.sampling ?? { type: "all" };
  switch (sampling.type) {
    case "all":
      return true;
    case "none":
      return false;
    case "ratio":
      return samplingValue(binding, ctx) < sampling.rate;
    default:
      return true;
  }
}
/**
 * Builds the stable primary key for one logical scorer execution. Rewinds can
 * execute the same attempt again, so persistence upserts this logical identity:
 * the latest execution replaces the pre-rewind score without creating a
 * duplicate that would corrupt aggregates.
 *
 * @param {ScorerContext} ctx
 * @param {string} scorerId
 * @param {"live" | "batch"} source
 * @returns {string}
 */
function scorerResultId(ctx, scorerId, source) {
  const identity = JSON.stringify([ctx.runId, ctx.nodeId, ctx.iteration, ctx.attempt, scorerId, source]);
  return `scorer_${crypto.createHash("sha256").update(identity).digest("hex")}`;
}
/**
 * Emit a scorer lifecycle event through the durable path (DB + NDJSON + live
 * listeners + metrics) so scorer events appear in the event/NDJSON stream, not
 * only in _smithers_scorers. Falls back to a bare emit for a third-party bus
 * that exposes only emit(). Persistence failure must never abort scoring, so the
 * error channel is ignored.
 *
 * @param {EventBus} bus
 * @param {unknown} event
 * @returns {Effect.Effect<void, never>}
 */
function emitScorerEvent(bus, event) {
  return Effect.ignore(
    typeof bus.emitEventWithPersist === "function"
      ? bus.emitEventWithPersist(event)
      : Effect.try(() => bus.emit("event", event)),
  );
}
// ---------------------------------------------------------------------------
// Score validation
// ---------------------------------------------------------------------------
/**
 * Validates and normalizes a raw ScoreResult before it is emitted/persisted.
 *
 * A scorer's contract is to return `{ score }` with `score` a finite number in
 * [0, 1]. A malformed result (missing/non-numeric/NaN/Infinity score) is a
 * scorer bug: it is surfaced as a SCORER_FAILED error rather than silently
 * dropping the row (which would leave a split-brain ScorerFinished event with
 * no durable record). A finite but out-of-range score is clamped to [0, 1]
 * (matching llmJudge), so a buggy scorer cannot poison aggregates or skew a
 * threshold gate with values like 5, -1, NaN, or Infinity.
 *
 * @param {ScoreResult} result
 * @param {{ key: string; scorerId: string; scorerName: string; source: string }} meta
 * @returns {ScoreResult}
 */
function validateScoreResult(result, meta) {
  const rawScore = result?.score;
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) {
    throw toSmithersError(
      new Error(`Scorer returned a non-finite or missing score: ${String(rawScore)}`),
      `scorer:${meta.scorerId}`,
      {
        code: "SCORER_FAILED",
        details: {
          bindingKey: meta.key,
          scorerId: meta.scorerId,
          scorerName: meta.scorerName,
          source: meta.source,
          rawScore,
          reason: "invalid-score-result",
        },
      },
    );
  }
  const clamped = Math.max(0, Math.min(1, rawScore));
  if (clamped === rawScore) return result;
  return { ...result, score: clamped };
}
// ---------------------------------------------------------------------------
// Single scorer execution
// ---------------------------------------------------------------------------
/**
 * @param {string} key
 * @param {ScorerBinding} binding
 * @param {ScorerContext} ctx
 * @param {SmithersDb | null} adapter
 * @param {"live" | "batch"} source
 * @param {EventBus | null} [eventBus]
 * @returns {Effect.Effect<ScoreResult | null, SmithersError>}
 */
function runSingleScorerEffect(key, binding, ctx, adapter, source, eventBus) {
  const { scorer } = binding;
  return Effect.gen(function* () {
    if (!shouldRun(binding, ctx)) {
      return null;
    }
    yield* Metric.update(scorersStarted, 1);
    if (eventBus) {
      yield* emitScorerEvent(eventBus, {
        type: "ScorerStarted",
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        scorerId: scorer.id,
        scorerName: scorer.name,
        timestampMs: nowMs(),
      });
    }
    const start = performance.now();
    const result = yield* Effect.tryPromise({
      try: async () => {
        const raw = await scorer.score({
          input: ctx.input,
          output: ctx.output,
          groundTruth: ctx.groundTruth,
          context: ctx.context,
          latencyMs: ctx.latencyMs,
          outputSchema: ctx.outputSchema,
        });
        return validateScoreResult(raw, {
          key,
          scorerId: scorer.id,
          scorerName: scorer.name,
          source,
        });
      },
      catch: (cause) =>
        toSmithersError(cause, `scorer:${scorer.id}`, {
          code: "SCORER_FAILED",
          details: {
            bindingKey: key,
            scorerId: scorer.id,
            scorerName: scorer.name,
            source,
          },
        }),
    }).pipe(
      Effect.tapError((err) =>
        Effect.gen(function* () {
          yield* Metric.update(scorersFailed, 1);
          if (eventBus) {
            yield* emitScorerEvent(eventBus, {
              type: "ScorerFailed",
              runId: ctx.runId,
              nodeId: ctx.nodeId,
              scorerId: scorer.id,
              scorerName: scorer.name,
              error: err instanceof Error ? err.message : String(err),
              timestampMs: nowMs(),
            });
          }
        }),
      ),
    );
    const durationMs = performance.now() - start;
    yield* Metric.update(scorersFinished, 1);
    yield* Metric.update(scorerDuration, durationMs);
    if (eventBus) {
      yield* emitScorerEvent(eventBus, {
        type: "ScorerFinished",
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        scorerId: scorer.id,
        scorerName: scorer.name,
        score: result.score,
        timestampMs: nowMs(),
      });
    }
    if (adapter) {
      const row = {
        id: scorerResultId(ctx, scorer.id, source),
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        iteration: ctx.iteration,
        attempt: ctx.attempt,
        scorerId: scorer.id,
        scorerName: scorer.name,
        source,
        score: result.score,
        reason: result.reason ?? null,
        metaJson: result.meta ? JSON.stringify(result.meta) : null,
        inputJson: safeJsonStringify(ctx.input),
        outputJson: safeJsonStringify(ctx.output),
        groundTruthJson: safeJsonStringify(ctx.groundTruth),
        contextJson: safeJsonStringify(ctx.context),
        latencyMs: ctx.latencyMs ?? null,
        scoredAtMs: nowMs(),
        durationMs,
      };
      yield* adapter.insertScorerResult(row);
    }
    return result;
  }).pipe(Effect.annotateLogs({ scorer: scorer.id, nodeId: ctx.nodeId }), Effect.withLogSpan(`scorer:${scorer.id}`));
}
/**
 * @param {unknown} value
 * @returns {string | null}
 */
function safeJsonStringify(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Fire-and-forget scorer execution. Runs all scorers via Effect.runFork
 * so they never block the workflow. Used for live scoring during execution.
 *
 * @param {ScorersMap} scorers
 * @param {ScorerContext} ctx
 * @param {SmithersDb | null} adapter
 * @param {EventBus | null} [eventBus]
 * @returns {void}
 */
export function runScorersAsync(scorers, ctx, adapter, eventBus) {
  const entries = Object.entries(scorers);
  if (entries.length === 0) return;
  const effects = entries.map(([key, binding]) =>
    runSingleScorerEffect(key, binding, ctx, adapter, "live", eventBus).pipe(
      Effect.catch((error) =>
        Effect.logError(`Scorer ${key} failed: ${error.message}`).pipe(
          Effect.annotateLogs({ scorer: key, error: error.message }),
          Effect.map(() => null),
        ),
      ),
    ),
  );
  const program = Effect.all(effects, { concurrency: "unbounded", discard: true }).pipe(
    Effect.withLogSpan("scorers:async"),
  );
  Effect.runFork(program);
}
/**
 * Blocking scorer execution. Runs all scorers and waits for completion.
 * Returns a map of key -> ScoreResult. Used for batch/test evaluation.
 *
 * @param {ScorersMap} scorers
 * @param {ScorerContext} ctx
 * @param {SmithersDb | null} adapter
 * @param {EventBus | null} [eventBus]
 * @returns {Promise<Record<string, ScoreResult | null>>}
 */
export async function runScorersBatch(scorers, ctx, adapter, eventBus) {
  const entries = Object.entries(scorers);
  if (entries.length === 0) return {};
  const effects = entries.map(([key, binding]) =>
    runSingleScorerEffect(key, binding, ctx, adapter, "batch", eventBus).pipe(
      Effect.map((result) => [key, result]),
      Effect.catch((error) =>
        Effect.logError(`Scorer ${key} failed: ${error.message}`).pipe(
          Effect.annotateLogs({ scorer: key, error: error.message }),
          Effect.map(() => [key, null]),
        ),
      ),
    ),
  );
  const results = await Effect.runPromise(
    Effect.all(effects, { concurrency: "unbounded" }).pipe(Effect.withLogSpan("scorers:batch")),
  );
  return Object.fromEntries(results);
}
