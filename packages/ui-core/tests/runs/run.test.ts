import { describe, expect, test } from "bun:test";
import { findNode, runSteps, type NodeStatus, type Run, type RunNode } from "../../src/runs/Run.ts";
import { statusLabel, statusTone } from "../../src/runs/statusMeta.ts";

/**
 * Pure domain tests for the run tree + status palette, adapted from multi's
 * `src/runs/runDomain.test.ts` with an inline fixture (multi's
 * `runTestFixture.ts` is shared across many multi-only tests outside phase 2's
 * scope, so this test builds its own small nested tree instead of porting it).
 */

const NESTED_ROOT: RunNode = {
  id: "workflow",
  name: "workflow",
  kind: "merge",
  status: "running",
  children: [
    { id: "plan", name: "plan", kind: "agent", status: "ok" },
    {
      id: "edit-files",
      name: "edit-files",
      kind: "merge",
      status: "running",
      children: [
        { id: "edit-session", name: "auth/session.ts", kind: "agent", status: "ok" },
        { id: "edit-token", name: "auth/token.ts", kind: "agent", status: "running" },
      ],
    },
    { id: "run-tests", name: "run-tests", kind: "compute", status: "queued" },
  ],
};

function runFrom(root: RunNode): Run {
  return {
    id: "r1",
    title: "Implement · auth refactor",
    model: "claude-opus-4-8",
    runId: "4821",
    status: root.status,
    startedAtMs: 0,
    frame: 0,
    frameCount: 1,
    root,
  };
}

describe("findNode", () => {
  test("returns the node when the id matches the root", () => {
    expect(findNode(NESTED_ROOT, "workflow")).toBe(NESTED_ROOT);
  });

  test("finds a node nested under a child", () => {
    const hit = findNode(NESTED_ROOT, "edit-session");
    expect(hit?.id).toBe("edit-session");
    expect(hit?.name).toBe("auth/session.ts");
  });

  test("returns undefined for an id that is not in the tree", () => {
    expect(findNode(NESTED_ROOT, "does-not-exist")).toBeUndefined();
  });

  test("returns undefined on a leaf with no children", () => {
    const leaf: RunNode = { id: "leaf", name: "leaf", kind: "compute", status: "ok" };
    expect(findNode(leaf, "other")).toBeUndefined();
    expect(findNode(leaf, "leaf")).toBe(leaf);
  });
});

describe("runSteps", () => {
  test("returns the root's top-level children as the step list", () => {
    const steps = runSteps(runFrom(NESTED_ROOT));
    expect(steps).toBe(NESTED_ROOT.children!);
    expect(steps.map((s) => s.id)).toEqual(["plan", "edit-files", "run-tests"]);
  });

  test("returns an empty array when the root has no children", () => {
    const root: RunNode = { id: "workflow", name: "workflow", kind: "merge", status: "ok" };
    expect(runSteps(runFrom(root))).toEqual([]);
  });
});

describe("statusMeta (Run.ts <-> statusMeta.ts share one NodeStatus)", () => {
  const ALL_STATUSES: NodeStatus[] = ["ok", "running", "queued", "failed", "waiting", "cancelled", "unknown"];
  const TONES = new Set(["running", "ok", "waiting", "failed", "idle"]);

  test("every NodeStatus resolves to a defined tone and label", () => {
    for (const status of ALL_STATUSES) {
      const tone = statusTone(status);
      const label = statusLabel(status);
      expect(TONES.has(tone)).toBe(true);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test("queued maps to the idle tone (color is state, not decoration)", () => {
    expect(statusTone("queued")).toBe("idle");
    expect(statusLabel("queued")).toBe("queued");
  });

  test("failed and waiting keep their own tone", () => {
    expect(statusTone("failed")).toBe("failed");
    expect(statusTone("waiting")).toBe("waiting");
  });
});
