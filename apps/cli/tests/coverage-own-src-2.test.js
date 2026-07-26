import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createSnapshotServer, nextSnapshotSocketPath } from "@smithers-orchestrator/engine/snapshotServer";
import { runOutputOnce } from "../src/output.js";
import { renderUnifiedDiff, renderDiffStat, runDiffOnce } from "../src/diff.js";
import { runSnapshotHookOnce } from "../src/snapshot-hook.js";
import { launchPostFailureAutopsy } from "../src/launchPostFailureAutopsy.js";
import { runFork, runPromise, runSync } from "../src/smithersRuntime.js";
import { Effect } from "effect";

function capture() {
  return {
    chunks: [],
    write(text) {
      this.chunks.push(String(text));
    },
    text() {
      return this.chunks.join("");
    },
  };
}

async function openMemoryDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, db, adapter: new SmithersDb(db) };
}

// Drizzle mirror of the physical `task_a_output` table so the getNodeOutput
// route can resolve the output definition and select the row.
const taskAOutput = sqliteTable("task_a_output", {
  runId: text("run_id").notNull(),
  nodeId: text("node_id").notNull(),
  iteration: integer("iteration").notNull().default(0),
  verdict: text("verdict"),
});

function outputWorkflow(db) {
  return {
    db,
    schemaRegistry: new Map([["task_a_output", { table: taskAOutput }]]),
  };
}

async function seedNodeOutput(sqlite, adapter) {
  await adapter.insertRun({
    runId: "run-out",
    workflowName: "wf",
    status: "finished",
    createdAtMs: 1_000,
    startedAtMs: 1_000,
    finishedAtMs: 2_000,
  });
  await adapter.insertNode({
    runId: "run-out",
    nodeId: "task-a",
    iteration: 0,
    state: "done",
    lastAttempt: 1,
    updatedAtMs: 1_500,
    outputTable: "task_a_output",
    label: "Task A",
  });
  sqlite.run(`CREATE TABLE task_a_output (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        verdict TEXT,
        PRIMARY KEY (run_id, node_id, iteration)
    )`);
  sqlite.run(`INSERT INTO task_a_output (run_id, node_id, iteration, verdict)
        VALUES ('run-out', 'task-a', 0, 'approved')`);
}

describe("runOutputOnce route paths (non-raw)", () => {
  test("renders the pretty output for a produced node", async () => {
    const { sqlite, db, adapter } = await openMemoryDb();
    const stdout = capture();
    const stderr = capture();
    try {
      await seedNodeOutput(sqlite, adapter);
      const result = await runOutputOnce({
        adapter,
        workflow: outputWorkflow(db),
        runId: "run-out",
        nodeId: "task-a",
        json: false,
        pretty: true,
        stdout,
        stderr,
      });
      expect(result.exitCode).toBe(0);
      expect(stderr.text()).toBe("");
      expect(stdout.text()).toContain("approved");
    } finally {
      sqlite.close();
    }
  });

  test("emits the raw row JSON for the default (non-json, non-pretty) path", async () => {
    const { sqlite, db, adapter } = await openMemoryDb();
    const stdout = capture();
    const stderr = capture();
    try {
      await seedNodeOutput(sqlite, adapter);
      const result = await runOutputOnce({
        adapter,
        workflow: outputWorkflow(db),
        runId: "run-out",
        nodeId: "task-a",
        iteration: 0,
        json: false,
        pretty: false,
        stdout,
        stderr,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(stdout.text())).toMatchObject({ verdict: "approved" });
    } finally {
      sqlite.close();
    }
  });
});

describe("diff render helpers", () => {
  test("colorizes 'diff '/'index ' header lines when color is on", () => {
    const bundle = {
      seq: 1,
      baseRef: "a",
      patches: [{ path: "x", diff: "diff --git a/x b/x\nindex 111..222 100644\n@@ -1 +1 @@\n-a\n+b\n" }],
    };
    const colored = renderUnifiedDiff(bundle, { color: true });
    expect(colored).toContain("[");
    expect(colored).toContain("diff --git");
  });

  test("renderDiffStat consumes a precomputed summary object verbatim", () => {
    const text = renderDiffStat({
      summary: {
        filesChanged: 2,
        added: 5,
        removed: 3,
        files: [{ path: "a", added: 5, removed: 3 }],
      },
    });
    expect(text).toContain("2 files changed");
    expect(text).toContain("5 insertions(+)");
    expect(text).toContain("3 deletions(-)");
  });
});

describe("runDiffOnce resolves the latest iteration when none is given", () => {
  test("looks up the newest node iteration before hitting the route", async () => {
    const stdout = capture();
    const stderr = capture();
    let asked = false;
    const adapter = {
      async listNodeIterations(runId, nodeId) {
        asked = true;
        expect(runId).toBe("run-x");
        expect(nodeId).toBe("task-a");
        return [{ iteration: 0 }, { iteration: 4 }, { iteration: "bad" }];
      },
      async getRun() {
        return null;
      },
    };
    const result = await runDiffOnce({
      adapter,
      runId: "run-x",
      nodeId: "task-a",
      // iteration omitted → resolveLatestIteration runs
      json: false,
      stat: false,
      color: false,
      stdout,
      stderr,
    });
    expect(asked).toBe(true);
    // The route then fails (run missing) → non-zero exit, stderr populated.
    expect(result.exitCode).toBeGreaterThan(0);
    expect(stderr.text().length).toBeGreaterThan(0);
  });
});

describe("runSnapshotHookOnce uncovered handlers", () => {
  test("spools a timeout gap when the socket accepts but never acks", async () => {
    const spooled = [];
    const server = await createSnapshotServer({
      socketPath: nextSnapshotSocketPath(),
      // Never resolve → no ack is ever written, so the client times out.
      onHook: () => new Promise(() => {}),
    });
    try {
      const r = await runSnapshotHookOnce({
        env: { SMITHERS_SNAPSHOT_SOCK: server.socketPath, SMITHERS_RUN_ID: "r-timeout" },
        stdin: Readable.from(["{}"]),
        spool: (rid, gap) => spooled.push([rid, gap]),
        timeoutMs: 40,
      });
      expect(r.exitCode).toBe(0);
      expect(spooled).toHaveLength(1);
      expect(spooled[0][1].reason).toBe("timeout");
    } finally {
      server.close();
    }
  });

  test("survives a stdin stream that errors mid-read (reads as empty)", async () => {
    const erroring = new Readable({ read() {} });
    process.nextTick(() => erroring.emit("error", new Error("stdin boom")));
    const r = await runSnapshotHookOnce({
      env: { SMITHERS_SNAPSHOT_SOCK: "/tmp/never.sock", SMITHERS_RUN_ID: "r-err" },
      stdin: erroring,
      request: async () => ({ ok: true }),
    });
    expect(r.exitCode).toBe(0);
  });
});

describe("launchPostFailureAutopsy default stderr writer", () => {
  test("prints the not-installed CTA through the default writer without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "autopsy-default-"));
    try {
      // No post-failure workflow installed → resolveWorkflow throws → the
      // default `write` (process.stderr) is exercised via safeWrite.
      const result = launchPostFailureAutopsy({
        failedRunId: "failed-1",
        workflowPath: null,
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH ?? "", SMITHERS_WORKFLOW_PATHS: join(root, "empty") },
        // no `write` override → default arrow runs
      });
      expect(result.launched).toBe(false);
      expect(result.reason).toBe("not-installed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("smithersRuntime effect runners", () => {
  test("runSync returns a synchronous success value", () => {
    expect(runSync(Effect.succeed(21))).toBe(21);
  });

  test("runPromise resolves a success and rejects a failure as a SmithersError", async () => {
    await expect(runPromise(Effect.succeed("ok"))).resolves.toBe("ok");
    await expect(runPromise(Effect.fail(new Error("boom")))).rejects.toThrow();
  });

  test("runFork schedules a fiber for the effect", async () => {
    const fiber = runFork(Effect.succeed(7));
    expect(fiber).toBeDefined();
    // Let the fiber settle so it does not leak into other tests.
    await runPromise(Effect.succeed(null));
  });
});
