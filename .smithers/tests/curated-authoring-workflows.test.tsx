/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { renderPrompt, renderWorkflow, runTask, simulate } from "smithers-orchestrator/testing";
import type { RenderedWorkflow } from "smithers-orchestrator/testing";
import type { TaskDescriptor } from "smithers-orchestrator/graph";
import { approval, skillClarify, skillDesign, skillInput, workflowClarify, workflowDesign, workflowInput, workflowProvision } from "./curated-authoring-workflows.contracts";

const workflows = join(import.meta.dir, "..", "workflows");
const envNames = ["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_CONFIG_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "SMITHERS_BUNX", "SMITHERS_BUN"] as const;
const load = async (name: string, tag: string) => (await import(`${pathToFileURL(join(workflows, name)).href}?authoring=${tag}-${Date.now()}-${Math.random()}`)).default;
type Frame = RenderedWorkflow;
type Row = { nodeId: string; value: Record<string, unknown> };
const task = (frame: Frame, nodeId: string): TaskDescriptor => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === nodeId);
  if (!found) throw new Error(`missing mounted node ${nodeId}`);
  return found!;
};
const row = (nodeId: string, value: Record<string, unknown>): Row => ({ nodeId, value });
const renderRows = async (workflow: any, name: string, input: unknown, rows: Row[] = []) => {
  const parsedInput = workflow.inputSchema.parse(input);
  const outputs: Record<string, unknown[]> = {};
  for (const staged of rows) {
    const frame = await renderWorkflow(workflow, { workflowPath: join(workflows, name), input: parsedInput, outputs });
    const mounted = task(frame, staged.nodeId);
    expect(mounted.outputTableName).toBeDefined();
    const parsed = mounted.outputSchema?.safeParse({ ...staged.value, nodeId: staged.nodeId });
    expect(parsed?.success).toBe(true);
    outputs[mounted.outputTableName!] = [...(outputs[mounted.outputTableName!] ?? []), parsed!.data];
  }
  return renderWorkflow(workflow, { workflowPath: join(workflows, name), input: parsedInput, outputs }) as Promise<Frame>;
};
const output = async (frame: Frame, nodeId: string, expected: unknown) => expect(await runTask(task(frame, nodeId))).toEqual(expected);
const temp = (prefix: string) => mkdtemp(join(tmpdir(), `authoring-${prefix}-`));
const removeTemp = async (path: string) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
};
const isolated = async <T,>(prefix: string, workflowName: string, fn: (root: string, workflow: any) => Promise<T>) => {
  const root = await temp(prefix);
  const oldCwd = process.cwd();
  const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  try {
    process.chdir(root);
    const home = join(root, "home");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.LOCALAPPDATA = join(root, "local-appdata");
    process.env.APPDATA = join(root, "appdata");
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    process.env.CODEX_HOME = join(root, "codex");
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
    process.env.PI_CODING_AGENT_DIR = join(root, "pi");
    process.env.OPENCODE_CONFIG_DIR = join(root, "opencode");
    const workflow = await load(workflowName, prefix);
    return await fn(root, workflow);
  } finally {
    process.chdir(oldCwd);
    for (const name of envNames) {
      const value = savedEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await removeTemp(root);
  }
};

describe.serial("curated authoring workflows", () => {
  test("create-workflow input and approval gates are causal", async () => {
    await isolated("workflow-gates", "create-workflow.tsx", async (_root, workflow) => {
    expect(() => workflow.inputSchema.parse({ prompt: 4 })).toThrow();
    expect(() => workflow.inputSchema.parse({ name: "Report_Workflow" })).toThrow();
    const beforeDecision = await renderRows(workflow, "create-workflow.tsx", workflowInput, [
      row("clarify", workflowClarify), row("provision", workflowProvision), row("design", workflowDesign),
    ]);
    expect(beforeDecision.tasks.map((candidate) => candidate.nodeId)).toEqual(["clarify", "provision", "design", "approve-design", "output"]);
    expect(task(beforeDecision, "approve-design").approvalOnDeny).toBe("continue");
    expect(beforeDecision.tasks.some((candidate) => ["scaffold", "verify", "fix", "document"].includes(candidate.nodeId))).toBe(false);
    const denied = await renderRows(workflow, "create-workflow.tsx", workflowInput, [
      row("clarify", workflowClarify), row("provision", workflowProvision), row("design", workflowDesign), row("approve-design", approval(false)),
    ]);
    expect(denied.tasks.map((candidate) => candidate.nodeId)).toEqual(["clarify", "provision", "design", "approve-design", "output"]);
    await output(denied, "output", { workflow: "report-workflow", workflowFile: ".smithers/workflows/report-workflow.tsx", status: "denied", summary: "REPORT_DESIGN", filesWritten: [], fileCount: 0, verified: false, skillPath: null, uiFile: null, nextSteps: ["smithers inspect <runId>  # review why the run stopped at status \"denied\"", "smithers workflow run create-workflow --prompt \"retry building report-workflow\""] });
    const bypass = await renderRows(workflow, "create-workflow.tsx", { ...workflowInput, review: false }, [row("clarify", workflowClarify), row("provision", workflowProvision), row("design", workflowDesign)]);
    expect(bypass.tasks.some((candidate) => candidate.nodeId === "approve-design")).toBe(false);
    expect(bypass.tasks.map((candidate) => candidate.nodeId)).toEqual(["clarify", "provision", "design", "scaffold", "output"]);
    const approved = await renderRows(workflow, "create-workflow.tsx", workflowInput, [
      row("clarify", workflowClarify), row("provision", workflowProvision), row("design", workflowDesign), row("approve-design", approval(true)),
    ]);
    expect(approved.tasks.map((candidate) => candidate.nodeId)).toEqual(["clarify", "provision", "design", "approve-design", "scaffold", "output"]);
    });
  });

  test("create-workflow simulates scaffold, real verify/fix/document boundaries, and exact final bytes", async () => {
    await isolated("workflow-simulation", "create-workflow.tsx", async (root, workflow) => {
      const bin = join(root, "bin"); await mkdir(bin, { recursive: true });
      const graphSentinel = join(root, "graph-sentinel");
      const buildSentinel = join(root, "build-sentinel");
      const launcher = (name: string, posix: string, windows: string) => writeFile(join(bin, process.platform === "win32" ? `${name}.cmd` : name), process.platform === "win32" ? windows : posix);
      await launcher("bunx", `#!/bin/sh\nif [ ! -f ${JSON.stringify(graphSentinel)} ]; then echo GRAPH_SENTINEL >&2; echo GRAPH_SENTINEL > ${JSON.stringify(graphSentinel)}; exit 1; fi\necho graph-ok\n`, `@echo off\r\nif not exist "%~dp0..\\graph-sentinel" (echo GRAPH_SENTINEL 1>&2 & echo GRAPH_SENTINEL > "%~dp0..\\graph-sentinel" & exit /b 1)\r\necho graph-ok\r\n`);
      await launcher("bun", `#!/bin/sh\nif [ "$1" = "build" ]; then echo BUILD_SENTINEL; echo BUILD_SENTINEL > ${JSON.stringify(buildSentinel)}; exit 0; fi\nexit 1\n`, `@echo off\r\nif "%1"=="build" (echo BUILD_SENTINEL & echo BUILD_SENTINEL > "%~dp0..\\build-sentinel" & exit /b 0)\r\nexit /b 1\r\n`);
      if (process.platform !== "win32") { await chmod(join(bin, "bunx"), 0o755); await chmod(join(bin, "bun"), 0o755); }
      process.env.PATH = bin;
      process.env.SMITHERS_BUNX = join(bin, process.platform === "win32" ? "bunx.cmd" : "bunx"); process.env.SMITHERS_BUN = join(bin, process.platform === "win32" ? "bun.cmd" : "bun");
      let documentCalls = 0;
      const sim = simulate(workflow, {
        input: { prompt: "build report", name: "report-workflow", review: false }, rootDir: root, workflowPath: join(workflows, "create-workflow.tsx"),
        mocks: {
          clarify: { ...workflowClarify }, provision: { ...workflowProvision }, design: { ...workflowDesign },
          scaffold: async () => { const file = join(root, ".smithers/workflows/report-workflow-scaffold.tsx"); await mkdir(join(root, ".smithers/workflows"), { recursive: true }); await writeFile(file, "INVALID_SCAFFOLD\n"); return { summary: "SCAFFOLD_SUMMARY", workflowName: "report-workflow-scaffold", filesWritten: [{ path: ".smithers/workflows/report-workflow-scaffold.tsx", kind: "workflow" }] }; },
          fix: async () => { const file = join(root, ".smithers/workflows/report-workflow.tsx"); await writeFile(file, "export default 'FIXED_WORKFLOW';\n"); await mkdir(join(root, ".smithers/ui"), { recursive: true }); await writeFile(join(root, ".smithers/ui/report-workflow.tsx"), "export default 'FIXED_UI';\n"); return { summary: "FIX_SUMMARY", workflowName: "report-workflow", filesWritten: [{ path: ".smithers/workflows/report-workflow.tsx", kind: "workflow" }, { path: ".smithers/ui/report-workflow.tsx", kind: "ui" }, { path: ".smithers/workflows/report-workflow-scaffold.tsx", kind: "workflow" }] }; },
          "document*": async () => { const path = join(root, ".smithers/skills/report-workflow.md"); const malformed = documentCalls++ === 0; await mkdir(join(root, ".smithers/skills"), { recursive: true }); await writeFile(path, malformed ? "---\nname: wrong\n---\n" : "---\nname: report-workflow\nworkflow: report-workflow\n---\n# Report\n"); return { summary: malformed ? "DOC_BAD" : "DOC_GOOD", skillPath: ".smithers/skills/report-workflow.md" }; },
        },
      });
      await sim.run();
      expect(sim.executed).toEqual(["clarify", "provision", "design", "scaffold", "verify", "fix", "verify", "document", "skill-verification", "document-retry", "skill-verification-retry", "output"]);
      expect(sim.task("verify").outputs).toEqual([
        { passed: false, command: `${process.env.SMITHERS_BUNX} smithers-orchestrator graph .smithers/workflows/report-workflow-scaffold.tsx`, errors: ["[graph] GRAPH_SENTINEL"], notes: "verification failed for report-workflow-scaffold; see errors." },
        { passed: true, command: `${process.env.SMITHERS_BUNX} smithers-orchestrator graph .smithers/workflows/report-workflow.tsx && ${process.env.SMITHERS_BUN} build --no-bundle .smithers/ui/report-workflow.tsx`, errors: [], notes: "report-workflow loads, its graph renders without executing, and .smithers/ui/report-workflow.tsx transpiles." },
      ]);
      expect(sim.task("fix").prompts[0]).toEqual(expect.stringContaining("GRAPH_SENTINEL"));
      expect(await readFile(graphSentinel, "utf8")).toBe("GRAPH_SENTINEL\n");
      expect(await readFile(buildSentinel, "utf8")).toBe("BUILD_SENTINEL\n");
      expect(sim.task("document").outputs.map((value) => (value as { summary: string }).summary)).toEqual(["DOC_BAD"]);
      expect(sim.task("document-retry").outputs.map((value) => (value as { summary: string }).summary)).toEqual(["DOC_GOOD"]);
      expect(sim.task("skill-verification").outputs.map((value) => (value as { exists: boolean; containsWorkflowMetadata: boolean })["exists"])).toEqual([true]);
      expect(sim.task("skill-verification-retry").outputs.map((value) => (value as { exists: boolean; containsWorkflowMetadata: boolean })["exists"])).toEqual([true]);
      expect(sim.task("skill-verification").outputs.map((value) => (value as { containsWorkflowMetadata: boolean }).containsWorkflowMetadata)).toEqual([false]);
      expect(sim.task("skill-verification-retry").outputs.map((value) => (value as { containsWorkflowMetadata: boolean }).containsWorkflowMetadata)).toEqual([true]);
      expect(sim.output).toEqual({ workflow: "report-workflow", workflowFile: ".smithers/workflows/report-workflow.tsx", status: "built", summary: "DOC_GOOD", filesWritten: [".smithers/workflows/report-workflow-scaffold.tsx", ".smithers/workflows/report-workflow.tsx", ".smithers/ui/report-workflow.tsx"], fileCount: 3, verified: true, skillPath: ".smithers/skills/report-workflow.md", uiFile: ".smithers/ui/report-workflow.tsx", nextSteps: ["smithers workflow run report-workflow --prompt \"<your input>\"  # or: smithers up .smithers/workflows/report-workflow.tsx", "bunx smithers-orchestrator graph .smithers/workflows/report-workflow.tsx  # print the graph; add --interactive for the TUI", "smithers ui <runId>  # open the custom UI in .smithers/ui/report-workflow.tsx for a run", "smithers workflow run create-workflow --prompt \"iterate on report-workflow: <what to change>\"  # iterate"] });
      expect(await readFile(join(root, ".smithers/workflows/report-workflow-scaffold.tsx"), "utf8")).toBe("INVALID_SCAFFOLD\n");
      expect(await readFile(join(root, ".smithers/workflows/report-workflow.tsx"), "utf8")).toBe("export default 'FIXED_WORKFLOW';\n");
      expect(await readFile(join(root, ".smithers/ui/report-workflow.tsx"), "utf8")).toBe("export default 'FIXED_UI';\n");
      expect(await readFile(join(root, ".smithers/skills/report-workflow.md"), "utf8")).toBe("---\nname: report-workflow\nworkflow: report-workflow\n---\n# Report\n");
      expect(sim.unusedMocks).toEqual([]);
    });
  }, 60_000);

  test("create-skill writes real files without review and stops/starts causally around approval", async () => {
    await isolated("skill-no-review", "create-skill.tsx", async (root, workflow) => {
      expect(() => workflow.inputSchema.parse({ prompt: 4 })).toThrow();
      expect(() => workflow.inputSchema.parse({ name: "Graph_Auditor" })).toThrow();
      const noReview = simulate(workflow, { input: { ...skillInput, review: false }, rootDir: root, workflowPath: join(workflows, "create-skill.tsx"), mocks: {
        clarify: skillClarify, design: skillDesign,
        scaffold: async () => { await mkdir(join(root, ".smithers/skills/graph-auditor/references"), { recursive: true }); await writeFile(join(root, ".smithers/skills/graph-auditor/SKILL.md"), "---\nname: graph-auditor\n---\n# Audit\n"); await writeFile(join(root, ".smithers/skills/graph-auditor/references/graph-auditor-checklist.md"), "GRAPH_SUPPORT_SENTINEL\n"); return { summary: "SKILL_SCAFFOLD", skillName: "graph-auditor", filesWritten: [{ path: ".smithers/skills/graph-auditor/SKILL.md", kind: "skill" }, { path: ".smithers/skills/graph-auditor/references/graph-auditor-checklist.md", kind: "supporting" }] }; }, document: { summary: "SKILL_DOCUMENT", skillPath: ".smithers/skills/graph-auditor/SKILL.md" },
      } });
      await noReview.run();
      expect(noReview.executed).toEqual(["clarify", "design", "scaffold", "document", "output"]);
      expect(noReview.output).toEqual({ skillName: "graph-auditor", skillPath: ".smithers/skills/graph-auditor/SKILL.md", approved: true, summary: "SKILL_DOCUMENT", filesWritten: [".smithers/skills/graph-auditor/SKILL.md", ".smithers/skills/graph-auditor/references/graph-auditor-checklist.md"], fileCount: 2 });
      expect(await readFile(join(root, ".smithers/skills/graph-auditor/SKILL.md"), "utf8")).toBe("---\nname: graph-auditor\n---\n# Audit\n");
      expect(await readFile(join(root, ".smithers/skills/graph-auditor/references/graph-auditor-checklist.md"), "utf8")).toBe("GRAPH_SUPPORT_SENTINEL\n");
      expect(noReview.unusedMocks).toEqual([]);
    });
  }, 60_000);

  test("create-skill review gates pending, denied, and approved work causally", async () => {
    await isolated("skill-gates", "create-skill.tsx", async (_root, workflow) => {
      const common = [row("clarify", skillClarify), row("design", skillDesign)];
      const pending = await renderRows(workflow, "create-skill.tsx", skillInput, common);
      expect(pending.tasks.map((candidate) => candidate.nodeId)).toEqual(["clarify", "design", "approve-design"]);
      const denied = await renderRows(workflow, "create-skill.tsx", skillInput, [...common, row("approve-design", approval(false))]);
      expect(denied.tasks.map((candidate) => candidate.nodeId)).toEqual(["clarify", "design", "approve-design"]);
      const approved = await renderRows(workflow, "create-skill.tsx", skillInput, [...common, row("approve-design", approval(true))]);
      expect(approved.tasks.map((candidate) => candidate.nodeId)).toEqual(["clarify", "design", "approve-design", "scaffold"]);
      const prompt = renderPrompt(task(approved, "scaffold").prompt);
      expect(prompt).toContain("graph-auditor");
      expect(prompt).toContain("SKILL_DESIGN_UNIQUE");
      expect(prompt).toContain("SKILL_CONCRETE_DESIGN_SENTINEL");
      expect(prompt).toContain("SKILL_SUPPORT_DESIGN_SENTINEL");
      expect(prompt).toContain("references/graph-auditor-checklist.md");
    });
  });
});
