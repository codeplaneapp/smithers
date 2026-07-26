// `smithers hijack --target` accepts an agent engine OR a node id: the TUI's
// HijackMode spawns `smithers hijack <runId> --target <nodeId>` (see
// packages/tui/src/modes/HijackMode.tsx), so a node-id target must resolve to
// the node's recorded session instead of failing HIJACK_TARGET_MISMATCH, and a
// live-run hijack request must persist the node's ENGINE (the only thing the
// engine-side hand-off check understands), not the raw node id. (#23)
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function openRepoDb(repo) {
  pinSqliteBackend(repo.dir);
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

/**
 * Seed a run whose latest attempt carries a resumable claude-code session.
 * @param {ReturnType<typeof createTempRepo>} repo
 * @param {SmithersDb} adapter
 * @param {{ status?: string }} [options]
 */
async function seedHijackableRun(repo, adapter, options = {}) {
  const now = Date.now();
  await adapter.insertRun({
    runId: "hijack-run",
    workflowName: "hijack-fixture",
    workflowPath: "workflow.tsx",
    status: options.status ?? "finished",
    createdAtMs: now - 10_000,
    startedAtMs: now - 9_000,
    finishedAtMs: options.status === "running" ? null : now - 1_000,
    heartbeatAtMs: options.status === "running" ? now : null,
    vcsType: "none",
    vcsRevision: null,
  });
  await adapter.insertNode({
    runId: "hijack-run",
    nodeId: "node-a",
    iteration: 0,
    state: options.status === "running" ? "in-progress" : "finished",
    lastAttempt: 1,
    updatedAtMs: now - 2_000,
    outputTable: "",
    label: "Node A",
  });
  await adapter.insertAttempt({
    runId: "hijack-run",
    nodeId: "node-a",
    iteration: 0,
    attempt: 1,
    state: options.status === "running" ? "in-progress" : "finished",
    startedAtMs: now - 7_000,
    finishedAtMs: options.status === "running" ? null : now - 6_000,
    errorJson: null,
    metaJson: JSON.stringify({
      kind: "agent",
      agentEngine: "claude-code",
      agentResume: "sess-123",
    }),
    responseText: null,
    cached: false,
    jjPointer: null,
    jjCwd: repo.dir,
  });
}

describe("hijack --target accepts node ids (#23)", () => {
  test("finished run: --target <nodeId> resolves the node's session instead of HIJACK_TARGET_MISMATCH", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await seedHijackableRun(repo, adapter);
      const result = runSmithers(["hijack", "hijack-run", "--target", "node-a", "--no-launch"], {
        cwd: repo.dir,
        format: "json",
      });
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        runId: "hijack-run",
        nodeId: "node-a",
        engine: "claude-code",
        mode: "native-cli",
        resume: "sess-123",
      });
    } finally {
      sqlite.close();
    }
  }, 60_000);

  test("--target <engine> still works and a target matching neither fails HIJACK_UNAVAILABLE", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await seedHijackableRun(repo, adapter);
      const byEngine = runSmithers(["hijack", "hijack-run", "--target", "claude-code", "--no-launch"], {
        cwd: repo.dir,
        format: "json",
      });
      expect(byEngine.exitCode).toBe(0);
      expect(byEngine.json.nodeId).toBe("node-a");

      const miss = runSmithers(["hijack", "hijack-run", "--target", "no-such-node", "--no-launch"], {
        cwd: repo.dir,
        format: "json",
      });
      expect(miss.exitCode).toBe(4);
      expect(miss.json.code).toBe("HIJACK_UNAVAILABLE");
    } finally {
      sqlite.close();
    }
  }, 60_000);

  test("live run: a node-id target is persisted as the node's ENGINE so the engine can hand off", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await seedHijackableRun(repo, adapter, { status: "running" });
      const child = spawn(
        process.execPath,
        [
          "run",
          CLI_ENTRY,
          "hijack",
          "hijack-run",
          "--target",
          "node-a",
          "--no-launch",
          "--timeout-ms",
          "15000",
          "--format",
          "json",
        ],
        {
          cwd: repo.dir,
          env: { ...process.env, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const closePromise = new Promise((resolveClose) => child.once("close", resolveClose));
      try {
        // The CLI persists the hijack request, then polls for the run to
        // stop. Watch the DB for the persisted target: it must be the
        // node's engine, never the raw node id (which the engine-side
        // check would silently ignore until HIJACK_TIMEOUT).
        let persistedTarget;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try {
            const run = await adapter.getRun("hijack-run");
            if (run?.hijackRequestedAtMs) {
              persistedTarget = run.hijackTarget ?? null;
              break;
            }
          } catch {
            // Transient cross-process SQLITE_BUSY; keep polling.
          }
          await Bun.sleep(100);
        }
        expect(persistedTarget).toBe("claude-code");
        // Let the run "hand off": once it is no longer running, the CLI
        // resolves the node-scoped candidate and succeeds.
        for (let attempt = 0; ; attempt += 1) {
          try {
            await adapter.updateRun("hijack-run", { status: "finished" });
            break;
          } catch (error) {
            if (attempt >= 20) throw error;
            await Bun.sleep(100);
          }
        }
        const exitCode = await closePromise;
        if (exitCode !== 0) {
          throw new Error(`hijack exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        }
        const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
        expect(parsed.nodeId).toBe("node-a");
        expect(parsed.engine).toBe("claude-code");
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await closePromise;
        }
      }
    } finally {
      sqlite.close();
    }
  }, 60_000);
});
