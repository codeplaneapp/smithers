import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import {
  buildTopPaintInput,
  listFleetRuns,
  openNodeDetail,
  openTopStore,
  resolveFocusIndex,
  runSmithersTop,
} from "../src/smithers-top.js";
import { buildGateCommand, buildOverviewCommand } from "../src/herdr.js";

function openTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-top-"));
  const dbPath = join(dir, "smithers.db");
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  const adapter = new SmithersDb(db);
  return {
    dir,
    dbPath,
    sqlite,
    adapter,
    close() {
      try {
        sqlite.close();
      } catch {
        /* ignore */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe("workflow supervisor (smithers supervisor)", () => {
  test("resolveFocusIndex prefers active runs when unpinned", () => {
    const fleet = [
      { runId: "a", status: "finished" },
      { runId: "b", status: "running" },
      { runId: "c", status: "finished" },
    ];
    expect(resolveFocusIndex(fleet, 0, undefined)).toBe(1);
    expect(resolveFocusIndex(fleet, 0, "c")).toBe(1);
    expect(resolveFocusIndex(fleet, 0, "c", { pin: true })).toBe(2);
    expect(resolveFocusIndex([], 0, undefined)).toBe(0);
  });

  test("buildOverviewCommand emits supervisor --db", () => {
    const cmd = buildOverviewCommand("/abs/cli/index.js", {
      dbPath: "/tmp/camp/smithers.db",
      cwd: "/tmp/camp",
    })({ runId: "run-1" });
    expect(cmd).toContain("supervisor");
    expect(cmd).toContain("--db");
    expect(cmd).not.toContain("tail");
  });

  test("openTopStore + listFleetRuns + paint against a real store", async () => {
    const repo = openTempDb();
    try {
      const now = Date.now();
      await repo.adapter.insertRun({
        runId: "run-top-1",
        workflowName: "camp-hello",
        status: "running",
        createdAtMs: now,
        startedAtMs: now,
      });
      await repo.adapter.insertNode({
        runId: "run-top-1",
        nodeId: "hello",
        iteration: 0,
        state: "in-progress",
        lastAttempt: 1,
        updatedAtMs: now,
        outputTable: "hello",
      });
      repo.sqlite.close();
      const store = await openTopStore({ db: repo.dbPath });
      expect(store.dbPath).toBe(repo.dbPath);
      const fleet = await listFleetRuns(store.adapter);
      expect(fleet.some((r) => r.runId === "run-top-1")).toBe(true);
      const painted = await buildTopPaintInput(store.adapter, fleet, 0);
      expect(painted.input.runId).toBe("run-top-1");
      expect(painted.input.nodes?.some((n) => n.nodeId === "hello")).toBe(true);
      store.cleanup?.();
    } finally {
      repo.close();
    }
  });

  /** A minimal ObservationSource of a given `kind` painting one running run. */
  function fakeSource(kind) {
    const run = {
      runId: "run-1",
      status: "running",
      derivedStatus: "running",
      workflowName: "deploy",
      createdAtMs: 0,
      startedAtMs: 0,
    };
    return {
      kind,
      async listFleet() {
        return [run];
      },
      async focusView() {
        return {
          focusIndex: 0,
          run,
          input: {
            runId: "run-1",
            workflowName: "deploy",
            status: "running",
            nodes: [{ nodeId: "build", state: "in-progress", lastAttempt: 1 }],
            agentMetaByNode: {},
            startedAtMs: 0,
            nowMs: Date.now(),
            live: true,
            liveElsewhere: false,
            queuedSteers: [],
          },
        };
      },
      async outlineTree() {
        return null;
      },
      async nodeActivity() {
        return [];
      },
    };
  }

  function collectStdout(chunks) {
    return {
      isTTY: false,
      columns: 120,
      rows: 30,
      write(s) {
        chunks.push(String(s));
        return true;
      },
      on() {},
      off() {},
      removeListener() {},
    };
  }

  const inertStdin = {
    isTTY: false,
    on() {},
    off() {},
    removeListener() {},
    resume() {},
    setRawMode() {},
  };

  test("header shows 'via gateway' when the injected source is gateway-kind", async () => {
    const repo = openTempDb();
    try {
      repo.sqlite.close();
      const chunks = [];
      await runSmithersTop({
        db: repo.dbPath,
        maxTicks: 2,
        pollMs: 20,
        frameMs: 10,
        stdout: collectStdout(chunks),
        stdin: inertStdin,
        source: fakeSource("gateway"),
      });
      const plain = chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
      expect(plain).toContain("via gateway");
    } finally {
      repo.close();
    }
  });

  test("header shows 'direct' when the injected source is direct-db-kind", async () => {
    const repo = openTempDb();
    try {
      repo.sqlite.close();
      const chunks = [];
      await runSmithersTop({
        db: repo.dbPath,
        maxTicks: 2,
        pollMs: 20,
        frameMs: 10,
        stdout: collectStdout(chunks),
        stdin: inertStdin,
        source: fakeSource("direct-db"),
      });
      const plain = chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
      expect(plain).toContain("direct");
      expect(plain).not.toContain("via gateway");
    } finally {
      repo.close();
    }
  });

  test("gateway source runs with NO local smithers.db (lazy store, dbPath null)", async () => {
    // A bare dir with no smithers.db: the direct path would throw
    // CLI_DB_NOT_FOUND, but an injected gateway source must run anyway.
    const dir = mkdtempSync(join(tmpdir(), "smithers-top-nodb-"));
    try {
      const chunks = [];
      const result = await runSmithersTop({
        cwd: dir,
        maxTicks: 2,
        pollMs: 20,
        frameMs: 10,
        stdout: collectStdout(chunks),
        stdin: inertStdin,
        source: fakeSource("gateway"),
      });
      // No local db was opened; detail panes are unavailable but we ran.
      expect(result.dbPath).toBeNull();
      const plain = chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
      expect(plain).toContain("via gateway");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("source.dispose runs even when the initial refresh throws (try/finally)", async () => {
    // A gateway source whose first read throws must still have its background
    // activity subscription torn down — the throw propagates, but dispose ran.
    const dir = mkdtempSync(join(tmpdir(), "smithers-top-dispose-"));
    let disposed = false;
    const throwingSource = {
      kind: "gateway",
      async listFleet() {
        throw new Error("gateway read blew up");
      },
      async focusView() {
        return { focusIndex: 0, run: null, input: {} };
      },
      async outlineTree() {
        return null;
      },
      async nodeActivity() {
        return [];
      },
      dispose() {
        disposed = true;
      },
    };
    try {
      let err;
      try {
        await runSmithersTop({
          cwd: dir,
          maxTicks: 2,
          pollMs: 20,
          frameMs: 10,
          stdout: collectStdout([]),
          stdin: inertStdin,
          source: throwingSource,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err?.message).toContain("gateway read blew up");
      // The finally tore down the source despite the throw.
      expect(disposed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("direct path (no injected source) still fails fast with no local db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-top-nodb-direct-"));
    try {
      let err;
      try {
        await runSmithersTop({ cwd: dir, maxTicks: 1, stdout: collectStdout([]), stdin: inertStdin });
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err?.code).toBe("CLI_DB_NOT_FOUND");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runSmithersTop maxTicks paints without hanging", async () => {
    const repo = openTempDb();
    try {
      repo.sqlite.close();
      const chunks = [];
      const stdout = {
        isTTY: false,
        write(s) {
          chunks.push(String(s));
          return true;
        },
        on() {},
        off() {},
        removeListener() {},
      };
      const stdin = {
        isTTY: false,
        on() {},
        off() {},
        removeListener() {},
        resume() {},
        setRawMode() {},
      };
      const result = await runSmithersTop({
        db: repo.dbPath,
        maxTicks: 2,
        pollMs: 20,
        frameMs: 10,
        stdout,
        stdin,
      });
      expect(result.dbPath).toBe(repo.dbPath);
      expect(chunks.join("").length).toBeGreaterThan(0);
      const plain = chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
      expect(plain).toMatch(/workflow supervisor|smithers|no nodes|waiting/i);
    } finally {
      repo.close();
    }
  });
});

describe("supervisor Enter → approval gate routing", () => {
  test("buildGateCommand builds the `approve --watch` argv for a gate node", () => {
    const argv = buildGateCommand("/fake/cli/index.js")({ runId: "run-1", nodeId: "review" });
    // [execPath, cliPath, "approve", runId, "--watch", "--node", nodeId]
    expect(argv.slice(1)).toEqual(["/fake/cli/index.js", "approve", "run-1", "--watch", "--node", "review"]);
  });

  test("openNodeDetail routes a gate to approve/deny, an agent to the steer/inspect tail", async () => {
    // herdrAvailable:false returns a hint carrying the command it WOULD run, so we
    // can assert the routing (gate → `approve`, agent → `tail`) with no herdr server.
    const gate = await openNodeDetail({
      runId: "run-1",
      nodeId: "review",
      dbPath: "/tmp/x/smithers.db",
      cwd: "/tmp/x",
      herdrAvailable: false,
      kind: "gate",
    });
    expect(gate.mode).toBe("hint");
    expect(gate.message).toContain("smithers approve run-1 --node review");
    expect(gate.message).not.toContain("tail");

    const agent = await openNodeDetail({
      runId: "run-1",
      nodeId: "alpha",
      dbPath: "/tmp/x/smithers.db",
      cwd: "/tmp/x",
      herdrAvailable: false,
    });
    expect(agent.mode).toBe("hint");
    expect(agent.message).toContain("smithers tail run-1 --node alpha --hud --linger");
    expect(agent.message).not.toContain("approve");
  });
});
