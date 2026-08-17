import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Unit-cover the owner-liveness gate AND the durable claim fencing that
// `approve`/`deny` share via maybeResumeDecidedDetachedRun (index.js): a
// genuinely-parked detached run with no live owner is claim-then-spawn resumed;
// a live-owner run is never double-driven; a missing workflow file never spawns
// a doomed resume; and a lost claim (a racing supervisor/second approve already
// won) does NOT double-spawn a second engine.
//
// Exercise the real child_process.spawn path with an executable fixture. A
// module mock would leak between Bun test files; the stub records argv and
// exits immediately without starting an engine.

/** @type {typeof import("../src/index.js")} */
let indexModule;
/** @type {string} */
let existingWorkflow;
/** @type {string} */
let missingWorkflow;
/** @type {string} */
let harnessDir;
/** @type {string} */
let stubExecutable;
/** @type {string} */
let resumeExecutable;
/** @type {string} */
let spawnRecord;
/** @type {string[]} */
let spawnArgs = [];
const previousSpawnRecord = process.env.SMITHERS_TEST_SPAWN_RECORD;

beforeAll(async () => {
  process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN = "1";
  process.env.SMITHERS_NO_SKILL_REFRESH = "1";
  process.env.SMITHERS_NO_UPDATE_CHECK = "1";
  indexModule = await import("../src/index.js");
  harnessDir = mkdtempSync(join(tmpdir(), "approve-resume-unit-"));
  stubExecutable = join(harnessDir, "bun-stub");
  spawnRecord = join(harnessDir, "spawn-argv.txt");
  writeFileSync(
    stubExecutable,
    '#!/bin/sh\ntmp="$SMITHERS_TEST_SPAWN_RECORD.tmp.$$"\nprintf \'%s\\n\' "$@" > "$tmp"\nmv "$tmp" "$SMITHERS_TEST_SPAWN_RECORD"\n',
  );
  chmodSync(stubExecutable, 0o755);
  process.env.SMITHERS_TEST_SPAWN_RECORD = spawnRecord;
  existingWorkflow = join(harnessDir, "workflow", "workflow.tsx");
  missingWorkflow = join(harnessDir, "workflow", "does-not-exist.tsx");
});

afterAll(() => {
  if (previousSpawnRecord === undefined) delete process.env.SMITHERS_TEST_SPAWN_RECORD;
  else process.env.SMITHERS_TEST_SPAWN_RECORD = previousSpawnRecord;
  rmSync(harnessDir, { recursive: true, force: true });
});

beforeEach(() => {
  mkdirSync(dirname(existingWorkflow), { recursive: true });
  writeFileSync(existingWorkflow, "export default {};\n");
  rmSync(spawnRecord, { force: true });
  resumeExecutable = stubExecutable;
  spawnArgs = [];
});

async function readSpawnArgs() {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(spawnRecord)) return readFileSync(spawnRecord, "utf8").trimEnd().split("\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("detached resume stub did not record argv");
}

async function maybeResume(adapter, run, runId) {
  const result = await indexModule.maybeResumeDecidedDetachedRun(adapter, run, runId, {
    executable: resumeExecutable,
  });
  if (result.resumed) spawnArgs = await readSpawnArgs();
  return result;
}

/**
 * A fake adapter that records claim/release calls and lets a test dictate
 * whether the durable claim is won. Only the two methods the resume path uses
 * are implemented.
 * @param {{ claim?: boolean; afterClaim?: () => void }} [opts]
 */
function makeAdapter(opts = {}) {
  const claimWon = opts.claim ?? true;
  /** @type {Array<Record<string, unknown>>} */
  const claimCalls = [];
  /** @type {Array<Record<string, unknown>>} */
  const releaseCalls = [];
  return {
    claimCalls,
    releaseCalls,
    claimRunForResumeEffect(params) {
      claimCalls.push(params);
      opts.afterClaim?.();
      return Promise.resolve(claimWon);
    },
    releaseRunResumeClaimEffect(params) {
      releaseCalls.push(params);
      return Promise.resolve();
    },
  };
}

/**
 * @param {Record<string, unknown>} extra
 */
function parkedGateRun(extra = {}) {
  return {
    runId: "run-1",
    // A genuinely-parked detached gate run: markRunWaiting nulls owner+heartbeat.
    status: "waiting-approval",
    workflowPath: existingWorkflow,
    runtimeOwnerId: null,
    heartbeatAtMs: null,
    ...extra,
  };
}

describe("maybeResumeDecidedDetachedRun", () => {
  test("claims then spawns up --resume WITH the claim for a parked owner-less run", async () => {
    const adapter = makeAdapter();
    const result = await maybeResume(adapter, parkedGateRun(), "run-1");
    expect(result.resumed).toBe(true);
    expect(result.pid).toBeGreaterThan(0);
    // The claim is acquired BEFORE the spawn, scoped to the parked tuple.
    expect(adapter.claimCalls).toHaveLength(1);
    expect(adapter.claimCalls[0]).toMatchObject({
      runId: "run-1",
      expectedStatus: "waiting-approval",
      expectedRuntimeOwnerId: null,
      expectedHeartbeatAtMs: null,
      requireStale: true,
    });
    expect(adapter.releaseCalls).toHaveLength(0);
    expect(spawnArgs).toContain("up");
    expect(spawnArgs).toContain("--resume");
    expect(spawnArgs).toContain("run-1");
    // The child must receive the claim so the engine boot validates it
    // instead of taking the --force ownership-steal branch.
    expect(spawnArgs).toContain("--resume-claim-owner");
    expect(spawnArgs).toContain("--resume-claim-heartbeat");
    const ownerIdx = spawnArgs.indexOf("--resume-claim-owner");
    expect(spawnArgs[ownerIdx + 1]).toBe(adapter.claimCalls[0].claimOwnerId);
  });

  test("resumes a parked waiting-event run too", async () => {
    const adapter = makeAdapter();
    const result = await maybeResume(adapter, parkedGateRun({ status: "waiting-event" }), "run-1");
    expect(result.resumed).toBe(true);
    expect(adapter.claimCalls[0].expectedStatus).toBe("waiting-event");
    expect(spawnArgs).not.toHaveLength(0);
  });

  test("resumes a parked built-in oneshot from its recorded config", async () => {
    const adapter = makeAdapter();
    const result = await maybeResume(
      adapter,
      parkedGateRun({
        workflowPath: null,
        configJson: JSON.stringify({
          builtinResume: { command: "oneshot", args: ["finish the patch", "--agent", "codex"], cwd: harnessDir },
        }),
      }),
      "run-1",
    );
    expect(result.resumed).toBe(true);
    expect(spawnArgs).toContain("oneshot");
    expect(spawnArgs).toContain("finish the patch");
    expect(spawnArgs).toContain("--resume");
    expect(spawnArgs).toContain("run-1");
  });

  test("resumes when the recorded owner pid is verifiably dead", async () => {
    const adapter = makeAdapter();
    const result = await maybeResume(adapter, parkedGateRun({ runtimeOwnerId: "pid:11111:dead-driver" }), "run-1");
    expect(result.resumed).toBe(true);
    // The dead owner is the expected tuple the claim CAS fences against.
    expect(adapter.claimCalls[0].expectedRuntimeOwnerId).toBe("pid:11111:dead-driver");
    expect(spawnArgs).not.toHaveLength(0);
  });

  test("does NOT spawn when the durable claim is lost to a racing resumer", async () => {
    const adapter = makeAdapter({ claim: false });
    const result = await maybeResume(adapter, parkedGateRun(), "run-1");
    expect(result).toEqual({ resumed: false, reason: "claim-lost" });
    expect(adapter.claimCalls).toHaveLength(1);
    // The whole point: a lost claim means another engine is (being) spawned;
    // this path must NOT double-spawn.
    expect(spawnArgs).toHaveLength(0);
  });

  test("releases the claim when the spawn throws, so the run is not left claimed by a dead resumer", async () => {
    const adapter = makeAdapter({ afterClaim: () => rmSync(dirname(existingWorkflow), { recursive: true }) });
    const result = await maybeResume(adapter, parkedGateRun(), "run-1");
    expect(result).toEqual({ resumed: false, reason: "spawn-failed" });
    expect(adapter.claimCalls).toHaveLength(1);
    expect(spawnArgs).toHaveLength(0);
    expect(adapter.releaseCalls).toHaveLength(1);
    expect(adapter.releaseCalls[0]).toMatchObject({
      runId: "run-1",
      claimOwnerId: adapter.claimCalls[0].claimOwnerId,
    });
  });

  test("releases the claim when the spawn produces NO pid (async ENOENT / missing bun), not just on a synchronous throw", async () => {
    // A spawn that fails asynchronously (missing `bun`, hit process limit)
    // returns a ChildProcess with `pid === undefined` WITHOUT throwing, so
    // resumeRunDetached returns null. This must be treated as a failed boot:
    // release the claim and report resumed:false — never resumed:true with a
    // null pid, which would strand the run claimed by an engine that never
    // started (and, detached with no supervisor, nothing would retry it).
    resumeExecutable = join(harnessDir, "missing-bun");
    const adapter = makeAdapter();
    const result = await maybeResume(adapter, parkedGateRun(), "run-1");
    expect(result).toEqual({ resumed: false, reason: "spawn-failed" });
    expect(adapter.claimCalls).toHaveLength(1);
    expect(spawnArgs).toHaveLength(0);
    expect(adapter.releaseCalls).toHaveLength(1);
    expect(adapter.releaseCalls[0]).toMatchObject({
      runId: "run-1",
      claimOwnerId: adapter.claimCalls[0].claimOwnerId,
    });
  });

  test("does NOT resume (or claim) when a live owner pid is driving the run (no double engine)", async () => {
    const adapter = makeAdapter();
    const result = await maybeResume(
      adapter,
      parkedGateRun({ runtimeOwnerId: `pid:${process.pid}:live-driver` }),
      "run-1",
    );
    expect(result).toEqual({ resumed: false, reason: "owner-alive" });
    expect(adapter.claimCalls).toHaveLength(0);
    expect(spawnArgs).toHaveLength(0);
  });

  test("does NOT resume (or claim) a run that is not parked", async () => {
    const adapter = makeAdapter();
    const result = await maybeResume(adapter, parkedGateRun({ status: "finished" }), "run-1");
    expect(result).toEqual({ resumed: false, reason: "not-parked" });
    expect(adapter.claimCalls).toHaveLength(0);
    expect(spawnArgs).toHaveLength(0);
  });

  test("does NOT resume when the run has no workflow path", async () => {
    const adapter = makeAdapter();
    const result = await maybeResume(adapter, parkedGateRun({ workflowPath: null }), "run-1");
    expect(result).toEqual({ resumed: false, reason: "no-workflow-path" });
    expect(adapter.claimCalls).toHaveLength(0);
    expect(spawnArgs).toHaveLength(0);
  });

  test("does NOT resume when the workflow file is missing (mirrors the supervisor's workflowExists gate)", async () => {
    const adapter = makeAdapter();
    const result = await maybeResume(adapter, parkedGateRun({ workflowPath: missingWorkflow }), "run-1");
    expect(result).toEqual({ resumed: false, reason: "workflow-missing" });
    expect(adapter.claimCalls).toHaveLength(0);
    expect(spawnArgs).toHaveLength(0);
  });

  test("does NOT resume a missing run row", async () => {
    const adapter = makeAdapter();
    const result = await maybeResume(adapter, null, "run-1");
    expect(result).toEqual({ resumed: false, reason: "run-missing" });
    expect(adapter.claimCalls).toHaveLength(0);
    expect(spawnArgs).toHaveLength(0);
  });
});
