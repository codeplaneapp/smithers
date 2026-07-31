import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHerdrClient } from "../src/createHerdrClient.js";
import { createHerdrRunSurface, launchHijackPane, openTabPane } from "../src/index.js";
import { isHerdrInstalled, randomSessionName, startHerdrServer } from "./herdr-server.js";

const herdrInstalled = isHerdrInstalled();

/**
 * Wrap a HerdrClient so a test can observe every RPC the surface issues. The
 * surface routes both its hard `call`s (agent.start) and its soft reports
 * (report_agent etc.) through the underlying client's `call`, so recording
 * `call` captures the full authoritative-push sequence.
 *
 * @param {import("../src/HerdrClientOptions.ts").HerdrClient} inner
 * @param {(rec: { method: string, params: Record<string, unknown> }) => void} record
 * @returns {import("../src/HerdrClientOptions.ts").HerdrClient}
 */
function recordingClient(inner, record) {
  return {
    socketPath: inner.socketPath,
    subscribe: inner.subscribe.bind(inner),
    ping: inner.ping.bind(inner),
    call: (method, params) => {
      record({ method, params: params ?? {} });
      return inner.call(method, params);
    },
    tryCall: (method, params) => {
      record({ method, params: params ?? {} });
      return inner.tryCall(method, params);
    },
  };
}

/** A tail command that never resolves the real (nonexistent) `smithers` bin. */
const STUB_TAIL = () => ["bash", "-c", "sleep 30"];

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, timeoutMs = 8000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return Boolean(await predicate());
}

/** @returns {string} */
function makeRunId() {
  return `run-${Math.random().toString(36).slice(2, 12)}-0000000000`;
}

describe.skipIf(!herdrInstalled)("createHerdrRunSurface against a real herdr server", () => {
  /** @type {Awaited<ReturnType<typeof startHerdrServer>>} */
  let server;
  /** @type {import("../src/HerdrClientOptions.ts").HerdrClient} */
  let client;
  // Suite-level unhandled-rejection detector: the surface's fire-and-forget
  // tasks must never leak a rejection, even against a live server.
  /** @type {unknown[]} */
  const suiteRejections = [];
  const onSuiteRejection = (/** @type {unknown} */ reason) => suiteRejections.push(reason);

  beforeAll(async () => {
    process.on("unhandledRejection", onSuiteRejection);
    server = await startHerdrServer();
    client = createHerdrClient({ socketPath: server.socketPath, callTimeoutMs: 4000, logger: () => {} });
  });

  afterAll(async () => {
    // Flush any trailing microtasks, then assert nothing leaked before teardown.
    await sleep(200);
    process.removeListener("unhandledRejection", onSuiteRejection);
    await server?.dispose();
    expect(suiteRejections).toEqual([]);
  });

  /** @returns {Promise<any[]>} */
  async function listAgents() {
    const res = /** @type {any} */ (await client.call("agent.list", {}));
    return res && Array.isArray(res.agents) ? res.agents : [];
  }
  /**
   * @param {string} name
   * @returns {Promise<any | undefined>}
   */
  async function agentByName(name) {
    return (await listAgents()).find((a) => a && a.name === name);
  }
  /**
   * @param {string} name
   * @returns {Promise<string | undefined>}
   */
  async function statusOf(name) {
    const agent = await agentByName(name);
    return agent ? agent.agent_status : undefined;
  }
  /** @returns {Promise<any[]>} */
  async function listWorkspaces() {
    const res = /** @type {any} */ (await client.call("workspace.list", {}));
    return res && Array.isArray(res.workspaces) ? res.workspaces : [];
  }
  /**
   * @param {string} label
   * @returns {Promise<any | undefined>}
   */
  async function workspaceByLabel(label) {
    return (await listWorkspaces()).find((w) => w.label === label);
  }
  /**
   * @param {string} workspaceId
   * @returns {Promise<any[]>}
   */
  async function listTabs(workspaceId) {
    const res = /** @type {any} */ (await client.call("tab.list", { workspace_id: workspaceId }));
    return res && Array.isArray(res.tabs) ? res.tabs : [];
  }
  /**
   * The tabs of the surface's workspace, resolved by label. Empty until the
   * workspace exists.
   *
   * @param {string} label
   * @returns {Promise<any[]>}
   */
  async function tabsOfWorkspace(label) {
    const ws = await workspaceByLabel(label);
    return ws ? await listTabs(ws.workspace_id) : [];
  }
  /**
   * Full pane-layout for a pane's tab (rects + split tree), per the layout research.
   *
   * @param {string} paneId
   * @returns {Promise<any | undefined>}
   */
  async function paneLayout(paneId) {
    const res = /** @type {any} */ (await client.call("pane.layout", { pane_id: paneId }).catch(() => undefined));
    return res ? res.layout : undefined;
  }
  /** A stub overview command that runs forever, so the overview tab persists for assertions. */
  const STUB_OVERVIEW = () => ["bash", "-c", "sleep 30"];
  /**
   * @param {string} type
   * @param {string} runId
   * @param {Record<string, unknown>} [extra]
   */
  function ev(type, runId, extra = {}) {
    return { type, runId, iteration: 0, attempt: 1, timestampMs: Date.now(), ...extra };
  }

  test("workspace find-or-create is idempotent across concurrent surfaces for the same run", async () => {
    const label = `smithers-test-ws-${randomSessionName()}`;
    const runId = makeRunId();
    const s1 = createHerdrRunSurface({ client, workspaceLabel: label, logger: () => {} });
    const s2 = createHerdrRunSurface({ client, workspaceLabel: label, logger: () => {} });
    await Promise.all([s1.attach(runId), s2.attach(runId)]);

    const matching = (await listWorkspaces()).filter((w) => w.label === label);
    expect(matching.length).toBe(1);
    expect(await Promise.all([s1.workspaceId(), s2.workspaceId()])).toEqual([
      matching[0].workspace_id,
      matching[0].workspace_id,
    ]);

    await s1.close();
    await s2.close();
    await client.call("workspace.close", { workspace_id: matching[0].workspace_id }).catch(() => {});
  });

  test("renames the workspace with the finished marker on RunFinished, then re-finds it prefix-tolerantly", async () => {
    const runId = makeRunId();
    const label = `smithers-test-outcome-fin-${randomSessionName()}`;
    const s1 = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      overviewCommand: STUB_OVERVIEW,
      softPinSlots: 20,
      logger: () => {},
    });
    s1.onEvent(ev("RunStarted", runId));
    expect(await waitFor(async () => Boolean(await workspaceByLabel(label)))).toBe(true);

    // Terminal: the workspace is renamed `✓ <label>` (marker prepended, run label kept).
    s1.onEvent(ev("RunFinished", runId, { failedChildren: 0 }));
    await s1.close();
    expect(await waitFor(async () => Boolean(await workspaceByLabel(`✓ ${label}`)))).toBe(true);
    expect(await workspaceByLabel(label)).toBeUndefined();

    // A fresh surface with the SAME clean label re-adopts the renamed workspace
    // (find-or-create tolerates the outcome prefix) instead of creating a duplicate.
    const s2 = createHerdrRunSurface({ client, workspaceLabel: label, logger: () => {} });
    await s2.attach(runId);
    const matching = (await listWorkspaces()).filter((w) => w.label === `✓ ${label}` || w.label === label);
    expect(matching.length).toBe(1);
    expect(matching[0].label).toBe(`✓ ${label}`);
    await s2.close();
    await client.call("workspace.close", { workspace_id: matching[0].workspace_id }).catch(() => {});
  });

  test("uses the ✗ marker on RunFailed and the ◻ marker on RunCancelled", async () => {
    for (const { type, marker } of [
      { type: "RunFailed", marker: "✗" },
      { type: "RunCancelled", marker: "◻" },
    ]) {
      const runId = makeRunId();
      const label = `smithers-test-outcome-${marker === "✗" ? "fail" : "cancel"}-${randomSessionName()}`;
      const s = createHerdrRunSurface({
        client,
        workspaceLabel: label,
        overviewCommand: STUB_OVERVIEW,
        softPinSlots: 20,
        logger: () => {},
      });
      s.onEvent(ev("RunStarted", runId));
      expect(await waitFor(async () => Boolean(await workspaceByLabel(label)))).toBe(true);
      s.onEvent(ev(type, runId));
      await s.close();
      expect(await waitFor(async () => Boolean(await workspaceByLabel(`${marker} ${label}`)))).toBe(true);
      const ws = await workspaceByLabel(`${marker} ${label}`);
      if (ws) {
        await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
      }
    }
  });

  test("creates a pane per agent node using the injected tailCommand", async () => {
    const runId = makeRunId();
    const label = `smithers-test-pane-${randomSessionName()}`;
    /** @type {{ runId: string, nodeId: string }[]} */
    const tailCalls = [];
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: (ctx) => {
        tailCalls.push(ctx);
        return STUB_TAIL();
      },
    });
    const name = `smithers:${runId}:node-1`;

    surface.onEvent(ev("NodeStarted", runId, { nodeId: "node-1" }));
    expect(await waitFor(async () => Boolean(await agentByName(name)))).toBe(true);
    expect(tailCalls).toContainEqual({ runId, nodeId: "node-1" });

    await surface.close();
    const ws = (await listWorkspaces()).find((w) => w.label === label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("nodeFilter 'unknown' (undefined) is not cached: the pane appears on the node's SECOND event", async () => {
    // COMPOSED regression: the surface memoizes a boolean filter decision per
    // node, so a filter that returns the "unknown" channel (`undefined` — what
    // the CLI's buildAgentNodeFilter yields on a transient DB error) MUST be
    // skipped WITHOUT caching, or that one blip freezes the node's pane off for
    // the rest of the run. The filter here errors once (soft-handled to
    // `undefined`) then returns true; the pane must materialize on event two.
    const runId = makeRunId();
    const label = `smithers-test-unknown-${randomSessionName()}`;
    let filterCalls = 0;
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      nodeFilter: async () => {
        filterCalls += 1;
        try {
          // First evaluation: a transient failure the filter soft-handles into
          // the "unknown" channel (mirrors buildAgentNodeFilter's DB-error path).
          if (filterCalls === 1) {
            throw new Error("transient read failure");
          }
          return true;
        } catch {
          return undefined;
        }
      },
    });
    const name = `smithers:${runId}:n1`;

    // Event one: the filter is "unknown" → no pane, and (crucially) the decision
    // is NOT cached. Give the queued task time to run before asserting absence.
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    await sleep(600);
    expect(await agentByName(name)).toBeUndefined();

    // Event two: the surface re-asks (the unknown result was not memoized), the
    // filter now returns true, and the pane materializes. Against the pre-fix
    // code the first decision is cached, so this pane never appears.
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => Boolean(await agentByName(name)))).toBe(true);
    expect(filterCalls).toBeGreaterThanOrEqual(2);

    await surface.close();
    const ws = (await listWorkspaces()).find((w) => w.label === label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("forwards the surface cwd to agent.start so the pane runs in the run directory", async () => {
    const runId = makeRunId();
    const label = `smithers-test-cwd-${randomSessionName()}`;
    /** @type {{ method: string, params: any }[]} */
    const calls = [];
    const surface = createHerdrRunSurface({
      client: recordingClient(client, (rec) => calls.push(rec)),
      workspaceLabel: label,
      cwd: "/tmp/smithers-test-run-dir",
      logger: () => {},
      tailCommand: STUB_TAIL,
    });
    const name = `smithers:${runId}:n1`;

    surface.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => Boolean(await agentByName(name)))).toBe(true);
    await surface.close();

    // A pane started via agent.start does NOT inherit the workspace cwd (it runs
    // in the herdr server's cwd), so the surface must pass cwd explicitly or the
    // tail viewer cannot find the run's store.
    const start = calls.find((c) => c.method === "agent.start" && c.params.name === name);
    expect(start?.params.cwd).toBe("/tmp/smithers-test-run-dir");

    const ws = (await listWorkspaces()).find((w) => w.label === label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("drives a pane through working -> blocked -> working -> done observable via agent.list", async () => {
    const runId = makeRunId();
    const label = `smithers-test-life-${randomSessionName()}`;
    const surface = createHerdrRunSurface({ client, workspaceLabel: label, logger: () => {}, tailCommand: STUB_TAIL });
    const name = `smithers:${runId}:n1`;

    surface.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => (await statusOf(name)) === "working")).toBe(true);

    surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => (await statusOf(name)) === "blocked")).toBe(true);

    surface.onEvent(ev("ApprovalGranted", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => (await statusOf(name)) === "working")).toBe(true);

    // The node finishes into its OWN background tab; herdr rolls an unviewed
    // finished (idle) pane up to "done" — the "done, come look" signal — not "idle".
    surface.onEvent(ev("NodeFinished", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => (await statusOf(name)) === "done")).toBe(true);

    const agent = await agentByName(name);
    expect(agent?.custom_status).toBe("done");

    await surface.close();
    const ws = (await listWorkspaces()).find((w) => w.label === label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("a nodeFilter-rejected approval gate is still surfaced blocked with its question, then done on grant", async () => {
    // F1 regression: a pure approval/human-gate node carries NO agent attempt
    // row, so the CLI's agent-only nodeFilter rejects it. Without the approval
    // bypass its pane is never created and the flagship "sidebar shows blocked
    // with the question" moment never fires. The bypass must force the pane for
    // `NodeWaitingApproval` regardless of the filter, report blocked with the
    // enriched question, then resolve to idle "approved" on grant.
    const runId = makeRunId();
    const label = `smithers-test-gate-${randomSessionName()}`;
    /** @type {{ method: string, params: any }[]} */
    const calls = [];
    const surface = createHerdrRunSurface({
      client: recordingClient(client, (rec) => calls.push(rec)),
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      // Reject every node, exactly as the agent-only filter rejects a gate node.
      nodeFilter: () => false,
    });
    const name = `smithers:${runId}:ship-approval`;

    surface.onEvent(
      ev("NodeWaitingApproval", runId, { nodeId: "ship-approval", request: { title: "Ship the haiku?" } }),
    );
    // The pane materializes despite the filter rejecting the node, and is blocked.
    expect(await waitFor(async () => (await statusOf(name)) === "blocked")).toBe(true);
    expect(await agentByName(name)).toBeDefined();

    // The blocked report carries the enriched gate question, not the generic text.
    const blockedReport = calls.find(
      (c) => c.method === "pane.report_agent" && c.params.agent === name && c.params.state === "blocked",
    );
    expect(blockedReport?.params.message).toBe("Ship the haiku?");

    // The question is ALSO pushed as the queryable custom_status (herdr does not
    // echo the report_agent `message` back in its agent JSON), so a sidebar /
    // dashboard reading `agent list` sees WHAT needs approving, not just "blocked".
    expect(await waitFor(async () => (await agentByName(name))?.custom_status === "Ship the haiku?")).toBe(true);

    // Granting the gate resolves the pane to idle "approved"; herdr rolls the
    // unviewed idle pane up to "done", with custom_status carrying "approved".
    surface.onEvent(ev("ApprovalGranted", runId, { nodeId: "ship-approval" }));
    expect(await waitFor(async () => (await statusOf(name)) === "done")).toBe(true);
    const agent = await agentByName(name);
    expect(agent?.custom_status).toBe("approved");

    await surface.close();
    const ws = (await listWorkspaces()).find((w) => w.label === label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("a parked gate pane runs the injected gateCommand, while agent nodes run the tailCommand", async () => {
    // Task 2: gate tabs are interactive. A pure approval-gate node's pane must be
    // built from `gateCommand` (the `approve --watch` loop), NOT the read-only
    // `tailCommand`; an ordinary agent node keeps the tailCommand. Both builders
    // record their ctx so we can assert which node each was asked to command.
    const runId = makeRunId();
    const label = `smithers-test-gatecmd-${randomSessionName()}`;
    /** @type {{ runId: string, nodeId: string }[]} */
    const tailCalls = [];
    /** @type {{ runId: string, nodeId: string }[]} */
    const gateCalls = [];
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: (ctx) => {
        tailCalls.push(ctx);
        return STUB_TAIL();
      },
      gateCommand: (ctx) => {
        gateCalls.push(ctx);
        return STUB_TAIL();
      },
      // Mirror an agent node ("worker") but reject the gate node, exactly as the
      // CLI's agent-only filter does (a pure gate carries no agent attempt row).
      nodeFilter: (ctx) => ctx.nodeId === "worker",
    });
    const gateName = `smithers:${runId}:ship-approval`;
    const agentName = `smithers:${runId}:worker`;

    // An ordinary agent node: its pane is built from tailCommand.
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "worker" }));
    expect(await waitFor(async () => Boolean(await agentByName(agentName)))).toBe(true);
    expect(tailCalls).toContainEqual({ runId, nodeId: "worker" });

    // A pure gate node: filtered out for tail, but force-surfaced as a gate whose
    // pane is built from gateCommand, never tailCommand.
    surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "ship-approval", request: { title: "Ship it?" } }));
    expect(await waitFor(async () => (await statusOf(gateName)) === "blocked")).toBe(true);
    expect(gateCalls).toContainEqual({ runId, nodeId: "ship-approval" });
    expect(tailCalls).not.toContainEqual({ runId, nodeId: "ship-approval" });
    expect(gateCalls).not.toContainEqual({ runId, nodeId: "worker" });

    await surface.close();
    const ws = (await listWorkspaces()).find((w) => w.label === label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("a parked gate adopted by a fresh surface resolves to done approved on resume (not stuck blocked)", async () => {
    // The real park -> approve -> resume flow spans TWO processes: `smithers up`
    // parks at the gate by EXITING (exit 3), the human approves, then a FRESH
    // process resumes. That resumed surface has no memory of the gate and its
    // agent-only nodeFilter rejects the attempt-less gate node, so before the fix
    // it never touched the parked pane and the gate sat stuck "blocked" forever.
    // The resume path must adopt the pane (attach) and re-flag the gate
    // (markApprovalGate) so the live NodeFinished resolves it to idle "approved".
    const runId = makeRunId();
    const label = `smithers-test-resume-gate-${randomSessionName()}`;
    const name = `smithers:${runId}:ship-approval`;

    // Process 1: parks the gate blocked, then exits (close()).
    const s1 = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      nodeFilter: () => false,
    });
    s1.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "ship-approval", request: { title: "Ship the haiku?" } }));
    expect(await waitFor(async () => (await statusOf(name)) === "blocked")).toBe(true);
    await s1.close();

    // Process 2 (fresh, same agent-only filter): adopt the parked pane and re-flag
    // the gate, then feed the live resume events (the gate re-runs as a compute
    // node: NodeStarted -> NodeFinished, with NO NodeWaitingApproval this time).
    const s2 = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      nodeFilter: () => false,
    });
    await s2.attach(runId);
    s2.markApprovalGate("ship-approval");
    s2.onEvent(ev("NodeStarted", runId, { nodeId: "ship-approval" }));
    s2.onEvent(ev("NodeFinished", runId, { nodeId: "ship-approval" }));

    // It lands idle "approved" — herdr rolls the unviewed idle gate pane up to
    // "done" (NOT stuck "blocked"), with custom_status "approved".
    expect(await waitFor(async () => (await statusOf(name)) === "done")).toBe(true);
    expect(await waitFor(async () => (await agentByName(name))?.custom_status === "approved")).toBe(true);
    // No duplicate pane: the fresh surface adopted the parked one.
    expect((await listAgents()).filter((a) => a && a.name === name).length).toBe(1);

    await s2.close();
    const ws = (await listWorkspaces()).filter((w) => w.label === label);
    for (const w of ws) {
      await client.call("workspace.close", { workspace_id: w.workspace_id }).catch(() => {});
    }
  });

  test("replaying the same run into a second surface adopts the pane (no duplicate)", async () => {
    const runId = makeRunId();
    const label = `smithers-test-replay-${randomSessionName()}`;
    const name = `smithers:${runId}:n1`;

    const s1 = createHerdrRunSurface({ client, workspaceLabel: label, logger: () => {}, tailCommand: STUB_TAIL });
    s1.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    s1.onEvent(ev("NodeFinished", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => (await statusOf(name)) === "done")).toBe(true);

    // A fresh surface fed the SAME run: agent.start hits agent_name_taken and
    // must adopt the existing pane rather than create a duplicate.
    const s2 = createHerdrRunSurface({ client, workspaceLabel: label, logger: () => {}, tailCommand: STUB_TAIL });
    s2.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    s2.onEvent(ev("NodeFinished", runId, { nodeId: "n1" }));
    await s2.close();
    await s1.close();

    const named = (await listAgents()).filter((a) => a && a.name === name);
    expect(named.length).toBe(1);

    const ws = (await listWorkspaces()).filter((w) => w.label === label);
    expect(ws.length).toBe(1);
    await client.call("workspace.close", { workspace_id: ws[0].workspace_id }).catch(() => {});
  });

  test("a second surface incarnation changes an adopted pane's status (monotonic seq across incarnations)", async () => {
    const runId = makeRunId();
    const label = `smithers-test-incarnation-${randomSessionName()}`;
    const name = `smithers:${runId}:n1`;

    // Incarnation 1 drives the pane to a terminal FAILURE (blocked) and detaches.
    const s1 = createHerdrRunSurface({ client, workspaceLabel: label, logger: () => {}, tailCommand: STUB_TAIL });
    s1.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    s1.onEvent(ev("NodeFailed", runId, { nodeId: "n1", error: "boom" }));
    expect(await waitFor(async () => (await statusOf(name)) === "blocked")).toBe(true);
    await s1.close();

    // Incarnation 2 (a fresh re-attach of the SAME run) adopts the existing pane
    // via agent_name_taken and must be able to push a NEW status. Its per-pane
    // seq is seeded from Date.now(), so it out-ranks s1's high-water mark. A seq
    // that restarted at 0/1 would be silently dropped by herdr (stale-seq) and
    // the pane would stay frozen at "blocked" - i.e. this fails before the fix.
    const s2 = createHerdrRunSurface({ client, workspaceLabel: label, logger: () => {}, tailCommand: STUB_TAIL });
    s2.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    s2.onEvent(ev("NodeFinished", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => (await statusOf(name)) === "done")).toBe(true);
    await s2.close();

    const named = (await listAgents()).filter((a) => a && a.name === name);
    expect(named.length).toBe(1);
    const ws = (await listWorkspaces()).filter((w) => w.label === label);
    for (const w of ws) {
      await client.call("workspace.close", { workspace_id: w.workspace_id }).catch(() => {});
    }
  });

  test("interleaved multi-node events preserve per-pane order (recorded states + strictly-increasing seq)", async () => {
    const runId = makeRunId();
    const label = `smithers-test-multi-${randomSessionName()}`;
    /** @type {{ method: string, params: any }[]} */
    const calls = [];
    const surface = createHerdrRunSurface({
      client: recordingClient(client, (rec) => calls.push(rec)),
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      // Ordering test needs both panes; raise soft-pin so stage policy does not drop b.
      softPinSlots: 20,
    });
    const nameA = `smithers:${runId}:a`;
    const nameB = `smithers:${runId}:b`;

    surface.onEvent(ev("NodeStarted", runId, { nodeId: "a" }));
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "b" }));
    surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "a" }));
    surface.onEvent(ev("NodeFinished", runId, { nodeId: "b" }));
    surface.onEvent(ev("ApprovalGranted", runId, { nodeId: "a" }));
    surface.onEvent(ev("NodeFinished", runId, { nodeId: "a" }));

    // close() drains the queue; ordered application must land both panes idle
    // (a: working -> blocked -> working -> idle; b: working -> idle).
    await surface.close();
    expect(await statusOf(nameA)).toBe("done");
    expect(await statusOf(nameB)).toBe("done");

    // The recording proves ordering directly (a reorder is invisible to a
    // final-state-only assertion): each pane's report_agent states arrive in
    // exactly the mapped order and its seq strictly increases.
    const reportsFor = (/** @type {string} */ name) =>
      calls.filter((c) => c.method === "pane.report_agent" && c.params.agent === name);
    expect(reportsFor(nameA).map((c) => c.params.state)).toEqual(["working", "blocked", "working", "idle"]);
    expect(reportsFor(nameB).map((c) => c.params.state)).toEqual(["working", "idle"]);
    for (const name of [nameA, nameB]) {
      const seqs = reportsFor(name).map((c) => c.params.seq);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
    }

    const ws = (await listWorkspaces()).find((w) => w.label === label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("NodeFailed reports the pane blocked", async () => {
    const runId = makeRunId();
    const label = `smithers-test-fail-${randomSessionName()}`;
    const surface = createHerdrRunSurface({ client, workspaceLabel: label, logger: () => {}, tailCommand: STUB_TAIL });
    const name = `smithers:${runId}:n1`;

    surface.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => (await statusOf(name)) === "working")).toBe(true);
    surface.onEvent(ev("NodeFailed", runId, { nodeId: "n1", error: "boom kaboom" }));
    expect(await waitFor(async () => (await statusOf(name)) === "blocked")).toBe(true);

    await surface.close();
    const ws = (await listWorkspaces()).find((w) => w.label === label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("closeWorkspaceOnFinish closes the workspace on RunFinished", async () => {
    const runId = makeRunId();
    const label = `smithers-test-cw-${randomSessionName()}`;
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      closeWorkspaceOnFinish: true,
    });
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => (await listWorkspaces()).some((w) => w.label === label))).toBe(true);
    surface.onEvent({ type: "RunFinished", runId, timestampMs: Date.now() });
    await surface.close();
    expect(await waitFor(async () => !(await listWorkspaces()).some((w) => w.label === label))).toBe(true);
  });

  test("launchHijackPane opens a blocked hijack pane in the run workspace", async () => {
    const runId = makeRunId();
    const created = /** @type {any} */ (
      await client.call("workspace.create", { label: `smithers-test-hijack-${randomSessionName()}`, focus: false })
    );
    const workspaceId = created.workspace.workspace_id;
    const name = `smithers:${runId}:hijack:n1`;

    const res = await launchHijackPane(
      client,
      { command: "bash", args: ["-c", "sleep 30"], cwd: process.cwd(), env: {} },
      { runId, nodeId: "n1", workspaceId, focus: false },
    );
    expect(res).toBeDefined();
    expect(res?.workspaceId).toBe(workspaceId);
    expect(typeof res?.paneId).toBe("string");

    const agent = await agentByName(name);
    expect(agent).toBeDefined();
    expect(await waitFor(async () => (await statusOf(name)) === "blocked")).toBe(true);

    await client.call("workspace.close", { workspace_id: workspaceId }).catch(() => {});
  });

  test("a real operator tab with a colliding label survives openTabPane", async () => {
    const runId = makeRunId();
    const collision = `collision-${randomSessionName()}`;
    const created = /** @type {any} */ (
      await client.call("workspace.create", { label: `smithers-test-${collision}`, focus: false })
    );
    const workspaceId = created.workspace.workspace_id;
    const operatorTabId = created.tab.tab_id;
    const operatorPaneId = created.root_pane.pane_id;
    await client.call("tab.rename", { tab_id: operatorTabId, label: collision });

    const opened = await openTabPane(client, {
      workspaceId,
      label: collision,
      name: `smithers:${runId}:collision-node`,
      argv: STUB_TAIL(),
      focus: false,
    });
    expect(opened).toBeDefined();
    expect(opened?.tabId).not.toBe(operatorTabId);

    const tabs = await listTabs(workspaceId);
    const panes = /** @type {any} */ (await client.call("pane.list", { workspace_id: workspaceId }));
    expect(tabs.some((tab) => tab.tab_id === operatorTabId && tab.label === collision)).toBe(true);
    expect(panes.panes.some((pane) => pane.pane_id === operatorPaneId && pane.tab_id === operatorTabId)).toBe(true);
    expect(tabs.filter((tab) => tab.label === collision).length).toBe(2);

    await client.call("workspace.close", { workspace_id: workspaceId }).catch(() => {});
  });

  test("two rapid NodeStarted for the same node issue exactly one agent.start", async () => {
    const runId = makeRunId();
    const label = `smithers-test-dup-${randomSessionName()}`;
    /** @type {{ method: string, params: any }[]} */
    const calls = [];
    const surface = createHerdrRunSurface({
      client: recordingClient(client, (rec) => calls.push(rec)),
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
    });
    const name = `smithers:${runId}:n1`;

    // Fire two NodeStarted for the same node back-to-back (e.g. a retry): the
    // serial queue must observe entry.paneId set by the first task before the
    // second runs, so exactly one agent.start happens.
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => (await statusOf(name)) === "working")).toBe(true);
    await surface.close();

    // Count agent.start directly: broken serialization would fire a second one
    // and lean on herdr's name uniqueness (+ adoption) to hide the duplicate.
    const starts = calls.filter((c) => c.method === "agent.start" && c.params.name === name);
    expect(starts.length).toBe(1);

    const named = (await listAgents()).filter((a) => a && a.name === name);
    expect(named.length).toBe(1);
    const ws = (await listWorkspaces()).filter((w) => w.label === label);
    expect(ws.length).toBe(1);
    await client.call("workspace.close", { workspace_id: ws[0].workspace_id }).catch(() => {});
  });

  test("events arriving before attach() are reconciled without duplicating the pane", async () => {
    const runId = makeRunId();
    const label = `smithers-test-pre-${randomSessionName()}`;
    const surface = createHerdrRunSurface({ client, workspaceLabel: label, logger: () => {}, tailCommand: STUB_TAIL });
    const name = `smithers:${runId}:n1`;

    // An event before attach() binds the run id and creates the workspace+pane.
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => Boolean(await agentByName(name)))).toBe(true);

    // attach() then reconciles against the already-created pane instead of
    // creating a second one.
    await surface.attach(runId);
    surface.onEvent(ev("NodeFinished", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => (await statusOf(name)) === "done")).toBe(true);

    await surface.close();
    const named = (await listAgents()).filter((a) => a && a.name === name);
    expect(named.length).toBe(1);
    const ws = (await listWorkspaces()).filter((w) => w.label === label);
    expect(ws.length).toBe(1);
    await client.call("workspace.close", { workspace_id: ws[0].workspace_id }).catch(() => {});
  });

  test("each node lands in its OWN tab (label = node id), one FULL-SIZE pane per tab", async () => {
    // The core layout claim: instead of N+1 progressively-halved slivers in one
    // tab (naive agent.start), each node gets its own tab holding a single pane
    // that fills the whole tab area. Asserted structurally via tab.list (one tab
    // per node, pane_count 1) AND pane.layout geometry (the pane rect == the tab
    // area, no splits) per the layout research.
    const runId = makeRunId();
    const label = `smithers-test-tabs-${randomSessionName()}`;
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      overviewCommand: STUB_OVERVIEW,
      softPinSlots: 20,
    });
    const nameA = `smithers:${runId}:alpha`;
    const nameB = `smithers:${runId}:beta`;

    surface.onEvent(ev("NodeStarted", runId, { nodeId: "alpha" }));
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "beta" }));
    expect(await waitFor(async () => Boolean(await agentByName(nameA)) && Boolean(await agentByName(nameB)))).toBe(
      true,
    );
    // Give the seed-pane close a beat to settle so pane_count/geometry is stable.
    await sleep(400);

    const tabs = await tabsOfWorkspace(label);
    const byLabel = (/** @type {string} */ l) => tabs.filter((t) => t.label === l);
    // Overview tab + exactly one tab per node, each with a SINGLE pane.
    expect(byLabel("cockpit").length).toBe(1);
    expect(byLabel("alpha").length).toBe(1);
    expect(byLabel("beta").length).toBe(1);
    expect(byLabel("alpha")[0].pane_count).toBe(1);
    expect(byLabel("beta")[0].pane_count).toBe(1);

    // Each node pane fills its whole tab (rect == area, no split) — the "one
    // full-size pane" the design wants, not a halved sliver.
    for (const nm of [nameA, nameB]) {
      const agent = await agentByName(nm);
      const layout = await paneLayout(agent.pane_id);
      expect(layout).toBeDefined();
      expect(layout.splits.length).toBe(0);
      expect(layout.panes.length).toBe(1);
      expect(layout.panes[0].rect.width).toBe(layout.area.width);
      expect(layout.panes[0].rect.height).toBe(layout.area.height);
    }

    await surface.close();
    const ws = await workspaceByLabel(label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("tab 1 is renamed 'cockpit' and runs the whole-run overview command in the root shell", async () => {
    // Tab 1 becomes the cockpit: renamed "cockpit" and running the
    // overviewCommand IN the seeded root shell (so the workspace survives the
    // command's exit). Asserted by (a) the "overview" tab existing, (b) the exact
    // pane.send_text RPC carrying the joined command, and (c) the command's marker
    // appearing in the root pane's output (proof it actually ran).
    const runId = makeRunId();
    const label = `smithers-test-overview-${randomSessionName()}`;
    const marker = `OVERVIEW_${randomSessionName()}`;
    /** @type {{ method: string, params: any }[]} */
    const calls = [];
    const surface = createHerdrRunSurface({
      client: recordingClient(client, (rec) => calls.push(rec)),
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      overviewCommand: () => ["bash", "-c", `echo ${marker}; sleep 30`],
    });

    surface.onEvent(ev("RunStarted", runId));
    expect(await waitFor(async () => (await tabsOfWorkspace(label)).some((t) => t.label === "cockpit"))).toBe(true);

    // The overview command was typed into the root shell as one pane.send_text.
    const sendText = calls.find((c) => c.method === "pane.send_text");
    expect(sendText).toBeDefined();
    expect(sendText.params.text).toContain(marker);

    // It actually executed: the marker shows up in the overview pane's output, and
    // the workspace survives (a replaced command pane exiting would have closed it).
    const overviewTab = (await tabsOfWorkspace(label)).find((t) => t.label === "cockpit");
    expect(overviewTab).toBeDefined();
    const panes = /** @type {any} */ (await client.call("pane.list", { workspace_id: overviewTab.workspace_id }));
    const overviewPane = panes.panes.find((/** @type {any} */ p) => p.tab_id === overviewTab.tab_id);
    expect(overviewPane).toBeDefined();
    const ran = await waitFor(async () => {
      const read = /** @type {any} */ (
        await client
          .call("pane.read", { pane_id: overviewPane.pane_id, source: "recent_unwrapped", lines: 80 })
          .catch(() => undefined)
      );
      const text = read && read.read ? String(read.read.text) : "";
      // The marker as OUTPUT (its own line), not just the echoed command text.
      return text.split("\n").some((l) => l.trim() === marker);
    });
    expect(ran).toBe(true);
    expect(await workspaceByLabel(label)).toBeDefined();

    await surface.close();
    const ws = await workspaceByLabel(label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("adaptive cap: past tabCap the surplus nodes stay unpaned (tabs stop at the cap)", async () => {
    // With tabCap 4 (overview + 3 node tabs), mirroring 8 nodes must create panes
    // for exactly the first 3; nodes 4-8 get no pane and the tab bar stops growing.
    const runId = makeRunId();
    const label = `smithers-test-cap-${randomSessionName()}`;
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      overviewCommand: STUB_OVERVIEW,
      softPinSlots: 20,
      tabCap: 4,
    });
    for (let i = 1; i <= 8; i++) {
      surface.onEvent(ev("NodeStarted", runId, { nodeId: `c${i}` }));
    }
    // The first 3 nodes get panes.
    expect(
      await waitFor(async () => {
        for (const i of [1, 2, 3]) {
          if (!(await agentByName(`smithers:${runId}:c${i}`))) {
            return false;
          }
        }
        return true;
      }),
    ).toBe(true);
    // Let any (incorrect) surplus pane creation flush before asserting absence.
    await sleep(600);

    for (const i of [1, 2, 3]) {
      expect(await agentByName(`smithers:${runId}:c${i}`)).toBeDefined();
    }
    for (const i of [4, 5, 6, 7, 8]) {
      expect(await agentByName(`smithers:${runId}:c${i}`)).toBeUndefined();
    }
    // Tab bar stops at the cap: overview + c1 + c2 + c3 = 4 tabs total.
    const tabs = await tabsOfWorkspace(label);
    expect(tabs.length).toBe(4);
    expect(tabs.map((t) => t.label).sort()).toEqual(["c1", "c2", "c3", "cockpit"]);

    await surface.close();
    const ws = await workspaceByLabel(label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("a NodeFailed promotes an unpaned (capped) node past the cap into its own tab", async () => {
    // Attention promotion: a node the cap had denied a pane gets one the moment it
    // FAILS, so its lingering tail shows the failure — cap-exempt.
    const runId = makeRunId();
    const label = `smithers-test-promote-${randomSessionName()}`;
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      overviewCommand: STUB_OVERVIEW,
      softPinSlots: 20,
      tabCap: 3, // overview + 2 node tabs
    });
    // Fill the budget with p1, p2; p3 is over the cap and stays unpaned.
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "p1" }));
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "p2" }));
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "p3" }));
    expect(
      await waitFor(
        async () =>
          Boolean(await agentByName(`smithers:${runId}:p1`)) && Boolean(await agentByName(`smithers:${runId}:p2`)),
      ),
    ).toBe(true);
    await sleep(500);
    expect(await agentByName(`smithers:${runId}:p3`)).toBeUndefined();

    // p3 fails -> promoted past the cap; its pane materializes, blocked.
    surface.onEvent(ev("NodeFailed", runId, { nodeId: "p3", error: "kaboom" }));
    expect(await waitFor(async () => (await statusOf(`smithers:${runId}:p3`)) === "blocked")).toBe(true);
    const tabs = await tabsOfWorkspace(label);
    expect(tabs.map((t) => t.label).sort()).toEqual(["cockpit", "p1", "p2", "p3"]);

    await surface.close();
    const ws = await workspaceByLabel(label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("an approval gate bypasses the cap and gets its own tab, blocked with its question", async () => {
    // A parked human gate is cap-exempt: even with the node budget full and an
    // agent-only nodeFilter that would drop the attempt-less gate node, the gate
    // must surface in its own tab.
    const runId = makeRunId();
    const label = `smithers-test-gatecap-${randomSessionName()}`;
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      overviewCommand: STUB_OVERVIEW,
      softPinSlots: 20,
      tabCap: 3, // overview + 2 node tabs
      // Reject gate nodes exactly as the agent-only filter does.
      nodeFilter: ({ nodeId }) => nodeId !== "ship-gate",
    });
    // Fill the node budget with two agent nodes.
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "g1" }));
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "g2" }));
    expect(
      await waitFor(
        async () =>
          Boolean(await agentByName(`smithers:${runId}:g1`)) && Boolean(await agentByName(`smithers:${runId}:g2`)),
      ),
    ).toBe(true);

    // The gate arrives past the cap AND rejected by the filter — it must still appear.
    surface.onEvent(ev("NodeWaitingApproval", runId, { nodeId: "ship-gate", request: { title: "Ship it?" } }));
    expect(await waitFor(async () => (await statusOf(`smithers:${runId}:ship-gate`)) === "blocked")).toBe(true);
    expect(
      await waitFor(async () => (await agentByName(`smithers:${runId}:ship-gate`))?.custom_status === "Ship it?"),
    ).toBe(true);
    const tabs = await tabsOfWorkspace(label);
    expect(tabs.map((t) => t.label).sort()).toEqual(["cockpit", "g1", "g2", "gate:ship-gate"]);

    await surface.close();
    const ws = await workspaceByLabel(label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("loop iterations REUSE the node's tab (no new tab per iteration)", async () => {
    // A loop re-enters the SAME nodeId across iterations; each re-entry must reuse
    // the node's tab/pane rather than spawn a new tab per iteration.
    const runId = makeRunId();
    const label = `smithers-test-loop-${randomSessionName()}`;
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      overviewCommand: STUB_OVERVIEW,
      softPinSlots: 20,
    });
    const name = `smithers:${runId}:loop-body`;
    for (let iteration = 0; iteration < 3; iteration++) {
      surface.onEvent(ev("NodeStarted", runId, { nodeId: "loop-body", iteration }));
      surface.onEvent(ev("NodeFinished", runId, { nodeId: "loop-body", iteration }));
    }
    expect(await waitFor(async () => Boolean(await agentByName(name)))).toBe(true);
    await sleep(500);
    // Exactly one "loop-body" tab and one agent, no matter how many iterations.
    const tabs = await tabsOfWorkspace(label);
    expect(tabs.filter((t) => t.label === "loop-body").length).toBe(1);
    expect((await listAgents()).filter((a) => a && a.name === name).length).toBe(1);

    await surface.close();
    const ws = await workspaceByLabel(label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("replay into a fresh surface reuses the node's tab (no duplicate tab)", async () => {
    // The pane-level no-duplicate is covered elsewhere; here assert the TAB is
    // reused (find-or-create by label) so replay never grows a second "n1" tab.
    const runId = makeRunId();
    const label = `smithers-test-tabreplay-${randomSessionName()}`;
    const name = `smithers:${runId}:n1`;

    const s1 = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      overviewCommand: STUB_OVERVIEW,
      softPinSlots: 20,
    });
    s1.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => Boolean(await agentByName(name)))).toBe(true);
    await s1.close();

    const s2 = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      overviewCommand: STUB_OVERVIEW,
      softPinSlots: 20,
    });
    s2.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    s2.onEvent(ev("NodeFinished", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => (await statusOf(name)) === "done")).toBe(true);
    await s2.close();

    const tabs = await tabsOfWorkspace(label);
    expect(tabs.filter((t) => t.label === "n1").length).toBe(1);
    expect(tabs.filter((t) => t.label === "cockpit").length).toBe(1);
    expect((await listAgents()).filter((a) => a && a.name === name).length).toBe(1);

    const ws = await workspaceByLabel(label);
    if (ws) {
      await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
    }
  });

  test("soft-pin K=1 default: only one concurrent stage tab; workers stay unpaned", async () => {
    const runId = makeRunId();
    const label = `smithers-test-softpin-${randomSessionName()}`;
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      overviewCommand: STUB_OVERVIEW,
      // default softPinSlots = 1; no override
    });
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "implement" }));
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "validate" }));
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "worker-07" }));
    expect(await waitFor(async () => Boolean(await agentByName(`smithers:${runId}:implement`)))).toBe(true);
    await sleep(400);
    expect(await agentByName(`smithers:${runId}:validate`)).toBeUndefined();
    expect(await agentByName(`smithers:${runId}:worker-07`)).toBeUndefined();
    // Release soft-pin; next stage can open
    surface.onEvent(ev("NodeFinished", runId, { nodeId: "implement" }));
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "validate" }));
    expect(await waitFor(async () => Boolean(await agentByName(`smithers:${runId}:validate`)))).toBe(true);
    // Failure promotes worker past calm policy
    surface.onEvent(ev("NodeFailed", runId, { nodeId: "worker-07", error: "boom" }));
    expect(await waitFor(async () => (await statusOf(`smithers:${runId}:worker-07`)) === "blocked")).toBe(true);
    await surface.close();
    const ws = await workspaceByLabel(label);
    if (ws) await client.call("workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
  });

  test("a node pane is NOT focused (focus:false) while a hijack pane IS (focus:true)", async () => {
    // Focus is never stolen for a mirrored node (its tab stays a background tab),
    // but a hijack pane deliberately grabs focus so the operator's screen jumps to
    // the interactive session — in its OWN full-size tab.
    const runId = makeRunId();
    const label = `smithers-test-focus-${randomSessionName()}`;
    const surface = createHerdrRunSurface({
      client,
      workspaceLabel: label,
      logger: () => {},
      tailCommand: STUB_TAIL,
      overviewCommand: STUB_OVERVIEW,
      softPinSlots: 20,
    });
    surface.onEvent(ev("NodeStarted", runId, { nodeId: "n1" }));
    expect(await waitFor(async () => Boolean(await agentByName(`smithers:${runId}:n1`)))).toBe(true);
    await sleep(300);

    // The node's tab did not steal focus.
    const nodeTab = (await tabsOfWorkspace(label)).find((t) => t.label === "n1");
    expect(nodeTab).toBeDefined();
    expect(nodeTab.focused).toBe(false);

    const ws = await workspaceByLabel(label);
    const res = await launchHijackPane(
      client,
      { command: "bash", args: ["-c", "sleep 30"], cwd: process.cwd(), env: {} },
      { runId, nodeId: "n1", workspaceId: ws.workspace_id, focus: true },
    );
    expect(res).toBeDefined();
    // The hijack lands in its OWN full-size tab (distinct label), focused.
    const hijackName = `smithers:${runId}:hijack:n1`;
    expect(await waitFor(async () => (await statusOf(hijackName)) === "blocked")).toBe(true);
    const hijackTab = await waitFor(async () => {
      const t = (await tabsOfWorkspace(label)).find((x) => x.label === "hijack n1");
      return t && t.focused === true;
    });
    expect(hijackTab).toBe(true);
    const finalTabs = await tabsOfWorkspace(label);
    const hj = finalTabs.find((t) => t.label === "hijack n1");
    expect(hj.pane_count).toBe(1);
    // The node tab is still there and still unfocused.
    expect(finalTabs.find((t) => t.label === "n1").focused).toBe(false);

    await surface.close();
    const ws2 = await workspaceByLabel(label);
    if (ws2) {
      await client.call("workspace.close", { workspace_id: ws2.workspace_id }).catch(() => {});
    }
  });
});

describe("createHerdrRunSurface degradability (no server needed)", () => {
  test("absorbs a full event stream against a dead socket with zero throws / unhandled rejections", async () => {
    /** @type {unknown[]} */
    const rejections = [];
    const onRejection = (/** @type {unknown} */ reason) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const client = createHerdrClient({
        socketPath: "/smithers-herdr-nonexistent-dir-xyz/deeper/herdr.sock",
        callTimeoutMs: 500,
        logger: () => {},
      });
      const surface = createHerdrRunSurface({ client, logger: () => {} });
      const runId = makeRunId();
      const stream = [
        { type: "RunStarted", runId, timestampMs: Date.now() },
        { type: "NodeStarted", runId, nodeId: "n1", iteration: 0, attempt: 1, timestampMs: Date.now() },
        { type: "NodeWaitingApproval", runId, nodeId: "n1", iteration: 0, timestampMs: Date.now() },
        { type: "ApprovalGranted", runId, nodeId: "n1", iteration: 0, timestampMs: Date.now() },
        {
          type: "AgentEvent",
          runId,
          nodeId: "n1",
          iteration: 0,
          attempt: 1,
          engine: "claude-code",
          event: { type: "started", engine: "claude-code", title: "t", resume: "sess-123" },
          timestampMs: Date.now(),
        },
        { type: "NodeFinished", runId, nodeId: "n1", iteration: 0, attempt: 1, timestampMs: Date.now() },
        { type: "NodeStarted", runId, nodeId: "n2", iteration: 0, attempt: 1, timestampMs: Date.now() },
        { type: "NodeFailed", runId, nodeId: "n2", iteration: 0, attempt: 1, error: "boom", timestampMs: Date.now() },
        { type: "RunFinished", runId, timestampMs: Date.now() },
      ];
      expect(() => {
        for (const e of stream) {
          surface.onEvent(e);
        }
      }).not.toThrow();

      await expect(surface.close()).resolves.toBeUndefined();
      // Let any stray microtasks / socket errors flush.
      await sleep(300);
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onRejection);
    }
  });

  test("launchHijackPane soft-fails to undefined against a dead socket", async () => {
    const client = createHerdrClient({
      socketPath: "/smithers-herdr-nonexistent-dir-xyz/deeper/herdr.sock",
      callTimeoutMs: 500,
      logger: () => {},
    });
    const res = await launchHijackPane(
      client,
      { command: "bash", args: ["-c", "sleep 1"], cwd: process.cwd(), env: {} },
      { runId: makeRunId(), nodeId: "n1" },
    );
    expect(res).toBeUndefined();
  });
});

describe.skipIf(!herdrInstalled)("createHerdrRunSurface survives a herdr server killed mid-stream", () => {
  test("absorbs the rest of the stream after the server dies; close() still resolves", async () => {
    /** @type {unknown[]} */
    const rejections = [];
    const onRejection = (/** @type {unknown} */ reason) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    // A dedicated throwaway server we can kill without disturbing the shared one.
    const server = await startHerdrServer();
    try {
      const client = createHerdrClient({ socketPath: server.socketPath, callTimeoutMs: 800, logger: () => {} });
      const runId = makeRunId();
      const label = `smithers-test-kill-${randomSessionName()}`;
      const surface = createHerdrRunSurface({
        client,
        workspaceLabel: label,
        logger: () => {},
        tailCommand: STUB_TAIL,
      });
      const name = `smithers:${runId}:n1`;

      surface.onEvent({ type: "RunStarted", runId, timestampMs: Date.now() });
      surface.onEvent({ type: "NodeStarted", runId, nodeId: "n1", iteration: 0, attempt: 1, timestampMs: Date.now() });

      // Pane materializes while the server is alive.
      const paneUp = await waitFor(async () => {
        const res = /** @type {any} */ (await client.call("agent.list", {}).catch(() => undefined));
        const agents = res && Array.isArray(res.agents) ? res.agents : [];
        return agents.some((/** @type {any} */ a) => a && a.name === name);
      });
      expect(paneUp).toBe(true);

      // Kill the server out from under the surface mid-stream.
      await server.stopServer();

      // The remaining events hit a dead socket: onEvent must not throw.
      expect(() => {
        surface.onEvent({ type: "NodeWaitingApproval", runId, nodeId: "n1", iteration: 0, timestampMs: Date.now() });
        surface.onEvent({
          type: "NodeFinished",
          runId,
          nodeId: "n1",
          iteration: 0,
          attempt: 1,
          timestampMs: Date.now(),
        });
        surface.onEvent({ type: "RunFinished", runId, timestampMs: Date.now() });
      }).not.toThrow();

      // close() drains the queue against the dead socket and resolves cleanly.
      await expect(surface.close()).resolves.toBeUndefined();
      await sleep(200);
      expect(rejections).toEqual([]);
    } finally {
      await server.dispose();
      process.removeListener("unhandledRejection", onRejection);
    }
  });
});
