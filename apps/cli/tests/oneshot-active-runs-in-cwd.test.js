import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { findActiveRunsInCwd } from "../src/oneshot/findActiveRunsInCwd.js";
import { isWorkingCopyHoldingRunState } from "../src/oneshot/isWorkingCopyHoldingRunState.js";
import { runConfigRootDir } from "../src/oneshot/runConfigRootDir.js";

// Bug 01kzzaqfx1g9qaefqxrderdz4m. Three oneshot runs shared one cwd on
// 2026-08-13. Each preflight read the others' in-flight diffs as inert
// "pre-existing work" and committed them, because launch never asked the
// workspace store which runs were already working there.

const tempDirs = [];

function temp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openStore() {
  const dir = temp("smithers-active-runs-store-");
  const sqlite = new Database(join(dir, "smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), close: () => sqlite.close() };
}

/**
 * @param {SmithersDb} adapter
 * @param {{ runId: string; status: string; rootDir?: string; ownerPid?: number | null; heartbeatAgeMs?: number }} spec
 */
async function insertRun(adapter, spec) {
  const now = Date.now();
  await adapter.insertRun({
    runId: spec.runId,
    workflowName: "oneshot",
    status: spec.status,
    createdAtMs: now - 60_000,
    startedAtMs: now - 60_000,
    finishedAtMs: null,
    heartbeatAtMs: now - (spec.heartbeatAgeMs ?? 0),
    runtimeOwnerId: spec.ownerPid === null ? null : `pid:${spec.ownerPid ?? process.pid}`,
    configJson: spec.rootDir === undefined ? null : JSON.stringify({ rootDir: spec.rootDir }),
  });
}

describe("runConfigRootDir", () => {
  test("reads the directory the engine stamped on the run", () => {
    expect(runConfigRootDir(JSON.stringify({ rootDir: "/w" }))).toBe("/w");
  });

  test("absent, empty, and malformed config yield null", () => {
    expect(runConfigRootDir(null)).toBeNull();
    expect(runConfigRootDir("")).toBeNull();
    expect(runConfigRootDir("{oops")).toBeNull();
    expect(runConfigRootDir(JSON.stringify({ rootDir: "" }))).toBeNull();
    expect(runConfigRootDir(JSON.stringify({}))).toBeNull();
  });
});

describe("isWorkingCopyHoldingRunState", () => {
  test("live and resumable states hold the tree", () => {
    for (const state of ["running", "stale", "paused", "waiting-approval", "waiting-quota"]) {
      expect(isWorkingCopyHoldingRunState(state)).toBe(true);
    }
  });

  test("terminal and orphaned states do not", () => {
    for (const state of ["succeeded", "failed", "cancelled", "orphaned", undefined, null]) {
      expect(isWorkingCopyHoldingRunState(state)).toBe(false);
    }
  });
});

describe("findActiveRunsInCwd", () => {
  test("finds a running run that shares the directory", async () => {
    const { adapter, close } = openStore();
    const cwd = temp("smithers-active-runs-cwd-");
    try {
      await insertRun(adapter, { runId: "oneshot-older", status: "running", rootDir: cwd });
      const active = await findActiveRunsInCwd(adapter, cwd);
      expect(active.map((run) => run.runId)).toEqual(["oneshot-older"]);
      expect(active[0].state).toBe("running");
    } finally {
      close();
    }
  });

  test("ignores runs in a different directory", async () => {
    const { adapter, close } = openStore();
    const cwd = temp("smithers-active-runs-cwd-");
    const other = temp("smithers-active-runs-other-");
    try {
      await insertRun(adapter, { runId: "oneshot-elsewhere", status: "running", rootDir: other });
      expect(await findActiveRunsInCwd(adapter, cwd)).toEqual([]);
    } finally {
      close();
    }
  });

  test("ignores the run being launched", async () => {
    const { adapter, close } = openStore();
    const cwd = temp("smithers-active-runs-cwd-");
    try {
      await insertRun(adapter, { runId: "oneshot-self", status: "running", rootDir: cwd });
      expect(await findActiveRunsInCwd(adapter, cwd, { excludeRunId: "oneshot-self" })).toEqual([]);
    } finally {
      close();
    }
  });

  test("a finished run in the same directory is not active", async () => {
    const { adapter, close } = openStore();
    const cwd = temp("smithers-active-runs-cwd-");
    try {
      await insertRun(adapter, { runId: "oneshot-done", status: "finished", rootDir: cwd });
      expect(await findActiveRunsInCwd(adapter, cwd)).toEqual([]);
    } finally {
      close();
    }
  });

  test("a stale run whose owner pid is dead is not active", async () => {
    const { adapter, close } = openStore();
    const cwd = temp("smithers-active-runs-cwd-");
    try {
      // A pid that cannot be alive, with a heartbeat well past the stale
      // threshold: deriveRunState classifies this "orphaned", and nobody is
      // coming back for its tree.
      await insertRun(adapter, {
        runId: "oneshot-dead",
        status: "running",
        rootDir: cwd,
        ownerPid: 2_147_483_600,
        heartbeatAgeMs: 10 * 60_000,
      });
      expect(await findActiveRunsInCwd(adapter, cwd)).toEqual([]);
    } finally {
      close();
    }
  });

  test("a run with no recorded owner at all is not active", async () => {
    const { adapter, close } = openStore();
    const cwd = temp("smithers-active-runs-cwd-");
    try {
      await insertRun(adapter, {
        runId: "oneshot-ownerless",
        status: "running",
        rootDir: cwd,
        ownerPid: null,
        heartbeatAgeMs: 10 * 60_000,
      });
      expect(await findActiveRunsInCwd(adapter, cwd)).toEqual([]);
    } finally {
      close();
    }
  });

  test("a paused run still holds its tree", async () => {
    const { adapter, close } = openStore();
    const cwd = temp("smithers-active-runs-cwd-");
    try {
      await insertRun(adapter, { runId: "oneshot-paused", status: "paused", rootDir: cwd });
      expect((await findActiveRunsInCwd(adapter, cwd)).map((run) => run.runId)).toEqual(["oneshot-paused"]);
    } finally {
      close();
    }
  });

  test("runs with no recorded rootDir are never matched", async () => {
    const { adapter, close } = openStore();
    const cwd = temp("smithers-active-runs-cwd-");
    try {
      await insertRun(adapter, { runId: "oneshot-no-config", status: "running" });
      expect(await findActiveRunsInCwd(adapter, cwd)).toEqual([]);
    } finally {
      close();
    }
  });

  test("every active run is reported, sorted, and deduped", async () => {
    const { adapter, close } = openStore();
    const cwd = temp("smithers-active-runs-cwd-");
    try {
      await insertRun(adapter, { runId: "oneshot-b", status: "running", rootDir: cwd });
      await insertRun(adapter, { runId: "oneshot-a", status: "waiting-approval", rootDir: cwd });
      expect((await findActiveRunsInCwd(adapter, cwd)).map((run) => run.runId)).toEqual(["oneshot-a", "oneshot-b"]);
    } finally {
      close();
    }
  });

  test("an unreadable store never blocks a launch", async () => {
    const broken = {
      listRuns: () => {
        throw new Error("store unavailable");
      },
    };
    expect(await findActiveRunsInCwd(broken, temp("smithers-active-runs-cwd-"))).toEqual([]);
  });
});
