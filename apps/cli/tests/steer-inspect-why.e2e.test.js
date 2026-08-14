// Real-backend coverage that `smithers inspect` and `smithers why` surface a
// run's durable steers (queued/consumed/expired), reusing the same
// `listSteers` rows `smithers steer` writes. No mocks: a real seeded SQLite store.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const QUIET_ENV = {
  SMITHERS_NO_SKILL_REFRESH: "1",
  SMITHERS_NO_UPDATE_CHECK: "1",
  HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
};

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
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function seedRunWithSteers(adapter, runId) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "steer-fixture",
    workflowPath: "workflow.tsx",
    status: "running",
    createdAtMs: now - 10_000,
    startedAtMs: now - 9_000,
    finishedAtMs: null,
    heartbeatAtMs: now,
  });
  await adapter.insertNode({
    runId,
    nodeId: "impl",
    iteration: 0,
    state: "in-progress",
    lastAttempt: 1,
    updatedAtMs: now - 2_000,
    outputTable: "",
    label: "impl",
  });
  // One consumed steer (already landed) and one still queued (waiting).
  await Effect.runPromise(
    adapter.enqueueSteer({
      steerId: "n-consumed",
      runId,
      nodeId: "impl",
      message: "done already",
      author: "alice",
      createdAtMs: now - 5_000,
    }),
  );
  await Effect.runPromise(
    adapter.markSteerConsumed("n-consumed", {
      consumedAtMs: now - 4_000,
      consumedByAttempt: 1,
      consumedByIteration: 0,
    }),
  );
  await Effect.runPromise(
    adapter.enqueueSteer({
      steerId: "n-queued",
      runId,
      nodeId: "impl",
      message: "prefer the smaller change",
      author: "bob",
      createdAtMs: now - 1_000,
    }),
  );
}

test("smithers inspect --json lists the run's steers with their status", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedRunWithSteers(adapter, "insp-steer");
    const result = runSmithers(["inspect", "insp-steer"], {
      cwd: repo.dir,
      format: "json",
      env: QUIET_ENV,
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(Array.isArray(result.json.steers)).toBe(true);
    expect(result.json.steers).toHaveLength(2);
    const byId = Object.fromEntries(result.json.steers.map((n) => [n.steerId, n]));
    expect(byId["n-consumed"].status).toBe("consumed");
    expect(byId["n-consumed"].consumedByAttempt).toBe(1);
    expect(byId["n-queued"].status).toBe("queued");
    expect(byId["n-queued"].message).toBe("prefer the smaller change");
    expect(byId["n-queued"].nodeId).toBe("impl");
  } finally {
    sqlite.close();
  }
}, 30_000);

test("smithers why surfaces a steering-steers section listing queued steers", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedRunWithSteers(adapter, "why-steer");
    const result = runSmithers(["why", "why-steer"], {
      cwd: repo.dir,
      env: QUIET_ENV,
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Steers: 1 queued · 1 consumed · 0 expired");
    expect(result.stdout).toContain("↪ queued → impl: prefer the smaller change");
  } finally {
    sqlite.close();
  }
}, 30_000);

test("smithers why --json includes steer rows on the diagnosis", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedRunWithSteers(adapter, "why-json-steer");
    const result = runSmithers(["why", "why-json-steer", "--format", "json"], {
      cwd: repo.dir,
      format: "json",
      env: QUIET_ENV,
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(Array.isArray(result.json.steers)).toBe(true);
    expect(result.json.steers).toHaveLength(2);
  } finally {
    sqlite.close();
  }
}, 30_000);
