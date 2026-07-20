// Unit coverage for the durable run-event target enumeration behind
// `useDelegationChain` (bug: fresh mounts lost non-current loop iterations —
// the devtools tree only reflects the current frame, so exec attempt history,
// unmounted dc-edit/dc-skip-preview listener rows, and budget actuals
// disappeared on reload/late-join). Synthetic events reproduce both the
// durable history spelling (`NodeFinished`, full engine payload) and the live
// wire spelling (`node.finished`).
import { describe, expect, test } from "bun:test";
import {
  delegationTargetKey,
  delegationTargetsFromEvents,
} from "../../src/delegation/delegationEventTargets.ts";

function ev(event: string, payload: unknown): { event: string; payload: unknown } {
  return { event, payload };
}

describe("delegationTargetsFromEvents", () => {
  test("reconstructs every (nodeId, iteration) pair from persisted history rows", () => {
    const targets = delegationTargetsFromEvents([
      ev("NodePending", { runId: "r", nodeId: "dc:root/ui/inspector:exec", iteration: 0 }),
      ev("NodeFinished", { runId: "r", nodeId: "dc:root/ui/inspector:exec", iteration: 0, attempt: 1 }),
      ev("NodeFinished", { runId: "r", nodeId: "dc:root/ui/inspector:exec", iteration: 1, attempt: 1 }),
      ev("NodeFinished", { runId: "r", nodeId: "dc:root/ui/inspector:exec", iteration: 2, attempt: 2 }),
      ev("NodeFinished", { runId: "r", nodeId: "dc:root/ui/inspector:review", iteration: 1, attempt: 1 }),
    ]);
    expect([...targets.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.iteration - b.iteration)).toEqual([
      { nodeId: "dc:root/ui/inspector:exec", iteration: 0 },
      { nodeId: "dc:root/ui/inspector:exec", iteration: 1 },
      { nodeId: "dc:root/ui/inspector:exec", iteration: 2 },
      { nodeId: "dc:root/ui/inspector:review", iteration: 1 },
    ]);
  });

  test("accepts wire-spelled live frames and dedupes against history rows", () => {
    const targets = delegationTargetsFromEvents([
      ev("NodeFinished", { runId: "r", nodeId: "dc:root:core:exec", iteration: 1, attempt: 1 }),
      ev("node.finished", { runId: "r", nodeId: "dc:root:core:exec", iteration: 1, state: "finished" }),
      ev("node.failed", { runId: "r", nodeId: "dc:root:core:exec", iteration: 2, state: "failed" }),
    ]);
    expect(targets.size).toBe(2);
    expect(targets.get(delegationTargetKey("dc:root:core:exec", 1))).toEqual({ nodeId: "dc:root:core:exec", iteration: 1 });
    expect(targets.get(delegationTargetKey("dc:root:core:exec", 2))).toEqual({ nodeId: "dc:root:core:exec", iteration: 2 });
  });

  test("recovers unmounted listener deliveries (dc-edit / dc-skip-preview / dc-poll)", () => {
    const targets = delegationTargetsFromEvents([
      ev("NodeFinished", { runId: "r", nodeId: "dc-edit", iteration: 0 }),
      ev("NodeFinished", { runId: "r", nodeId: "dc-edit", iteration: 1 }),
      ev("NodeFinished", { runId: "r", nodeId: "dc-skip-preview", iteration: 0 }),
      ev("NodeFinished", { runId: "r", nodeId: "dc-poll", iteration: 0 }),
    ]);
    expect(targets.size).toBe(4);
    expect(targets.get(delegationTargetKey("dc-edit", 1))).toEqual({ nodeId: "dc-edit", iteration: 1 });
  });

  test("excludes non-delegation nodes and approval-only phases (no output row to fetch)", () => {
    const targets = delegationTargetsFromEvents([
      ev("NodeFinished", { runId: "r", nodeId: "build", iteration: 0 }),
      ev("NodeFinished", { runId: "r", nodeId: "some-other-workflow-node", iteration: 0 }),
      ev("NodeFinished", { runId: "r", nodeId: "dc:goal:approve", iteration: 0 }),
      ev("NodeFinished", { runId: "r", nodeId: "dc:root:core:x:approval-2", iteration: 0 }),
      ev("NodeFinished", { runId: "r", nodeId: "dc:goal:goal", iteration: 0 }),
    ]);
    expect([...targets.values()]).toEqual([{ nodeId: "dc:goal:goal", iteration: 0 }]);
  });

  test("ignores non-lifecycle events and malformed payloads; defaults missing iteration to 0", () => {
    const targets = delegationTargetsFromEvents([
      ev("run.heartbeat", { runId: "r", nodeId: "dc:root:plan", iteration: 3 }),
      ev("ToolCallStarted", { runId: "r", nodeId: "dc:root:plan", iteration: 3 }),
      ev("NodeFinished", "not-an-object"),
      ev("NodeFinished", { runId: "r" }),
      ev("NodeFinished", { runId: "r", nodeId: "dc:root:plan" }),
      ev("NodeFinished", { runId: "r", nodeId: "dc:root:gates", iteration: -1 }),
      ev("NodeFinished", { runId: "r", nodeId: "dc:root:exec", iteration: 1.5 }),
    ]);
    expect([...targets.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId))).toEqual([
      { nodeId: "dc:root:exec", iteration: 0 },
      { nodeId: "dc:root:gates", iteration: 0 },
      { nodeId: "dc:root:plan", iteration: 0 },
    ]);
  });
});
