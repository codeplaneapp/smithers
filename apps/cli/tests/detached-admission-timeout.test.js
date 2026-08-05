import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DETACHED_ADMISSION_TIMEOUT_ENV, DETACHED_ADMISSION_TIMEOUT_MS } from "../src/detached-admission.js";

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
