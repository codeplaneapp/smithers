import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTempRepo, pinSqliteBackend } from "../../../packages/smithers/tests/e2e-helpers.js";
import { CANCEL, createKeyReader, findNextPending, parseSelectOptions, runApproveWatch } from "../src/approve-watch.js";

const BUN_BINARY = process.execPath;
const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");
const QUIET_ENV = {
  SMITHERS_NO_SKILL_REFRESH: "1",
  SMITHERS_NO_UPDATE_CHECK: "1",
};

// Interactive `smithers approve --watch` against a REAL seeded store (no mocks):
// the loop drives the actual approveNode/denyNode/answerHumanRequest engine
// machinery. Stdin is a PassThrough (no TTY needed, so this runs in CI) and the
// linger is injected so the test does not block on the terminal-hold, mirroring
// the existing tail-command linger test approach.

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
 * @param {string} status
 */
async function insertRun(adapter, runId, status) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "approve-watch-fixture",
    status,
    createdAtMs: now - 2_000,
    startedAtMs: now - 2_000,
    finishedAtMs: null,
  });
}

/**
 * Seed a run parked on a single approval gate: a `waiting-approval` run, a
 * `waiting-approval` node, and a `requested` approval row carrying the question.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 */
async function seedApprovalGate(adapter, runId, nodeId) {
  const now = Date.now();
  await insertRun(adapter, runId, "waiting-approval");
  await adapter.insertNode({
    runId,
    nodeId,
    iteration: 0,
    state: "waiting-approval",
    lastAttempt: 1,
    updatedAtMs: now,
    outputTable: "",
    label: null,
  });
  await adapter.insertOrUpdateApproval({
    runId,
    nodeId,
    iteration: 0,
    status: "requested",
    requestedAtMs: now,
    decidedAtMs: null,
    note: null,
    decidedBy: null,
    requestJson: JSON.stringify({ title: "Ship the change?", summary: "Deploys to prod." }),
    decisionJson: null,
    autoApproved: false,
  });
}

/**
 * Seed an agent-initiated human request (no backing approval) on a running run.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {{ kind: string, prompt: string, optionsJson?: string | null, schemaJson?: string | null }} req
 * @returns {Promise<string>} the request id
 */
async function seedHumanRequest(adapter, runId, nodeId, req) {
  const now = Date.now();
  await insertRun(adapter, runId, "running");
  await adapter.insertNode({
    runId,
    nodeId,
    iteration: 0,
    state: "in-progress",
    lastAttempt: 1,
    updatedAtMs: now,
    outputTable: "",
    label: null,
  });
  const requestId = `human:${runId}:${nodeId}:0`;
  await adapter.insertHumanRequest({
    requestId,
    runId,
    nodeId,
    iteration: 0,
    kind: req.kind,
    status: "pending",
    prompt: req.prompt,
    schemaJson: req.schemaJson ?? null,
    optionsJson: req.optionsJson ?? null,
    responseJson: null,
    requestedAtMs: now,
    answeredAtMs: null,
    answeredBy: null,
    timeoutAtMs: null,
  });
  return requestId;
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {() => string} read
 * @param {string} matcher
 */
async function waitForText(read, matcher, timeoutMs = 10_000, pollMs = 20) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (read().includes(matcher)) {
      return;
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for output containing "${matcher}". Got:\n${read()}`);
}

test("findNextPending prefers a human request over its backing approval on the same node", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    const runId = "fnp-run";
    const now = Date.now();
    await insertRun(adapter, runId, "waiting-approval");
    await adapter.insertNode({
      runId,
      nodeId: "gate",
      iteration: 0,
      state: "waiting-approval",
      lastAttempt: 1,
      updatedAtMs: now,
      outputTable: "",
      label: null,
    });
    await adapter.insertOrUpdateApproval({
      runId,
      nodeId: "gate",
      iteration: 0,
      status: "requested",
      requestedAtMs: now,
      decidedAtMs: null,
      note: null,
      decidedBy: null,
      requestJson: null,
      decisionJson: null,
      autoApproved: false,
    });
    await adapter.insertHumanRequest({
      requestId: `human:${runId}:gate:0`,
      runId,
      nodeId: "gate",
      iteration: 0,
      kind: "confirm",
      status: "pending",
      prompt: "Proceed?",
      schemaJson: null,
      optionsJson: null,
      responseJson: null,
      requestedAtMs: now,
      answeredAtMs: null,
      answeredBy: null,
      timeoutAtMs: null,
    });
    const next = await findNextPending(adapter, runId, undefined);
    expect(next?.kind).toBe("human");
    expect(next?.item.nodeId).toBe("gate");
  } finally {
    sqlite.close();
  }
});

test("parseSelectOptions handles string and object options", () => {
  expect(parseSelectOptions(JSON.stringify(["red", "blue"]))).toEqual([
    { label: "red", value: "red" },
    { label: "blue", value: "blue" },
  ]);
  expect(parseSelectOptions(JSON.stringify([{ label: "Red", value: "r" }]))).toEqual([{ label: "Red", value: "r" }]);
  expect(parseSelectOptions(null)).toEqual([]);
  expect(parseSelectOptions("not json")).toEqual([]);
});

test("approve --watch: 'y' approves the gate, then lingers on the terminal run", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    const runId = "watch-approve-run";
    await seedApprovalGate(adapter, runId, "gate");
    const stdin = new PassThrough();
    /** @type {string[]} */
    const out = [];
    let lingerCalled = false;
    const done = runApproveWatch({
      adapter,
      runId,
      stdin,
      emit: (t) => out.push(t),
      pollIntervalMs: 40,
      linger: async () => {
        lingerCalled = true;
      },
    });
    await waitForText(() => out.join(""), "approval needed");
    expect(out.join("")).toContain("Ship the change?");
    stdin.write("y");
    await waitForText(() => out.join(""), "approved gate");

    // The real engine committed the decision: the gate is approved and the node
    // re-armed to pending.
    const approval = await adapter.getApproval(runId, "gate", 0);
    expect(approval?.status).toBe("approved");
    const node = await adapter.getNode(runId, "gate", 0);
    expect(node?.state).toBe("pending");

    // Drive the run terminal; the loop prints the final status line and lingers.
    await adapter.updateRun(runId, { status: "finished", finishedAtMs: Date.now() });
    await waitForText(() => out.join(""), `Run ${runId} finished`);
    const result = await done;
    expect(result.cancelled).toBe(false);
    expect(lingerCalled).toBe(true);
  } finally {
    sqlite.close();
  }
}, 30_000);

test("approve --watch: a committed decision invokes the resumeDetached auto-resume seam", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    const runId = "watch-resume-run";
    await seedApprovalGate(adapter, runId, "gate");
    const stdin = new PassThrough();
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const resumeCalls = [];
    const done = runApproveWatch({
      adapter,
      runId,
      stdin,
      emit: (t) => out.push(t),
      pollIntervalMs: 40,
      linger: async () => {},
      resumeDetached: async (_adapter, _run, id) => {
        resumeCalls.push(id);
        return { resumed: true };
      },
    });
    await waitForText(() => out.join(""), "approval needed");
    stdin.write("y");
    await waitForText(() => out.join(""), "approved gate");
    // The committed decision drove the auto-resume seam + a resuming notice.
    await waitForText(() => out.join(""), `resuming ${runId}`);
    expect(resumeCalls).toEqual([runId]);

    await adapter.updateRun(runId, { status: "finished", finishedAtMs: Date.now() });
    const result = await done;
    expect(result.cancelled).toBe(false);
  } finally {
    sqlite.close();
  }
}, 30_000);

test("approve --watch: a FAILED commit does NOT invoke resumeDetached (no false auto-resume)", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    const runId = "watch-commitfail-run";
    await seedApprovalGate(adapter, runId, "gate");
    // Proxy the adapter so the approval COMMIT fails while reads still succeed:
    // resolveApproval then returns COMMIT_FAILED and the watch loop must SKIP the
    // resume (nothing was decided — a resume here would print a false "resuming").
    const failing = new Proxy(adapter, {
      get(target, prop, receiver) {
        if (prop === "withTransactionEffect") {
          return () => Effect.fail(new Error("simulated commit failure"));
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const stdin = new PassThrough();
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const resumeCalls = [];
    const done = runApproveWatch({
      adapter: failing,
      runId,
      stdin,
      emit: (t) => out.push(t),
      pollIntervalMs: 40,
      linger: async () => {},
      resumeDetached: async (_a, _r, id) => {
        resumeCalls.push(id);
        return { resumed: true };
      },
    });
    await waitForText(() => out.join(""), "approval needed");
    stdin.write("y");
    await waitForText(() => out.join(""), "could not approve gate");
    // Quit the loop (it re-polls the still-pending gate after the failed commit).
    stdin.write(Buffer.from([0x03]));
    const result = await done;
    expect(result.cancelled).toBe(true);
    // The decision never committed → NO auto-resume attempted, and no notice.
    expect(resumeCalls).toEqual([]);
    expect(out.join("")).not.toContain(`resuming ${runId}`);
    // The gate is still pending (the transaction rolled back).
    const approval = await adapter.getApproval(runId, "gate", 0);
    expect(approval?.status).toBe("requested");
  } finally {
    sqlite.close();
  }
}, 30_000);

test("approve --watch: 'n' then a note denies the gate via the real engine", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    const runId = "watch-deny-run";
    await seedApprovalGate(adapter, runId, "gate");
    const stdin = new PassThrough();
    /** @type {string[]} */
    const out = [];
    const done = runApproveWatch({
      adapter,
      runId,
      stdin,
      emit: (t) => out.push(t),
      pollIntervalMs: 40,
      decidedBy: "qa",
      linger: async () => {},
    });
    await waitForText(() => out.join(""), "approval needed");
    stdin.write("n");
    await waitForText(() => out.join(""), "Deny note");
    stdin.write("needs work\n");
    await waitForText(() => out.join(""), "denied gate");

    const approval = await adapter.getApproval(runId, "gate", 0);
    expect(approval?.status).toBe("denied");
    expect(approval?.note).toBe("needs work");
    expect(approval?.decidedBy).toBe("qa");
    // A denied gate fails its node.
    const node = await adapter.getNode(runId, "gate", 0);
    expect(node?.state).toBe("failed");

    await adapter.updateRun(runId, { status: "failed", finishedAtMs: Date.now() });
    const result = await done;
    expect(result.cancelled).toBe(false);
  } finally {
    sqlite.close();
  }
}, 30_000);

test("approve --watch: a select human request answered by digit persists the chosen value", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    const runId = "watch-select-run";
    const requestId = await seedHumanRequest(adapter, runId, "ask1", {
      kind: "select",
      prompt: "Which rollout?",
      optionsJson: JSON.stringify(["red", "blue"]),
      schemaJson: JSON.stringify({ type: "string", enum: ["red", "blue"] }),
    });
    const stdin = new PassThrough();
    /** @type {string[]} */
    const out = [];
    const done = runApproveWatch({
      adapter,
      runId,
      stdin,
      emit: (t) => out.push(t),
      pollIntervalMs: 40,
      decidedBy: "op",
      linger: async () => {},
    });
    await waitForText(() => out.join(""), "human request (select)");
    expect(out.join("")).toContain("[2] blue");
    stdin.write("2");
    await waitForText(() => out.join(""), "answered ask1");

    const fresh = await adapter.getHumanRequest(requestId);
    expect(fresh?.status).toBe("answered");
    expect(fresh?.responseJson).toBe(JSON.stringify("blue"));
    expect(fresh?.answeredBy).toBe("op");

    await adapter.updateRun(runId, { status: "finished", finishedAtMs: Date.now() });
    await done;
  } finally {
    sqlite.close();
  }
}, 30_000);

test("approve --watch: a raw Ctrl-C quits the loop without lingering and leaves the gate pending", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    const runId = "watch-cancel-run";
    await seedApprovalGate(adapter, runId, "gate");
    const stdin = new PassThrough();
    /** @type {string[]} */
    const out = [];
    let lingerCalled = false;
    const done = runApproveWatch({
      adapter,
      runId,
      stdin,
      emit: (t) => out.push(t),
      pollIntervalMs: 40,
      linger: async () => {
        lingerCalled = true;
      },
    });
    await waitForText(() => out.join(""), "approval needed");
    // Raw ETX byte (Ctrl-C in a raw-mode pane fires no SIGINT).
    stdin.write(Buffer.from([0x03]));
    const result = await done;
    expect(result.cancelled).toBe(true);
    expect(lingerCalled).toBe(false);
    // The gate was NOT decided: still requested.
    const approval = await adapter.getApproval(runId, "gate", 0);
    expect(approval?.status).toBe("requested");
  } finally {
    sqlite.close();
  }
}, 30_000);

/**
 * @param {string[]} args
 * @param {{ cwd: string }} options
 */
function spawnSmithersLive(args, options) {
  const child = spawn(BUN_BINARY, ["run", CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...QUIET_ENV },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ exitCode: code ?? 1, signal }));
  });
  return { child, readStdout: () => stdout, readStderr: () => stderr, exited };
}

/** @type {{ child: import("node:child_process").ChildProcess } | undefined} */
let liveProcess;
afterEach(() => {
  if (liveProcess && liveProcess.child.exitCode === null && !liveProcess.child.killed) {
    liveProcess.child.kill("SIGKILL");
  }
  liveProcess = undefined;
});

test("smithers approve --watch on an already-terminal run prints the final status and lingers", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    // A finished run with no pending gates: the watch loop finds nothing
    // actionable, prints the terminal status line, then holds the pane open.
    await insertRun(adapter, "watch-cli-run", "finished");
    await adapter.updateRun("watch-cli-run", { status: "finished", finishedAtMs: Date.now() });
    liveProcess = spawnSmithersLive(["approve", "watch-cli-run", "--watch"], { cwd: repo.dir });
    await waitForText(liveProcess.readStdout, "Run watch-cli-run finished");
    await waitForText(liveProcess.readStdout, "Lingering");
    // It must not exit on its own within a window a non-lingering command would.
    await sleep(1_200);
    expect(liveProcess.child.exitCode).toBeNull();
    liveProcess.child.kill("SIGINT");
    const exit = await liveProcess.exited;
    expect(exit.exitCode).toBe(0);
  } finally {
    sqlite.close();
  }
}, 40_000);

test("createKeyReader resolves reads with CANCEL after a raw Ctrl-C", async () => {
  const stdin = new PassThrough();
  /** @type {string[]} */
  const out = [];
  const reader = createKeyReader(stdin, (t) => out.push(t));
  try {
    const keyP = reader.nextKey();
    await sleep(10);
    stdin.write(Buffer.from([0x03]));
    const key = await keyP;
    expect(key).toBe(CANCEL);
    expect(reader.cancelled()).toBe(true);
    // Every later read short-circuits to CANCEL.
    expect(await reader.nextKey()).toBe(CANCEL);
  } finally {
    reader.close();
  }
}, 10_000);
