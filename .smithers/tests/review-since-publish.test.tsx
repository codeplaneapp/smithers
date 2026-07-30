/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { renderWorkflow } from "smithers-orchestrator/testing";

setDefaultTimeout(60_000);

type Task = { nodeId: string; prompt?: unknown; [key: string]: unknown };
type Frame = { tasks: readonly Task[] };

const path = join(import.meta.dir, "..", "workflows", "review-since-publish.tsx");
const load = async () => (await import(path)).default;
const render = async (input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  (await renderWorkflow(await load(), { workflowPath: path, input, outputs })) as Frame;
const ids = (frame: Frame) => frame.tasks.map((t) => t.nodeId);

const baselineRow = {
  packageName: "smithers-orchestrator",
  publishedVersion: "0.31.0",
  tag: "v0.31.0",
  tagCommit: "abc123",
  head: "def456",
  commitCount: 12,
  diffStat: "10 files changed",
  changedFiles: ["packages/engine/src/a.ts"],
  untrackedFiles: [],
  commits: ["abc pretend commit"],
  notes: [],
  briefing: "BRIEFING BODY",
};

const issue = (over: Record<string, unknown> = {}) => ({
  id: "R1-001",
  title: "boom",
  severity: "high",
  file: "packages/engine/src/a.ts",
  line: 10,
  detail: "it throws",
  suggestedFix: "guard it",
  files: ["packages/engine/src/a.ts"],
  raisedBy: ["sol"],
  ...over,
});

describe("review-since-publish workflow", () => {
  test("starts with the baseline compute task", async () => {
    const frame = await render();
    expect(ids(frame)).toContain("baseline");
  });

  test("fans the panel out to all three seats with the baseline briefing", async () => {
    const frame = await render({}, { baseline: [baselineRow] });
    for (const seat of ["review:sol", "review:opus", "review:fable"]) {
      const found = frame.tasks.find((t) => t.nodeId === seat);
      expect(found, `missing ${seat}`).toBeDefined();
      expect(String(found!.prompt)).toContain("BRIEFING BODY");
    }
    expect(ids(frame)).toContain("merge");
  });

  test("reviewShards gives every panelist one task per disjoint file slice", async () => {
    const frame = await render(
      { reviewShards: 3 },
      { baseline: [{ ...baselineRow, changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"] }] },
    );
    const reviewIds = ids(frame).filter((id) => id.startsWith("review:"));
    expect(reviewIds.length).toBe(9);
    const slice = (id: string) =>
      String(frame.tasks.find((t) => t.nodeId === id)!.prompt)
        .split("other reviewers cover the rest:")[1]!
        .split("```")[1]!
        .trim()
        .split("\n");
    expect(slice("review:sol:0")).toEqual(["a.ts", "d.ts"]);
    expect(slice("review:sol:1")).toEqual(["b.ts"]);
    expect(slice("review:sol:2")).toEqual(["c.ts"]);
  });

  test("reviewShards include untracked files exactly once per panelist", async () => {
    const frame = await render(
      { reviewShards: 2 },
      {
        baseline: [
          {
            ...baselineRow,
            changedFiles: ["changed.ts", "shared.ts"],
            untrackedFiles: ["new.ts", "shared.ts"],
          },
        ],
      },
    );
    const solPrompts = frame.tasks
      .filter((task) => task.nodeId.startsWith("review:sol:"))
      .map((task) => String(task.prompt));
    expect(solPrompts.filter((prompt) => prompt.includes("new.ts"))).toHaveLength(1);
    expect(solPrompts.filter((prompt) => prompt.includes("shared.ts"))).toHaveLength(1);
  });

  test("dropping a seat removes its review tasks entirely", async () => {
    const frame = await render({ seats: ["sol", "fable"], reviewShards: 2 }, { baseline: [baselineRow] });
    const reviewIds = ids(frame).filter((id) => id.startsWith("review:"));
    expect(reviewIds.filter((id) => id.startsWith("review:opus"))).toEqual([]);
    expect(reviewIds.length).toBe(4);
  });

  test("SMITHERS_PANEL_SEATS overrides the immutable run input", async () => {
    const prior = process.env.SMITHERS_PANEL_SEATS;
    process.env.SMITHERS_PANEL_SEATS = "sol,fable";
    try {
      const frame = await render({ seats: ["sol", "opus", "fable"] }, { baseline: [baselineRow] });
      expect(ids(frame).filter((id) => id.startsWith("review:opus"))).toEqual([]);
      expect(ids(frame).filter((id) => id.startsWith("review:"))).toHaveLength(2);
    } finally {
      if (prior === undefined) delete process.env.SMITHERS_PANEL_SEATS;
      else process.env.SMITHERS_PANEL_SEATS = prior;
    }
  });

  test("merged issues become file-disjoint parallel fix lanes", async () => {
    const frame = await render(
      { maxFixLanes: 4 },
      {
        baseline: [baselineRow],
        merged: [
          {
            summary: "two issues",
            clean: false,
            dismissed: [],
            issues: [issue(), issue({ id: "R1-002", file: "packages/cli/b.ts", files: ["packages/cli/b.ts"] })],
          },
        ],
      },
    );
    const lanes = ids(frame).filter((id) => id.startsWith("fix:"));
    expect(lanes.length).toBe(2);
    // No file may appear in two concurrently-running lanes.
    const boundaryFiles = (prompt: string) =>
      new Set(
        prompt
          .split("you may only edit these files")[1]!
          .split("\n\n")[0]!
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => l.slice(2).trim()),
      );
    const [one, two] = lanes.map((id) => boundaryFiles(String(frame.tasks.find((t) => t.nodeId === id)!.prompt)));
    expect(one!.size).toBeGreaterThan(0);
    expect(two!.size).toBeGreaterThan(0);
    expect([...one!].filter((f) => two!.has(f))).toEqual([]);
    for (const id of lanes) {
      const prompt = String(frame.tasks.find((task) => task.nodeId === id)!.prompt);
      expect(prompt).toContain("Test files are not an exception");
      expect(prompt).not.toContain("plus tests that cover them");
    }
  });

  test("issues sharing a file collapse into one lane", async () => {
    const frame = await render(
      { maxFixLanes: 4 },
      {
        baseline: [baselineRow],
        merged: [
          {
            summary: "overlapping",
            clean: false,
            dismissed: [],
            issues: [
              issue({ id: "R1-001", files: ["a.ts", "b.ts"] }),
              issue({ id: "R1-002", files: ["b.ts", "c.ts"] }),
            ],
          },
        ],
      },
    );
    expect(ids(frame).filter((id) => id.startsWith("fix:")).length).toBe(1);
  });

  test("low-severity-only findings raise no fix lanes and end the loop", async () => {
    const frame = await render(
      {},
      {
        baseline: [baselineRow],
        merged: [
          {
            summary: "nits only",
            clean: false,
            dismissed: [],
            issues: [issue({ severity: "low" })],
          },
        ],
      },
    );
    expect(ids(frame).filter((id) => id.startsWith("fix:"))).toEqual([]);
  });

  test("a clean merge schedules no fixers", async () => {
    const frame = await render(
      {},
      { baseline: [baselineRow], merged: [{ summary: "clean", clean: true, issues: [], dismissed: [] }] },
    );
    expect(ids(frame).filter((id) => id.startsWith("fix:"))).toEqual([]);
  });
});
