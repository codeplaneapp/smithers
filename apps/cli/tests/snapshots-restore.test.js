import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { runSnapshotsOnce } from "../src/snapshots.js";
import { defaultRevert, pickTargetCheckpoint, runRestoreOnce } from "../src/restore.js";

function capture() {
  let out = "";
  return {
    write: (s) => {
      out += s;
    },
    get: () => out,
  };
}

const snapAdapter = {
  async listWorkspaceCheckpoints() {
    return [
      {
        seq: 0,
        nodeId: "task",
        iteration: 0,
        attempt: 0,
        tier: 2,
        source: "watch",
        label: null,
        jjCwd: "/wt",
        jjCommitId: "commit000000aaa",
        createdAtMs: Date.now() - 3000,
      },
      {
        seq: 1,
        nodeId: "task",
        iteration: 0,
        attempt: 0,
        tier: 1,
        source: "hook",
        label: "Edit a.ts",
        jjCwd: "/wt",
        jjCommitId: "commit111111bbb",
        createdAtMs: Date.now() - 1000,
      },
    ];
  },
  async listWorkspaceStates() {
    return [
      { jjCwd: "/wt", jjCommitId: "commit000000aaa", jjOperationId: "op000000xxx" },
      { jjCwd: "/wt", jjCommitId: "commit111111bbb", jjOperationId: "op111111yyy" },
    ];
  },
};

describe("smithers snapshots", () => {
  test("lists checkpoints with their operation ids and labels", async () => {
    const out = capture();
    const r = await runSnapshotsOnce({ adapter: snapAdapter, runId: "r1", stdout: out });
    expect(r.exitCode).toBe(0);
    expect(out.get()).toContain("#0");
    expect(out.get()).toContain("#1");
    expect(out.get()).toContain("Edit a.ts");
    expect(out.get()).toContain("op111111yyy");
  });

  test("json mode emits machine-readable rows", async () => {
    const out = capture();
    await runSnapshotsOnce({ adapter: snapAdapter, runId: "r1", json: true, stdout: out });
    const parsed = JSON.parse(out.get());
    expect(parsed.snapshots).toHaveLength(2);
    expect(parsed.snapshots[1].runId).toBe("r1");
    expect(parsed.snapshots[1].operationId).toBe("op111111yyy");
    expect(parsed.snapshots[1].label).toBe("Edit a.ts");
  });

  test("a parent lists descendant checkpoints with their owning run id", async () => {
    const out = capture();
    await runSnapshotsOnce({
      adapter: {
        async listRunDescendants() {
          return [
            { runId: "parent", parentRunId: null, depth: 0 },
            { runId: "parent:child:sub:0", parentRunId: "parent", depth: 1 },
          ];
        },
        async listWorkspaceCheckpoints(runId) {
          return runId === "parent"
            ? []
            : [
                {
                  seq: 0,
                  nodeId: "child-task",
                  iteration: 0,
                  attempt: 1,
                  tier: 2,
                  source: "watch",
                  jjCwd: "/wt",
                  jjCommitId: "child-commit",
                  createdAtMs: 10,
                },
              ];
        },
        async listWorkspaceStates(runId) {
          return runId === "parent" ? [] : [{ jjCwd: "/wt", jjCommitId: "child-commit", jjOperationId: "child-op" }];
        },
      },
      runId: "parent",
      json: true,
      stdout: out,
    });
    expect(JSON.parse(out.get()).snapshots).toEqual([
      expect.objectContaining({
        runId: "parent:child:sub:0",
        nodeId: "child-task",
        operationId: "child-op",
      }),
    ]);
  });

  test("a parent excludes fork and continuation snapshot subtrees", async () => {
    const out = capture();
    const rows = [
      { runId: "parent", parentRunId: null, depth: 0 },
      { runId: "parent:child:sub:0", parentRunId: "parent", depth: 1 },
      { runId: "fork", parentRunId: "parent", depth: 1 },
      { runId: "fork:child:nested:0", parentRunId: "fork", depth: 2 },
      { runId: "continuation", parentRunId: "parent", depth: 1 },
    ];
    await runSnapshotsOnce({
      adapter: {
        async listRunDescendants() {
          return rows;
        },
        async listWorkspaceCheckpoints(runId) {
          return [{ ...(await snapAdapter.listWorkspaceCheckpoints())[0], nodeId: runId, createdAtMs: 10 }];
        },
        async listWorkspaceStates() {
          return [];
        },
      },
      runId: "parent",
      json: true,
      stdout: out,
    });
    expect(JSON.parse(out.get()).snapshots.map((snapshot) => snapshot.runId)).toEqual(["parent", "parent:child:sub:0"]);
  });

  test("empty run is reported, not an error", async () => {
    const out = capture();
    const r = await runSnapshotsOnce({
      adapter: {
        async listWorkspaceCheckpoints() {
          return [];
        },
        async listWorkspaceStates() {
          return [];
        },
      },
      runId: "r1",
      stdout: out,
    });
    expect(r.exitCode).toBe(0);
    expect(out.get()).toContain("No durability snapshots");
  });
});

describe("smithers restore", () => {
  const cps = [
    { nodeId: "n1", iteration: 0, attempt: 0, seq: 0, jjCommitId: "c0", jjCwd: "/wt", createdAtMs: 10 },
    { nodeId: "n1", iteration: 0, attempt: 0, seq: 1, jjCommitId: "c1", jjCwd: "/wt", createdAtMs: 20 },
    { nodeId: "n2", iteration: 0, attempt: 0, seq: 0, jjCommitId: "d0", jjCwd: "/wt", createdAtMs: 30 },
  ];

  test("pickTargetCheckpoint picks the latest, honors --seq, returns null on no match", () => {
    expect(pickTargetCheckpoint(cps, { nodeId: "n1" })?.jjCommitId).toBe("c1");
    expect(pickTargetCheckpoint(cps, { nodeId: "n1", seq: 0 })?.jjCommitId).toBe("c0");
    expect(pickTargetCheckpoint(cps, { nodeId: "none" })).toBeNull();
  });

  test("pickTargetCheckpoint resolves a parent subflow node to its child checkpoint", () => {
    expect(
      pickTargetCheckpoint(
        [
          {
            ...cps[2],
            runId: "parent:child:sub:0",
            ownerNodeId: "sub",
            ownerIteration: 0,
          },
        ],
        { nodeId: "sub" },
      )?.jjCommitId,
    ).toBe("d0");
  });

  test("pickTargetCheckpoint prefers the requested run when a child reuses its node id", () => {
    expect(
      pickTargetCheckpoint(
        [
          { ...cps[0], runId: "parent" },
          { ...cps[1], runId: "parent:child:sub:0", createdAtMs: 100 },
        ],
        { runId: "parent", nodeId: "n1" },
      )?.jjCommitId,
    ).toBe("c0");
  });

  test("restore never selects a newer checkpoint from a fork", async () => {
    const reverted = [];
    const checkpoints = {
      parent: [{ ...cps[0], runId: "parent", jjCommitId: "MINE", jjCwd: "/mine", createdAtMs: 100 }],
      fork: [{ ...cps[0], runId: "fork", jjCommitId: "FORK", jjCwd: "/fork", createdAtMs: 200 }],
    };
    const result = await runRestoreOnce({
      adapter: {
        async listRunDescendants() {
          return [
            { runId: "parent", parentRunId: null, depth: 0 },
            { runId: "fork", parentRunId: "parent", depth: 1 },
          ];
        },
        async listWorkspaceCheckpoints(runId) {
          return checkpoints[runId] ?? [];
        },
        async listWorkspaceStates() {
          return [];
        },
      },
      runId: "parent",
      nodeId: "n1",
      stdout: capture(),
      stderr: capture(),
      revert: async (commitId, cwd) => {
        reverted.push([commitId, cwd]);
        return { success: true };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(reverted).toEqual([["MINE", "/mine"]]);
  });

  test("restore refuses to invalidate child work while the parent is active", async () => {
    const reverted = [];
    const err = capture();
    const target = { ...cps[0], runId: "parent", createdAtMs: 10 };
    const child = {
      ...cps[1],
      runId: "parent:child:sub:0",
      nodeId: "child-task",
      createdAtMs: 20,
    };
    const result = await runRestoreOnce({
      adapter: {
        async listRunDescendants() {
          return [
            { runId: "parent", parentRunId: null, depth: 0 },
            { runId: "parent:child:sub:0", parentRunId: "parent", depth: 1 },
          ];
        },
        async listWorkspaceCheckpoints(runId) {
          return runId === "parent" ? [target] : [child];
        },
        async listWorkspaceStates() {
          return [];
        },
        async getNode() {
          return { runId: "parent", nodeId: "sub", iteration: 0 };
        },
        async getRun() {
          return { runId: "parent", status: "waiting-quota" };
        },
      },
      runId: "parent",
      nodeId: "n1",
      stdout: capture(),
      stderr: err,
      revert: async (commitId, cwd) => {
        reverted.push([commitId, cwd]);
        return { success: true };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(reverted).toEqual([]);
    expect(err.get()).toContain("Run is still running: parent");
  });

  test("invalidates newer child state before touching the filesystem", async () => {
    const reverted = [];
    const err = capture();
    const target = { ...cps[0], runId: "parent", createdAtMs: 10 };
    const child = {
      ...cps[1],
      runId: "parent:child:sub:0",
      nodeId: "child-task",
      createdAtMs: 20,
    };
    const result = await runRestoreOnce({
      adapter: {
        async listRunDescendants() {
          return [
            { runId: "parent", parentRunId: null, depth: 0 },
            { runId: "parent:child:sub:0", parentRunId: "parent", depth: 1 },
          ];
        },
        async listWorkspaceCheckpoints(runId) {
          return runId === "parent" ? [target] : [child];
        },
        async listWorkspaceStates() {
          return [];
        },
        async getNode() {
          return null;
        },
        async getRun() {
          return { runId: "parent", status: "failed" };
        },
      },
      runId: "parent",
      nodeId: "n1",
      target,
      stdout: capture(),
      stderr: err,
      revert: async (commitId, cwd) => {
        reverted.push([commitId, cwd]);
        return { success: true };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(reverted).toEqual([]);
    expect(err.get()).toContain("Node not found: parent/sub/0");
  });

  test("reverts to the target and reports success", async () => {
    const reverted = [];
    const out = capture();
    const r = await runRestoreOnce({
      adapter: {
        async listWorkspaceCheckpoints() {
          return cps;
        },
      },
      runId: "r1",
      nodeId: "n1",
      stdout: out,
      stderr: capture(),
      revert: async (commitId, cwd) => {
        reverted.push([commitId, cwd]);
        return { success: true };
      },
    });
    expect(r.exitCode).toBe(0);
    expect(reverted).toEqual([["c1", "/wt"]]);
    expect(out.get()).toContain("Restored");
  });

  test("reuses a preselected target without an adapter to list from", async () => {
    const reverted = [];
    const out = capture();
    const r = await runRestoreOnce({
      // No adapter: a preselected target must be honored without any
      // listWorkspaceCheckpoints read, so callers can omit it entirely.
      runId: "r1",
      nodeId: "n1",
      target: cps[0],
      stdout: out,
      stderr: capture(),
      revert: async (commitId, cwd) => {
        reverted.push([commitId, cwd]);
        return { success: true };
      },
    });

    expect(r.exitCode).toBe(0);
    expect(reverted).toEqual([["c0", "/wt"]]);
    expect(out.get()).toContain("checkpoint #0");
  });

  test("rejects a preselected target that does not match the requested node", async () => {
    const reverted = [];
    const err = capture();
    const r = await runRestoreOnce({
      runId: "r1",
      nodeId: "n2",
      target: cps[0],
      stdout: capture(),
      stderr: err,
      revert: async (commitId, cwd) => {
        reverted.push([commitId, cwd]);
        return { success: true };
      },
    });

    expect(r.exitCode).toBe(1);
    expect(reverted).toEqual([]);
    // A mis-reported preselected target gets a distinct, actionable message
    // rather than the generic listing-miss text.
    expect(err.get()).toContain("Preselected checkpoint");
    expect(err.get()).toContain("does not match requested node n2");
    expect(err.get()).toContain("for run r1");
  });

  test("rejects a preselected target whose iteration differs, naming both iterations", async () => {
    const reverted = [];
    const err = capture();
    const r = await runRestoreOnce({
      runId: "r1",
      nodeId: "n1",
      iteration: 1,
      target: cps[0], // n1 iteration 0 — right node, wrong iteration
      stdout: capture(),
      stderr: err,
      revert: async (commitId, cwd) => {
        reverted.push([commitId, cwd]);
        return { success: true };
      },
    });

    expect(r.exitCode).toBe(1);
    expect(reverted).toEqual([]);
    // Both the target's iteration and the requested iteration are named so
    // an iteration-only mismatch isn't two identical-looking checkpoints.
    expect(err.get()).toContain("iteration 0");
    expect(err.get()).toContain("iteration 1");
  });

  test("a rejected preselect does NOT fall back to listing from the adapter", async () => {
    const reverted = [];
    const err = capture();
    let listed = false;
    const r = await runRestoreOnce({
      // An adapter that WOULD supply a matching checkpoint is present, but a
      // rejected preselect must fail loudly, never silently list-and-pick a
      // different checkpoint than the one the caller reported.
      adapter: {
        async listWorkspaceCheckpoints() {
          listed = true;
          return cps;
        },
      },
      runId: "r1",
      nodeId: "n2", // cps[2] (d0) would match if we fell back to listing
      target: cps[0], // preselected n1 — mismatched, must be rejected
      stdout: capture(),
      stderr: err,
      revert: async (commitId, cwd) => {
        reverted.push([commitId, cwd]);
        return { success: true };
      },
    });

    expect(r.exitCode).toBe(1);
    expect(reverted).toEqual([]);
    expect(listed).toBe(false);
    expect(err.get()).toContain("Preselected checkpoint");
  });

  test("rejects a preselected target whose seq differs from the requested --seq", async () => {
    const reverted = [];
    const err = capture();
    const r = await runRestoreOnce({
      runId: "r1",
      nodeId: "n1",
      seq: 1,
      target: cps[0], // n1 seq 0 — right node, wrong seq
      stdout: capture(),
      stderr: err,
      revert: async (commitId, cwd) => {
        reverted.push([commitId, cwd]);
        return { success: true };
      },
    });

    expect(r.exitCode).toBe(1);
    expect(reverted).toEqual([]);
    expect(err.get()).toContain("Preselected checkpoint");
    expect(err.get()).toContain("seq 1");
  });

  test("honors a preselected target that matches the requested --seq", async () => {
    const reverted = [];
    const out = capture();
    const r = await runRestoreOnce({
      runId: "r1",
      nodeId: "n1",
      seq: 0,
      target: cps[0], // n1 seq 0 — matches
      stdout: out,
      stderr: capture(),
      revert: async (commitId, cwd) => {
        reverted.push([commitId, cwd]);
        return { success: true };
      },
    });

    expect(r.exitCode).toBe(0);
    expect(reverted).toEqual([["c0", "/wt"]]);
    expect(out.get()).toContain("checkpoint #0");
  });

  test("missing checkpoint exits non-zero with a message", async () => {
    const err = capture();
    const r = await runRestoreOnce({
      adapter: {
        async listWorkspaceCheckpoints() {
          return cps;
        },
      },
      runId: "r1",
      nodeId: "nope",
      stdout: capture(),
      stderr: err,
      revert: async () => ({ success: true }),
    });
    expect(r.exitCode).toBe(1);
    expect(err.get()).toContain("No matching");
  });

  test("a failed revert exits non-zero", async () => {
    const err = capture();
    const r = await runRestoreOnce({
      adapter: {
        async listWorkspaceCheckpoints() {
          return cps;
        },
      },
      runId: "r1",
      nodeId: "n1",
      stdout: capture(),
      stderr: err,
      revert: async () => ({ success: false, error: "commit gone" }),
    });
    expect(r.exitCode).toBe(1);
    expect(err.get()).toContain("commit gone");
  });

  test("a failed revert preserves durable child-run state", async () => {
    const target = { ...cps[0], runId: "parent", createdAtMs: 10 };
    const child = {
      ...cps[1],
      runId: "parent:child:sub:0",
      nodeId: "child-task",
      createdAtMs: 20,
    };
    let nodeState = "finished";
    let transactionCalls = 0;
    const ownerNode = {
      runId: "parent",
      nodeId: "sub",
      iteration: 0,
      state: nodeState,
      updatedAtMs: 15,
      outputTable: "sub_output",
    };
    const result = await runRestoreOnce({
      adapter: {
        async listRunDescendants() {
          return [
            { runId: "parent", parentRunId: null, depth: 0 },
            { runId: "parent:child:sub:0", parentRunId: "parent", depth: 1 },
          ];
        },
        async listWorkspaceCheckpoints(runId) {
          return runId === "parent" ? [target] : [child];
        },
        async listWorkspaceStates() {
          return [];
        },
        async getNode() {
          return ownerNode;
        },
        async getRun(runId) {
          return runId === "parent" ? { runId, status: "failed" } : null;
        },
        async listNodes() {
          return [ownerNode];
        },
        async listAttemptsForRun() {
          return [];
        },
        async listAttempts() {
          return [];
        },
        async withTransaction() {
          transactionCalls += 1;
          nodeState = "pending";
          return true;
        },
      },
      runId: "parent",
      nodeId: "n1",
      target,
      stdout: capture(),
      stderr: capture(),
      revert: async () => ({ success: false, error: "commit gone" }),
    });

    expect(result.exitCode).toBe(1);
    expect(transactionCalls).toBe(0);
    expect(nodeState).toBe("finished");
  });

  test("reverts before invalidating all child owners in one transaction", async () => {
    const target = { ...cps[0], runId: "parent", createdAtMs: 10 };
    const ownerNodes = [
      { runId: "parent", nodeId: "sub-a", iteration: 0, state: "finished", updatedAtMs: 20, outputTable: "" },
      { runId: "parent", nodeId: "sub-b", iteration: 0, state: "finished", updatedAtMs: 30, outputTable: "" },
    ];
    const events = [];
    const resetNodes = [];
    const result = await runRestoreOnce({
      adapter: {
        async listRunDescendants() {
          return [
            { runId: "parent", parentRunId: null, depth: 0 },
            { runId: "parent:child:sub-a:0", parentRunId: "parent", depth: 1 },
            { runId: "parent:child:sub-b:0", parentRunId: "parent", depth: 1 },
          ];
        },
        async listWorkspaceCheckpoints(runId) {
          if (runId === "parent") return [target];
          return [
            {
              ...cps[1],
              runId,
              nodeId: "child-task",
              createdAtMs: runId.includes("sub-a") ? 20 : 30,
            },
          ];
        },
        async listWorkspaceStates() {
          return [];
        },
        async getNode(_runId, nodeId) {
          return ownerNodes.find((node) => node.nodeId === nodeId) ?? null;
        },
        async getRun(runId) {
          return runId === "parent" ? { runId, status: "failed" } : null;
        },
        async listNodes() {
          return ownerNodes;
        },
        async listAttemptsForRun() {
          return [];
        },
        async listAttempts() {
          return [];
        },
        insertNodeEffect(row) {
          return Effect.sync(() => {
            resetNodes.push(row.nodeId);
          });
        },
        updateRunEffect() {
          return Effect.void;
        },
        async withTransaction(writeGroup, operation) {
          events.push(`transaction:${writeGroup}`);
          return Effect.runPromise(operation);
        },
      },
      runId: "parent",
      nodeId: "n1",
      target,
      stdout: capture(),
      stderr: capture(),
      revert: async () => {
        events.push("revert");
        return { success: true };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(events).toEqual(["revert", "transaction:restore-child-work-invalidation"]);
    expect(resetNodes).toEqual(["sub-a", "sub-b", "sub-b"]);
  });

  test("the timeout and abort signal reach the revert runner", async () => {
    /** @type {Array<unknown>} */
    const seen = [];
    const controller = new AbortController();
    const r = await runRestoreOnce({
      adapter: {
        async listWorkspaceCheckpoints() {
          return cps;
        },
      },
      runId: "r1",
      nodeId: "n1",
      stdout: capture(),
      stderr: capture(),
      timeoutMs: 1234,
      signal: controller.signal,
      revert: async (_commitId, _cwd, options) => {
        seen.push(options);
        return { success: true };
      },
    });
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual([{ timeoutMs: 1234, signal: controller.signal }]);
  });
});

describe("smithers restore jj invocation", () => {
  /**
   * A stand-in `jj` on disk, picked up through the SMITHERS_JJ_PATH override.
   * @param {string} body
   */
  function withFakeJj(body, fn) {
    const dir = mkdtempSync(join(tmpdir(), "smithers-restore-"));
    const bin = join(dir, "jj");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const previous = process.env.SMITHERS_JJ_PATH;
    process.env.SMITHERS_JJ_PATH = bin;
    return (async () => {
      try {
        return await fn(dir);
      } finally {
        if (previous === undefined) delete process.env.SMITHERS_JJ_PATH;
        else process.env.SMITHERS_JJ_PATH = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    })();
  }

  test("passes the checkpoint commit to jj restore and reports success", async () => {
    await withFakeJj('printf "%s" "$*" > "$(dirname "$0")/argv"; exit 0', async (dir) => {
      const result = await defaultRevert("cafebabe", dir, { timeoutMs: 30_000 });
      expect(result).toEqual({ success: true });
      expect(readFileSync(join(dir, "argv"), "utf8")).toBe("restore --from cafebabe");
    });
  });

  test("a non-zero jj reports its stderr", async () => {
    await withFakeJj('echo "commit gone" >&2; exit 3', async (dir) => {
      const result = await defaultRevert("cafebabe", dir, { timeoutMs: 30_000 });
      expect(result.success).toBe(false);
      expect(result.error).toBe("commit gone");
    });
  });

  test("a hung jj restore times out instead of blocking the event loop", async () => {
    // Regression: this used to be a spawnSync, so a jj stuck on a repo lock
    // or a slow filesystem froze the CLI *and* the in-process MCP server
    // (no other tool call, cancellation, or shutdown could be serviced)
    // until jj exited on its own — which it may never do.
    await withFakeJj("exec sleep 5", async (dir) => {
      let ticked = false;
      const ticker = setTimeout(() => {
        ticked = true;
      }, 100);
      const startedAtMs = Date.now();
      try {
        const result = await defaultRevert("cafebabe", dir, { timeoutMs: 400 });
        expect(result.success).toBe(false);
        expect(result.error).toContain("timed out");
        // The loop kept running while jj was live, and we did not wait
        // out the full 5s sleep.
        expect(ticked).toBe(true);
        expect(Date.now() - startedAtMs).toBeLessThan(4_000);
      } finally {
        clearTimeout(ticker);
      }
    });
  });

  test("an already-aborted signal never spawns jj at all", async () => {
    await withFakeJj('printf "%s" "$*" > "$(dirname "$0")/argv"; exit 0', async (dir) => {
      const result = await defaultRevert("cafebabe", dir, { signal: AbortSignal.abort() });
      expect(result.success).toBe(false);
      expect(result.error).toContain("aborted");
      // A cancelled restore is destructive-if-run: jj must not have been invoked.
      expect(() => readFileSync(join(dir, "argv"), "utf8")).toThrow();
    });
  });

  test("an aborted restore terminates jj and resolves a typed failure", async () => {
    await withFakeJj("exec sleep 5", async (dir) => {
      const controller = new AbortController();
      const pending = defaultRevert("cafebabe", dir, { timeoutMs: 30_000, signal: controller.signal });
      controller.abort();
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.error).toContain("aborted");
    });
  });
});
