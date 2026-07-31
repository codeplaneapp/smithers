import { describe, expect, onTestFinished, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalWorkspacePath,
  claimGatewayAutostartLock,
  claimGatewayDaemonStartLock,
  clearGatewayRuntimeState,
  describeGatewayStartInProgress,
  discoverWorkspaceGateway,
  gatewayAutostartWaitMs,
  gatewayRuntimePaths,
  isRemoteSession,
  isWildcardGatewayHost,
  mintGatewayToken,
  probeGatewayHealthIdentity,
  reachableGatewayUrls,
  readGatewayRuntimeState,
  readGatewayStartProgress,
  resolveGatewayBearer,
  verifyGatewayHealthIdentity,
  writeGatewayRuntimeState,
} from "../src/gateway-runtime.js";

function makeEnv() {
  const stateDir = mkdtempSync(join(tmpdir(), "smithers-gwstate-"));
  onTestFinished(() => rmSync(stateDir, { recursive: true, force: true }));
  return { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir };
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-gwws-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A real gateway-shaped /health endpoint (no mocks: actual HTTP server).
 *
 * @param {Record<string, unknown> | null} identity
 */
async function serveHealth(identity) {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, protocol: 1, features: [], stateVersion: 0, ...(identity ? { identity } : {}) }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  onTestFinished(() => new Promise((resolve) => server.close(resolve)));
  return { server, url, port: address.port };
}

/**
 * A real HTTP server whose /health NEVER answers: the request is held open so
 * the probe's per-request timeout must fire — the "gateway alive but its event
 * loop is busy" case. Held sockets are destroyed on teardown so close() can't
 * hang the test.
 */
async function serveHangingHealth() {
  const sockets = new Set();
  const server = createServer(() => {
    // Deliberately never respond.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  onTestFinished(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  );
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}

/**
 * A real /health endpoint that fails the first `failures` requests with a 500
 * (a gateway transiently erroring under load) and then answers with the given
 * identity — for exercising the discovery retry.
 *
 * @param {Record<string, unknown>} identity
 * @param {number} failures
 */
async function serveFlakyHealth(identity, failures) {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (requests <= failures) {
      res.writeHead(500);
      res.end("busy");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, protocol: 1, features: [], stateVersion: 0, identity }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  onTestFinished(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}

/** A 127.0.0.1 port with NOTHING listening (bind, read the port, close). */
async function refusedTarget() {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return { url: `http://127.0.0.1:${port}`, port };
}

/**
 * @param {string} workspace
 * @param {{ url: string; port: number }} target
 * @param {Record<string, unknown>} [overrides]
 */
function stateFor(workspace, target, overrides = {}) {
  return {
    pid: process.pid,
    host: "127.0.0.1",
    port: target.port,
    url: target.url,
    token: null,
    workspaceRoot: canonicalWorkspacePath(workspace),
    backend: "sqlite",
    version: "0.0.0-test",
    protocol: 1,
    startedAtMs: Date.now(),
    ...overrides,
  };
}

function supportsPosixOwnershipChecks() {
  return typeof process.getuid === "function";
}

async function expectRejectsGatewayStateTrust(promise) {
  try {
    await promise;
    throw new Error("Expected gateway state trust failure");
  } catch (error) {
    expect(error?.code).toBe("GATEWAY_STATE_UNTRUSTED");
  }
}

describe("runtime state file", () => {
  test("write/read round-trips and the file is owner-only", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const path = writeGatewayRuntimeState(
      workspace,
      stateFor(workspace, { url: "http://127.0.0.1:1", port: 1 }, { token: mintGatewayToken() }),
      env,
    );
    const state = readGatewayRuntimeState(workspace, env);
    expect(state?.pid).toBe(process.pid);
    expect(state?.token).toHaveLength(64);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(gatewayRuntimePaths(workspace, env).stateFile).toBe(path);
    expect(gatewayRuntimePaths(workspace, env).logFile).toMatch(/\.log$/);
  });

  test("clear only removes state belonging to the given pid", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    writeGatewayRuntimeState(
      workspace,
      stateFor(workspace, { url: "http://127.0.0.1:1", port: 1 }, { pid: 12345 }),
      env,
    );
    clearGatewayRuntimeState(workspace, 99999, env);
    expect(readGatewayRuntimeState(workspace, env)?.pid).toBe(12345);
    clearGatewayRuntimeState(workspace, 12345, env);
    expect(readGatewayRuntimeState(workspace, env)).toBeNull();
  });

  test("malformed state reads as absent", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const { dir, stateFile } = gatewayRuntimePaths(workspace, env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile, "not json {{{");
    expect(readGatewayRuntimeState(workspace, env)).toBeNull();
  });

  test("distinct workspaces get distinct state files", () => {
    const env = makeEnv();
    const a = makeWorkspace();
    const b = makeWorkspace();
    expect(gatewayRuntimePaths(a, env).stateFile).not.toBe(gatewayRuntimePaths(b, env).stateFile);
  });

  test("write refuses a group-or-other-writable state directory", () => {
    if (!supportsPosixOwnershipChecks()) return;
    const env = makeEnv();
    const workspace = makeWorkspace();
    const { dir } = gatewayRuntimePaths(workspace, env);
    chmodSync(dir, 0o777);
    onTestFinished(() => {
      try {
        chmodSync(dir, 0o700);
      } catch {}
    });
    expect(() =>
      writeGatewayRuntimeState(workspace, stateFor(workspace, { url: "http://127.0.0.1:1", port: 1 }), env),
    ).toThrow("writable by group or other users");
  });

  test("discovery refuses an untrusted state directory before parsing state", async () => {
    if (!supportsPosixOwnershipChecks()) return;
    const env = makeEnv();
    const workspace = makeWorkspace();
    const target = await serveHealth({
      workspaceRoot: workspace,
      backend: "sqlite",
      version: "1",
      pid: process.pid,
      startedAtMs: 1,
    });
    const { dir, stateFile } = gatewayRuntimePaths(workspace, env);
    writeFileSync(stateFile, `${JSON.stringify(stateFor(workspace, target))}\n`, { mode: 0o600 });
    chmodSync(dir, 0o777);
    onTestFinished(() => {
      try {
        chmodSync(dir, 0o700);
      } catch {}
    });
    await expectRejectsGatewayStateTrust(discoverWorkspaceGateway(workspace, env));
  });

  test("discovery refuses a group-or-other-writable state file", async () => {
    if (!supportsPosixOwnershipChecks()) return;
    const env = makeEnv();
    const workspace = makeWorkspace();
    const target = await serveHealth({
      workspaceRoot: workspace,
      backend: "sqlite",
      version: "1",
      pid: process.pid,
      startedAtMs: 1,
    });
    const { stateFile } = gatewayRuntimePaths(workspace, env);
    writeFileSync(stateFile, `${JSON.stringify(stateFor(workspace, target))}\n`, { mode: 0o600 });
    chmodSync(stateFile, 0o666);
    await expectRejectsGatewayStateTrust(discoverWorkspaceGateway(workspace, env));
  });
});

describe("resolveGatewayBearer", () => {
  test("uses the state-file token when the URL matches after slash normalization", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const token = mintGatewayToken();
    writeGatewayRuntimeState(
      workspace,
      stateFor(workspace, { url: "http://127.0.0.1:7331/", port: 7331 }, { token }),
      env,
    );
    expect(resolveGatewayBearer(workspace, "http://127.0.0.1:7331", { ...env, SMITHERS_TOKEN: "env-token" })).toBe(
      token,
    );
  });

  test("falls back to env when the state-file URL does not match", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    writeGatewayRuntimeState(
      workspace,
      stateFor(workspace, { url: "http://127.0.0.1:7331", port: 7331 }, { token: "state-token" }),
      env,
    );
    expect(
      resolveGatewayBearer(workspace, "http://127.0.0.1:7332", {
        ...env,
        SMITHERS_TOKEN: "env-token",
        SMITHERS_API_KEY: "api-token",
      }),
    ).toBe("env-token");
  });

  test("uses env without a workspace and prefers SMITHERS_TOKEN over SMITHERS_API_KEY", () => {
    expect(
      resolveGatewayBearer(undefined, "http://127.0.0.1:7331", {
        SMITHERS_TOKEN: "env-token",
        SMITHERS_API_KEY: "api-token",
      }),
    ).toBe("env-token");
    expect(resolveGatewayBearer(undefined, "http://127.0.0.1:7331", { SMITHERS_API_KEY: "api-token" })).toBe(
      "api-token",
    );
  });
});

describe("verifyGatewayHealthIdentity", () => {
  test("matches when the advertised workspace is the resolved workspace", async () => {
    const workspace = makeWorkspace();
    const target = await serveHealth({
      workspaceRoot: workspace,
      backend: "sqlite",
      version: "1",
      pid: process.pid,
      startedAtMs: 1,
    });
    const identity = await verifyGatewayHealthIdentity(target.url, workspace);
    expect(identity?.pid).toBe(process.pid);
  });

  test("rejects a gateway advertising a different workspace", async () => {
    const workspace = makeWorkspace();
    const other = makeWorkspace();
    const target = await serveHealth({
      workspaceRoot: other,
      backend: "sqlite",
      version: "1",
      pid: process.pid,
      startedAtMs: 1,
    });
    expect(await verifyGatewayHealthIdentity(target.url, workspace)).toBeNull();
  });

  test("rejects a gateway with no identity on the wire (older library)", async () => {
    const workspace = makeWorkspace();
    const target = await serveHealth(null);
    expect(await verifyGatewayHealthIdentity(target.url, workspace)).toBeNull();
  });

  test("rejects an unreachable url", async () => {
    const workspace = makeWorkspace();
    expect(await verifyGatewayHealthIdentity("http://127.0.0.1:1", workspace)).toBeNull();
  });
});

describe("discoverWorkspaceGateway", () => {
  test("discovers a live, identity-matching gateway", async () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const target = await serveHealth({
      workspaceRoot: workspace,
      backend: "sqlite",
      version: "1",
      pid: process.pid,
      startedAtMs: 1,
    });
    writeGatewayRuntimeState(workspace, stateFor(workspace, target), env);
    const discovered = await discoverWorkspaceGateway(workspace, env);
    expect(discovered?.state.url).toBe(target.url);
  });

  test("cleans up state pointing at a dead pid", async () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    writeGatewayRuntimeState(
      workspace,
      stateFor(workspace, { url: "http://127.0.0.1:1", port: 1 }, { pid: 999999999 }),
      env,
    );
    expect(await discoverWorkspaceGateway(workspace, env)).toBeNull();
    expect(readGatewayRuntimeState(workspace, env)).toBeNull();
  });

  test("cleans up state whose gateway now serves a different workspace", async () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const other = makeWorkspace();
    const target = await serveHealth({
      workspaceRoot: other,
      backend: "sqlite",
      version: "1",
      pid: process.pid,
      startedAtMs: 1,
    });
    writeGatewayRuntimeState(workspace, stateFor(workspace, target), env);
    expect(await discoverWorkspaceGateway(workspace, env)).toBeNull();
    expect(readGatewayRuntimeState(workspace, env)).toBeNull();
  });

  test("cleans up state whose port stopped answering", async () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    // Connection refused with a live pid: the spec-sanctioned deletable-stale
    // case (the process exists but nothing serves the recorded address).
    const target = await refusedTarget();
    writeGatewayRuntimeState(workspace, stateFor(workspace, target), env);
    expect(await discoverWorkspaceGateway(workspace, env, { backoffMs: 1 })).toBeNull();
    expect(readGatewayRuntimeState(workspace, env)).toBeNull();
  });

  test("leaves the state file for a live pid whose /health only times out", async () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    // The daemon writes its state file ONCE, after listen(); deleting it on a
    // transient probe timeout would permanently orphan a live gateway (stop
    // can't find it, autostart doubles it up). A hung /health with a live pid
    // must report "not discovered" WITHOUT deleting the file.
    const target = await serveHangingHealth();
    writeGatewayRuntimeState(workspace, stateFor(workspace, target), env);
    let testDeadline;
    try {
      const discovery = Promise.race([
        discoverWorkspaceGateway(workspace, env, { healthTimeoutMs: 50, attempts: 2, backoffMs: 1 }),
        new Promise((resolve) => {
          testDeadline = setTimeout(() => resolve("test deadline exceeded"), 2_000);
        }),
      ]);
      expect(await discovery).toBeNull();
    } finally {
      clearTimeout(testDeadline);
    }
    expect(readGatewayRuntimeState(workspace, env)?.pid).toBe(process.pid);
  });

  test("retries through a transient /health blip and discovers the live gateway", async () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const identity = { workspaceRoot: workspace, backend: "sqlite", version: "1", pid: process.pid, startedAtMs: 1 };
    // First probe hits a 500 (gateway busy/erroring), the retry succeeds: one
    // transient blip must not hide a live gateway from discovery.
    const target = await serveFlakyHealth(identity, 1);
    writeGatewayRuntimeState(workspace, stateFor(workspace, target), env);
    const discovered = await discoverWorkspaceGateway(workspace, env, { attempts: 3, backoffMs: 1 });
    expect(discovered?.state.url).toBe(target.url);
    expect(readGatewayRuntimeState(workspace, env)?.pid).toBe(process.pid);
  });
});

describe("probeGatewayHealthIdentity", () => {
  test("classifies a wrong-workspace (or identity-less) answer as a definitive mismatch", async () => {
    const workspace = makeWorkspace();
    const other = makeWorkspace();
    const wrong = await serveHealth({
      workspaceRoot: other,
      backend: "sqlite",
      version: "1",
      pid: process.pid,
      startedAtMs: 1,
    });
    expect(await probeGatewayHealthIdentity(wrong.url, workspace)).toEqual({ ok: false, reason: "mismatch" });
    const bare = await serveHealth(null);
    expect(await probeGatewayHealthIdentity(bare.url, workspace)).toEqual({ ok: false, reason: "mismatch" });
  });

  test("classifies connection refused as refused, and a timeout as transient", async () => {
    const workspace = makeWorkspace();
    const refused = await refusedTarget();
    expect(await probeGatewayHealthIdentity(refused.url, workspace)).toEqual({ ok: false, reason: "refused" });
    const hanging = await serveHangingHealth();
    expect(await probeGatewayHealthIdentity(hanging.url, workspace, { timeoutMs: 50 })).toEqual({
      ok: false,
      reason: "transient",
    });
  });

  test("matches a live gateway advertising this workspace", async () => {
    const workspace = makeWorkspace();
    const target = await serveHealth({
      workspaceRoot: workspace,
      backend: "sqlite",
      version: "1",
      pid: process.pid,
      startedAtMs: 1,
    });
    const outcome = await probeGatewayHealthIdentity(target.url, workspace);
    expect(outcome.ok).toBe(true);
    expect(outcome.identity?.pid).toBe(process.pid);
  });

  test("probes a wildcard (0.0.0.0) state URL over loopback", async () => {
    const workspace = makeWorkspace();
    const target = await serveHealth({
      workspaceRoot: workspace,
      backend: "sqlite",
      version: "1",
      pid: process.pid,
      startedAtMs: 1,
    });
    const outcome = await probeGatewayHealthIdentity(`http://0.0.0.0:${target.port}`, workspace);
    expect(outcome.ok).toBe(true);
    expect(outcome.identity?.pid).toBe(process.pid);
  });
});

describe("reachableGatewayUrls", () => {
  test("passes a loopback or named-host base through unchanged", () => {
    expect(reachableGatewayUrls("http://127.0.0.1:7331")).toEqual(["http://127.0.0.1:7331"]);
    expect(reachableGatewayUrls("http://100.64.1.2:7331")).toEqual(["http://100.64.1.2:7331"]);
  });

  test("expands a wildcard base to dialable interface URLs, Tailscale first", () => {
    const urls = reachableGatewayUrls("http://0.0.0.0:7331");
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.port).toBe("7331");
      expect(isWildcardGatewayHost(parsed.hostname)).toBe(false);
      expect(parsed.hostname).not.toBe("127.0.0.1");
    }
    const ranks = urls.map((url) => (new URL(url).hostname.startsWith("100.") ? 0 : 1));
    expect([...ranks].sort()).toEqual(ranks);
  });

  test("falls back to the raw base when the URL is unparseable", () => {
    expect(reachableGatewayUrls("not a url")).toEqual(["not a url"]);
  });
});

describe("isRemoteSession", () => {
  test("detects SSH and mosh shells only", () => {
    expect(isRemoteSession({ SSH_CONNECTION: "1" })).toBe(true);
    expect(isRemoteSession({ SSH_TTY: "/dev/ttys1" })).toBe(true);
    expect(isRemoteSession({ MOSH_CONNECTION: "1" })).toBe(true);
    expect(isRemoteSession({})).toBe(false);
  });
});

describe("claimGatewayAutostartLock", () => {
  test("second claim from a live fresh holder loses", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const first = claimGatewayAutostartLock(workspace, env);
    expect(first).not.toBeNull();
    expect(claimGatewayAutostartLock(workspace, env)).toBeNull();
    first?.release();
    const third = claimGatewayAutostartLock(workspace, env);
    expect(third).not.toBeNull();
    third?.release();
  });

  test("steals a lock held by a dead pid", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const { dir, lockFile } = gatewayRuntimePaths(workspace, env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lockFile, JSON.stringify({ pid: 999999999, atMs: Date.now() }));
    const lock = claimGatewayAutostartLock(workspace, env);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  test("steals a stale lock from a live pid", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const { dir, lockFile } = gatewayRuntimePaths(workspace, env);
    mkdirSync(dir, { recursive: true });
    // Comfortably past any staleness threshold (currently 5 minutes) so the
    // test asserts "stale claims are stealable", not the exact cutoff.
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, atMs: Date.now() - 24 * 60 * 60_000 }));
    const lock = claimGatewayAutostartLock(workspace, env);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  test("release does not remove a lock another process re-claimed", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const { lockFile } = gatewayRuntimePaths(workspace, env);
    const lock = claimGatewayAutostartLock(workspace, env);
    expect(lock).not.toBeNull();
    // Simulate a steal by another pid between our claim and release.
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid + 1, atMs: Date.now() }));
    lock?.release();
    expect(readFileSync(lockFile, "utf8")).toContain(String(process.pid + 1));
  });

  test("does not remove a fresh lock created during stale-lock steal", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const { dir, lockFile } = gatewayRuntimePaths(workspace, env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, atMs: Date.now() - 10 * 60_000, claimId: "stale" }));
    const freshClaim = { pid: process.pid, atMs: Date.now(), claimId: "fresh" };
    const lock = claimGatewayAutostartLock(workspace, env, {
      beforeStaleRename: () => {
        renameSync(lockFile, `${lockFile}.other-stale`);
        writeFileSync(lockFile, JSON.stringify(freshClaim), { flag: "wx", mode: 0o600 });
      },
    });
    expect(lock).toBeNull();
    expect(JSON.parse(readFileSync(lockFile, "utf8"))).toEqual(freshClaim);
  });

  test("daemon-start lock is independent from the autostart client lock", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const autostart = claimGatewayAutostartLock(workspace, env);
    const daemon = claimGatewayDaemonStartLock(workspace, env);
    expect(autostart).not.toBeNull();
    expect(daemon).not.toBeNull();
    daemon?.release();
    autostart?.release();
  });

  test("a big pack's wait window keeps the lock unstealable for that long", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const { dir, lockFile } = gatewayRuntimePaths(workspace, env);
    mkdirSync(dir, { recursive: true });
    // Held for 7 minutes: past the flat 5-minute staleness cutoff, but a
    // pack this size is still inside its wait window, so stealing it here
    // would spawn a SECOND daemon over a booting one.
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, atMs: Date.now() - 7 * 60_000 }));
    expect(claimGatewayAutostartLock(workspace, env, { workflowCount: 400 })).toBeNull();
    const stealable = claimGatewayAutostartLock(workspace, env, { workflowCount: 0 });
    expect(stealable).not.toBeNull();
    stealable?.release();
  });
});

describe("gatewayAutostartWaitMs", () => {
  test("scales the wait budget with the discovered-workflow count", () => {
    // A ~130-workflow pack timed out on the flat budget (#1362).
    const empty = gatewayAutostartWaitMs(0);
    const big = gatewayAutostartWaitMs(130);
    expect(empty).toBe(120_000);
    expect(big).toBeGreaterThan(empty);
    expect(gatewayAutostartWaitMs(10)).toBeGreaterThan(empty);
    expect(big).toBeGreaterThan(gatewayAutostartWaitMs(10));
  });

  test("caps the budget so a wedged boot still fails in bounded time", () => {
    expect(gatewayAutostartWaitMs(100_000)).toBe(600_000);
    expect(gatewayAutostartWaitMs(100_000)).toBe(gatewayAutostartWaitMs(1_000_000));
  });

  test("treats a missing or nonsense count as no workflows", () => {
    expect(gatewayAutostartWaitMs()).toBe(120_000);
    expect(gatewayAutostartWaitMs(Number.NaN)).toBe(120_000);
    expect(gatewayAutostartWaitMs(-5)).toBe(120_000);
  });
});

describe("describeGatewayStartInProgress", () => {
  test("reports the in-flight boot's age, bind, and load progress", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const { dir, daemonStartLockFile, logFile } = gatewayRuntimePaths(workspace, env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(daemonStartLockFile, JSON.stringify({ pid: process.pid, atMs: Date.now() - 90_000 }), {
      mode: 0o600,
    });
    writeFileSync(
      logFile,
      ["[smithers] Gateway listening on http://127.0.0.1:7331", "[smithers] Workflow loading: 37/130", ""].join("\n"),
      { mode: 0o600 },
    );

    const progress = readGatewayStartProgress(workspace, env);
    expect(progress.pid).toBe(process.pid);
    expect(progress.bootAgeMs).toBeGreaterThanOrEqual(90_000);
    expect(progress.url).toBe("http://127.0.0.1:7331");
    expect(progress).toMatchObject({ workflowsLoaded: 37, workflowsTotal: 130 });

    const { message, details } = describeGatewayStartInProgress(workspace, { waitedMs: 315_000, env });
    // The old message claimed nothing became discoverable; the boot is
    // alive and mid-load, so say that instead (#1362).
    expect(message).not.toContain("no healthy gateway became discoverable");
    expect(message).toContain("still in progress");
    expect(message).toContain(`pid ${process.pid}`);
    expect(message).toContain("booting for 1m 30s");
    expect(message).toContain("37/130 workflows");
    expect(message).toContain("http://127.0.0.1:7331");
    expect(message).toContain("5m 15s");
    expect(message).toContain("--gateway <url>");
    expect(message).toContain(logFile);
    expect(details).toMatchObject({
      workspace,
      startPid: process.pid,
      workflowsLoaded: 37,
      workflowsTotal: 130,
      waitedMs: 315_000,
    });
  });

  test("degrades to a usable message when nothing is knowable", () => {
    const env = makeEnv();
    const workspace = makeWorkspace();
    const { message, details } = describeGatewayStartInProgress(workspace, { env });
    expect(message).toContain("still in progress");
    expect(message).toContain(workspace);
    expect(message).toContain("--gateway <url>");
    expect(message).not.toContain("undefined");
    expect(message).not.toContain("NaN");
    expect(details).toMatchObject({ workspace, startPid: null, workflowsTotal: null });
  });
});
