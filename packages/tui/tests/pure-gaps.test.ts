import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { resolveCliEntry } from "../src/cliEntry.ts";
import { DEFAULT_GATEWAY_PORT, resolveGatewayConfig } from "../src/gatewayConfig.ts";
import { resolveMonitorWorkspaceRoot, workspaceGatewayStatePath } from "../src/gatewayRuntimeState.ts";
import {
  resolveGatewayForRun,
  type GatewayCandidate,
  type GatewayStartupDeps,
  type ServesRun,
} from "../src/startupGateway.ts";
import { hijackCandidates, killHijackChild, type HijackChildLike } from "../src/modes/hijackUtils.ts";
import { Keybindings } from "../src/Keybindings.tsx";
import { deriveOutputText } from "../src/modes/TreeMode.tsx";
import { readWorkspaceGatewayState } from "../src/gatewayRuntimeState.ts";
import { chmodSync, writeFileSync } from "node:fs";

// ─── cliEntry.resolveCliEntry ─────────────────────────────────────────────────

describe("resolveCliEntry", () => {
  const priorEnv = process.env.SMITHERS_CLI;
  afterEach(() => {
    if (priorEnv === undefined) delete process.env.SMITHERS_CLI;
    else process.env.SMITHERS_CLI = priorEnv;
  });

  test("prefers SMITHERS_CLI when set", () => {
    process.env.SMITHERS_CLI = "/custom/cli/entry.js";
    expect(resolveCliEntry()).toBe("/custom/cli/entry.js");
  });

  test("resolves the installed @smithers-orchestrator/cli entry to a filesystem path", () => {
    delete process.env.SMITHERS_CLI;
    const entry = resolveCliEntry();
    expect(entry).not.toBeNull();
    // fileURLToPath output: an absolute path (platform separators), no
    // file:// scheme.
    expect(entry!.split(sep).join("/")).toContain("apps/cli/src/index.js");
    expect(entry!.startsWith("file:")).toBe(false);
  });

  test("returns null when module resolution throws (CLI not installed alongside)", () => {
    delete process.env.SMITHERS_CLI;
    expect(
      resolveCliEntry(() => {
        throw new Error("ERR_MODULE_NOT_FOUND");
      }),
    ).toBeNull();
  });
});

// ─── gatewayConfig: invalid pinned URL falls back to the default port ──────────

describe("resolveGatewayConfig – invalid pinned URL", () => {
  test("a non-URL SMITHERS_GATEWAY_URL with no --port falls back to the default port", () => {
    const cfg = resolveGatewayConfig({ gatewayUrlArg: "not-a-valid-url", env: {} });
    expect(cfg.port).toBe(DEFAULT_GATEWAY_PORT);
    expect(cfg.autoStartAllowed).toBe(false);
    expect(cfg.base).toBe("not-a-valid-url");
  });
});

// ─── gatewayRuntimeState edge branches ────────────────────────────────────────

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gatewayRuntimeState edge branches", () => {
  test("canonicalWorkspacePath falls back to resolve() when realpath throws (missing path)", () => {
    // A workspace root that does not exist on disk: realpathSync throws ENOENT,
    // so canonicalWorkspacePath returns resolve(path). The hash is still stable.
    const missing = join(tmpdir(), "smithers-tui-does-not-exist-xyz");
    const a = workspaceGatewayStatePath(missing, { SMITHERS_GATEWAY_STATE_DIR: "/state" });
    const b = workspaceGatewayStatePath(resolve(missing), { SMITHERS_GATEWAY_STATE_DIR: "/state" });
    expect(a.stateFile).toBe(b.stateFile);
    // join() renders the pinned "/state" dir with platform separators.
    expect(dirname(a.stateFile)).toBe(join("/state"));
  });

  test("resolveMonitorWorkspaceRoot returns the start dir when no marker exists anywhere up the tree", () => {
    // A fresh temp dir under the OS tmp root: no `.smithers/` pack and no
    // `smithers.db` in it or any ancestor, so both walk-up passes exhaust and
    // the start directory is returned unchanged.
    const dir = tempDir("smx-nomarker-");
    const nested = join(dir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(resolveMonitorWorkspaceRoot(nested, {})).toBe(resolve(nested));
  });

  // The Linux branch additionally requires process.getuid, which does not
  // exist on Windows, so faking process.platform cannot reach it there.
  test.skipIf(process.platform === "win32")(
    "defaultGatewayRuntimeDir uses XDG_RUNTIME_DIR on Linux, else a uid-scoped tmp dir",
    () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        // XDG set → <XDG>/smithers-gateway
        const withXdg = workspaceGatewayStatePath("/ws", { XDG_RUNTIME_DIR: "/run/user/1000" });
        expect(withXdg.dir).toBe("/run/user/1000/smithers-gateway");
        // XDG unset → <tmp>/smithers-gateway-<uid>
        const noXdg = workspaceGatewayStatePath("/ws", {});
        expect(noXdg.dir).toContain("smithers-gateway-");
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    },
  );
});

// ─── deriveOutputText: produced envelope with a null row ──────────────────────

describe("deriveOutputText produced-with-null-row", () => {
  const node: GatewayRunNode = { id: "n", name: "n", kind: "task", status: "ok" };
  test("a 'produced' envelope whose row is null falls through to '(no output)'", () => {
    expect(deriveOutputText({ status: "produced", row: null, schema: null }, node)).toBe("(no output)");
  });
});

// ─── readWorkspaceGatewayState: unreadable-but-trusted file ────────────────────

describe("readWorkspaceGatewayState unreadable file", () => {
  test("returns null when a trusted state file cannot be read", () => {
    if (process.platform === "win32") return;
    // Root ignores permission bits (0o000 stays readable), so this EACCES path
    // can only be exercised as a non-root user.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const stateDir = tempDir("smx-unread-");
    chmodSync(stateDir, 0o700);
    const workspaceRoot = tempDir("smx-ws-");
    const { stateFile } = workspaceGatewayStatePath(workspaceRoot, { SMITHERS_GATEWAY_STATE_DIR: stateDir });
    writeFileSync(stateFile, JSON.stringify({ pid: process.pid, url: "http://127.0.0.1:9", workspaceRoot }), {
      mode: 0o600,
    });
    // Owner-only, no read bit: lstat-based trust passes but readFileSync throws
    // EACCES → the reader swallows it and returns null.
    chmodSync(stateFile, 0o000);
    const result = readWorkspaceGatewayState(workspaceRoot, {
      SMITHERS_GATEWAY_STATE_DIR: stateDir,
      SMITHERS_WORKSPACE_ROOT: workspaceRoot,
    });
    chmodSync(stateFile, 0o600); // restore so cleanup can remove it
    expect(result).toBeNull();
  });
});

// ─── startupGateway remaining branches ────────────────────────────────────────

function makeDeps(overrides: {
  probe?: Record<string, boolean>;
  servesRun?: Record<string, ServesRun>;
  autoStartServes?: ServesRun;
  autoStartAllowed?: boolean;
  hasCliEntry?: boolean;
  workspaceGateway?: GatewayCandidate | null;
}) {
  const calls = { autoStart: [] as GatewayCandidate[], logs: [] as string[] };
  const servesRunMap = overrides.servesRun ?? {};
  const deps: GatewayStartupDeps = {
    runId: "run-1",
    base: "http://127.0.0.1:7331",
    port: 7331,
    token: undefined,
    autoStartAllowed: overrides.autoStartAllowed ?? true,
    hasCliEntry: overrides.hasCliEntry ?? true,
    probe: async (candidate) => overrides.probe?.[candidate.base] ?? false,
    servesRun: async (candidate) => {
      if (calls.autoStart.some((s) => s.base === candidate.base)) return overrides.autoStartServes ?? "yes";
      return servesRunMap[candidate.base] ?? "no";
    },
    autoStart: async (candidate) => {
      calls.autoStart.push(candidate);
      return true;
    },
    findFreePort: async () => 45000 + calls.autoStart.length,
    isPortBusy: async () => false,
    discoverWorkspaceGateway: async () => overrides.workspaceGateway ?? null,
    log: (m) => calls.logs.push(m),
  };
  return { deps, calls };
}

describe("resolveGatewayForRun remaining branches", () => {
  test("an autostarted gateway that rejects the token surfaces a token error", async () => {
    const { deps } = makeDeps({
      // Configured unreachable → no workspace gateway → autostart a dedicated one,
      // which then answers getRun with 401/403.
      probe: {},
      autoStartServes: "unauthorized",
    });
    const result = await resolveGatewayForRun(deps);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("rejected the token");
    }
  });

  test("reachable-but-wrong-workspace with no workspace gateway and no CLI entry errors out", async () => {
    const { deps } = makeDeps({
      probe: { "http://127.0.0.1:7331": true },
      servesRun: { "http://127.0.0.1:7331": "no" },
      workspaceGateway: null,
      hasCliEntry: false,
    });
    const result = await resolveGatewayForRun(deps);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("no smithers CLI entry to autostart one");
    }
  });
});

// ─── hijackUtils remaining branches ───────────────────────────────────────────

describe("hijackCandidates tree-status fallback", () => {
  test("appends a tree-status running node that has no event-derived session", () => {
    // No events → activeNodeIdsFromEvents is empty, so the only candidate comes
    // from the tree-status running-node fallback branch.
    const nodes = [
      { id: "root", name: "root", kind: "task", status: "running" as const },
      { id: "done", name: "done", kind: "task", status: "done" as const },
    ];
    const result = hijackCandidates(nodes, []);
    expect(result.map((n) => n.id)).toEqual(["root"]);
  });

  test("does not duplicate a node already found via events", () => {
    const nodes = [{ id: "n1", name: "n1", kind: "task", status: "running" as const }];
    const events = [
      { type: "event" as const, seq: 1, event: "node.start", payload: { nodeId: "n1" }, stateVersion: 1 },
    ];
    const result = hijackCandidates(nodes, events);
    expect(result.map((n) => n.id)).toEqual(["n1"]);
  });
});

describe("killHijackChild process-group path", () => {
  test("signals the child's process group on POSIX and returns", async () => {
    if (process.platform === "win32") return;
    // Spawn a REAL child that LEADS its own process group (detached → setsid), so
    // killHijackChild's group-kill branch (process.kill(-pid)) signals it.
    const child = nodeSpawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 50));
    const pid = child.pid!;
    const fake: HijackChildLike = {
      pid,
      exitCode: null,
      signalCode: null,
      on: () => fake,
      kill: () => {
        throw new Error("direct kill should not be reached on the group-kill path");
      },
    };
    const exited = new Promise<NodeJS.Signals | null>((resolve) => {
      child.on("exit", (_code, signal) => resolve(signal));
    });
    killHijackChild(fake);
    // The group signal reached the real child.
    expect(await exited).toBe("SIGTERM");
  });

  test("falls back to a direct kill when the group signal throws (stale pid)", () => {
    let directKilled = false;
    const fake: HijackChildLike = {
      // A pid that is not a live process: process.kill(-pid) throws ESRCH, so the
      // group-kill branch falls through to the direct kill.
      pid: 2147483646,
      exitCode: null,
      signalCode: null,
      on: () => fake,
      kill: () => {
        directKilled = true;
        return true;
      },
    };
    killHijackChild(fake);
    expect(directKilled).toBe(true);
  });
});

// ─── Keybindings ──────────────────────────────────────────────────────────────

describe("Keybindings context element", () => {
  test("Keybindings returns a provider element carrying the keymap", () => {
    const custom = { entries: [{ key: "z", description: "Zoom" }] };
    const el = Keybindings({ keymap: custom, children: null }) as { props: { value: { keymap: unknown } } };
    expect(el.props.value).toEqual({ keymap: custom });
  });

  test("Keybindings defaults to the built-in keymap", () => {
    const el = Keybindings({ children: null }) as { props: { value: { keymap: { entries: unknown[] } } } };
    expect(el.props.value.keymap.entries.length).toBeGreaterThan(0);
  });
});
