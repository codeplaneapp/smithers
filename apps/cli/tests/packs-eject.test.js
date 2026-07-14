import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPack, ejectPack, updatePack } from "../src/packs.js";
import { discoverWorkflows, resolveWorkflow } from "../src/workflows.js";

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
  writeFileSync(join(root, "ui", "demo.tsx"), `export const uiMarker = "${marker}";\n`);
  writeFileSync(join(root, "prompts", "instructions.md"), `# ${marker}\n`);
  writeFileSync(join(root, "lib", "helper.ts"), `export default "${marker}";\n`);
}

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "smithers-pack-eject-"));
  mkdirSync(join(root, ".smithers"), { recursive: true });
  return root;
}

describe("pack eject", () => {
  test("copies the workflow's UI, prompts, and lib closure and local discovery shadows it", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writePack(source);
    try {
      await addPack(`file:${source}`, { from: workspace, yes: true });
      const result = ejectPack("demo-pack:demo", { from: workspace });

      expect(result.files.map((file) => file.replace(`${workspace}/`, "")).sort()).toEqual([
        ".smithers/lib/helper.ts",
        ".smithers/prompts/instructions.md",
        ".smithers/ui/demo.tsx",
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
});
