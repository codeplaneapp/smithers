import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Logger } from "effect";
import { emitOtelLogRecord } from "../src/emitOtelLogRecord.js";
import { setSmithersLogRunner } from "../src/logging.js";

/** @type {{ level: string; message: unknown; spans: string[] }[]} */
const captured = [];

/**
 * Install a log runner that runs the fire-and-forget program through a
 * capturing Logger so we can observe which severity/message/span the
 * OTLP record was routed to. This is a real Effect runtime, not a mock.
 */
function installCapturingRunner() {
  const capturingLogger = Logger.make(({ logLevel, message, spans }) => {
    captured.push({
      level: logLevel.label,
      message: Array.isArray(message) ? message[0] : message,
      spans: Array.from(spans, (span) => span.label),
    });
  });
  const layer = Logger.replace(Logger.defaultLogger, capturingLogger);
  return setSmithersLogRunner({
    runFork: (effect) => Effect.runFork(effect.pipe(Effect.provide(layer))),
    runPromise: (effect) => Effect.runPromise(effect.pipe(Effect.provide(layer))),
  });
}

describe("emitOtelLogRecord", () => {
  afterEach(() => {
    captured.length = 0;
  });

  test("routes ERROR records through logErrorAwait", async () => {
    const restore = installCapturingRunner();
    try {
      await emitOtelLogRecord("agent-trace", {
        severity: "ERROR",
        body: "boom",
        attributes: { code: "E_FAIL" },
      });
    } finally {
      restore();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0].level).toBe("ERROR");
    expect(captured[0].message).toBe("boom");
    expect(captured[0].spans).toContain("agent-trace");
  });

  test("routes WARN records through logWarningAwait", async () => {
    const restore = installCapturingRunner();
    try {
      await emitOtelLogRecord("agent-session", {
        severity: "WARN",
        body: "careful",
        attributes: { reason: "retry" },
      });
    } finally {
      restore();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0].level).toBe("WARN");
    expect(captured[0].message).toBe("careful");
    expect(captured[0].spans).toContain("agent-session");
  });

  test("routes non-error/non-warn records through logInfoAwait", async () => {
    const restore = installCapturingRunner();
    try {
      await emitOtelLogRecord("agent-trace", {
        severity: "INFO",
        body: "hello",
        attributes: { runId: "r1" },
      });
    } finally {
      restore();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0].level).toBe("INFO");
    expect(captured[0].message).toBe("hello");
    expect(captured[0].spans).toContain("agent-trace");
  });
});
