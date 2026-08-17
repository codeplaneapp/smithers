// @smithers-type-exports-begin
/**
 * @template S
 * @typedef {import("./ExternalSmithersEngine.ts").ExternalSmithersEngine<S>} ExternalSmithersEngine
 */
/**
 * @template S
 * @typedef {import("./ExternalSmithersEngineConfig.ts").ExternalSmithersEngineConfig<S>} ExternalSmithersEngineConfig
 */
/** @typedef {import("./ExternalSmithersEngineConfig.ts").SmithersEngineLogger} SmithersEngineLogger */
/** @typedef {import("./ExternalSmithersEngineConfig.ts").SmithersEngineLogLevel} SmithersEngineLogLevel */
/** @typedef {import("./ExternalSmithersEngineConfig.ts").SmithersEngineLogRecord} SmithersEngineLogRecord */
// @smithers-type-exports-end

import { Effect, Layer, Logger, References } from "effect";
import { closeSingleRunnerRuntime, reopenSingleRunnerRuntime, runWorkflow } from "@smthrs/engine";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { isKnownSmithersErrorCode } from "@smthrs/errors/isKnownSmithersErrorCode";
import { runWithSmithersLogRunner } from "@smthrs/observability/logging";
import { openSmithersBackend } from "../openSmithersBackend.js";
import { hostNodeToReact, serializeCtx } from "./create-external-smithers.js";

let openEngineCount = 0;

/** @param {unknown} value */
function messageText(value) {
  if (Array.isArray(value)) return value.map(messageText).join(" ");
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {SmithersEngineLogger | false | undefined} logger
 */
function createLoggerBinding(logger) {
  const sink = logger === false ? () => {} : logger;
  if (!sink) return null;
  const effectLogger = Logger.make(({ date, fiber, logLevel, message }) => {
    const annotations = { ...fiber.getRef(References.CurrentLogAnnotations) };
    const spans = fiber.getRef(References.CurrentLogSpans).map(([label]) => label);
    const level =
      logLevel === "Debug" || logLevel === "Trace"
        ? "debug"
        : logLevel === "Warn"
          ? "warn"
          : logLevel === "Error" || logLevel === "Fatal"
            ? "error"
            : "info";
    try {
      sink({ level, message: messageText(message), timestamp: date, annotations, spans });
    } catch {
      // A host logger is an observation sink, never part of run correctness.
    }
  });
  const layer = Logger.layer([effectLogger]);
  return {
    layer,
    runner: {
      runFork: (effect) => Effect.runFork(effect.pipe(Effect.provide(layer))),
      runPromise: (effect) => Effect.runPromise(effect.pipe(Effect.provide(layer))),
    },
  };
}

/** @param {unknown} value */
function restoreError(value) {
  if (value instanceof Error) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Error(String(value));
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const cause = record.cause === undefined ? undefined : restoreError(record.cause);
  const message = typeof record.message === "string" ? record.message : String(record.summary ?? "Workflow failed");
  const code =
    typeof record.code === "string" && isKnownSmithersErrorCode(record.code) ? record.code : "INTERNAL_ERROR";
  const details =
    record.details && typeof record.details === "object" && !Array.isArray(record.details)
      ? /** @type {Record<string, unknown>} */ (record.details)
      : undefined;
  return new SmithersError(code, typeof record.summary === "string" ? record.summary : message, details, {
    cause,
    includeDocsUrl: false,
    name: typeof record.name === "string" ? record.name : undefined,
  });
}

async function makeNodePlatformLayer() {
  const { NodeChildProcessSpawner, NodeCrypto, NodeFileSystem, NodePath, NodeStdio, NodeTerminal } =
    await import("@effect/platform-node-shared");
  return Layer.provideMerge(
    NodeChildProcessSpawner.layer,
    Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, NodePath.layer, NodeStdio.layer, NodeTerminal.layer),
  );
}

/**
 * Open one reusable engine over the normal Smithers runtime. Plain Node
 * defaults to PGlite; Bun keeps SQLite as its default. Node callers may choose
 * managed Postgres, but asking for SQLite fails explicitly because bun:sqlite
 * is the only SQLite driver supported by the durable engine.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} S
 * @param {ExternalSmithersEngineConfig<S>} config
 * @returns {Promise<ExternalSmithersEngine<S>>}
 */
export async function createExternalSmithersEngine(config) {
  const { schemas, agents, logger, ...backendOptions } = config;
  const loggerBinding = createLoggerBinding(logger);
  const withLogger = (execute) => (loggerBinding ? runWithSmithersLogRunner(loggerBinding.runner, execute) : execute());
  const nodeRuntime = typeof Bun === "undefined";
  const backend = backendOptions.backend ?? (nodeRuntime ? "pglite" : "sqlite");
  const api = await withLogger(() => openSmithersBackend(schemas, { ...backendOptions, backend }));
  const platformLayer = nodeRuntime ? await makeNodePlatformLayer() : null;
  reopenSingleRunnerRuntime();
  openEngineCount += 1;
  let closed = false;
  const activeRuns = new Set();

  const assertOpen = () => {
    if (closed) {
      throw new SmithersError("INVALID_INPUT", "External Smithers engine is closed.");
    }
  };

  return {
    api,
    workflow(buildFn, options) {
      assertOpen();
      return api.smithers((ctx) => hostNodeToReact(buildFn(serializeCtx(ctx)), agents), options);
    },
    async run(workflow, options) {
      assertOpen();
      const running = withLogger(async () => {
        let effect = runWorkflow(workflow, {
          ...options,
          ...(nodeRuntime
            ? { effectPlatformRuntime: "node", effectPlatformLayer: platformLayer }
            : { effectPlatformRuntime: "bun" }),
        });
        if (loggerBinding) effect = effect.pipe(Effect.provide(loggerBinding.layer));
        const result = await Effect.runPromise(effect);
        if (result.status === "failed") {
          const cause = restoreError(result.error);
          throw new SmithersError(
            cause.code ?? "WORKFLOW_EXECUTION_FAILED",
            `Embedded workflow run ${result.runId} failed: ${cause.summary ?? cause.message}`,
            { runId: result.runId, status: result.status },
            { cause },
          );
        }
        return result;
      });
      activeRuns.add(running);
      try {
        return await running;
      } finally {
        activeRuns.delete(running);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(activeRuns);
      try {
        await api.close?.();
      } finally {
        openEngineCount = Math.max(0, openEngineCount - 1);
        if (openEngineCount === 0) await closeSingleRunnerRuntime();
      }
    },
  };
}
