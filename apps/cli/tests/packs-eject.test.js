import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPack, ejectPack, updatePack } from "../src/packs.js";
import { discoverWorkflows, resolveWorkflow } from "../src/workflows.js";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

function writePack(root, version = "1.0.0", marker = "original") {
  mkdirSync(join(root, "workflows"), { recursive: true });
  mkdirSync(join(root, "ui"), { recursive: true });
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "smithers.toon"), `name: demo-pack\nversion: ${version}\ncontents:\n  workflows[1]: demo\n  ui[1]: demo\n`);
  writeFileSync(join(root, "workflows", "demo.tsx"), [
    "/* smithers",
    "name: demo",
    "*/",
    'import helper from "../lib/helper";',
    'import instructions from "../prompts/instructions.md";',
    'import { UI, Workflow, createSmithers } from "smithers-orchestrator";',
    'const { smithers } = createSmithers({});',
    `export default smithers(() => <Workflow name="demo-${marker}-\${helper}-\${instructions}"><UI entry="../ui/demo.tsx" /></Workflow>);`,
    "",
  ].join("\n"));
  writeFileSync(join(root, "ui", "demo.tsx"), `import "./demo.css";\nexport const uiMarker = "${marker}";\n`);
  writeFileSync(join(root, "ui", "demo.css"), 'body { background: url("./logo.svg"); }\n');
  writeFileSync(join(root, "ui", "logo.svg"), `<svg>${marker}</svg>\n`);
  writeFileSync(join(root, "prompts", "instructions.md"), `import details from "./details.mdx"\n# ${marker} {details}\n`);
  writeFileSync(join(root, "prompts", "details.mdx"), `import nested from "./nested.mdx"\n${marker} {nested}\n`);
  writeFileSync(join(root, "prompts", "nested.mdx"), `nested-${marker}\n`);
  writeFileSync(join(root, "lib", "helper.ts"), `export default "${marker}";\n`);
}

function writeDirectoryWorkflowPack(root) {
  mkdirSync(join(root, "workflows", "nested"), { recursive: true });
  mkdirSync(join(root, "ui"), { recursive: true });
  mkdirSync(join(root, "lib", "shared"), { recursive: true });
  writeFileSync(join(root, "smithers.toon"), "name: directory-pack\nversion: 1.0.0\n");
  writeFileSync(join(root, "workflows", "nested", "workflow.tsx"), [
    "/* smithers",
    "name: nested",
    "*/",
    'import helper from "../../lib/shared";',
    'import { UI, Workflow, createSmithers } from "smithers-orchestrator";',
    "const { smithers } = createSmithers({});",
    'export default smithers(() => <Workflow name={helper}><UI entry="../../ui/nested.tsx" /></Workflow>);',
    "",
  ].join("\n"));
  writeFileSync(join(root, "ui", "nested.tsx"), "export const uiMarker = true;\n");
  writeFileSync(join(root, "lib", "shared", "index.ts"), 'export default "nested";\n');
}

function writeCliPack(root, marker = "pack") {
  mkdirSync(join(root, "workflows"), { recursive: true });
  mkdirSync(join(root, "ui"), { recursive: true });
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "smithers.toon"), "name: cli-pack\nversion: 1.0.0\n");
  writeFileSync(join(root, "lib", "marker.ts"), `export default "${marker}";\n`);
  writeFileSync(join(root, "ui", "demo.tsx"), "export default function Demo() { return null; }\n");
  writeFileSync(join(root, "workflows", "demo.tsx"), [
    'import marker from "../lib/marker";',
    'import { createSmithers } from "smithers-orchestrator";',
    'const { Workflow, Task, smithers } = createSmithers({});',
    'export default smithers(() => <Workflow name="demo"><Task id="done">{() => ({ marker })}</Task></Workflow>);',
  ].join("\n"));
}

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "smithers-pack-eject-"));
  mkdirSync(join(root, ".smithers"), { recursive: true });
  writeFileSync(join(root, ".smithers", "smithers.config.ts"), 'export default { backend: "sqlite" };\n');
  return root;
}

describe("pack eject", () => {
  test("copies directory-form workflows and resolves directory imports", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writeDirectoryWorkflowPack(source);
    try {
      await addPack(`file:${source}`, { from: workspace, yes: true });
      const result = ejectPack("directory-pack:nested", { from: workspace });

      expect(result.files.map((file) => file.replace(`${workspace}/`, "")).sort()).toEqual([
        ".smithers/lib/shared/index.ts",
        ".smithers/ui/nested.tsx",
        ".smithers/workflows/nested/workflow.tsx",
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("copies the workflow's UI, prompts, and lib closure and local discovery shadows it", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writePack(source);
    try {
      await addPack(`file:${source}`, { from: workspace, yes: true });
      const result = ejectPack("demo-pack:demo", { from: workspace });

      expect(result.files.map((file) => file.replace(`${workspace}/`, "")).sort()).toEqual([
        ".smithers/lib/helper.ts",
        ".smithers/prompts/details.mdx",
        ".smithers/prompts/instructions.md",
        ".smithers/prompts/nested.mdx",
        ".smithers/ui/demo.css",
        ".smithers/ui/demo.tsx",
        ".smithers/ui/logo.svg",
        ".smithers/workflows/demo.tsx",
      ]);
      expect(discoverWorkflows(workspace).find((workflow) => workflow.id === "demo")).toMatchObject({
        source: "local",
        entryFile: join(workspace, ".smithers", "workflows", "demo.tsx"),
      });
      expect(resolveWorkflow("demo-pack:demo", workspace).source).toBe("pack:demo-pack");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("updates only the pack and leaves an ejected copy untouched", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writePack(source, "1.0.0", "v1");
    try {
      await addPack(`file:${source}`, { from: workspace, yes: true });
      ejectPack("demo-pack:demo", { from: workspace });
      writePack(source, "2.0.0", "v2");
      await updatePack("demo-pack", { from: workspace });

      expect(readFileSync(join(workspace, ".smithers", "packs", "demo-pack", "lib", "helper.ts"), "utf8")).toContain("v2");
      expect(readFileSync(join(workspace, ".smithers", "lib", "helper.ts"), "utf8")).toContain("v1");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("refuses when any local closure target already exists", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writePack(source);
    try {
      await addPack(`file:${source}`, { from: workspace, yes: true });
      mkdirSync(join(workspace, ".smithers", "workflows"), { recursive: true });
      writeFileSync(join(workspace, ".smithers", "workflows", "demo.tsx"), "local");
      expect(() => ejectPack("demo-pack:demo", { from: workspace })).toThrow("local target already exists");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("ignores UI-looking comments and strings while finding multiline expression entries", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writePack(source);
    writeFileSync(join(source, "workflows", "demo.tsx"), [
      "// <UI entry=\"../ui/not-real.tsx\" />",
      'const entry = "../ui/demo.tsx";',
      'const text = "<UI entry=\\\"../ui/not-real.tsx\\\" />";',
      'import { UI as WorkflowUI } from "smithers-orchestrator";',
      'export default <WorkflowUI\n  entry={entry}\n/>;',
    ].join("\n"));
    try {
      await addPack(`file:${source}`, { from: workspace, yes: true });
      expect(ejectPack("demo-pack:demo", { from: workspace }).files).toContain(join(workspace, ".smithers", "ui", "demo.tsx"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("rejects symlinked pack files instead of copying or following them", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writePack(source);
    symlinkSync(join(source, "ui", "logo.svg"), join(source, "ui", "escape.svg"));
    try {
      await expect(addPack(`file:${source}`, { from: workspace, yes: true })).rejects.toThrow(/unsupported symlink/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("real CLI list, eject, and workflow run use the ejected shadow", { timeout: 180_000 }, async () => {
    const workspace = createTempRepo().dir;
    mkdirSync(join(workspace, ".smithers"), { recursive: true });
    writeFileSync(join(workspace, ".smithers", "smithers.config.ts"), 'export default { backend: "sqlite" };\n');
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writeCliPack(source);
    try {
      const env = { CI: "1", SMITHERS_NO_SKILL_REFRESH: "1", SMITHERS_BACKEND: "sqlite" };
      const add = runSmithers(["add", `file:${source}`, "--yes"], { cwd: workspace, format: "json", env, timeoutMs: 60_000 });
      expect(add.exitCode, `${add.stdout}\n${add.stderr}`).toBe(0);
      const listBefore = runSmithers(["workflow", "list", "--json"], { cwd: workspace, format: "json", env, timeoutMs: 60_000 });
      expect(listBefore.exitCode, `${listBefore.stdout}\n${listBefore.stderr}`).toBe(0);
      expect(listBefore.stdout).toContain("pack:cli-pack");
      const eject = runSmithers(["eject", "cli-pack:demo", "--json"], { cwd: workspace, format: "json", env, timeoutMs: 60_000 });
      expect(eject.exitCode, `${eject.stdout}\n${eject.stderr}`).toBe(0);
      const listAfter = runSmithers(["workflow", "list", "--json"], { cwd: workspace, format: "json", env, timeoutMs: 60_000 });
      expect(listAfter.exitCode, `${listAfter.stdout}\n${listAfter.stderr}`).toBe(0);
      expect(listAfter.stdout).toContain('"source": "local"');
      const run = runSmithers(["workflow", "run", "demo", "--run-id", "eject-shadow", "--detach"], { cwd: workspace, format: "json", env, timeoutMs: 120_000 });
      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });
});
