/** @jsxImportSource smthrs */
// Cross-feature audit: durability snapshots (Tier 1/2 workspace checkpoints)
// combined with child workflows (<Subflow mode="childRun">).
//
// Harness idioms are copied from durability-snapshots.e2e.test.jsx (jj temp
// dir + SMITHERS_DURABILITY_SNAPSHOTS env flip + scripted file-writing agent)
// and dynamic-workflow-file-subflow.e2e.test.jsx (real <Subflow> parent runs,
// deterministic child run ids, abort-then-resume). The parent-facing agent
// surfaces (`smithers snapshots` / `restore`, which the MCP `list_snapshots`
// and `restore_checkpoint` tools call into) are exercised directly so the
// assertions describe what an agent actually sees.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { Effect } from "effect";
import { Parallel, Subflow, Task, Workflow } from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
import { runWorkflow } from "../src/engine.js";
import { defaultGapSpoolPath } from "../src/durabilityGapSpool.js";
import { runSnapshotsOnce } from "../../../apps/cli/src/snapshots.js";
import { runRestoreOnce } from "../../../apps/cli/src/restore.js";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";

const END_TO_END_TIMEOUT_MS = 90_000;

const jjAvailable = (() => {
  try {
    return spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();
const describeIfJj = jjAvailable ? describe : describe.skip;

/** @param {string} prefix */
function initJjDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const init = spawnSync("jj", ["git", "init"], { cwd: dir, encoding: "utf8" });
  if (init.status !== 0) throw new Error(`jj git init failed: ${init.stderr}`);
  return dir;
}

/**
 * An agent that writes `file` into its worktree (taskRoot) during the turn.
 * @param {string} file
 * @param {string} [body]
 * @param {{ delayBeforeMs?: number, delayAfterMs?: number }} [timing]
 */
function writingAgent(file, body = "written\n", timing = {}) {
  return {
    id: `writer-${file}`,
    tools: {},
    generate: async (args) => {
      if (timing.delayBeforeMs) await sleep(timing.delayBeforeMs);
      if (args.rootDir) writeFileSync(join(args.rootDir, file), body);
      if (timing.delayAfterMs) await sleep(timing.delayAfterMs);
      return { output: { value: 1 } };
    },
  };
}

/** An agent that hangs on its first turn until aborted, then succeeds. */
function hangThenSucceedAgent(markerPath) {
  let turns = 0;
  return {
    id: "hang-then-succeed",
    tools: {},
    generate: async (args) => {
      turns += 1;
      if (turns > 1) return { output: { value: 2 } };
      writeFileSync(markerPath, "started\n");
      await new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("hang agent never aborted")), 30_000);
        timer.unref?.();
        const onAbort = () => {
          clearTimeout(timer);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (args.abortSignal?.aborted) onAbort();
        else args.abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
      return { output: { value: 1 } };
    },
  };
}

function buildSmithers() {
  return createTestSmithers({
    parentOut: z.object({ value: z.number() }),
    subflowOut: z.object({ value: z.number() }),
    childOut: z.object({ value: z.number() }),
    tailOut: z.object({ value: z.number() }),
  });
}

/** @template T @param {() => Promise<T>} fn */
async function withDurabilityOn(fn) {
  const prev = process.env.SMITHERS_DURABILITY_SNAPSHOTS;
  process.env.SMITHERS_DURABILITY_SNAPSHOTS = "1";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SMITHERS_DURABILITY_SNAPSHOTS;
    else process.env.SMITHERS_DURABILITY_SNAPSHOTS = prev;
  }
}

function collect() {
  let text = "";
  return {
    write: (chunk) => {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

/** @param {string} runId */
function readGaps(runId) {
  const spool = defaultGapSpoolPath(runId);
  if (!existsSync(spool)) return [];
  return readFileSync(spool, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}

/** Files tracked in a jj commit, so a checkpoint's real contents are auditable. */
function filesInCommit(cwd, commitId) {
  const out = spawnSync("jj", ["file", "list", "-r", commitId], { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`jj file list failed: ${out.stderr}`);
  return out.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

describeIfJj("durability snapshots x child workflows (subflow)", () => {
  test(
    "checkpoints captured while a child run's task executes are attributed to the child run",
    async () => {
      const jjDir = initJjDir("xcombo-attr-");
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        await withDurabilityOn(async () => {
          const childWorkflow = smithers(
            () => (
              <Workflow name="xcombo-attr-child">
                <Task id="child-write" output={outputs.childOut} agent={writingAgent("child.txt")}>
                  write the child file
                </Task>
              </Workflow>
            ),
            { output: outputs.childOut },
          );
          const parent = smithers(() => (
            <Workflow name="xcombo-attr-parent">
              <Task id="parent-write" output={outputs.parentOut} agent={writingAgent("parent.txt")}>
                write the parent file
              </Task>
              <Subflow
                id="sub"
                output={outputs.subflowOut}
                workflow={childWorkflow}
                dependsOn={["parent-write"]}
                retries={0}
              />
            </Workflow>
          ));
          const runId = "xcombo-attr-parent-run";
          const result = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, rootDir: jjDir }));
          expect(result.status).toBe("finished");

          const adapter = new SmithersDb(db);
          const childRunId = `${runId}:child:sub:0`;
          expect((await adapter.getRun(childRunId))?.parentRunId).toBe(runId);

          // Tier 2 durability is live inside the child run: the child task's
          // writes are checkpointed, under the child run id, with a durable
          // jj operation handle on the state row.
          const childCheckpoints = await adapter.listWorkspaceCheckpoints(childRunId);
          expect(childCheckpoints.length).toBeGreaterThanOrEqual(1);
          expect(childCheckpoints.every((c) => c.nodeId === "child-write")).toBe(true);
          const childStates = await adapter.listWorkspaceStates(childRunId);
          expect(childStates.length).toBeGreaterThanOrEqual(1);
          expect(childStates.every((s) => typeof s.jjOperationId === "string" && s.jjOperationId.length > 0)).toBe(
            true,
          );

          // The parent's own agent task is checkpointed under the parent id.
          const parentCheckpoints = await adapter.listWorkspaceCheckpoints(runId);
          expect(parentCheckpoints.map((c) => c.nodeId)).toEqual(["parent-write"]);
          // No durability gaps were spooled for either run.
          expect(readGaps(runId)).toEqual([]);
          expect(readGaps(childRunId)).toEqual([]);
        });
      } finally {
        cleanup();
        rmSync(jjDir, { recursive: true, force: true });
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "the parent run can list and restore the checkpoints its subflow produced",
    async () => {
      // A parent that delegates all file work to a <Subflow> is the shape every
      // orchestrator workflow has. The user only ever knows the parent run id
      // ("my run"), so the parent-facing snapshot surfaces must expose the
      // checkpoints taken while the child ran, and `restore` must accept the
      // subflow node id that the parent's own graph exposes.
      const jjDir = initJjDir("xcombo-list-");
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        await withDurabilityOn(async () => {
          const childWorkflow = smithers(
            () => (
              <Workflow name="xcombo-list-child">
                <Task id="child-write" output={outputs.childOut} agent={writingAgent("child.txt")}>
                  write the child file
                </Task>
              </Workflow>
            ),
            { output: outputs.childOut },
          );
          const parent = smithers(() => (
            <Workflow name="xcombo-list-parent">
              <Subflow id="sub" output={outputs.subflowOut} workflow={childWorkflow} retries={0} />
            </Workflow>
          ));
          const runId = "xcombo-list-parent-run";
          const result = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, rootDir: jjDir }));
          expect(result.status).toBe("finished");
          expect(existsSync(join(jjDir, "child.txt"))).toBe(true);

          const adapter = new SmithersDb(db);
          const childRunId = `${runId}:child:sub:0`;
          // The work WAS checkpointed - just under the hidden child run id.
          expect((await adapter.listWorkspaceCheckpoints(childRunId)).length).toBeGreaterThanOrEqual(1);

          // `smithers snapshots <parent>` / MCP list_snapshots(parent).
          const listed = collect();
          await runSnapshotsOnce({ adapter, runId, json: true, stdout: listed });
          const humanListed = collect();
          await runSnapshotsOnce({ adapter, runId, stdout: humanListed });
          expect(humanListed.text).not.toContain("No durability snapshots");
          expect(JSON.parse(listed.text).snapshots.length).toBeGreaterThanOrEqual(1);

          // `smithers restore <parent> --node sub` / MCP restore_checkpoint on
          // the subflow node id the parent's graph and timeline expose.
          const stdout = collect();
          const stderr = collect();
          const restore = await runRestoreOnce({ adapter, runId, nodeId: "sub", stdout, stderr });
          expect(stderr.text).toBe("");
          expect(restore.exitCode).toBe(0);
        });
      } finally {
        cleanup();
        rmSync(jjDir, { recursive: true, force: true });
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "restoring the parent behind a finished child does not silently destroy the child's work",
    async () => {
      // "Roll my files back to the checkpoint before that step and run it
      // again": restoring the parent to a checkpoint captured BEFORE its
      // subflow ran wipes the child's files out of the worktree, while the
      // child run stays `finished` - so prefer-resume replays its recorded
      // output and never recreates them. Either the restore must refuse /
      // invalidate the child, or the resume must re-execute it; both fixes
      // leave the child's file on disk once the parent reaches `finished`.
      const jjDir = initJjDir("xcombo-restore-");
      const tailMarker = join(tmpdir(), `xcombo-tail-${Date.now()}`);
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        await withDurabilityOn(async () => {
          const childWorkflow = smithers(
            () => (
              <Workflow name="xcombo-restore-child">
                <Task id="child-write" output={outputs.childOut} agent={writingAgent("child.txt")}>
                  write the child file
                </Task>
              </Workflow>
            ),
            { output: outputs.childOut },
          );
          const tailAgent = hangThenSucceedAgent(tailMarker);
          const parent = smithers(() => (
            <Workflow name="xcombo-restore-parent">
              <Task id="parent-write" output={outputs.parentOut} agent={writingAgent("parent.txt")}>
                write the parent file
              </Task>
              <Subflow
                id="sub"
                output={outputs.subflowOut}
                workflow={childWorkflow}
                dependsOn={["parent-write"]}
                retries={0}
              />
              <Task id="tail" output={outputs.tailOut} agent={tailAgent} dependsOn={["sub"]}>
                keep going after the subflow
              </Task>
            </Workflow>
          ));
          const runId = "xcombo-restore-parent-run";
          const childRunId = `${runId}:child:sub:0`;
          const adapter = new SmithersDb(db);

          // Run until the tail task is in flight, then interrupt it the way a
          // crashed / cancelled run leaves the workspace.
          const controller = new AbortController();
          const firstPromise = Effect.runPromise(
            runWorkflow(parent, { input: {}, runId, rootDir: jjDir, signal: controller.signal }),
          );
          const deadline = Date.now() + 30_000;
          while (!existsSync(tailMarker) && Date.now() < deadline) await sleep(20);
          expect(existsSync(tailMarker)).toBe(true);
          controller.abort();
          const first = await firstPromise;
          expect(first.status).toBe("cancelled");
          expect(existsSync(join(jjDir, "child.txt"))).toBe(true);
          expect((await adapter.getRun(childRunId))?.status).toBe("finished");

          // The agent rolls the worktree back to the last checkpoint that
          // predates the subflow, then resumes the run.
          const stdout = collect();
          const stderr = collect();
          const restore = await runRestoreOnce({
            adapter,
            runId,
            nodeId: "parent-write",
            stdout,
            stderr,
          });
          expect(restore.exitCode).toBe(0);
          const second = await Effect.runPromise(
            runWorkflow(parent, { input: {}, runId, resume: true, rootDir: jjDir }),
          );
          expect(second.status).toBe("finished");

          // The parent reports the subflow finished, so the files it produced
          // must exist - and if they cannot, the run must not be reported as a
          // clean success with an empty durability gap spool.
          const childRun = await adapter.getRun(childRunId);
          expect(childRun?.status).toBe("finished");
          expect({
            childFileOnDisk: existsSync(join(jjDir, "child.txt")),
            gaps: readGaps(runId),
          }).toEqual({ childFileOnDisk: true, gaps: [] });
        });
      } finally {
        rmSync(tailMarker, { force: true });
        cleanup();
        rmSync(jjDir, { recursive: true, force: true });
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "a parent task's checkpoint does not capture a concurrent subflow child's files",
    async () => {
      // A <Subflow> child inherits the parent's rootDir, so a parent agent
      // task running in <Parallel> with a subflow snapshots the SAME jj
      // working copy from two engines. Every checkpoint then contains both
      // lanes' files, and restoring one lane's checkpoint silently rewrites
      // the other lane's work.
      const jjDir = initJjDir("xcombo-par-");
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        await withDurabilityOn(async () => {
          const childWorkflow = smithers(
            () => (
              <Workflow name="xcombo-par-child">
                <Task
                  id="child-write"
                  output={outputs.childOut}
                  agent={writingAgent("child.txt", "child\n", { delayAfterMs: 1_500 })}
                >
                  write the child file, then hold the lane open
                </Task>
              </Workflow>
            ),
            { output: outputs.childOut },
          );
          const parent = smithers(() => (
            <Workflow name="xcombo-par-parent">
              <Parallel>
                <Task
                  id="parent-write"
                  output={outputs.parentOut}
                  agent={writingAgent("parent.txt", "parent\n", { delayBeforeMs: 600, delayAfterMs: 900 })}
                >
                  write the parent file after the child lane started
                </Task>
                <Subflow id="sub" output={outputs.subflowOut} workflow={childWorkflow} retries={0} />
              </Parallel>
            </Workflow>
          ));
          const runId = "xcombo-par-parent-run";
          const result = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, rootDir: jjDir }));
          expect(result.status).toBe("finished");

          const adapter = new SmithersDb(db);
          const parentCheckpoints = await adapter.listWorkspaceCheckpoints(runId);
          expect(parentCheckpoints.length).toBeGreaterThanOrEqual(1);
          const leaked = parentCheckpoints
            .map((c) => ({ seq: c.seq, nodeId: c.nodeId, files: filesInCommit(jjDir, c.jjCommitId) }))
            .filter((c) => c.files.includes("child.txt"));
          // A checkpoint attributed to the parent's own node must be
          // restorable without reaching into the concurrent child's lane.
          expect(leaked).toEqual([]);
        });
      } finally {
        cleanup();
        rmSync(jjDir, { recursive: true, force: true });
      }
    },
    END_TO_END_TIMEOUT_MS,
  );

  test(
    "interrupting the engine mid-child and resuming re-drives the same child run to finished",
    async () => {
      const jjDir = initJjDir("xcombo-crash-");
      const marker = join(tmpdir(), `xcombo-child-marker-${Date.now()}`);
      const { smithers, outputs, db, cleanup } = buildSmithers();
      try {
        await withDurabilityOn(async () => {
          const childAgent = hangThenSucceedAgent(marker);
          const childWorkflow = smithers(
            () => (
              <Workflow name="xcombo-crash-child">
                <Task id="child-write" output={outputs.childOut} agent={childAgent}>
                  hang until interrupted, then succeed
                </Task>
              </Workflow>
            ),
            { output: outputs.childOut },
          );
          const parent = smithers(() => (
            <Workflow name="xcombo-crash-parent">
              <Subflow id="sub" output={outputs.subflowOut} workflow={childWorkflow} />
            </Workflow>
          ));
          const runId = "xcombo-crash-parent-run";
          const childRunId = `${runId}:child:sub:0`;
          const adapter = new SmithersDb(db);

          const controller = new AbortController();
          const firstPromise = Effect.runPromise(
            runWorkflow(parent, { input: {}, runId, rootDir: jjDir, signal: controller.signal }),
          );
          const deadline = Date.now() + 30_000;
          while (!existsSync(marker) && Date.now() < deadline) await sleep(20);
          expect(existsSync(marker)).toBe(true);
          controller.abort();
          const first = await firstPromise;
          expect(first.status).toBe("cancelled");
          // The parent's promise resolves `cancelled` a few hundred ms BEFORE
          // the child run row is finalized, so anything that reads run state
          // straight after a cancel (`smithers ps`, a supervisor sweep) can
          // still see the child as `running`. Wait for the child row to settle
          // instead of asserting the instantaneous read.
          const settleDeadline = Date.now() + 15_000;
          let childStatus = (await adapter.getRun(childRunId))?.status;
          while (childStatus === "running" && Date.now() < settleDeadline) {
            await sleep(50);
            childStatus = (await adapter.getRun(childRunId))?.status;
          }
          expect(childStatus).toBe("cancelled");

          const second = await Effect.runPromise(
            runWorkflow(parent, { input: {}, runId, resume: true, rootDir: jjDir }),
          );
          expect(second.status).toBe("finished");
          // Same child run id, resumed rather than duplicated, and durability
          // stayed live across the interruption (no spooled gaps).
          const runs = await adapter.listRuns(100);
          expect(runs.filter((r) => r.runId === childRunId)).toHaveLength(1);
          expect((await adapter.getRun(childRunId))?.status).toBe("finished");
          expect(readGaps(runId)).toEqual([]);
          expect(readGaps(childRunId)).toEqual([]);
        });
      } finally {
        rmSync(marker, { force: true });
        cleanup();
        rmSync(jjDir, { recursive: true, force: true });
      }
    },
    END_TO_END_TIMEOUT_MS,
  );
});
