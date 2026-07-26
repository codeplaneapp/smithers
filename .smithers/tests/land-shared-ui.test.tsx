/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPrompt, renderWorkflow } from "smithers-orchestrator/testing";

setDefaultTimeout(45_000);

type Descriptor = {
  nodeId: string;
  prompt?: unknown;
  staticPayload?: unknown;
  [key: string]: unknown;
};
type Frame = { tasks: readonly Descriptor[] };
type Outputs = Record<string, unknown[]>;

const workflows = join(import.meta.dir, "..", "workflows");
const workflowPath = join(workflows, "land-shared-ui.tsx");
const load = async () => (await import(workflowPath)).default;
const render = async (input: unknown = {}, outputs: Outputs = {}) =>
  (await renderWorkflow(await load(), { input, outputs, workflowPath, runId: "Land Run" })) as unknown as Frame;
const baseId = (id: string) => id.split("@@", 1)[0] ?? id;
const optional = (frame: Frame, id: string) => frame.tasks.find((candidate) => baseId(candidate.nodeId) === id);
const task = (frame: Frame, id: string) => {
  const found = optional(frame, id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found!;
};
const row = (nodeId: string, iteration: number, value: Record<string, unknown>) => ({
  nodeId,
  iteration,
  iterationCount: iteration,
  ...value,
});

describe("land-shared-ui workflow", () => {
  test("discovers worktrees, serializes merges, and gates the report on green CI", async () => {
    const mod = await import(workflowPath);
    const root = mkdtempSync(join(tmpdir(), "land-shared-ui-"));
    try {
      for (const name of ["lane-b", "lane-a"]) mkdirSync(join(root, name));
      expect(mod.discoverWorktrees(root, [])).toEqual([join(root, "lane-a"), join(root, "lane-b")]);
      expect(mod.discoverWorktrees(root, [join(root, "lane-b"), join(root, "missing")])).toEqual([
        join(root, "lane-b"),
      ]);

      const initial = await render({ worktreesRoot: root });
      const mergePrompt = renderPrompt(task(initial, "merge-lane-a").prompt);
      expect(mergePrompt).toContain("git show --name-only");
      expect(mergePrompt).toContain("UNION");
      expect(mergePrompt).toContain("bun.lock");
      expect(mergePrompt).toContain("update-ref refs/heads/");
      expect(mergePrompt).toContain("merge-base --is-ancestor");
      expect(optional(initial, "land-ci")).toBeUndefined();
      expect(optional(initial, "land-report")).toBeUndefined();

      const merges = [
        row("merge-lane-a@@land-loop=0", 0, {
          worktree: "lane-a",
          merged: true,
          summary: "landed",
          conflicts: [],
          commandsRun: [],
        }),
        row("merge-lane-b@@land-loop=0", 0, {
          worktree: "lane-b",
          merged: true,
          summary: "landed",
          conflicts: [],
          commandsRun: [],
        }),
      ];
      const merged = await render({ worktreesRoot: root }, { merge: merges });
      expect(optional(merged, "merge-lane-a")).toBeUndefined();

      const redCi = row("land-ci@@land-loop=0", 0, {
        batchKey: "land:0",
        allPassed: false,
        summary: "red",
        commands: [],
      });
      const redFrame = await render({ worktreesRoot: root }, { merge: merges, ci: [redCi] });
      expect(optional(redFrame, "land-fix")).toBeDefined();
      expect(optional(redFrame, "land-report")).toBeUndefined();

      const greenCi = row("land-ci@@land-loop=0", 0, {
        batchKey: "land:0",
        allPassed: true,
        summary: "green",
        commands: [],
      });
      const greenFrame = await render({ worktreesRoot: root }, { merge: merges, ci: [greenCi] });
      expect(optional(greenFrame, "land-fix")).toBeUndefined();
      expect(optional(greenFrame, "land-report")).toBeDefined();
      expect(renderPrompt(task(greenFrame, "land-report").prompt)).toContain("adapters/*");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
