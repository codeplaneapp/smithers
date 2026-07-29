import { Effect, Logger, LogLevel } from "effect";
import { getCurrentSmithersTraceAnnotations } from "./getCurrentSmithersTraceAnnotations.js";
import {
  correlationContextToLogAnnotations,
  getCurrentCorrelationContext,
  withCurrentCorrelationContext,
} from "./correlation.js";
/**
 * @typedef {Record<string, unknown> | undefined} LogAnnotations
 */

/** @type {number} */
const LOG_LEVEL_NONE = 0;
const LOG_LEVEL_DEBUG = 1;
const LOG_LEVEL_INFO = 2;
const LOG_LEVEL_WARNING = 3;
const LOG_LEVEL_ERROR = 4;
const LOG_RUNNER_KEY = Symbol.for("smithers.observability.logRunner");
const defaultLoggerLayer = Logger.layer([Logger.consoleLogFmt]);

/**
 * Resolve the minimum imperative log level. The environment value is an
 * injectable parameter (defaulting to `SMITHERS_LOG_LEVEL`) so the mapping is
 * testable without re-importing the module; module state still captures the
 * env-derived value once at load time.
 *
 * @param {string | undefined} [env]
 * @returns {number}
 */
export function resolveMinLevel(env = process.env.SMITHERS_LOG_LEVEL?.toLowerCase()) {
  switch (env) {
    case "none":
      return Infinity;
    case "trace":
    case "debug":
      return LOG_LEVEL_DEBUG;
    case "warning":
    case "warn":
      return LOG_LEVEL_WARNING;
    case "error":
      return LOG_LEVEL_ERROR;
    case "fatal":
      return Infinity;
    case "all":
      return LOG_LEVEL_NONE;
    // Default to INFO so INFO/OTLP records flow without SMITHERS_LOG_LEVEL,
    // matching resolveSmithersObservabilityOptions' Effect-layer default.
    case "info":
    default:
      return LOG_LEVEL_INFO;
  }
}

const minLevel = resolveMinLevel();

/**
 * @typedef {{
 *   runFork: (effect: Effect.Effect<void, never, never>) => unknown;
 *   runPromise: (effect: Effect.Effect<void, never, never>) => Promise<void>;
 * }} SmithersLogRunner
 */

/** @returns {{ runner: SmithersLogRunner | null }} */
function getRunnerState() {
  const globalState = /** @type {typeof globalThis & { [LOG_RUNNER_KEY]?: { runner: SmithersLogRunner | null } }} */ (
    globalThis
  );
  globalState[LOG_RUNNER_KEY] ??= { runner: null };
  return globalState[LOG_RUNNER_KEY];
}

/** @type {SmithersLogRunner} */
const defaultRunner = {
  runFork: (effect) => Effect.runFork(effect.pipe(Effect.provide(defaultLoggerLayer))),
  runPromise: (effect) => Effect.runPromise(effect.pipe(Effect.provide(defaultLoggerLayer))),
};

/** @returns {SmithersLogRunner} */
function getLogRunner() {
  return getRunnerState().runner ?? defaultRunner;
}

/**
 * Install the Effect runtime used by fire-and-forget observability logs.
 * Returns a restore function so tests and embedded hosts can scope overrides.
 *
 * @param {SmithersLogRunner | null} runner
 * @returns {() => void}
 */
export function setSmithersLogRunner(runner) {
  const state = getRunnerState();
  const previous = state.runner;
  state.runner = runner;
  return () => {
    state.runner = previous;
  };
}

/**
 * Map an imperative smithers log level to the Effect log level used when
 * running the log program. Exported alongside {@link resolveMinLevel} so the
 * level mapping (including the catch-all `LogLevel.All` fallback) can be
 * exercised directly with injected level values.
 *
 * @param {number} level
 */
export function toEffectLogLevel(level) {
  switch (level) {
    case LOG_LEVEL_DEBUG:
      return LogLevel.Debug;
    case LOG_LEVEL_INFO:
      return LogLevel.Info;
    case LOG_LEVEL_WARNING:
      return LogLevel.Warn;
    case LOG_LEVEL_ERROR:
      return LogLevel.Error;
    default:
      return LogLevel.All;
  }
}

/**
 * @param {Effect.Effect<void, never, never>} effect
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 * @returns {Effect.Effect<void, never, never>}
 */
function buildLogProgram(effect, annotations, span) {
  const correlationAnnotations = correlationContextToLogAnnotations(getCurrentCorrelationContext());
  const traceAnnotations = getCurrentSmithersTraceAnnotations();
  const mergedAnnotations =
    correlationAnnotations || traceAnnotations || annotations
      ? {
          ...correlationAnnotations,
          ...traceAnnotations,
          ...annotations,
        }
      : undefined;
  let program = effect;
  if (mergedAnnotations) {
    program = program.pipe(Effect.annotateLogs(mergedAnnotations));
  }
  if (span) {
    program = program.pipe(Effect.withLogSpan(span));
  }
  return withCurrentCorrelationContext(program);
}

/**
 * @param {Effect.Effect<void, never, never>} effect
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 * @param {number} [level]
 */
function emitLog(effect, annotations, span, level = LOG_LEVEL_INFO) {
  if (level < minLevel) return;
  const program = buildLogProgram(effect, annotations, span);
  try {
    void getLogRunner().runFork(program);
  } catch {
    // Logging must never break the caller.
  }
}

/**
 * @param {Effect.Effect<void, never, never>} effect
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 * @param {number} [level]
 * @returns {Promise<void>}
 */
async function emitLogAwait(effect, annotations, span, level = LOG_LEVEL_INFO) {
  if (level < minLevel) return;
  const program = buildLogProgram(effect, annotations, span);
  try {
    await getLogRunner().runPromise(program);
  } catch {
    // Logging must never break the caller.
  }
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
export function logDebug(message, annotations, span) {
  emitLog(Effect.logDebug(message), annotations, span, LOG_LEVEL_DEBUG);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
export function logInfo(message, annotations, span) {
  emitLog(Effect.logInfo(message), annotations, span, LOG_LEVEL_INFO);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
export function logWarning(message, annotations, span) {
  emitLog(Effect.logWarning(message), annotations, span, LOG_LEVEL_WARNING);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
export function logError(message, annotations, span) {
  emitLog(Effect.logError(message), annotations, span, LOG_LEVEL_ERROR);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 * @returns {Promise<void>}
 */
export async function logDebugAwait(message, annotations, span) {
  await emitLogAwait(Effect.logDebug(message), annotations, span, LOG_LEVEL_DEBUG);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 * @returns {Promise<void>}
 */
export async function logInfoAwait(message, annotations, span) {
  await emitLogAwait(Effect.logInfo(message), annotations, span, LOG_LEVEL_INFO);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 * @returns {Promise<void>}
 */
export async function logWarningAwait(message, annotations, span) {
  await emitLogAwait(Effect.logWarning(message), annotations, span, LOG_LEVEL_WARNING);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 * @returns {Promise<void>}
 */
export async function logErrorAwait(message, annotations, span) {
  await emitLogAwait(Effect.logError(message), annotations, span, LOG_LEVEL_ERROR);
}
