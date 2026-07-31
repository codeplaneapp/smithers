import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killChildTree } from "../src/child-process.js";

/**
 * `killChildTree` contains a defensive pid-less guard and a Windows-only
 * `taskkill` branch that the public `spawnCaptureEffect` path can never reach on
 * a POSIX box (a successfully spawned child always has a pid, and
 * `process.platform` is not "win32"). These tests drive the function directly
 * with a real `taskkill` shim placed on PATH so the Windows branch executes a
 * genuine child process rather than a mock.
 */

/**
 * Override a property on `process` (platform / versions) and return a restorer.
 * @param {"platform"} key
 * @param {unknown} value
 */
function overrideProcessProp(key, value) {
  const original = Object.getOwnPropertyDescriptor(process, key);
  Object.defineProperty(process, key, { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(process, key, original);
  };
}

/**
 * Wait until `predicate` is true or the timeout elapses.
 * @param {() => boolean} predicate
 */
async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

describe("killChildTree — defensive pid-less guard", () => {
  test("no pid falls back to child.kill('SIGKILL')", () => {
    const signals = [];
    const child = {
      pid: undefined,
      kill: (sig) => {
        signals.push(sig);
      },
    };
    killChildTree(/** @type {any} */ (child), false);
    expect(signals).toEqual(["SIGKILL"]);
  });
});

// On real Windows, spawn("taskkill") resolves the actual taskkill.exe (PATHEXT
// lookup ignores the extension-less sh shim), so the shim harness only works
// from POSIX — which is exactly the box this branch can never be reached from
// via the public path. Real win32 coverage comes from the engine e2e suites.
describe.skipIf(process.platform === "win32")("killChildTree — win32 taskkill branch", () => {
  /** @type {string} */
  let binDir;
  /** @type {(() => void) | undefined} */
  let restorePlatform;
  /** @type {string} */
  let originalPath;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "taskkill-"));
    originalPath = process.env.PATH ?? "";
    restorePlatform = overrideProcessProp("platform", "win32");
  });

  afterEach(() => {
    if (restorePlatform) restorePlatform();
    process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  /**
   * Install a `taskkill` executable that writes a completion marker and exits
   * with the given code, and put its dir at the front of PATH so
   * `spawn("taskkill")` resolves to it.
   * @param {number} exitCode
   * @returns {string} the marker path the shim writes on exit
   */
  function installTaskkill(exitCode) {
    const script = join(binDir, "taskkill");
    const marker = join(binDir, "ran.marker");
    writeFileSync(script, `#!/bin/sh\necho ran > "${marker}"\nexit ${exitCode}\n`);
    chmodSync(script, 0o755);
    process.env.PATH = `${binDir}:${originalPath}`;
    return marker;
  }

  /**
   * Install a Node-based taskkill shim that records startup and exits later.
   * @param {number} delayMs
   * @param {number} exitCode
   * @returns {string}
   */
  function installDelayedTaskkill(delayMs, exitCode) {
    const script = join(binDir, "taskkill");
    const marker = join(binDir, "started.marker");
    writeFileSync(
      script,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");\nsetTimeout(() => process.exit(${exitCode}), ${delayMs});\n`,
    );
    chmodSync(script, 0o755);
    process.env.PATH = `${binDir}:${originalPath}`;
    return marker;
  }

  test("taskkill exits 0: does not fall back to child.kill", async () => {
    const marker = installTaskkill(0);
    const signals = [];
    const child = { pid: 999999, kill: (s) => signals.push(s) };
    killChildTree(/** @type {any} */ (child), false);
    // The shim wrote the marker, so the process ran and exited; give the
    // 'exit' handler a macrotask to run its code===0 return path.
    await waitFor(() => existsSync(marker));
    await new Promise((r) => setTimeout(r, 100));
    expect(signals).toEqual([]);
  });

  test("taskkill exits non-zero: falls back to child.kill('SIGKILL')", async () => {
    installTaskkill(1);
    const signals = [];
    const child = { pid: 999999, kill: (s) => signals.push(s) };
    killChildTree(/** @type {any} */ (child), false);
    await waitFor(() => signals.length > 0);
    expect(signals).toEqual(["SIGKILL"]);
  });

  test("taskkill exits non-zero and child.kill throws: error is swallowed", async () => {
    installTaskkill(1);
    let attempts = 0;
    const child = {
      pid: 999999,
      kill: () => {
        attempts += 1;
        throw new Error("kill failed");
      },
    };
    killChildTree(/** @type {any} */ (child), false);
    await waitFor(() => attempts > 0);
    expect(attempts).toBe(1);
  });

  test("taskkill spawn error (ENOENT): falls back to child.kill('SIGKILL')", async () => {
    // No taskkill on PATH → spawn emits an 'error' event.
    process.env.PATH = binDir; // empty dir, taskkill absent
    const signals = [];
    const child = { pid: 999999, kill: (s) => signals.push(s) };
    killChildTree(/** @type {any} */ (child), false);
    await waitFor(() => signals.length > 0);
    expect(signals).toEqual(["SIGKILL"]);
  });

  test("taskkill spawn error and child.kill throws: error is swallowed", async () => {
    process.env.PATH = binDir; // taskkill absent → 'error' event
    let attempts = 0;
    const child = {
      pid: 999999,
      kill: () => {
        attempts += 1;
        throw new Error("kill failed");
      },
    };
    killChildTree(/** @type {any} */ (child), false);
    await waitFor(() => attempts > 0);
    expect(attempts).toBe(1);
  });

  test("hung taskkill is bounded and cannot run a late direct-kill fallback", async () => {
    const marker = installDelayedTaskkill(10_000, 1);
    const signals = [];
    const child = { pid: 999999, exitCode: null, signalCode: null, kill: (s) => signals.push(s) };
    killChildTree(/** @type {any} */ (child), false);
    await waitFor(() => existsSync(marker));
    await new Promise((r) => setTimeout(r, 1_200));
    expect(signals).toEqual([]);
  });

  test("late taskkill failure does not kill an already-exited target", async () => {
    installDelayedTaskkill(100, 1);
    const signals = [];
    const child = { pid: 999999, exitCode: null, signalCode: null, kill: (s) => signals.push(s) };
    killChildTree(/** @type {any} */ (child), false);
    child.exitCode = 0;
    await new Promise((r) => setTimeout(r, 250));
    expect(signals).toEqual([]);
  });
});
