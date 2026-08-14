import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { CANCEL_APPROVAL_AUTHOR, classifyTerminalCause } from "../src/classifyTerminalCause.js";

// classifyTerminalCause decides whether a failed run warrants a post-failure
// autopsy. Only a genuine, unexpected task error does; a human-denied gate, an
// operator cancel, or a quota park all have their cause already recorded.

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {Record<string, unknown>} extra
 */
async function insertRun(adapter, runId, extra = {}) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "classify-fixture",
    status: "failed",
    createdAtMs: now - 5_000,
    startedAtMs: now - 5_000,
    finishedAtMs: now - 1_000,
    heartbeatAtMs: null,
    ...extra,
  });
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} decidedBy
 */
async function insertDeniedGate(adapter, runId, decidedBy, nodeState = "failed") {
  const now = Date.now();
  await adapter.insertNode({
    runId,
    nodeId: "gate",
    iteration: 0,
    // A denied gate with the default onDeny:'fail' fails its node — the exact
    // state that would be excluded by the node-state='pending' filter of
    // listDecidedApprovals. onDeny:'continue'/'skip' instead leaves the node
    // 'finished'/'skipped' and the run continues past the gate.
    state: nodeState,
    lastAttempt: 1,
    updatedAtMs: now - 2_000,
    outputTable: "",
    label: "approval:gate",
  });
  await adapter.insertOrUpdateApproval({
    runId,
    nodeId: "gate",
    iteration: 0,
    status: "denied",
    requestedAtMs: now - 3_000,
    decidedAtMs: now - 2_000,
    note: "no",
    decidedBy,
  });
}

/**
 * A downstream compute node that threw — the genuine terminal cause when a
 * denied onDeny:'continue' gate let the run keep going.
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function insertFailedTaskNode(adapter, runId) {
  const now = Date.now();
  await adapter.insertNode({
    runId,
    nodeId: "compute",
    iteration: 0,
    state: "failed",
    lastAttempt: 1,
    updatedAtMs: now - 500,
    outputTable: "",
    label: "compute",
  });
}

/** @type {{ close: () => void } | undefined} */
let openSqlite;
afterEach(() => {
  openSqlite?.close();
  openSqlite = undefined;
});

describe("classifyTerminalCause", () => {
  test("a plain task error (no approvals) is autopsy-worthy", async () => {
    const { adapter, sqlite } = createTestDb();
    openSqlite = sqlite;
    await insertRun(adapter, "run-task-error");
    expect(await classifyTerminalCause(adapter, "run-task-error", { status: "failed" })).toBe("task-error");
  });

  test("a cancelled run is not autopsy-worthy", async () => {
    const { adapter, sqlite } = createTestDb();
    openSqlite = sqlite;
    await insertRun(adapter, "run-cancelled", { status: "cancelled" });
    expect(await classifyTerminalCause(adapter, "run-cancelled", { status: "cancelled" })).toBe("cancelled");
  });

  test("a run with a pending cancel request is treated as cancelled", async () => {
    const { adapter, sqlite } = createTestDb();
    openSqlite = sqlite;
    await insertRun(adapter, "run-cancel-req", { cancelRequestedAtMs: Date.now() - 2_000 });
    expect(await classifyTerminalCause(adapter, "run-cancel-req", { status: "failed" })).toBe("cancelled");
  });

  test("a quota-parked run is not autopsy-worthy", async () => {
    const { adapter, sqlite } = createTestDb();
    openSqlite = sqlite;
    await insertRun(adapter, "run-quota", { status: "waiting-quota", finishedAtMs: null });
    expect(await classifyTerminalCause(adapter, "run-quota", { status: "waiting-quota" })).toBe("quota-parked");
  });

  test("a genuinely human-denied gate (node failed) is classified human-denied", async () => {
    const { adapter, sqlite } = createTestDb();
    openSqlite = sqlite;
    await insertRun(adapter, "run-denied");
    await insertDeniedGate(adapter, "run-denied", "qa:reviewer");
    expect(await classifyTerminalCause(adapter, "run-denied", { status: "failed" })).toBe("human-denied");
  });

  test("a denied onDeny:'continue' gate that let the run continue does NOT suppress the autopsy of a later task error", async () => {
    const { adapter, sqlite } = createTestDb();
    openSqlite = sqlite;
    // The human denied the gate, but onDeny:'continue' let the run proceed
    // (gate node NOT 'failed'); a downstream compute task then threw. The
    // genuine task error is the terminal cause and must still be autopsied —
    // the run-global denial must not mask it.
    await insertRun(adapter, "run-continue-then-error");
    await insertDeniedGate(adapter, "run-continue-then-error", "qa:reviewer", "finished");
    await insertFailedTaskNode(adapter, "run-continue-then-error");
    expect(await classifyTerminalCause(adapter, "run-continue-then-error", { status: "failed" })).toBe("task-error");
  });

  test("a cancel-driven denial (smithers:cancel sentinel) is NOT a human deny", async () => {
    const { adapter, sqlite } = createTestDb();
    openSqlite = sqlite;
    // No cancel status/flag on the run, only the sentinel-authored denial the
    // engine writes when cancelling: it must not masquerade as a human deny.
    await insertRun(adapter, "run-sentinel-denial");
    await insertDeniedGate(adapter, "run-sentinel-denial", CANCEL_APPROVAL_AUTHOR);
    expect(await classifyTerminalCause(adapter, "run-sentinel-denial", { status: "failed" })).toBe("task-error");
  });
});
