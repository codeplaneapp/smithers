/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { jumpToFrameRoute, JumpToFrameError } from "../src/gatewayRoutes/jumpToFrame.js";

function makeDbPath(name: string) {
  return join(tmpdir(), `smithers-jump-route-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

async function seedRunWithFrames(name: string) {
  const dbPath = makeDbPath(name);
  const api = createSmithers({ output: z.object({ value: z.number() }) }, { dbPath });
  ensureSmithersTables(api.db);
  const adapter = new SmithersDb(api.db);
  const runId = `run-${name}`;
  await adapter.insertRun({
    runId,
    workflowName: "wf",
    status: "finished",
    createdAtMs: Date.now(),
    configJson: JSON.stringify({ auth: { triggeredBy: "user:owner" } }),
  });
  await adapter.insertFrame({
    runId,
    frameNo: 0,
    createdAtMs: Date.now() - 2000,
    xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: {} }),
    xmlHash: "hash-0",
    mountedTaskIdsJson: "[]",
    taskIndexJson: "[]",
    note: "frame-0",
  });
  await adapter.insertFrame({
    runId,
    frameNo: 1,
    createdAtMs: Date.now(),
    xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: { f: 1 } }),
    xmlHash: "hash-1",
    mountedTaskIdsJson: "[]",
    taskIndexJson: "[]",
    note: "frame-1",
  });
  return { adapter, runId, dbPath };
}

describe("jumpToFrameRoute default reconciler hooks", () => {
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    dbPaths.length = 0;
  });

  test("re-exports JumpToFrameError", () => {
    expect(typeof JumpToFrameError).toBe("function");
  });

  test("default capture snapshots the latest frame and completes the rewind", async () => {
    const { adapter, runId, dbPath } = await seedRunWithFrames("capture-ok");
    dbPaths.push(dbPath);
    const result = await jumpToFrameRoute({ adapter, runId, frameNo: 0, confirm: true });
    expect(result.ok).toBe(true);
    expect(result.newFrameNo).toBe(0);
    // Frame 1 was above the target, so the rewind truncated it.
    expect(result.deletedFrames).toBeGreaterThanOrEqual(1);
  });

  test("default capture tolerates the latest frame vanishing during snapshot", async () => {
    // Simulate a race: the frame read for validation still succeeds, but by the
    // time defaultCapture re-reads getLastFrame the row is gone. The rewind must
    // still proceed with a null pre-jump snapshot.
    const { adapter, runId, dbPath } = await seedRunWithFrames("capture-vanish");
    dbPaths.push(dbPath);
    const realGetLastFrame = adapter.getLastFrame.bind(adapter);
    let calls = 0;
    // getLastFrame is called once by jumpToFrame's validation and once by the
    // route's defaultCapture; return null only on the capture call.
    (adapter as unknown as { getLastFrame: (id: string) => unknown }).getLastFrame = async (id: string) => {
      calls += 1;
      return calls === 1 ? realGetLastFrame(id) : null;
    };
    const result = await jumpToFrameRoute({ adapter, runId, frameNo: 0, confirm: true });
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("default capture swallows a getLastFrame error during snapshot", async () => {
    // Validation reads getLastFrame successfully; the route's defaultCapture then
    // re-reads it and this time the adapter throws (e.g. a transient DB error).
    // defaultCapture must catch it and fall back to a null pre-jump snapshot so
    // the rewind still proceeds.
    const { adapter, runId, dbPath } = await seedRunWithFrames("capture-throw");
    dbPaths.push(dbPath);
    const realGetLastFrame = adapter.getLastFrame.bind(adapter);
    let calls = 0;
    (adapter as unknown as { getLastFrame: (id: string) => unknown }).getLastFrame = async (id: string) => {
      calls += 1;
      if (calls === 1) return realGetLastFrame(id);
      throw new Error("transient getLastFrame failure");
    };
    const result = await jumpToFrameRoute({ adapter, runId, frameNo: 0, confirm: true });
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("propagates a ConfirmationRequired error when confirm is not true", async () => {
    const { adapter, runId, dbPath } = await seedRunWithFrames("no-confirm");
    dbPaths.push(dbPath);
    await expect(jumpToFrameRoute({ adapter, runId, frameNo: 0 })).rejects.toThrow(JumpToFrameError);
  });
});
