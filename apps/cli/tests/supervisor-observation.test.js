import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";
import { getDevToolsSnapshotRoute } from "@smithers-orchestrator/server/gatewayRoutes/getDevToolsSnapshot";
import { Gateway } from "@smithers-orchestrator/server/gateway";
import { flattenOutlineTree } from "../src/cockpit-outline-graph.js";
import {
  createDirectDbObservationSource,
  createGatewayObservationSource,
  deriveDerivedStatusFromRunState,
  flattenSnapshotToNodeRows,
  metaByNodeFromSnapshot,
  resolveGatewaySource,
  resolveSupervisorGatewayTarget,
} from "../src/supervisor-observation.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function openTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-obs-"));
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

/** A workflow > sequence(setup) + parallel(worker-a, worker-b) frame. */
function seedFrameXml() {
  return JSON.stringify({
    kind: "element",
    tag: "smithers:workflow",
    props: { name: "parity-flow" },
    children: [
      {
        kind: "element",
        tag: "smithers:sequence",
        props: {},
        children: [
          {
            kind: "element",
            tag: "smithers:task",
            props: { id: "setup", label: "Setup" },
            children: [],
          },
          {
            kind: "element",
            tag: "smithers:parallel",
            props: {},
            children: [
              {
                kind: "element",
                tag: "smithers:task",
                props: { id: "worker-a", label: "Worker A" },
                children: [],
              },
              {
                kind: "element",
                tag: "smithers:task",
                props: { id: "worker-b", label: "Worker B" },
                children: [],
              },
            ],
          },
        ],
      },
    ],
  });
}

async function seedParityRun(adapter) {
  const now = Date.now();
  await adapter.insertRun({
    runId: "run-parity",
    workflowName: "parity-flow",
    status: "running",
    createdAtMs: now,
    startedAtMs: now,
  });
  await adapter.insertFrame({
    runId: "run-parity",
    frameNo: 0,
    createdAtMs: now,
    xmlHash: "hash-0",
    xmlJson: seedFrameXml(),
  });
  /** @type {Array<[string, string, number]>} */
  const nodes = [
    ["setup", "finished", 1],
    ["worker-a", "in-progress", 1],
    ["worker-b", "pending", 0],
  ];
  for (const [nodeId, state, lastAttempt] of nodes) {
    await adapter.insertNode({
      runId: "run-parity",
      nodeId,
      iteration: 0,
      state,
      lastAttempt,
      updatedAtMs: now,
      outputTable: nodeId,
    });
    await adapter.insertAttempt({
      runId: "run-parity",
      nodeId,
      iteration: 0,
      attempt: lastAttempt,
      state,
      startedAtMs: now,
      metaJson: JSON.stringify({
        agentEngine: "claude-code",
        agentModel: "claude-sonnet-4",
        effort: "high",
        label: nodeId,
      }),
    });
  }
}

/**
 * A gateway client shim backed by a real adapter + the real server routes, so
 * the gateway source consumes byte-identical snapshot/run data to the direct-db
 * path (the parity harness).
 */
function makeAdapterBackedClient(adapter) {
  return {
    async listRuns({ filter } = {}) {
      const limit = filter?.limit ?? 32;
      const rows = (await adapter.listRuns(limit, filter?.status)) ?? [];
      return rows.map((r) => ({ ...r, workflowKey: r.workflowName }));
    },
    async getRun({ runId }) {
      const run = await adapter.getRun(runId);
      if (!run) return null;
      const runState = await computeRunStateFromRow(adapter, run).catch(() => undefined);
      return { ...run, workflowKey: run.workflowName, ...(runState ? { runState } : {}) };
    },
    async getDevToolsSnapshot({ runId }) {
      return getDevToolsSnapshotRoute({ adapter, runId });
    },
  };
}

// ---------------------------------------------------------------------------
// (a) Contract — both factories satisfy the same shape
// ---------------------------------------------------------------------------

describe("supervisor observation source — contract", () => {
  test("both factories expose kind + the four read methods", () => {
    const direct = createDirectDbObservationSource({});
    const gateway = createGatewayObservationSource({});
    expect(direct.kind).toBe("direct-db");
    expect(gateway.kind).toBe("gateway");
    for (const source of [direct, gateway]) {
      expect(typeof source.listFleet).toBe("function");
      expect(typeof source.focusView).toBe("function");
      expect(typeof source.outlineTree).toBe("function");
      expect(typeof source.nodeActivity).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveSupervisorGatewayTarget — flag parsing (no gateway spawned)
// ---------------------------------------------------------------------------

describe("resolveSupervisorGatewayTarget", () => {
  test("auto starts-or-attaches the workspace gateway", () => {
    expect(resolveSupervisorGatewayTarget("auto")).toEqual({
      gateway: undefined,
      autostart: true,
    });
  });
  test("a url attaches without autostart", () => {
    expect(resolveSupervisorGatewayTarget("http://127.0.0.1:7331")).toEqual({
      gateway: "http://127.0.0.1:7331",
      autostart: false,
    });
  });
  test("the DEFAULT (unset / empty) is now gateway auto (the flip)", () => {
    const auto = { gateway: undefined, autostart: true };
    expect(resolveSupervisorGatewayTarget(undefined)).toEqual(auto);
    expect(resolveSupervisorGatewayTarget("")).toEqual(auto);
    // A non-string flag value is neither a url nor `auto` => still the default.
    expect(resolveSupervisorGatewayTarget(42)).toEqual(auto);
  });
  test("--direct forces direct-db (null) regardless of the gateway value", () => {
    expect(resolveSupervisorGatewayTarget(undefined, { direct: true })).toBeNull();
    expect(resolveSupervisorGatewayTarget("auto", { direct: true })).toBeNull();
    expect(resolveSupervisorGatewayTarget("http://127.0.0.1:7331", { direct: true })).toBeNull();
  });

  // S1 review (revise) finding: a pinned --db is a direct-db concept the
  // gateway can't serve, so the default path honors it directly.
  test("a pinned --db forces direct-db on the DEFAULT path", () => {
    expect(resolveSupervisorGatewayTarget(undefined, { pinnedDb: true })).toBeNull();
    expect(resolveSupervisorGatewayTarget("", { pinnedDb: true })).toBeNull();
  });
  test("an explicit --gateway overrides a pinned --db (gateway wins for primary reads)", () => {
    expect(resolveSupervisorGatewayTarget("http://127.0.0.1:7331", { pinnedDb: true })).toEqual({
      gateway: "http://127.0.0.1:7331",
      autostart: false,
    });
    expect(resolveSupervisorGatewayTarget("auto", { pinnedDb: true })).toEqual({
      gateway: undefined,
      autostart: true,
    });
  });

  // S1 review (revise) finding: the default flip must not autostart a daemon
  // for every headless/scripted supervisor. Only a TTY takes the gateway path.
  test("the DEFAULT path stays direct-db when non-interactive (no daemon spawned)", () => {
    expect(resolveSupervisorGatewayTarget(undefined, { interactive: false })).toBeNull();
    expect(resolveSupervisorGatewayTarget("", { interactive: false })).toBeNull();
  });
  test("an explicit --gateway is honored even when non-interactive", () => {
    expect(resolveSupervisorGatewayTarget("auto", { interactive: false })).toEqual({
      gateway: undefined,
      autostart: true,
    });
    expect(resolveSupervisorGatewayTarget("http://gw", { interactive: false })).toEqual({
      gateway: "http://gw",
      autostart: false,
    });
  });
  test("the interactive DEFAULT (no pin) still takes the gateway (the flip)", () => {
    expect(resolveSupervisorGatewayTarget(undefined, { interactive: true })).toEqual({
      gateway: undefined,
      autostart: true,
    });
  });
});

describe("resolveGatewaySource — attach posture", () => {
  function deps(overrides = {}) {
    const warnings = [];
    let built = 0;
    return {
      warnings,
      builtCount: () => built,
      resolveGateway: overrides.resolveGateway ?? (async () => ({ ok: true, base: "http://gw", token: null })),
      makeClient:
        overrides.makeClient ??
        ((resolved) => {
          built += 1;
          return { base: resolved.base }; // fake client (no streaming support)
        }),
      warn: (m) => warnings.push(m),
      unreachableError: (m) => Object.assign(new Error(m), { code: "GATEWAY_UNREACHABLE" }),
    };
  }

  test("auto (default) resolve-failure warns and falls back to direct-db (undefined)", async () => {
    const d = deps({
      resolveGateway: async () => ({ ok: false, message: "no gateway for this workspace" }),
      makeClient: () => {
        throw new Error("must not build a client on fallback");
      },
    });
    const source = await resolveGatewaySource({ gateway: undefined, autostart: true }, d);
    expect(source).toBeUndefined();
    expect(d.warnings.join("")).toContain("using direct-db");
    expect(d.warnings.join("")).toContain("no gateway for this workspace");
  });

  test("explicit unreachable --gateway <url> hard-errors (GATEWAY_UNREACHABLE)", async () => {
    const d = deps({
      resolveGateway: async () => ({ ok: false, message: "connection refused" }),
    });
    let err;
    try {
      await resolveGatewaySource({ gateway: "http://127.0.0.1:1", autostart: false }, d);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err?.code).toBe("GATEWAY_UNREACHABLE");
    expect(err?.message).toContain("connection refused");
    expect(d.warnings).toHaveLength(0);
  });

  test("a reachable gateway builds the client and returns a gateway source", async () => {
    const d = deps();
    const source = await resolveGatewaySource({ gateway: undefined, autostart: true }, d);
    expect(source?.kind).toBe("gateway");
    expect(d.builtCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (b) Direct-db over a real temp SQLite store
// ---------------------------------------------------------------------------

describe("direct-db observation source", () => {
  test("listFleet / focusView / outlineTree / nodeActivity shapes", async () => {
    const repo = openTempDb();
    try {
      await seedParityRun(repo.adapter);
      const source = createDirectDbObservationSource(repo.adapter);

      const fleet = await source.listFleet();
      expect(fleet.some((r) => r.runId === "run-parity")).toBe(true);

      const focus = await source.focusView(fleet, 0);
      expect(focus.input.runId).toBe("run-parity");
      expect(focus.input.nodes.some((n) => n.nodeId === "setup")).toBe(true);
      expect(focus.input.agentMetaByNode).toBeTruthy();

      const outline = await source.outlineTree("run-parity", focus.input.agentMetaByNode ?? {});
      expect(outline?.roots?.length).toBeGreaterThan(0);
      const { selectables } = flattenOutlineTree(outline.roots, {});
      expect(selectables.some((s) => s.nodeId === "worker-a")).toBe(true);

      const activity = await source.nodeActivity("run-parity", "setup", { limit: 4 });
      expect(Array.isArray(activity)).toBe(true);
    } finally {
      repo.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Gateway over an in-memory fake client with canned payloads
// ---------------------------------------------------------------------------

describe("gateway observation source (canned client)", () => {
  function cannedClient() {
    const run = {
      runId: "run-g",
      status: "running",
      workflowKey: "deploy",
      createdAtMs: 1000,
      startedAtMs: 1000,
      finishedAtMs: null,
      runState: { runId: "run-g", state: "running", computedAt: "2026-01-01T00:00:00.000Z" },
    };
    const snapshot = {
      version: 1,
      runId: "run-g",
      frameNo: 2,
      seq: 2,
      root: {
        id: 1,
        type: "workflow",
        name: "deploy",
        props: {},
        depth: 0,
        children: [
          {
            id: 2,
            type: "task",
            name: "build",
            props: { id: "build" },
            task: {
              nodeId: "build",
              kind: "agent",
              state: "finished",
              attempt: 1,
              label: "Build",
              agentRan: { engine: "claude-code", model: "claude-sonnet-4" },
              agentSummary: { label: "Build", engine: "claude-code", model: "claude-sonnet-4" },
            },
            children: [],
            depth: 1,
          },
          {
            id: 3,
            type: "task",
            name: "deploy",
            props: { id: "deploy-node" },
            task: {
              nodeId: "deploy-node",
              kind: "agent",
              state: "in-progress",
              attempt: 2,
              label: "Deploy",
              agentRan: { engine: "codex", model: "gpt-5" },
            },
            children: [],
            depth: 1,
          },
        ],
      },
      runState: run.runState,
    };
    return {
      calls: { listRuns: 0, getRun: 0, getDevToolsSnapshot: 0 },
      async listRuns({ filter } = {}) {
        this.calls.listRuns += 1;
        // recent (no status) and the "running" status query both surface run-g.
        if (!filter?.status || filter.status === "running") return [run];
        return [];
      },
      async getRun() {
        this.calls.getRun += 1;
        return run;
      },
      async getDevToolsSnapshot() {
        this.calls.getDevToolsSnapshot += 1;
        return snapshot;
      },
    };
  }

  test("listFleet derives status from runState and dedupes", async () => {
    const client = cannedClient();
    const source = createGatewayObservationSource(client);
    const fleet = await source.listFleet();
    expect(fleet).toHaveLength(1);
    expect(fleet[0].runId).toBe("run-g");
    expect(fleet[0].derivedStatus).toBe("running");
    expect(fleet[0].workflowName).toBe("deploy");
  });

  test("focusView flattens snapshot nodes, reconstructs agent meta, RPC status", async () => {
    const client = cannedClient();
    const source = createGatewayObservationSource(client);
    const fleet = await source.listFleet();
    const focus = await source.focusView(fleet, 0);
    expect(focus.input.runId).toBe("run-g");
    expect(focus.input.status).toBe("running");
    expect(focus.input.workflowName).toBe("deploy");
    expect(focus.input.live).toBe(true);
    // nodes flattened from the snapshot task tree.
    const byId = new Map(focus.input.nodes.map((n) => [n.nodeId, n]));
    expect(byId.get("build")?.state).toBe("finished");
    expect(byId.get("deploy-node")?.state).toBe("in-progress");
    expect(byId.get("deploy-node")?.lastAttempt).toBe(2);
    // agent identity reconstructed from agentRan/agentSummary.
    expect(focus.input.agentMetaByNode.build).toMatchObject({
      agentEngine: "claude-code",
      agentModel: "claude-sonnet-4",
      label: "Build",
    });
    expect(focus.input.agentMetaByNode["deploy-node"]).toMatchObject({
      agentEngine: "codex",
      agentModel: "gpt-5",
    });
    // queuedSteers has no RPC this slice.
    expect(focus.input.queuedSteers).toEqual([]);
  });

  test("outlineTree maps the snapshot through the shared pure path", async () => {
    const client = cannedClient();
    const source = createGatewayObservationSource(client);
    const outline = await source.outlineTree("run-g", {});
    expect(outline?.source).toBe("graph");
    const { selectables } = flattenOutlineTree(outline.roots, {});
    const nodeIds = selectables.filter((s) => s.kind === "agent").map((s) => s.nodeId);
    expect(nodeIds).toContain("build");
    expect(nodeIds).toContain("deploy-node");
  });

  test("focusView + outlineTree share ONE getDevToolsSnapshot call per tick", async () => {
    const client = cannedClient();
    const source = createGatewayObservationSource(client);
    const fleet = await source.listFleet();
    const focus = await source.focusView(fleet, 0);
    await source.outlineTree("run-g", focus.input.agentMetaByNode ?? {});
    // focusView (reuse:false) fetches; outlineTree (reuse:true) reuses the memo.
    expect(client.calls.getDevToolsSnapshot).toBe(1);
  });

  test("focused active run's getRun is deduped across listFleet + focusView", async () => {
    const client = cannedClient();
    const source = createGatewayObservationSource(client);
    const fleet = await source.listFleet();
    // listFleet's runStatesFor already getRun'd the active run-g once.
    expect(client.calls.getRun).toBe(1);
    await source.focusView(fleet, 0);
    // focusView reuses that memoized getRun instead of issuing a second one.
    expect(client.calls.getRun).toBe(1);
    // A fresh tick (listFleet clears the memo) fetches again — not stale.
    await source.listFleet();
    await source.focusView(fleet, 0);
    expect(client.calls.getRun).toBe(2);
  });

  test("nodeActivity returns [] when the client has no streaming support", async () => {
    // cannedClient exposes no streamRunEventsResilient, so the activity ring
    // stays empty and the strip degrades to []. dispose() is a safe no-op.
    const source = createGatewayObservationSource(cannedClient());
    expect(await source.nodeActivity("run-g", "build", { limit: 4 })).toEqual([]);
    expect(() => source.dispose?.()).not.toThrow();
  });

  test("empty fleet yields the idle focus input", async () => {
    const source = createGatewayObservationSource(cannedClient());
    const focus = await source.focusView([], 0);
    expect(focus.run).toBeNull();
    expect(focus.input.status).toBe("idle");
    expect(focus.input.nodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (c2) Gateway streamed per-node activity (spec item 1 / StreamRunEvents)
// ---------------------------------------------------------------------------

describe("gateway observation source — streamed activity", () => {
  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

  /** Minimal fleet-capable RPC stub (run-g running) for focusView warming. */
  function fleetStub() {
    const run = {
      runId: "run-g",
      status: "running",
      workflowKey: "deploy",
      createdAtMs: 1000,
      startedAtMs: 1000,
      finishedAtMs: null,
    };
    const snapshot = {
      version: 1,
      runId: "run-g",
      frameNo: 1,
      seq: 1,
      root: { id: 1, type: "workflow", name: "deploy", props: {}, depth: 0, children: [] },
    };
    return {
      async listRuns({ filter } = {}) {
        return !filter?.status || filter.status === "running" ? [run] : [];
      },
      async getRun() {
        return run;
      },
      async getDevToolsSnapshot() {
        return snapshot;
      },
    };
  }

  // A shared, stateless Gateway instance used ONLY as the real event mapper.
  // Building test frames through the SAME `mapEvent` the live server uses is
  // what keeps this suite honest: the S2 fix-round-3 divergence was exactly a
  // hand-fabricated frame shape (PascalCase `event` names + flat tool payloads)
  // the gateway never actually produces. Route every frame through mapEvent so
  // the event NAME and payload SHAPE can't drift from production again.
  const mapper = new Gateway({});

  /**
   * A `run.event` frame wrapping ONE server-mapped run-event row, built by
   * mapping a real SmithersEvent through the gateway's own `mapEvent`. The outer
   * `{ type:"event", event:"run.event", payload:{ streamId, …mappedRow } }`
   * envelope mirrors gateway.js `appendRunEventWindow` + `sendEvent`; the inner
   * `payload.event` / `payload.payload` come straight from `mapEvent`.
   *
   * @param {import("@smithers-orchestrator/server/gateway").SmithersEvent} smithersEvent
   * @param {number} seq
   */
  function mappedRunEventFrame(smithersEvent, seq) {
    const mapped = mapper.mapEvent(smithersEvent);
    if (!mapped) throw new Error(`mapEvent produced no frame for ${smithersEvent.type}`);
    return {
      type: "event",
      event: "run.event",
      seq,
      payload: { streamId: "s1", runId: smithersEvent.runId, seq, event: mapped.event, payload: mapped.payload },
    };
  }

  /**
   * A streamed AgentEvent frame carrying one CLI-agent `action` (the shape all
   * gateway-path tool/agent activity actually arrives in — kind "tool" etc).
   *
   * @param {number} seq
   * @param {{ nodeId?: string, phase?: "started" | "completed", kind?: string, id?: string, title?: string, input?: unknown, output?: unknown, ok?: boolean }} action
   */
  function agentActionFrame(
    seq,
    { nodeId = "build", phase = "started", kind = "tool", id, title, input, output, ok } = {},
  ) {
    return mappedRunEventFrame(
      {
        type: "AgentEvent",
        runId: "run-g",
        nodeId,
        iteration: 0,
        attempt: 1,
        engine: "claude-code",
        event: {
          type: "action",
          engine: "claude-code",
          phase,
          ...(ok === undefined ? {} : { ok }),
          action: {
            kind,
            id,
            title,
            detail: {
              ...(input === undefined ? {} : { input }),
              ...(output === undefined ? {} : { output }),
            },
          },
        },
      },
      seq,
    );
  }

  /**
   * A gateway client whose streamRunEventsResilient yields `frames` then either
   * returns, throws (`throwAfter` frames in), or stays open until aborted.
   */
  function streamingClient(frames, { mode = "return", throwAt = 0, onSignal } = {}) {
    return {
      async *streamRunEventsResilient(_params, options = {}) {
        const signal = options.signal;
        onSignal?.(signal);
        let i = 0;
        for (const frame of frames) {
          if (signal?.aborted) return;
          if (mode === "throw" && i === throwAt) throw new Error("stream dropped");
          yield frame;
          i += 1;
        }
        if (mode === "throw") throw new Error("stream dropped");
        if (mode === "open") {
          // Live stream: stay open until the consumer aborts.
          await new Promise((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
    };
  }

  test("nodeActivity renders lines mapped from streamed agent.event frames", async () => {
    const frames = [
      agentActionFrame(1, {
        nodeId: "build",
        phase: "started",
        id: "call-1",
        title: "bash",
        input: { command: "ls -la" },
      }),
      agentActionFrame(2, { nodeId: "build", phase: "completed", id: "call-1", title: "bash", output: "done" }),
      // An event for another node must NOT leak into build's strip.
      agentActionFrame(3, { nodeId: "deploy-node", phase: "started", id: "call-2", title: "scp", input: {} }),
    ];
    const source = createGatewayObservationSource(streamingClient(frames, { mode: "open" }));
    try {
      // Warm the subscription, then let the background loop drain the frames.
      await source.nodeActivity("run-g", "build", { limit: 4 });
      await tick();
      const lines = await source.nodeActivity("run-g", "build", { limit: 4 });
      expect(lines.length).toBe(1);
      expect(lines[0].title).toBe("bash");
      expect(lines[0].status).toBe("done");
      // The scp tool belongs to deploy-node and is filtered out for build.
      expect(lines.some((l) => l.title === "scp")).toBe(false);
      // The other node's strip surfaces ITS tool from the same ring.
      const other = await source.nodeActivity("run-g", "deploy-node", { limit: 4 });
      expect(other.some((l) => l.title === "scp")).toBe(true);
    } finally {
      source.dispose?.();
    }
  });

  test("focusView warms the stream so the strip is primed", async () => {
    const frames = [
      agentActionFrame(1, { nodeId: "build", phase: "started", id: "call-1", title: "vitest", input: {} }),
    ];
    const client = { ...fleetStub(), ...streamingClient(frames, { mode: "open" }) };
    const source = createGatewayObservationSource(client);
    try {
      const fleet = await source.listFleet();
      await source.focusView(fleet, 0); // warms ensureStreamFor(run-g)
      await tick();
      const lines = await source.nodeActivity("run-g", "build", { limit: 4 });
      expect(lines.some((l) => l.title === "vitest")).toBe(true);
    } finally {
      source.dispose?.();
    }
  });

  test("non-activity event types never dilute/evict the focused node's ring", async () => {
    // One real tool line, then a flood of non-activity events larger than the
    // 500-entry ring. Without the push-time type filter the tool row would be
    // evicted (parity divergence from direct-db, which pre-filters in SQL).
    const frames = [
      agentActionFrame(1, { nodeId: "build", phase: "started", id: "call-1", title: "bash", input: {} }),
      agentActionFrame(2, { nodeId: "build", phase: "completed", id: "call-1", title: "bash", output: "ok" }),
    ];
    for (let i = 0; i < 600; i += 1) {
      // node.started is a legitimate run.event the strip never renders; on the
      // gateway path it maps to no activity type and is dropped at push time.
      frames.push(mappedRunEventFrame({ type: "NodeStarted", runId: "run-g", nodeId: "build" }, 100 + i));
    }
    const source = createGatewayObservationSource(streamingClient(frames, { mode: "open" }));
    try {
      await source.nodeActivity("run-g", "build", { limit: 4 });
      await tick(30);
      const lines = await source.nodeActivity("run-g", "build", { limit: 4 });
      // The tool line survives the flood because non-activity frames are dropped
      // at push time rather than competing for the bounded ring.
      expect(lines.length).toBe(1);
      expect(lines[0].title).toBe("bash");
      expect(lines[0].status).toBe("done");
    } finally {
      source.dispose?.();
    }
  });

  test("a mid-stream throw degrades to last-known without crashing", async () => {
    // Yields one good frame, then throws on the next iteration.
    const frames = [agentActionFrame(1, { nodeId: "build", phase: "started", id: "call-1", title: "bash", input: {} })];
    const source = createGatewayObservationSource(streamingClient(frames, { mode: "throw", throwAt: 1 }));
    try {
      await source.nodeActivity("run-g", "build", { limit: 4 });
      await tick();
      // The throw was swallowed; the one line pushed before it survives.
      const lines = await source.nodeActivity("run-g", "build", { limit: 4 });
      expect(lines.length).toBe(1);
      expect(lines[0].title).toBe("bash");
    } finally {
      source.dispose?.();
    }
  });

  test("an immediate throw leaves the strip empty, never throwing", async () => {
    const source = createGatewayObservationSource(streamingClient([], { mode: "throw", throwAt: 0 }));
    try {
      await source.nodeActivity("run-g", "build", { limit: 4 });
      await tick();
      const lines = await source.nodeActivity("run-g", "build", { limit: 4 });
      expect(lines).toEqual([]);
    } finally {
      source.dispose?.();
    }
  });

  test("dispose() aborts the background subscription signal", async () => {
    /** @type {AbortSignal | undefined} */
    let captured;
    const source = createGatewayObservationSource(
      streamingClient([], { mode: "open", onSignal: (s) => (captured = s) }),
    );
    await source.nodeActivity("run-g", "build", { limit: 4 }); // starts the stream
    await tick();
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false);
    source.dispose?.();
    expect(captured?.aborted).toBe(true);
  });

  test("re-focusing another run rebinds the subscription (fresh signal)", async () => {
    /** @type {AbortSignal[]} */
    const signals = [];
    const client = streamingClient([], { mode: "open", onSignal: (s) => signals.push(s) });
    const source = createGatewayObservationSource(client);
    try {
      await source.nodeActivity("run-a", "n1", { limit: 4 });
      await tick();
      await source.nodeActivity("run-b", "n1", { limit: 4 });
      await tick();
      expect(signals.length).toBe(2);
      // Rebinding aborts the prior run's subscription.
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);
    } finally {
      source.dispose?.();
    }
  });
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("gateway pure helpers", () => {
  test("deriveDerivedStatusFromRunState renames succeeded -> finished", () => {
    expect(deriveDerivedStatusFromRunState({ state: "succeeded" }, "running")).toBe("finished");
    expect(deriveDerivedStatusFromRunState({ state: "running" }, "x")).toBe("running");
    // no runState -> fall back to persisted status, with the rename applied.
    expect(deriveDerivedStatusFromRunState(undefined, "succeeded")).toBe("finished");
    expect(deriveDerivedStatusFromRunState(undefined, "failed")).toBe("failed");
  });

  test("metaByNodeFromSnapshot carries the effort suffix (agentRan / agentSummary)", () => {
    const snapshot = {
      root: {
        type: "workflow",
        children: [
          {
            type: "task",
            task: {
              nodeId: "n1",
              // The snapshot now carries effort on agentRan (from the
              // attempt's first-class column / meta_json fallback).
              agentRan: { engine: "codex", model: "gpt-5", effort: "xhigh" },
              agentSummary: { label: "N1" },
            },
            children: [],
          },
          {
            type: "task",
            task: {
              nodeId: "n2",
              // Declared-only effort (agentSummary) is picked up too.
              agentSummary: { label: "N2", engine: "claude-code", effort: "high" },
            },
            children: [],
          },
        ],
      },
    };
    const meta = metaByNodeFromSnapshot(snapshot);
    expect(meta.n1).toEqual({ agentEngine: "codex", agentModel: "gpt-5", effort: "xhigh", label: "N1" });
    expect(meta.n2.effort).toBe("high");
  });

  test("flattenSnapshotToNodeRows yields listNodes-shaped rows", () => {
    const snapshot = {
      root: {
        type: "workflow",
        children: [
          { type: "task", task: { nodeId: "a", state: "finished", attempt: 3 }, children: [] },
          { type: "task", task: { nodeId: "b" }, children: [] },
        ],
      },
    };
    const rows = flattenSnapshotToNodeRows(snapshot);
    expect(rows).toContainEqual({ nodeId: "a", state: "finished", lastAttempt: 3, iteration: 0 });
    expect(rows).toContainEqual({ nodeId: "b", state: "pending", lastAttempt: 0, iteration: 0 });
  });
});

// ---------------------------------------------------------------------------
// (d) Parity — gateway client fed from the SAME seeded store as direct-db
// ---------------------------------------------------------------------------

describe("direct-db vs gateway parity (shared store)", () => {
  test("focusView.input and outlineTree.roots match on structural fields", async () => {
    const repo = openTempDb();
    try {
      await seedParityRun(repo.adapter);
      const direct = createDirectDbObservationSource(repo.adapter);
      const gateway = createGatewayObservationSource(makeAdapterBackedClient(repo.adapter));

      const directFleet = await direct.listFleet();
      const gatewayFleet = await gateway.listFleet();
      // Same run surfaces on both paths with the same runState-derived status.
      const directRun = directFleet.find((r) => r.runId === "run-parity");
      const gatewayRun = gatewayFleet.find((r) => r.runId === "run-parity");
      expect(directRun).toBeTruthy();
      expect(gatewayRun).toBeTruthy();
      expect(gatewayRun.derivedStatus).toBe(directRun.derivedStatus);

      const directFocus = await direct.focusView(directFleet, 0);
      const gatewayFocus = await gateway.focusView(gatewayFleet, 0);
      // Structural paint fields agree (remaining known divergences:
      // activity lines, updatedAtMs-derived finishedAtMs).
      expect(gatewayFocus.input.runId).toBe(directFocus.input.runId);
      expect(gatewayFocus.input.status).toBe(directFocus.input.status);
      expect(gatewayFocus.input.workflowName).toBe(directFocus.input.workflowName);
      expect(gatewayFocus.input.live).toBe(directFocus.input.live);
      const nodeStates = (input) => Object.fromEntries(input.nodes.map((n) => [n.nodeId, n.state]).sort());
      expect(nodeStates(gatewayFocus.input)).toEqual(nodeStates(directFocus.input));
      // Effort now travels on BOTH paths (seed sets effort:"high"): the
      // direct path reads the persisted meta, the gateway path lifts it off
      // the snapshot's agentRan. Parity, not divergence.
      expect(directFocus.input.agentMetaByNode.setup.effort).toBe("high");
      expect(gatewayFocus.input.agentMetaByNode.setup.effort).toBe("high");

      // Outline trees agree on selectable keys/nodeIds/states/labels.
      const directOutline = await direct.outlineTree("run-parity", directFocus.input.agentMetaByNode ?? {});
      const gatewayOutline = await gateway.outlineTree("run-parity", gatewayFocus.input.agentMetaByNode ?? {});
      const structural = (roots) =>
        flattenOutlineTree(roots, {})
          .selectables.map((s) => ({
            key: s.key,
            nodeId: s.nodeId,
            state: s.state,
            label: s.label,
            kind: s.kind,
          }))
          .sort((a, b) => a.key.localeCompare(b.key));
      expect(structural(gatewayOutline.roots)).toEqual(structural(directOutline.roots));
    } finally {
      repo.close();
    }
  });
});
