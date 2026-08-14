import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DETACHED_ADMISSION_TIMEOUT_ENV,
  DETACHED_ADMISSION_TIMEOUT_MS,
  detachedAdmissionMarker,
  waitForDetachedAdmission,
} from "../src/detached-admission.js";

const MODULE_URL = new URL("../src/detached-admission.js", import.meta.url).href;

// DETACHED_ADMISSION_TIMEOUT_MS is resolved once, at module evaluation time, so
// each env case needs its own process: re-importing inside this one would just
// hand back the cached module. The child prints the resolved constant as JSON.
function resolveTimeoutWithEnv(value) {
  const env = { ...process.env };
  if (value === undefined) delete env[DETACHED_ADMISSION_TIMEOUT_ENV];
  else env[DETACHED_ADMISSION_TIMEOUT_ENV] = value;

  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `const m = await import(${JSON.stringify(MODULE_URL)});\nconsole.log(JSON.stringify({ timeoutMs: m.DETACHED_ADMISSION_TIMEOUT_MS }));`,
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), env, encoding: "utf8" },
  );

  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()).timeoutMs;
}

describe("detached admission timeout", () => {
  test("exposes the env var name the timeout is read from", () => {
    expect(DETACHED_ADMISSION_TIMEOUT_ENV).toBe("SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS");
  });

  test("defaults to 30s when the env var is unset or empty", () => {
    expect(resolveTimeoutWithEnv(undefined)).toBe(30_000);
    expect(resolveTimeoutWithEnv("")).toBe(30_000);
  });

  test("honours an override at or above the 1000ms floor", () => {
    expect(resolveTimeoutWithEnv("5000")).toBe(5_000);
    expect(resolveTimeoutWithEnv("1000")).toBe(1_000);
    expect(resolveTimeoutWithEnv("120000")).toBe(120_000);
  });

  test("falls back to the default for values below the floor", () => {
    expect(resolveTimeoutWithEnv("999")).toBe(30_000);
    expect(resolveTimeoutWithEnv("0")).toBe(30_000);
    expect(resolveTimeoutWithEnv("-1")).toBe(30_000);
  });

  test("falls back to the default for values that are not numbers", () => {
    expect(resolveTimeoutWithEnv("soon")).toBe(30_000);
    expect(resolveTimeoutWithEnv("NaN")).toBe(30_000);
  });

  test("the module-scope default is itself a valid timeout", () => {
    expect(DETACHED_ADMISSION_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
  });
});

// A live ChildProcess stand-in: EventEmitter carrying the fields
// waitForDetachedAdmission reads (pid, exitCode, signalCode, on/off).
function fakeChild(pid = 43210) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function admissionFixture() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-admission-"));
  const logFile = join(dir, "run.log");
  writeFileSync(logFile, "");
  return { logFile, nonce: "test-nonce" };
}

describe("detached admission live-child grace", () => {
  test("admits a slow-booting live child after the timeout but within the grace window", async () => {
    const { logFile, nonce } = admissionFixture();
    const child = fakeChild();
    const slowBootCalls = [];
    const timer = setTimeout(() => {
      writeFileSync(logFile, `${detachedAdmissionMarker(nonce)}\n`);
    }, 250);
    try {
      const result = await waitForDetachedAdmission({
        child,
        logFile,
        nonce,
        timeoutMs: 100,
        maxWaitMs: 2_000,
        intervalMs: 10,
        onSlowBoot: (info) => slowBootCalls.push(info),
      });
      expect(result.admitted).toBe(true);
      expect(slowBootCalls).toHaveLength(1);
      expect(slowBootCalls[0].pid).toBe(child.pid);
      expect(slowBootCalls[0].maxWaitMs).toBe(2_000);
    } finally {
      clearTimeout(timer);
    }
  });

  test("a live child that never admits fails at the grace cap with pid and env hint", async () => {
    const { logFile, nonce } = admissionFixture();
    const child = fakeChild(55555);
    const slowBootCalls = [];
    const result = await waitForDetachedAdmission({
      child,
      logFile,
      nonce,
      timeoutMs: 60,
      maxWaitMs: 240,
      intervalMs: 10,
      onSlowBoot: (info) => slowBootCalls.push(info),
    });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain("pid 55555");
    expect(result.reason).toContain("still alive");
    expect(result.reason).toContain(DETACHED_ADMISSION_TIMEOUT_ENV);
    expect(slowBootCalls).toHaveLength(1);
  });

  test("a child that admits before the timeout never triggers the slow-boot notice", async () => {
    const { logFile, nonce } = admissionFixture();
    writeFileSync(logFile, `${detachedAdmissionMarker(nonce)}\n`);
    const slowBootCalls = [];
    const result = await waitForDetachedAdmission({
      child: fakeChild(),
      logFile,
      nonce,
      timeoutMs: 1_000,
      intervalMs: 10,
      onSlowBoot: (info) => slowBootCalls.push(info),
    });
    expect(result.admitted).toBe(true);
    expect(slowBootCalls).toHaveLength(0);
  });

  test("a child that exits before admission keeps the exit reason", async () => {
    const { logFile, nonce } = admissionFixture();
    const child = fakeChild();
    const timer = setTimeout(() => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    }, 30);
    try {
      const result = await waitForDetachedAdmission({
        child,
        logFile,
        nonce,
        timeoutMs: 5_000,
        intervalMs: 10,
      });
      expect(result.admitted).toBe(false);
      expect(result.reason).toContain("exited before admission (exit 1)");
    } finally {
      clearTimeout(timer);
    }
  });

  test("the grace cap never sits below the timeout", async () => {
    const { logFile, nonce } = admissionFixture();
    const child = fakeChild();
    const started = Date.now();
    const result = await waitForDetachedAdmission({
      child,
      logFile,
      nonce,
      timeoutMs: 200,
      maxWaitMs: 1,
      intervalMs: 10,
    });
    expect(result.admitted).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });
});
