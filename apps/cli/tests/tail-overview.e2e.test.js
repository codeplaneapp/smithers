import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";
import { buildOverviewBlock, overviewSignature, overviewStateLabel } from "../src/tail-overview.js";

const QUIET_ENV = { SMITHERS_NO_SKILL_REFRESH: "1", SMITHERS_NO_UPDATE_CHECK: "1" };

// ── Pure renderer tests (no DB) ────────────────────────────────────────────

test("buildOverviewBlock renders a header, per-node board, and approve/steer CTAs", () => {
  const block = buildOverviewBlock({
    runId: "r1",
    status: "waiting-approval",
    nodes: [
      { nodeId: "implement", state: "finished", iteration: 0, lastAttempt: 2 },
      { nodeId: "ship-gate", state: "waiting-approval", iteration: 0, lastAttempt: 1 },
      { nodeId: "deploy", state: "failed", iteration: 0, lastAttempt: 3 },
    ],
    pendingApprovals: [{ nodeId: "ship-gate", iteration: 0 }],
  });
  // Renderer cells include ANSI color resets between the padded state and
  // attempt columns. Assert layout against visible text, independent of color.
  const plainBlock = block.replace(/\x1B\[[0-9;]*m/g, "");
  expect(block).toContain("overview · run r1 · waiting-approval · 3 nodes");
  // Board is columnar: node · state · attempt
  expect(block).toContain("implement");
  expect(plainBlock).toMatch(/implement\s+done\s+2/);
  expect(block).toContain("blocked · approval");
  expect(plainBlock).toMatch(/deploy\s+failed\s+3/);
  // CTAs: the exact approve command for the gate, and the one-key steer/takeover
  // affordance + full machine commands for the failure.
  expect(block).toContain("smithers approve r1 --node ship-gate --iteration 0");
  expect(block).toContain("in its node tab press s to steer · h to hijack");
  expect(block).toContain('smithers steer r1 --node deploy "…"');
  expect(block).toContain("smithers steer r1 --node deploy --takeover");
  expect(block).not.toContain("smithers hijack r1");
  // Deterministic digest always includes tallies (not a fan-out queue summary).
  expect(block).toMatch(/0 working \/ 1 blocked \/ 1 failed \/ 1 done/);
});

test("buildOverviewBlock renders a run-level line per node with queued steers", () => {
  const block = buildOverviewBlock({
    runId: "r1",
    status: "running",
    nodes: [{ nodeId: "implement", state: "in-progress", iteration: 0, lastAttempt: 1 }],
    pendingApprovals: [],
    queuedSteers: [{ nodeId: "implement" }, { nodeId: "implement" }, { nodeId: "review" }],
  });
  expect(block).toContain("↪ 2 steers queued → implement (lands on its next agent step)");
  expect(block).toContain("↪ 1 steer queued → review (lands on its next agent step)");
});

test("buildOverviewBlock trims to attention nodes and adds a queue summary past the threshold", () => {
  const nodes = [];
  for (let i = 0; i < 10; i += 1) {
    nodes.push({ nodeId: `done-${i}`, state: "finished", iteration: 0, lastAttempt: 1 });
  }
  nodes.push({ nodeId: "hot", state: "in-progress", iteration: 0, lastAttempt: 1 });
  nodes.push({ nodeId: "stuck", state: "waiting-approval", iteration: 0, lastAttempt: 1 });
  const block = buildOverviewBlock({ runId: "big", status: "running", nodes, pendingApprovals: [] });
  // The queue summary counts every node.
  expect(block).toContain("1 working / 1 blocked / 0 failed / 10 done");
  // Only attention-worthy nodes are listed individually; the 10 done nodes are not.
  expect(block).toContain("hot");
  expect(block).toContain("stuck");
  expect(block).not.toContain("done-3");
});

test("overviewSignature changes when a node's state changes and is stable otherwise", () => {
  const a = overviewSignature("running", [{ nodeId: "n", state: "in-progress", iteration: 0, lastAttempt: 1 }]);
  const b = overviewSignature("running", [{ nodeId: "n", state: "in-progress", iteration: 0, lastAttempt: 1 }]);
  const c = overviewSignature("running", [{ nodeId: "n", state: "finished", iteration: 0, lastAttempt: 1 }]);
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test("overviewStateLabel maps internal states to short human labels", () => {
  expect(overviewStateLabel("in-progress")).toBe("working");
  expect(overviewStateLabel("waiting-approval")).toBe("blocked · approval");
  expect(overviewStateLabel("finished")).toBe("done");
  expect(overviewStateLabel("failed")).toBe("failed");
});

// ── CLI wiring test (real seeded DB) ───────────────────────────────────────

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
 * @param {string} nodeId
 * @param {string} state
 * @param {number} attempt
 */
async function seedNode(adapter, runId, nodeId, state, attempt) {
  await adapter.insertNode({
    runId,
    nodeId,
    iteration: 0,
    state,
    lastAttempt: attempt,
    updatedAtMs: Date.now(),
    outputTable: "",
    label: null,
  });
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @param {{ ts: number }} clock
 */
async function insertEvent(adapter, runId, type, payload, clock) {
  const timestampMs = (clock.ts += 1);
  await adapter.insertEventWithNextSeq({
    runId,
    timestampMs,
    type,
    payloadJson: JSON.stringify({ type, runId, ...payload, timestampMs }),
  });
}

test("smithers tail --overview prints the run board with node states and a failure CTA", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    const runId = "overview-run";
    const now = Date.now();
    await adapter.insertRun({
      runId,
      workflowName: "overview-fixture",
      status: "finished",
      createdAtMs: now - 2_000,
      startedAtMs: now - 2_000,
      finishedAtMs: now,
    });
    await seedNode(adapter, runId, "alpha", "finished", 1);
    await seedNode(adapter, runId, "beta", "failed", 2);
    const clock = { ts: now - 1_000 };
    await insertEvent(adapter, runId, "RunStarted", {}, clock);
    await insertEvent(adapter, runId, "NodeStarted", { nodeId: "alpha", iteration: 0, attempt: 1 }, clock);
    await insertEvent(adapter, runId, "NodeFinished", { nodeId: "alpha", iteration: 0, attempt: 1 }, clock);
    await insertEvent(adapter, runId, "RunFinished", {}, clock);

    const result = runSmithers(["tail", runId, "--overview"], {
      cwd: repo.dir,
      env: QUIET_ENV,
      timeoutMs: 30_000,
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    // The overview board rendered, with the per-node states and the failure CTA.
    expect(result.stdout).toContain(`overview · run ${runId}`);
    expect(result.stdout).toContain("alpha");
    expect(result.stdout).toContain("beta");
    expect(result.stdout).toContain("failed");
    expect(result.stdout).toContain(`smithers steer ${runId} --node beta --takeover`);
    expect(result.stdout).not.toContain("press s to steer");
    expect(result.stdout).toContain(`smithers steer ${runId} --node beta`);
    // It still ends with the normal terminal status line.
    expect(result.stdout).toContain(`Run ${runId} finished`);
  } finally {
    sqlite.close();
  }
}, 40_000);

test("smithers tail (no --overview) does not print the board", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    const runId = "no-overview-run";
    const now = Date.now();
    await adapter.insertRun({
      runId,
      workflowName: "overview-fixture",
      status: "finished",
      createdAtMs: now - 2_000,
      startedAtMs: now - 2_000,
      finishedAtMs: now,
    });
    await seedNode(adapter, runId, "alpha", "finished", 1);
    const clock = { ts: now - 1_000 };
    await insertEvent(adapter, runId, "RunStarted", {}, clock);
    await insertEvent(adapter, runId, "RunFinished", {}, clock);
    const result = runSmithers(["tail", runId], { cwd: repo.dir, env: QUIET_ENV, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("overview · run");
    expect(result.stdout).toContain(`Run ${runId} finished`);
  } finally {
    sqlite.close();
  }
}, 40_000);
