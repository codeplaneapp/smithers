/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";
import { Monitor, Task, monitorPrompt } from "../src/components/index.js";

const agent = { id: "watcher", generate: async () => ({}) };

/**
 * One heartbeat sample of a fake watched run, shaped like the `healthOutput`
 * row `<Monitor>` reads: the classifier's verdict plus its evidence.
 */
function sample({ condition, runStatus = "running", iteration = 0 } = {}) {
  return {
    health: [
      {
        runId: "monitor-unit",
        nodeId: "monitor-check",
        iteration,
        condition,
        runStatus,
        targetNodeId: "implement",
        evidence: "no event for 4m",
        summary: condition,
      },
    ],
  };
}

async function render(element, { outputs = {}, iterations } = {}) {
  const ctx = new SmithersCtx({
    runId: "monitor-unit",
    iteration: 0,
    iterations,
    input: {},
    outputs,
  });
  const graph = await new SmithersRenderer().render(
    <SmithersContext.Provider value={ctx}>{element}</SmithersContext.Provider>,
  );
  return { graph, ctx, ids: graph.tasks.map((task) => task.nodeId) };
}

const monitor = (props = {}) => (
  <Monitor watchRunId="run-under-watch" agent={agent} healthOutput="health" actionOutput="action" {...props} />
);

describe("<Monitor> classify → route → heal", () => {
  test("the first beat samples immediately and routes nowhere until a verdict exists", async () => {
    const { ids } = await render(monitor());
    expect(ids).toContain("monitor-check");
    // No classification yet, so no handler is selected, and beat 0 skips the
    // pacing timer so the monitor does not sleep before its first look.
    expect(ids.filter((id) => id !== "monitor-check")).toEqual([]);
  });

  test("a healthy verdict routes to nothing: observe and keep watching", async () => {
    const { ids } = await render(monitor(), { outputs: sample({ condition: "healthy" }) });
    expect(ids).toEqual(["monitor-check"]);
  });

  test("stalled heals by default, because resuming a run is idempotent", async () => {
    const { ids } = await render(monitor(), { outputs: sample({ condition: "stalled" }) });
    expect(ids).toContain("monitor-stalled");
    expect(ids).not.toContain("monitor-escalate-stalled");
  });

  test("wedged-node heals by default, because retrying a node discards nothing", async () => {
    const { ids } = await render(monitor(), { outputs: sample({ condition: "wedged-node" }) });
    expect(ids).toContain("monitor-wedged-node");
  });

  test("a condition outside autoHeal escalates to a human instead of guessing", async () => {
    const { ids } = await render(monitor({ autoHeal: [] }), { outputs: sample({ condition: "stalled" }) });
    expect(ids).toContain("monitor-escalate-stalled");
    expect(ids).not.toContain("monitor-stalled");
  });

  test("runaway-loop escalates by default; cancelling only happens on explicit opt-in", async () => {
    const outputs = sample({ condition: "runaway-loop" });
    const escalating = await render(monitor(), { outputs });
    expect(escalating.ids).toContain("monitor-escalate-runaway-loop");
    expect(escalating.ids).not.toContain("monitor-runaway-loop");

    const cancelling = await render(monitor({ autoHeal: ["runaway-loop"] }), { outputs });
    expect(cancelling.ids).toContain("monitor-runaway-loop");
    expect(cancelling.ids).not.toContain("monitor-escalate-runaway-loop");
  });

  test("unknown always escalates — an unreadable run is never repaired on a guess", async () => {
    const { ids } = await render(monitor({ autoHeal: ["stalled", "wedged-node", "unknown"] }), {
      outputs: sample({ condition: "unknown" }),
    });
    expect(ids).toContain("monitor-escalate-unknown");
  });

  test("awaiting-human reports without resolving the gate itself", async () => {
    const { graph, ids } = await render(monitor(), { outputs: sample({ condition: "awaiting-human" }) });
    expect(ids).toContain("monitor-awaiting-human");
    const handler = graph.tasks.find((task) => task.nodeId === "monitor-awaiting-human");
    expect(String(handler.prompt)).toContain("Do NOT resolve the approval");
  });

  test("handlers override a condition, and null makes it a no-op", async () => {
    const outputs = sample({ condition: "failing" });
    const overridden = await render(
      monitor({ handlers: { failing: <Task id="page-oncall" output="action" agent={agent} children="page" /> } }),
      { outputs },
    );
    expect(overridden.ids).toContain("page-oncall");
    expect(overridden.ids).not.toContain("monitor-failing");

    const silenced = await render(monitor({ handlers: { failing: null } }), { outputs });
    expect(silenced.ids).toEqual(["monitor-check"]);
  });

  test("the pacing timer is skipped on beat 0 and enforced on later beats", async () => {
    const first = await render(monitor({ intervalMs: 30_000 }));
    expect(first.ids).not.toContain("monitor-beat");

    const later = await render(monitor({ intervalMs: 30_000 }), {
      outputs: sample({ condition: "healthy", iteration: 1 }),
      iterations: { "monitor-loop": 1 },
    });
    const beat = later.graph.tasks.find((task) => task.nodeId === "monitor-beat");
    expect(beat, "later beats must be paced by a durable timer").toBeDefined();
  });

  test("skipIf renders nothing at all", async () => {
    const { graph } = await render(monitor({ skipIf: true }));
    expect(graph.tasks).toHaveLength(0);
  });
});

describe("the shipped monitoring prompt", () => {
  const prompt = monitorPrompt({ watchRunId: "run-under-watch" });

  test("binds the monitor to the Gateway client / CLI and forbids the store", () => {
    expect(prompt).toContain("smithers-orchestrator/gateway-client");
    expect(prompt).toContain("NEVER open the store directly");
    expect(prompt).toContain("smithers.db");
  });

  test("states healthy vs unhealthy, and demands evidence before acting", () => {
    expect(prompt).toContain("HEALTHY looks like");
    expect(prompt).toContain("STALLED looks like");
    expect(prompt).toContain("Never act on a single sample");
  });

  test("biases toward observing and names what it may never do alone", () => {
    expect(prompt).toContain("OBSERVE AND REPORT");
    expect(prompt).toContain("You may NEVER take a destructive or irreversible action");
    expect(prompt).toContain("ESCALATE to a human instead of guessing");
  });

  test("narrows the allowed actions to the ones actually granted", () => {
    expect(monitorPrompt({ autoHeal: [] })).toContain("(nothing — report only)");
    expect(monitorPrompt({ autoHeal: ["stalled"] })).toContain("ONLY on these conditions: stalled");
  });
});
