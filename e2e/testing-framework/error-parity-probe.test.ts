import { describe, expect, test } from "bun:test";
import { Effect, Either } from "effect";
import { spawnCaptureEffect } from "@smithers-orchestrator/driver/child-process";
import { compareBoundaryShape, contractProbe } from "@smithers-orchestrator/testing";

describe("testing framework production error parity", () => {
  test("probes the production child-process adapter at its native boundary", async () => {
    class SmithersError extends Error {
      readonly code = "PROCESS_SPAWN_FAILED";
      readonly summary: string;
      readonly docsUrl = "https://smithers.sh/reference/errors";
      readonly details: { command: string; args: never[]; cwd: string; timeoutMs: undefined; idleTimeoutMs: undefined; operation: string };
      readonly cause: Error;
      constructor() {
        const command = "smithers-testing-binary-that-does-not-exist";
        const cause = Object.assign(new Error(`Executable not found in $PATH: "${command}"`), { code: "ENOENT" });
        super(`spawn ${command}: ${cause.message} See https://smithers.sh/reference/errors`);
        this.name = "SmithersError";
        this.summary = `spawn ${command}: ${cause.message}`;
        this.details = { command, args: [], cwd: process.cwd(), timeoutMs: undefined, idleTimeoutMs: undefined, operation: `spawn ${command}` };
        this.cause = cause;
      }
    }
    const production = async () => {
      const result = await Effect.runPromise(Effect.either(spawnCaptureEffect("smithers-testing-binary-that-does-not-exist", [], { cwd: process.cwd() })));
      if (Either.isLeft(result)) throw result.left;
      return result.right;
    };
    const serialize = (value: unknown): unknown => { if (!(value instanceof Error)) return value; const error = value as Error & { code?: string; summary?: string; docsUrl?: string; details?: unknown; cause?: unknown }; return { name: error.name, message: error.message, code: error.code, summary: error.summary, details: error.details, docsUrl: error.docsUrl, cause: error.cause instanceof Error ? { name: error.cause.name, message: error.cause.message, code: (error.cause as Error & { code?: string }).code } : error.cause }; };
    const report = await contractProbe("driver.spawnCaptureEffect.missing-binary", production, () => { throw new SmithersError(); }, { serializeProduction: serialize, serializeSimulation: serialize });
    expect(report.passed).toBe(true);
    expect(report.expected.className).toBe("SmithersError");
    expect(report.expected.code).toBe("PROCESS_SPAWN_FAILED");
    expect(report.expected.cause?.code).toBe("ENOENT");
    expect(compareBoundaryShape(report.expected, report.actual)).toEqual([]);
    const drift = await contractProbe("negative-drift", production, () => { const error = new SmithersError(); Object.defineProperty(error, "code", { value: "DRIFT" }); throw error; }, { serializeProduction: serialize, serializeSimulation: serialize });
    expect(drift.passed).toBe(false);
    expect(drift.differences).toContain("code differs");
  });
});
