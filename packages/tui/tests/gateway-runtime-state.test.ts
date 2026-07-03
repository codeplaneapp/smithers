import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readWorkspaceGatewayState,
  resolveMonitorWorkspaceRoot,
  workspaceGatewayStatePath,
} from "../src/gatewayRuntimeState.ts";
// Relative import (not a bare specifier) so check-dependency-boundaries permits
// a test reaching across to the CLI writer it must stay in lockstep with. Loaded
// dynamically through a non-literal specifier + cast because the CLI is plain JS
// with no shipped .d.ts (a statically-resolvable import trips TS7016 under
// this project's stricter settings); the runtime import is unchanged.
const cliGatewayRuntimeModule = "../../../apps/cli/src/gateway-runtime.js";
const { gatewayRuntimePaths } = (await import(cliGatewayRuntimeModule)) as {
  gatewayRuntimePaths: (
    workspace: string,
    env?: Record<string, string | undefined>,
  ) => { dir: string; stateFile: string };
};

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) removeTempDir(dir);
});

function removeTempDir(dir: string) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
}

/** Write a state file under `stateDir` keyed by `workspaceRoot`, returning its path. */
function writeState(
  stateDir: string,
  workspaceRoot: string,
  state: Record<string, unknown>,
): string {
  mkdirSync(stateDir, { recursive: true });
  const { stateFile } = workspaceGatewayStatePath(workspaceRoot, { SMITHERS_GATEWAY_STATE_DIR: stateDir });
  writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  return stateFile;
}

/** Env that pins BOTH the state dir and the workspace root so tests are hermetic. */
function pinnedEnv(stateDir: string, workspaceRoot: string): Record<string, string> {
  return { SMITHERS_GATEWAY_STATE_DIR: stateDir, SMITHERS_WORKSPACE_ROOT: workspaceRoot };
}

describe("readWorkspaceGatewayState", () => {
  test("round-trips a trusted, live state file (url trailing slash stripped)", () => {
    const workspaceRoot = tempDir("smx-ws-");
    const stateDir = tempDir("smx-state-");
    writeState(stateDir, workspaceRoot, {
      pid: process.pid,
      url: "http://127.0.0.1:41234/",
      token: "tok-abc",
      workspaceRoot,
    });
    const state = readWorkspaceGatewayState(workspaceRoot, pinnedEnv(stateDir, workspaceRoot));
    expect(state).not.toBeNull();
    expect(state!.url).toBe("http://127.0.0.1:41234");
    expect(state!.token).toBe("tok-abc");
    expect(state!.pid).toBe(process.pid);
  });

  test("returns null for a dead pid", () => {
    const workspaceRoot = tempDir("smx-ws-");
    const stateDir = tempDir("smx-state-");
    writeState(stateDir, workspaceRoot, {
      pid: 2147483646, // improbable pid → process.kill throws ESRCH → not alive
      url: "http://127.0.0.1:41234",
      token: "tok",
      workspaceRoot,
    });
    expect(readWorkspaceGatewayState(workspaceRoot, pinnedEnv(stateDir, workspaceRoot))).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    const workspaceRoot = tempDir("smx-ws-");
    const stateDir = tempDir("smx-state-");
    mkdirSync(stateDir, { recursive: true });
    const { stateFile } = workspaceGatewayStatePath(workspaceRoot, { SMITHERS_GATEWAY_STATE_DIR: stateDir });
    writeFileSync(stateFile, "{ not json", { mode: 0o600 });
    expect(readWorkspaceGatewayState(workspaceRoot, pinnedEnv(stateDir, workspaceRoot))).toBeNull();
  });

  test("returns null when required fields are missing", () => {
    const workspaceRoot = tempDir("smx-ws-");
    const stateDir = tempDir("smx-state-");
    writeState(stateDir, workspaceRoot, { pid: process.pid, url: "http://127.0.0.1:41234" }); // no workspaceRoot
    expect(readWorkspaceGatewayState(workspaceRoot, pinnedEnv(stateDir, workspaceRoot))).toBeNull();
  });

  test("returns null when the file is missing", () => {
    const workspaceRoot = tempDir("smx-ws-");
    const stateDir = tempDir("smx-state-");
    expect(readWorkspaceGatewayState(workspaceRoot, pinnedEnv(stateDir, workspaceRoot))).toBeNull();
  });

  test("empty token normalizes to null", () => {
    const workspaceRoot = tempDir("smx-ws-");
    const stateDir = tempDir("smx-state-");
    writeState(stateDir, workspaceRoot, {
      pid: process.pid,
      url: "http://127.0.0.1:41234",
      token: "",
      workspaceRoot,
    });
    const state = readWorkspaceGatewayState(workspaceRoot, pinnedEnv(stateDir, workspaceRoot));
    expect(state).not.toBeNull();
    expect(state!.token).toBeNull();
  });

  test("returns null when the recorded workspace does not match (identity mismatch)", () => {
    const workspaceRoot = tempDir("smx-ws-");
    const otherWorkspace = tempDir("smx-other-");
    const stateDir = tempDir("smx-state-");
    // File is keyed by workspaceRoot but claims a DIFFERENT workspaceRoot inside.
    writeState(stateDir, workspaceRoot, {
      pid: process.pid,
      url: "http://127.0.0.1:41234",
      token: "tok",
      workspaceRoot: otherWorkspace,
    });
    expect(readWorkspaceGatewayState(workspaceRoot, pinnedEnv(stateDir, workspaceRoot))).toBeNull();
  });

  test("returns null when the state file is group/other-writable (untrusted)", () => {
    if (process.platform === "win32") return;
    const workspaceRoot = tempDir("smx-ws-");
    const stateDir = tempDir("smx-state-");
    const stateFile = writeState(stateDir, workspaceRoot, {
      pid: process.pid,
      url: "http://attacker.example/",
      token: null,
      workspaceRoot,
    });
    chmodSync(stateFile, 0o666); // world-writable → an attacker could seed url/token
    expect(readWorkspaceGatewayState(workspaceRoot, pinnedEnv(stateDir, workspaceRoot))).toBeNull();
  });

  test("returns null when the state directory is group/other-writable (untrusted)", () => {
    if (process.platform === "win32") return;
    const workspaceRoot = tempDir("smx-ws-");
    const stateDir = tempDir("smx-state-");
    writeState(stateDir, workspaceRoot, {
      pid: process.pid,
      url: "http://127.0.0.1:41234",
      token: "tok",
      workspaceRoot,
    });
    chmodSync(stateDir, 0o777);
    expect(readWorkspaceGatewayState(workspaceRoot, pinnedEnv(stateDir, workspaceRoot))).toBeNull();
    chmodSync(stateDir, 0o700); // restore so afterEach cleanup can descend
  });
});

describe("resolveMonitorWorkspaceRoot", () => {
  test("prefers SMITHERS_WORKSPACE_ROOT over the walk-up", () => {
    const ws = tempDir("smx-ws-");
    expect(resolveMonitorWorkspaceRoot("/nowhere/at/all", { SMITHERS_WORKSPACE_ROOT: ws })).toBe(resolve(ws));
  });

  test("walks up from a subdirectory to the .smithers pack root", () => {
    const ws = tempDir("smx-ws-");
    mkdirSync(join(ws, ".smithers"));
    const sub = join(ws, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(resolveMonitorWorkspaceRoot(sub, {})).toBe(ws);
  });

  test("walks up to a smithers.db when no pack exists", () => {
    const ws = tempDir("smx-ws-");
    writeFileSync(join(ws, "smithers.db"), "");
    const sub = join(ws, "nested");
    mkdirSync(sub, { recursive: true });
    expect(resolveMonitorWorkspaceRoot(sub, {})).toBe(ws);
  });
});

describe("state path parity with the CLI writer (gateway-runtime.js)", () => {
  // These assertions go RED if the TUI reader's directory or hash-key
  // convention drifted from the daemon writer's, which is exactly the class of
  // bug (Linux uid dir + cwd keying) that broke singleton reuse.
  test("default state path matches on this platform", () => {
    const workspaceRoot = tempDir("smx-ws-");
    const env = {}; // no override → both compute defaultGatewayRuntimeDir(env)
    const tui = workspaceGatewayStatePath(workspaceRoot, env);
    const cli = gatewayRuntimePaths(workspaceRoot, env);
    expect(tui.dir).toBe(cli.dir);
    expect(tui.stateFile).toBe(cli.stateFile);
  });

  test("SMITHERS_GATEWAY_STATE_DIR override path matches", () => {
    const workspaceRoot = tempDir("smx-ws-");
    const stateDir = tempDir("smx-state-");
    const env = { SMITHERS_GATEWAY_STATE_DIR: stateDir };
    expect(workspaceGatewayStatePath(workspaceRoot, env).stateFile).toBe(gatewayRuntimePaths(workspaceRoot, env).stateFile);
  });

  test("a Linux-style XDG_RUNTIME_DIR env keys identically on both sides", () => {
    // Cannot force the Linux branch on macOS (both gate on process.platform), but
    // the shared inputs must still yield identical paths per platform.
    const workspaceRoot = tempDir("smx-ws-");
    const env = { XDG_RUNTIME_DIR: tempDir("smx-xdg-") };
    expect(workspaceGatewayStatePath(workspaceRoot, env).stateFile).toBe(gatewayRuntimePaths(workspaceRoot, env).stateFile);
  });
});
