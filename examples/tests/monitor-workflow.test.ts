import { expect, test } from "bun:test";
import { renderMdx } from "smithers-orchestrator";
import MonitorPrompt from "../../packages/components/src/components/MonitorPrompt.mdx";
import { coverExample } from "./_setup.ts";

// The `.mdx` prompt shipped next to <Monitor> renders every section from
// `monitorPrompt.js` — the same source the component's default prompt uses — so
// a monitor file can import it, pass props, and extend it with JSX.
test("the shipped MonitorPrompt.mdx renders the monitoring doctrine", () => {
  const text = renderMdx(MonitorPrompt, { watchRunId: "run-42", autoHeal: ["stalled"] });

  expect(text).toContain("# Monitor one Smithers run");
  expect(text).toContain("run-42");
  // Read path: gateway-client / CLI only, never the store.
  expect(text).toContain("smithers-orchestrator/gateway-client");
  expect(text).toContain("NEVER open the store directly");
  // Healthy vs unhealthy, evidence, authority, escalation.
  expect(text).toContain("HEALTHY looks like");
  expect(text).toContain("Never act on a single sample");
  expect(text).toContain("OBSERVE AND REPORT");
  expect(text).toContain("ESCALATE to a human instead of guessing");
  // Authority narrows to what was actually granted.
  expect(text).toContain("ONLY on these conditions: stalled");
});

test("MonitorPrompt.mdx appends repo-specific guidance when given", () => {
  const text = renderMdx(MonitorPrompt, { watchRunId: "run-42", guidance: "Long agent tasks are normal here." });
  expect(text).toContain("Repo-specific guidance");
  expect(text).toContain("Long agent tasks are normal here.");
});

// Two beats: the first classifies the watched run as stalled (an auto-heal
// condition, so the monitor resumes it), the second sees it running again and
// terminal, which ends the heartbeat loop.
test("covers monitor-workflow: a stalled beat heals, a terminal beat stops the loop", async () => {
  let beat = 0;
  const result = await coverExample("../monitor-workflow.jsx", {
    input: { watchRunId: "run-under-watch" },
    maxLoopIterations: 2,
    mocks: {
      "monitor-check": () => {
        const stalled = beat++ === 0;
        return stalled
          ? {
              condition: "stalled",
              runStatus: "running",
              targetNodeId: "implement",
              evidence: "no event for 4m10s across two beats; no pending approval",
              summary: "silent for four minutes",
            }
          : {
              condition: "healthy",
              runStatus: "finished",
              targetNodeId: null,
              evidence: "run finished at 12:04:11",
              summary: "done",
            };
      },
      "monitor-stalled": { action: "resume", changed: true, summary: "resumed run-under-watch" },
    },
    expectedNodes: ["monitor-check", "monitor-stalled", "monitor-beat"],
  });

  // Beat 1 samples immediately (no `monitor-beat` timer) and routes to the
  // stalled handler; the durable timer then paces beat 2, which classifies
  // healthy/terminal, routes nowhere, and exits the loop.
  expect(result.executed).toEqual(["monitor-check", "monitor-stalled", "monitor-beat", "monitor-check"]);
  expect(result.taskOutputs["monitor-stalled"][0]).toMatchObject({ action: "resume", changed: true });
});

// `healthy` has no rule in the decision table, so a healthy run routes to
// nothing at all: the monitor observes and keeps watching.
test("covers monitor-workflow: a healthy run triggers no handler", async () => {
  const result = await coverExample("../monitor-workflow.jsx", {
    input: { watchRunId: "run-under-watch" },
    maxLoopIterations: 1,
    mocks: {
      "monitor-check": {
        condition: "healthy",
        runStatus: "finished",
        targetNodeId: null,
        evidence: "12 nodes finished, newest event 3s ago",
        summary: "progressing",
      },
    },
    expectedNodes: ["monitor-check"],
    allowUnreached: ["monitor-stalled"],
  });

  expect(result.executed).toEqual(["monitor-check"]);
});

// `runaway-loop` is not in this monitor's `autoHeal` set, and cancelling is
// destructive, so it must reach a human rather than being repaired silently.
test("covers monitor-workflow: a condition outside autoHeal escalates to a human", async () => {
  const result = await coverExample("../monitor-workflow.jsx", {
    input: { watchRunId: "run-under-watch" },
    maxLoopIterations: 1,
    mocks: {
      "monitor-check": {
        condition: "runaway-loop",
        runStatus: "running",
        targetNodeId: "implement:loop",
        evidence: "iteration 41 of implement:loop, exit condition unchanged since iteration 12",
        summary: "looping without converging",
      },
    },
    approvals: { "monitor-escalate-runaway-loop": { approved: true, note: "cancel it" } },
    expectedNodes: ["monitor-check", "monitor-escalate-runaway-loop"],
    allowUnreached: ["monitor-stalled"],
  });

  expect(result.executed).toEqual(["monitor-check", "monitor-escalate-runaway-loop"]);
});
