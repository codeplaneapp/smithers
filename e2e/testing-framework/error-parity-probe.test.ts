import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { spawnCaptureEffect } from "@smithers-orchestrator/driver/child-process";
import { isRetryableSqliteWriteError, withSqliteWriteRetry, withSqliteWriteRetryEffect } from "@smithers-orchestrator/db/write-retry";
import * as engineModule from "@smithers-orchestrator/engine/engine";
import { errorToJson, toSmithersError } from "@smithers-orchestrator/errors";
// The probes exercise the PUBLISHED testing artifact (the committed
// src/index.js the package exports map ships) via an explicit .js specifier —
// not the tsconfig alias to the TypeScript source.
import { compareBoundaryShape, contractProbe, serializeBoundaryError, serializeSimulationDurableError, simulationNativeError, simulationSmithersError } from "../../packages/testing/src/index.js";

/**
 * Production error-parity probes. Every `production` side executes REAL
 * production code (driver spawn, engine heartbeat validation, the SmithersDb
 * write boundary — real `toSmithersError` + `withSqliteWriteRetryEffect`
 * composed exactly as packages/db adapter.js `write()` composes them — over
 * bun:sqlite under a genuinely held lock, a child killed by an EXTERNAL
 * SIGKILL); every
 * `simulated` side uses the reusable harness-native simulation constructors —
 * no per-test constructor spoofing. Each family is compared TWICE:
 *  - through the reusable harness boundary serializer on both sides
 *    (family-specific native fields such as errno/byteOffset included), and
 *  - through GENUINE production-native serialization: the production error
 *    runs through packages/errors `errorToJson` (the durable failed-task
 *    write-path serializer consumers actually receive) while the simulation
 *    double runs through the independently implemented
 *    serializeSimulationDurableError; only stack locations are excluded.
 * Every family proves drift detection with a negative regression.
 */
const { validateHeartbeatValue, serializeHeartbeatPayload } = (engineModule as unknown as {
  __engineInternals: {
    validateHeartbeatValue: (value: unknown, path: string, seen: Set<unknown>) => void;
    serializeHeartbeatPayload: (data: unknown) => { heartbeatDataJson: string; dataSizeBytes: number };
  };
}).__engineInternals;

const withoutStacks = (value: unknown): unknown => Array.isArray(value)
  ? value.map(withoutStacks)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "stack").map(([key, entry]) => [key, withoutStacks(entry)]))
    : value;

const probeOptions = { serializeProduction: serializeBoundaryError, serializeSimulation: serializeBoundaryError };
const durableOptions = {
  serializeProduction: (value: unknown) => withoutStacks(errorToJson(value)),
  serializeSimulation: (value: unknown) => withoutStacks(serializeSimulationDurableError(value)),
};
const tempDirs: string[] = [];
afterAll(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("testing framework production error parity", () => {
  test("family 1: production child-process spawn failure at its native boundary", async () => {
    const command = "smithers-testing-binary-that-does-not-exist";
    const simulatedSpawnError = () => {
      // The double mirrors the native ENOENT cause the production spawn path
      // throws — errno/path/syscall included, because the serializer compares
      // them now. `spawnargs` is intentionally absent: the driver strips it
      // from spawn causes so raw argv (which can carry secrets) never reaches
      // durable error records.
      const cause = simulationNativeError({
        className: "Error",
        message: `Executable not found in $PATH: "${command}"`,
        code: "ENOENT",
        extra: { errno: -2, path: command, syscall: `spawn ${command}` },
      });
      return simulationSmithersError("PROCESS_SPAWN_FAILED", `spawn ${command}: ${cause.message}`, {
        details: { command, args: [], cwd: process.cwd(), timeoutMs: undefined, idleTimeoutMs: undefined, operation: `spawn ${command}` },
        cause,
      });
    };
    const production = async () => {
      const result = await Effect.runPromise(Effect.result(spawnCaptureEffect(command, [], { cwd: process.cwd() })));
      if (Result.isFailure(result)) throw result.failure;
      return result.success;
    };
    const report = await contractProbe("driver.spawnCaptureEffect.missing-binary", production, () => { throw simulatedSpawnError(); }, probeOptions);
    expect(report.differences).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.expected.className).toBe("SmithersError");
    expect(report.actual.className).toBe("SmithersError");
    expect(report.expected.code).toBe("PROCESS_SPAWN_FAILED");
    expect(report.expected.cause?.code).toBe("ENOENT");
    expect(compareBoundaryShape(report.expected, report.actual)).toEqual([]);
    // Production-native serialization: the REAL durable errorToJson output
    // must match the independent simulation serializer's output exactly
    // (stacks excluded).
    const durable = await contractProbe("driver.spawnCaptureEffect.missing-binary.durable", production, () => { throw simulatedSpawnError(); }, durableOptions);
    expect(durable.differences).toEqual([]);
    expect(durable.passed).toBe(true);
    const drift = await contractProbe("negative-drift", production, () => { const error = simulatedSpawnError(); Object.defineProperty(error, "code", { value: "DRIFT" }); throw error; }, probeOptions);
    expect(drift.passed).toBe(false);
    expect(drift.differences).toContain("code differs");
    const durableDrift = await contractProbe("negative-drift.durable", production, () => { const error = simulatedSpawnError() as Error & { summary?: string }; error.summary = "drifted summary"; throw error; }, durableOptions);
    expect(durableDrift.passed).toBe(false);
    expect(durableDrift.differences).toContain("serialized differs");
  });

  test("family 2: production engine heartbeat validation (non-finite and circular payloads)", async () => {
    const nonFinite = await contractProbe(
      "engine.validateHeartbeatValue.non-finite",
      () => validateHeartbeatValue(Number.POSITIVE_INFINITY, "$.progress", new Set()),
      () => { throw simulationSmithersError("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE", "Heartbeat payload must contain only finite numbers (invalid at $.progress).", { details: { path: "$.progress", value: Number.POSITIVE_INFINITY } }); },
      probeOptions,
    );
    expect(nonFinite.differences).toEqual([]);
    expect(nonFinite.passed).toBe(true);
    expect(nonFinite.expected.className).toBe("SmithersError");
    expect(nonFinite.expected.code).toBe("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE");
    const nonFiniteDurable = await contractProbe(
      "engine.validateHeartbeatValue.non-finite.durable",
      () => validateHeartbeatValue(Number.POSITIVE_INFINITY, "$.progress", new Set()),
      () => { throw simulationSmithersError("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE", "Heartbeat payload must contain only finite numbers (invalid at $.progress).", { details: { path: "$.progress", value: Number.POSITIVE_INFINITY } }); },
      durableOptions,
    );
    expect(nonFiniteDurable.differences).toEqual([]);
    expect(nonFiniteDurable.passed).toBe(true);

    const payload: Record<string, unknown> = {};
    payload.self = payload;
    const circular = await contractProbe(
      "engine.validateHeartbeatValue.circular",
      () => validateHeartbeatValue(payload, "$", new Set()),
      () => { throw simulationSmithersError("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE", "Heartbeat payload cannot contain circular references.", { details: { path: "$.self" } }); },
      probeOptions,
    );
    expect(circular.differences).toEqual([]);
    expect(circular.passed).toBe(true);
    expect(circular.expected.detailsKeys).toEqual(["path"]);
    const circularDurable = await contractProbe(
      "engine.validateHeartbeatValue.circular.durable",
      () => validateHeartbeatValue(payload, "$", new Set()),
      () => { throw simulationSmithersError("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE", "Heartbeat payload cannot contain circular references.", { details: { path: "$.self" } }); },
      durableOptions,
    );
    expect(circularDurable.differences).toEqual([]);
    expect(circularDurable.passed).toBe(true);
    const detailsDrift = await contractProbe(
      "engine.validateHeartbeatValue.circular.details-drift",
      () => validateHeartbeatValue(payload, "$", new Set()),
      () => { throw simulationSmithersError("HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE", "Heartbeat payload cannot contain circular references.", { details: { path: "$.drifted" } }); },
      durableOptions,
    );
    expect(detailsDrift.passed).toBe(false);
    expect(detailsDrift.differences).toContain("serialized differs");
  });

  test("family 2b: production engine OVERSIZED heartbeat payload boundary", async () => {
    // TASK_HEARTBEAT_MAX_PAYLOAD_BYTES is 1_000_000; JSON.stringify of an
    // ASCII string adds two quote bytes, so this payload serializes to
    // 1_000_003 bytes — computed independently, never copied from the
    // production error.
    const oversized = "x".repeat(1_000_001);
    const simulatedOversized = (maxBytes: number) => simulationSmithersError(
      "HEARTBEAT_PAYLOAD_TOO_LARGE",
      `Heartbeat payload exceeds ${maxBytes} bytes.`,
      { details: { dataSizeBytes: oversized.length + 2, maxBytes } },
    );
    const report = await contractProbe(
      "engine.serializeHeartbeatPayload.oversized",
      () => serializeHeartbeatPayload(oversized),
      () => { throw simulatedOversized(1_000_000); },
      probeOptions,
    );
    expect(report.differences).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.expected.className).toBe("SmithersError");
    expect(report.expected.code).toBe("HEARTBEAT_PAYLOAD_TOO_LARGE");
    expect(report.expected.detailsKeys).toEqual(["dataSizeBytes", "maxBytes"]);
    const durable = await contractProbe(
      "engine.serializeHeartbeatPayload.oversized.durable",
      () => serializeHeartbeatPayload(oversized),
      () => { throw simulatedOversized(1_000_000); },
      durableOptions,
    );
    expect(durable.differences).toEqual([]);
    expect(durable.passed).toBe(true);
    // Negative drift: a simulator whose byte ceiling drifts must fail on the
    // exact serialized details, under the production-native serializer.
    const drift = await contractProbe(
      "engine.serializeHeartbeatPayload.oversized.max-bytes-drift",
      () => serializeHeartbeatPayload(oversized),
      () => { throw simulatedOversized(999_999); },
      durableOptions,
    );
    expect(drift.passed).toBe(false);
    expect(drift.differences).toContain("serialized differs");
  });

  test("family 3: production SQLite write-retry exhaustion under a genuinely held lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-testing-parity-lock-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "locked.db");
    const setup = new Database(dbPath);
    setup.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)");
    setup.close();
    // A REAL reserved lock held by a second connection — not an interception.
    const freezer = new Database(dbPath);
    freezer.exec("BEGIN IMMEDIATE");
    freezer.exec("INSERT INTO probe (v) VALUES ('held')");
    const victim = new Database(dbPath);
    let attempts = 0;
    let productionError: unknown;
    const simulatedLockError = (extra: Record<string, unknown>) => simulationNativeError({ className: "Error", name: "SQLiteError", message: "database is locked", code: "SQLITE_BUSY", extra });
    try {
      const production = () => withSqliteWriteRetry(() => { attempts++; victim.exec("INSERT INTO probe (v) VALUES ('blocked')"); }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 });
      const report = await contractProbe(
        "db.withSqliteWriteRetry.held-lock-exhaustion",
        async () => { try { await production(); } catch (error) { productionError = error; throw error; } },
        // Bun's native SQLiteError exposes constructor name "Error" with
        // name "SQLiteError" — the double mirrors that exactly.
        () => { throw simulatedLockError({ errno: 5, byteOffset: -1 }); },
        probeOptions,
      );
      expect(report.differences).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.expected.name).toBe("SQLiteError");
      expect(report.expected.code).toBe("SQLITE_BUSY");
      // The exhaustion is real: the production retry wrapper made every
      // bounded attempt against the held lock and classified it retryable.
      expect(attempts).toBe(3);
      expect(isRetryableSqliteWriteError(productionError)).toBe(true);
      expect((productionError as { errno?: number }).errno).toBe(5);
      const durable = await contractProbe(
        "db.withSqliteWriteRetry.held-lock-exhaustion.durable",
        async () => { throw productionError; },
        () => { throw simulatedLockError({ errno: 5, byteOffset: -1 }); },
        durableOptions,
      );
      expect(durable.differences).toEqual([]);
      expect(durable.passed).toBe(true);
      // Negative native-field drift regression: identical name/code/message
      // but wrong errno/byteOffset MUST fail parity — the serializer may not
      // be blind to family-specific native fields.
      const nativeDrift = await contractProbe(
        "db.withSqliteWriteRetry.native-field-drift",
        async () => { throw productionError; },
        () => { throw simulatedLockError({ errno: 999, byteOffset: 42 }); },
        probeOptions,
      );
      expect(nativeDrift.passed).toBe(false);
      expect(nativeDrift.differences).toContain("serialized differs");
      const durableNativeDrift = await contractProbe(
        "db.withSqliteWriteRetry.native-field-drift.durable",
        async () => { throw productionError; },
        () => { throw simulatedLockError({ errno: 999, byteOffset: 42 }); },
        durableOptions,
      );
      expect(durableNativeDrift.passed).toBe(false);
      expect(durableNativeDrift.differences).toContain("serialized differs");
    } finally {
      victim.close();
      freezer.exec("COMMIT");
      freezer.close();
    }
  });

  test("family 3b: the PRODUCTION SmithersDb write boundary — DB_WRITE_FAILED under held-lock retry exhaustion", async () => {
    // The DB error shape consumers actually receive is the one packages/db
    // adapter.js `write()` produces: the native SQLite failure is mapped by
    // the real `toSmithersError` (code DB_WRITE_FAILED, details.operation)
    // INSIDE the write operation and retried through the real
    // `withSqliteWriteRetryEffect` until exhaustion, whose retryability
    // predicate walks the SmithersError's native cause chain. This probe
    // composes exactly that production pair over a REAL reserved lock held by
    // a second connection, with bounded attempts so exhaustion is provable
    // without the adapter's multi-second default backoff. The raw
    // Promise-helper probe above remains as additional native-layer coverage;
    // it does not certify this boundary.
    const dir = mkdtempSync(join(tmpdir(), "smithers-testing-parity-dbwrite-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "locked.db");
    const setup = new Database(dbPath);
    setup.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)");
    setup.close();
    const freezer = new Database(dbPath);
    freezer.exec("BEGIN IMMEDIATE");
    freezer.exec("INSERT INTO probe (v) VALUES ('held')");
    const victim = new Database(dbPath);
    const label = "insert probe row";
    let attempts = 0;
    let productionError: unknown;
    // The reusable simulation double: a harness-native SmithersError shape
    // whose cause is the harness-native SQLiteError shape — constructed
    // independently, never copied from the production error instance.
    const simulatedWriteFailure = (options: Readonly<{ code?: string; operation?: string; causeCode?: string; causeExtra?: Record<string, unknown> }> = {}) =>
      simulationSmithersError(options.code ?? "DB_WRITE_FAILED", `${label}: database is locked`, {
        details: { operation: options.operation ?? label },
        cause: simulationNativeError({
          className: "Error",
          name: "SQLiteError",
          message: "database is locked",
          code: options.causeCode ?? "SQLITE_BUSY",
          extra: options.causeExtra ?? { errno: 5, byteOffset: -1 },
        }),
      });
    try {
      const production = async () => {
        const result = await Effect.runPromise(Effect.result(withSqliteWriteRetryEffect(
          () => Effect.tryPromise({
            try: async () => { attempts++; victim.exec("INSERT INTO probe (v) VALUES ('blocked')"); },
            catch: (cause) => toSmithersError(cause, label, { code: "DB_WRITE_FAILED", details: { operation: label } }),
          }),
          { label, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
        )));
        if (Result.isFailure(result)) throw result.failure;
        return result.success;
      };
      const report = await contractProbe(
        "db.smithersdb-write-boundary.held-lock-exhaustion",
        async () => { try { return await production(); } catch (error) { productionError = error; throw error; } },
        () => { throw simulatedWriteFailure(); },
        probeOptions,
      );
      expect(report.differences).toEqual([]);
      expect(report.passed).toBe(true);
      // Class, name, code, details, and the native SQLite cause of the REAL
      // production boundary error.
      expect(report.expected.className).toBe("SmithersError");
      expect(report.expected.name).toBe("SmithersError");
      expect(report.expected.code).toBe("DB_WRITE_FAILED");
      expect(report.expected.detailsKeys).toEqual(["operation"]);
      expect(report.expected.cause?.name).toBe("SQLiteError");
      expect(report.expected.cause?.code).toBe("SQLITE_BUSY");
      // The exhaustion is real: the production Effect retry schedule made
      // every bounded attempt against the held lock, and its retryability
      // predicate classified the SmithersError THROUGH its native cause chain.
      expect(attempts).toBe(3);
      expect(isRetryableSqliteWriteError(productionError)).toBe(true);
      expect(((productionError as Error).cause as { errno?: number } | undefined)?.errno).toBe(5);
      // Production durable serialization: the real errorToJson output of the
      // real boundary error must match the independent simulation serializer.
      const durable = await contractProbe(
        "db.smithersdb-write-boundary.held-lock-exhaustion.durable",
        async () => { throw productionError; },
        () => { throw simulatedWriteFailure(); },
        durableOptions,
      );
      expect(durable.differences).toEqual([]);
      expect(durable.passed).toBe(true);
      // Negative drift, one mutated simulator field each, asserting the exact
      // differing field: top-level code, details payload, native cause code,
      // and cause-level native fields.
      const codeDrift = await contractProbe(
        "db.smithersdb-write-boundary.code-drift",
        async () => { throw productionError; },
        () => { throw simulatedWriteFailure({ code: "DB_QUERY_FAILED" }); },
        probeOptions,
      );
      expect(codeDrift.passed).toBe(false);
      expect(codeDrift.differences).toContain("code differs");
      const detailsDrift = await contractProbe(
        "db.smithersdb-write-boundary.details-drift",
        async () => { throw productionError; },
        () => { throw simulatedWriteFailure({ operation: "drifted operation" }); },
        durableOptions,
      );
      expect(detailsDrift.passed).toBe(false);
      expect(detailsDrift.differences).toContain("details differs");
      const causeCodeDrift = await contractProbe(
        "db.smithersdb-write-boundary.cause-code-drift",
        async () => { throw productionError; },
        () => { throw simulatedWriteFailure({ causeCode: "SQLITE_LOCKED" }); },
        probeOptions,
      );
      expect(causeCodeDrift.passed).toBe(false);
      expect(causeCodeDrift.differences).toContain("cause differs");
      const causeNativeDrift = await contractProbe(
        "db.smithersdb-write-boundary.cause-native-drift",
        async () => { throw productionError; },
        () => { throw simulatedWriteFailure({ causeExtra: { errno: 999, byteOffset: 42 } }); },
        probeOptions,
      );
      expect(causeNativeDrift.passed).toBe(false);
      expect(causeNativeDrift.differences).toContain("serialized differs");
    } finally {
      victim.close();
      freezer.exec("COMMIT");
      freezer.close();
    }
  });

  test("family 4: a live child killed by an EXTERNAL SIGKILL at the production spawn boundary", async () => {
    // The kill is delivered by THIS test process to the child's real pid —
    // production code never initiates it. Production truth at the
    // spawnCaptureEffect boundary: an externally SIGKILLed child is NOT an
    // error; it resolves with `exitCode: null` and the caller must classify.
    // The parity probe pins exactly that shape, and the negative regressions
    // prove a simulation that models the kill as a thrown error or as the
    // folk-wisdom `exitCode: 137` fails parity.
    let pid: number | undefined;
    const spawnAndKill = async () => {
      pid = undefined;
      const pending = Effect.runPromise(Effect.result(spawnCaptureEffect("sleep", ["30"], {
        cwd: process.cwd(),
        onProcess: (event: { phase: string; pid?: number }) => { if (event.phase === "started") pid = event.pid; },
      })));
      const deadline = Date.now() + 5_000;
      while (pid === undefined && Date.now() < deadline) await Bun.sleep(10);
      expect(pid).toBeGreaterThan(0);
      process.kill(pid!, "SIGKILL");
      const result = await pending;
      if (Result.isFailure(result)) throw result.failure;
      return result.success;
    };
    const killedResult = { stdout: "", stderr: "", exitCode: null, stdoutTruncated: false, stderrTruncated: false };
    const report = await contractProbe("driver.spawnCaptureEffect.external-sigkill", spawnAndKill, () => killedResult, probeOptions);
    expect(report.differences).toEqual([]);
    expect(report.passed).toBe(true);
    // The child was real and the external SIGKILL genuinely terminated it.
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid!, 0); await Bun.sleep(25); } catch { alive = false; }
    }
    expect(alive).toBe(false);
    // Production-native serialization of the boundary VALUE: a fresh real
    // spawn+SIGKILL run serialized by the production durable serializer must
    // match the simulation shape exactly.
    const durable = await contractProbe("driver.spawnCaptureEffect.external-sigkill.durable", spawnAndKill, () => killedResult, durableOptions);
    expect(durable.differences).toEqual([]);
    expect(durable.passed).toBe(true);
    const exitCodeDrift = await contractProbe(
      "driver.spawnCaptureEffect.external-sigkill.exit-code-drift",
      async () => killedResult,
      () => ({ ...killedResult, exitCode: 137 }),
      durableOptions,
    );
    expect(exitCodeDrift.passed).toBe(false);
    expect(exitCodeDrift.differences).toContain("serialized differs");
    const thrownDrift = await contractProbe(
      "driver.spawnCaptureEffect.external-sigkill.thrown-drift",
      async () => killedResult,
      () => { throw simulationSmithersError("PROCESS_ABORTED", "child killed"); },
      durableOptions,
    );
    expect(thrownDrift.passed).toBe(false);
    expect(thrownDrift.differences).toContain("production and simulation must both throw or both succeed");
  }, { timeout: 30_000 });

  test("timeout family (retained, distinct from external SIGKILL): the production timeout path kills its own child", async () => {
    let pid: number | undefined;
    const production = async () => {
      const result = await Effect.runPromise(Effect.result(spawnCaptureEffect("sleep", ["30"], {
        cwd: process.cwd(),
        timeoutMs: 150,
        onProcess: (event: { phase: string; pid?: number }) => { if (event.phase === "started") pid = event.pid; },
      })));
      if (Result.isFailure(result)) throw result.failure;
      return result.success;
    };
    const simulatedTimeout = () => simulationSmithersError("PROCESS_TIMEOUT", "CLI timed out after 150ms", { details: { command: "sleep", args: ["30"], cwd: process.cwd(), timeoutMs: 150, idleTimeoutMs: undefined } });
    const report = await contractProbe(
      "driver.spawnCaptureEffect.timeout-kill",
      production,
      () => { throw simulatedTimeout(); },
      probeOptions,
    );
    expect(report.differences).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.expected.className).toBe("SmithersError");
    expect(report.expected.code).toBe("PROCESS_TIMEOUT");
    const durable = await contractProbe(
      "driver.spawnCaptureEffect.timeout-kill.durable",
      production,
      () => { throw simulatedTimeout(); },
      durableOptions,
    );
    expect(durable.differences).toEqual([]);
    expect(durable.passed).toBe(true);
    // The kill is real: the production timeout path SIGKILLed the live child,
    // so its pid no longer exists.
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid!, 0); await Bun.sleep(25); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  }, { timeout: 20_000 });
});
