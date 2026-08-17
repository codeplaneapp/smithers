import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessTree, taskkillArgs } from "../src/child-process.js";

/**
 * `killProcessTree` is the pid-addressed sibling of `killChildTree` used by
 * subtree cancellation (#971, #972) to reap detached run owners and agent
 * process trees recorded only as pids. These tests drive REAL processes: a
 * detached group leader with a real grandchild, a SIGTERM-ignoring process
 * that must be escalated to SIGKILL, and a real `taskkill` shim on PATH for
 * the win32 branch.
 */

/** Pids spawned by a test; reaped afterEach so a failure cannot leak them. */
const spawnedPids = [];
const tempDirs = [];
afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "kill-process-tree-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Spawn a detached process-group LEADER that itself spawns a grandchild in the
 * same group — the exact shape of an agent CLI that fans out subagents. Both
 * pids are written to files so the test can assert the whole tree died.
 *
 * @param {string} dir
 * @param {{ ignoreSigterm?: boolean }} [options]
 * @returns {Promise<{ leaderPid: number; grandchildPid: number }>}
 */
async function spawnDetachedTree(dir, options = {}) {
  const leaderFile = join(dir, "leader.pid");
  const grandchildFile = join(dir, "grandchild.pid");
  const ignore = options.ignoreSigterm === true;
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const { writeFileSync } = require("node:fs");
       ${ignore ? 'process.on("SIGTERM", () => {});' : ""}
       const child = spawn(process.execPath, ["-e", '${ignore ? 'process.on("SIGTERM", () => {});' : ""}setInterval(() => {}, 1000)'], { stdio: "ignore" });
       writeFileSync(process.env.GRANDCHILD_FILE, String(child.pid));
       writeFileSync(process.env.LEADER_FILE, String(process.pid));
       setInterval(() => {}, 1000);`,
    ],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, LEADER_FILE: leaderFile, GRANDCHILD_FILE: grandchildFile },
    },
  );
  leader.unref();
  spawnedPids.push(leader.pid);
  await waitFor(() => existsSync(leaderFile) && existsSync(grandchildFile));
  const grandchildPid = Number(readFileSync(grandchildFile, "utf8").trim());
  spawnedPids.push(grandchildPid);
  return { leaderPid: leader.pid, grandchildPid };
}

describe("killProcessTree — guards", () => {
  test("refuses non-positive, non-integer and missing pids", async () => {
    for (const pid of [0, -1, 1.5, null, undefined, Number.NaN]) {
      expect(await killProcessTree(/** @type {any} */ (pid))).toEqual({
        terminated: false,
        skipped: true,
        escalated: false,
      });
    }
  });

  test("refuses to signal our own pid", async () => {
    expect(await killProcessTree(process.pid)).toEqual({ terminated: false, skipped: true, escalated: false });
  });

  test("refuses to signal our own process group", async () => {
    const killed = [];
    const outcome = await killProcessTree(4242, {
      platform: "linux",
      getpgrp: () => 4242,
      kill: (pid, signal) => killed.push([pid, signal]),
      alive: () => true,
    });
    expect(outcome).toEqual({ terminated: false, skipped: true, escalated: false });
    // A group kill on our own pgid would take the caller down with the target.
    expect(killed).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("killProcessTree — real POSIX process trees", () => {
  test("SIGTERM takes down the whole detached group, grandchild included", async () => {
    const { leaderPid, grandchildPid } = await spawnDetachedTree(makeTempDir());
    expect(pidAlive(leaderPid)).toBe(true);
    expect(pidAlive(grandchildPid)).toBe(true);

    const outcome = await killProcessTree(leaderPid, { graceMs: 5_000 });

    expect(outcome.terminated).toBe(true);
    expect(outcome.skipped).toBe(false);
    expect(outcome.escalated).toBe(false);
    expect(await waitFor(() => !pidAlive(leaderPid))).toBe(true);
    expect(await waitFor(() => !pidAlive(grandchildPid))).toBe(true);
  });

  test("escalates to SIGKILL when the tree ignores SIGTERM", async () => {
    const { leaderPid, grandchildPid } = await spawnDetachedTree(makeTempDir(), { ignoreSigterm: true });

    const outcome = await killProcessTree(leaderPid, { graceMs: 300 });

    expect(outcome.terminated).toBe(true);
    expect(outcome.escalated).toBe(true);
    expect(await waitFor(() => !pidAlive(leaderPid))).toBe(true);
    expect(await waitFor(() => !pidAlive(grandchildPid))).toBe(true);
  });

  test("falls back to the bare pid when the target is not a group leader", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    spawnedPids.push(child.pid);
    await waitFor(() => pidAlive(child.pid));

    const outcome = await killProcessTree(child.pid, { graceMs: 5_000 });

    expect(outcome.terminated).toBe(true);
    expect(await waitFor(() => !pidAlive(child.pid))).toBe(true);
  });

  test("an already-dead pid reports terminated without escalating", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid;
    await new Promise((resolvePromise) => child.on("exit", resolvePromise));
    await waitFor(() => !pidAlive(pid));

    const outcome = await killProcessTree(pid, { graceMs: 100 });

    expect(outcome.terminated).toBe(true);
    expect(outcome.skipped).toBe(false);
    expect(outcome.escalated).toBe(false);
  });
});

describe("killProcessTree — win32 taskkill branch", () => {
  test("taskkillArgs is the /T /F tree kill shared with killChildTree", () => {
    expect(taskkillArgs(1234)).toEqual(["/PID", "1234", "/T", "/F"]);
  });

  // On real Windows `spawnSync("taskkill")` resolves the actual taskkill.exe,
  // so the shim harness only runs from POSIX. Real win32 coverage comes from
  // the platform e2e suites.
  test.skipIf(process.platform === "win32")("runs taskkill /T /F and reports the tree terminated", async () => {
    const dir = makeTempDir();
    const argsFile = join(dir, "args.txt");
    const shim = join(dir, "taskkill");
    writeFileSync(shim, `#!/bin/sh\nprintf '%s ' "$@" > "${argsFile}"\nexit 0\n`);
    chmodSync(shim, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${dir}:${previousPath}`;
    try {
      const outcome = await killProcessTree(999_999, { platform: "win32", alive: () => false });
      expect(outcome).toEqual({ terminated: true, skipped: false, escalated: false });
      expect(readFileSync(argsFile, "utf8").trim()).toBe("/PID 999999 /T /F");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("a failing taskkill still reports terminated when the pid is verifiably gone", async () => {
    const outcome = await killProcessTree(999_998, {
      platform: "win32",
      runTaskkill: () => false,
      alive: () => false,
    });
    expect(outcome).toEqual({ terminated: true, skipped: false, escalated: false });
  });

  test("a failing taskkill against a surviving pid reports not terminated", async () => {
    const outcome = await killProcessTree(999_997, {
      platform: "win32",
      runTaskkill: () => false,
      alive: () => true,
    });
    expect(outcome).toEqual({ terminated: false, skipped: false, escalated: false });
  });
});
