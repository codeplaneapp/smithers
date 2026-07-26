/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Gateway } from "../src/gateway.js";
import { hijackCandidatesFromAttempts } from "../src/hijackCandidates.js";
import { sleep } from "../../smithers/tests/helpers.js";

setDefaultTimeout(60_000);

const AUTH = { triggeredBy: "tester", scopes: ["*"], role: "operator" };

/** @type {Array<() => Promise<void> | void>} */
const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {}
  }
});

/**
 * A fake upgrade socket that records what the gateway writes. Bun's node:http
 * compat flushes NOTHING written to a real upgrade socket (the ws client only
 * sees "Connection ended"), so refusal statuses are asserted by driving
 * `handlePtyHijackUpgrade` directly with this stub — the same seam the
 * Host-defense tests use for `authenticateRequest`.
 */
function fakeUpgradeSocket() {
  /** @type {{ written: string; ended: boolean; end: (data?: unknown) => void; destroy: () => void }} */
  const socket = {
    written: "",
    ended: false,
    end(data) {
      if (data !== undefined) {
        socket.written += String(data);
      }
      socket.ended = true;
    },
    destroy() {
      socket.ended = true;
    },
  };
  return socket;
}

/**
 * @param {number} port
 * @param {Record<string, string | undefined>} [headers]
 */
function fakeUpgradeReq(port, headers = {}) {
  return {
    headers: { host: `127.0.0.1:${port}`, ...headers },
    socket: {},
    url: "/v1/pty/hijack",
  };
}

/**
 * @param {import("node:http").Server} server
 */
function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Gateway server did not expose a port");
  }
  return addr.port;
}

/**
 * @param {string} name
 */
function makeDbPath(name) {
  return join(tmpdir(), `smithers-pty-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/**
 * @param {string} dbPath
 */
function createValueWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers(
    {
      ptyResult: z.object({ value: z.number() }),
    },
    { dbPath },
  );
  const workflow = smithers((ctx) => (
    <Workflow name="pty-basic">
      <Task id="task1" output={outputs.ptyResult}>
        {{ value: Number(ctx.input.value ?? 1) }}
      </Task>
    </Workflow>
  ));
  cleanups.push(() => {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });
  return workflow;
}

/**
 * Boot a real gateway with a run in its DB and an injected PTY launcher.
 *
 * @param {(params: { runId: string; nodeId?: string }) => { command: string[]; cwd?: string } | null} [hijackPty]
 */
async function bootGateway(hijackPty) {
  const dbPath = makeDbPath("gw");
  const workflow = createValueWorkflow(dbPath);
  const gateway = new Gateway(hijackPty ? { hijackPty } : {});
  gateway.register("pty-basic", workflow);
  const server = await gateway.listen({ port: 0 });
  cleanups.push(() => gateway.close());
  await gateway.startRun("pty-basic", { value: 3 }, AUTH, "run-pty", { resume: false });
  await gateway.inflightRuns.get("run-pty");
  return { gateway, workflow, port: getPort(server) };
}

/**
 * Collect every frame from a PTY websocket until it closes (or times out).
 *
 * @param {WebSocket} ws
 * @returns {{ text: () => string; control: Record<string, unknown>[]; closed: Promise<{ code: number }> }}
 */
function collectPty(ws) {
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Record<string, unknown>[]} */
  const control = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(/** @type {ArrayBuffer} */ (data)));
      return;
    }
    try {
      control.push(JSON.parse(String(data)));
    } catch {}
  });
  const closed = new Promise((resolve) => {
    ws.on("close", (code) => resolve({ code }));
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
    control,
    closed,
  };
}

describe("gateway /v1/pty/hijack", () => {
  test("spawns the injected command in a real PTY and streams bytes both ways", async () => {
    /** @type {Array<{ runId: string; nodeId?: string }>} */
    const builderCalls = [];
    const { port } = await bootGateway((params) => {
      builderCalls.push(params);
      return {
        command: ["bash", "-c", 'printf pty-banner:; read line; printf "got:%s" "$line"'],
      };
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/pty/hijack?runId=run-pty&nodeId=task1&cols=80&rows=24`);
    const pty = collectPty(ws);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    // Input travels as binary frames, exactly like the terminal bytes.
    const deadline = Date.now() + 10_000;
    while (!pty.text().includes("pty-banner:") && Date.now() < deadline) {
      await sleep(25);
    }
    expect(pty.text()).toContain("pty-banner:");
    const input = Buffer.from("hello\n", "utf8");
    ws.send(input, { binary: true });
    const { code } = await pty.closed;
    expect(code).toBe(1000);
    expect(pty.text()).toContain("got:hello");
    // Process exit is announced as a JSON control frame before the close.
    expect(pty.control.some((frame) => frame.type === "exit")).toBe(true);
    expect(builderCalls).toEqual([{ runId: "run-pty", nodeId: "task1" }]);
  });

  test("resize control frames reach the PTY (stty size sees the new geometry)", async () => {
    const { port } = await bootGateway(() => ({
      command: ["bash", "-c", "sleep 0.5; stty size"],
    }));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/pty/hijack?runId=run-pty&cols=80&rows=24`);
    const pty = collectPty(ws);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await pty.closed;
    expect(pty.text()).toContain("40 120");
  });

  test("rejects a cross-origin upgrade before any PTY spawns", async () => {
    let spawned = false;
    const { gateway, port } = await bootGateway(() => {
      spawned = true;
      return { command: ["bash", "-c", "printf nope"] };
    });
    // End to end: the shared upgrade handler's Origin allow-list covers the
    // PTY path exactly like the RPC websocket — the socket never opens.
    // (Bun's http compat flushes no HTTP bytes on a rejected upgrade, so
    // the client can only observe error/close, per the 503 test.)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/pty/hijack?runId=run-pty`, {
      headers: { origin: "http://evil.example" },
    });
    ws.on("error", () => {});
    const outcome = await new Promise((resolve) => {
      ws.once("open", () => resolve("open"));
      ws.once("error", () => resolve("error"));
      ws.once("close", () => resolve("close"));
    });
    expect(outcome).not.toBe("open");
    expect(spawned).toBe(false);
    // Defense in depth: even if a request reached the PTY handler itself,
    // authenticateRequest rejects the foreign Origin at that layer too.
    const socket = fakeUpgradeSocket();
    await gateway.handlePtyHijackUpgrade(
      fakeUpgradeReq(port, { origin: "http://evil.example" }),
      socket,
      Buffer.alloc(0),
      null,
      new URL(`http://127.0.0.1:${port}/v1/pty/hijack?runId=run-pty`),
    );
    expect(socket.written).toContain("Origin is not allowed");
    expect(spawned).toBe(false);
  });

  test("404s an unknown run and 501s when no launcher is configured", async () => {
    const { gateway, port } = await bootGateway(() => ({ command: ["bash", "-c", "printf hi"] }));
    const missing = fakeUpgradeSocket();
    await gateway.handlePtyHijackUpgrade(
      fakeUpgradeReq(port),
      missing,
      Buffer.alloc(0),
      null,
      new URL(`http://127.0.0.1:${port}/v1/pty/hijack?runId=no-such-run`),
    );
    expect(missing.written).toStartWith("HTTP/1.1 404");

    const { gateway: bareGateway, port: barePort } = await bootGateway(undefined);
    const bare = fakeUpgradeSocket();
    await bareGateway.handlePtyHijackUpgrade(
      fakeUpgradeReq(barePort),
      bare,
      Buffer.alloc(0),
      null,
      new URL(`http://127.0.0.1:${barePort}/v1/pty/hijack?runId=run-pty`),
    );
    expect(bare.written).toStartWith("HTTP/1.1 501");
  });
});

describe("gateway /v1/api/runs/:id/hijack-candidates", () => {
  test("lists per-node resumable sessions from attempt meta; nodes without one stay absent", async () => {
    const { workflow, port } = await bootGateway(() => null);
    // The compute task recorded a real attempt with no agent session:
    // the run must report zero candidates.
    const before = await fetch(`http://127.0.0.1:${port}/v1/api/runs/run-pty/hijack-candidates`);
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    expect(beforeBody.ok).toBe(true);
    expect(beforeBody.data.candidates).toEqual([]);

    // Persist the continuation shape an agent attempt records
    // (agentEngine + agentResume), then the node becomes a candidate.
    const adapter = new SmithersDb(workflow.db);
    const attempts = await adapter.listAttemptsForRun("run-pty");
    expect(attempts.length).toBeGreaterThan(0);
    const attempt = attempts[attempts.length - 1];
    const meta = JSON.parse(attempt.metaJson ?? "{}");
    await adapter.updateAttempt("run-pty", attempt.nodeId, attempt.iteration ?? 0, attempt.attempt, {
      metaJson: JSON.stringify({ ...meta, agentEngine: "claude-code", agentResume: "session-123" }),
    });
    const after = await fetch(`http://127.0.0.1:${port}/v1/api/runs/run-pty/hijack-candidates`);
    expect(after.status).toBe(200);
    const afterBody = await after.json();
    expect(afterBody.data.candidates).toEqual([
      expect.objectContaining({ nodeId: attempt.nodeId, engine: "claude-code", mode: "native-cli" }),
    ]);

    const missing = await fetch(`http://127.0.0.1:${port}/v1/api/runs/nope/hijack-candidates`);
    expect(missing.status).toBe(404);
  });

  test("hijackCandidatesFromAttempts keeps the newest continuation per node", () => {
    const rows = [
      {
        nodeId: "a",
        iteration: 0,
        attempt: 1,
        startedAtMs: 100,
        metaJson: JSON.stringify({ agentEngine: "codex", agentResume: "old" }),
      },
      {
        nodeId: "a",
        iteration: 0,
        attempt: 2,
        startedAtMs: 200,
        metaJson: JSON.stringify({ agentEngine: "claude-code", agentResume: "new" }),
      },
      {
        nodeId: "b",
        iteration: 0,
        attempt: 1,
        startedAtMs: 150,
        metaJson: JSON.stringify({ agentEngine: "pi", agentConversation: [{ role: "user", content: "hi" }] }),
      },
      {
        nodeId: "c",
        iteration: 0,
        attempt: 1,
        startedAtMs: 300,
        metaJson: JSON.stringify({ note: "compute task, nothing resumable" }),
      },
      { nodeId: "d", iteration: 0, attempt: 1, startedAtMs: 50, metaJson: "not-json" },
    ];
    const candidates = hijackCandidatesFromAttempts(rows);
    expect(candidates).toEqual([
      expect.objectContaining({ nodeId: "a", engine: "claude-code", mode: "native-cli", attempt: 2 }),
      expect.objectContaining({ nodeId: "b", engine: "pi", mode: "conversation" }),
    ]);
  });
});
