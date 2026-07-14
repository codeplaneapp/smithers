import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    'import { z } from "zod/v4";',
    "const { Workflow, Task, smithers, outputs } = createSmithers({",
    "    input: z.object({}),",
    "    result: z.object({ marker: z.string() }),",
    "});",
    'export default smithers(() => <Workflow name="demo"><Task id="done" output={outputs.result}>{async () => ({ marker })}</Task></Workflow>);',
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

  test("convention-based ui/<workflow>.tsx is ejected even without a <UI entry>", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writeCliPack(source);
    try {
      await addPack(`file:${source}`, { from: workspace, yes: true });
      // writeCliPack's workflow has NO <UI entry> — the Gateway resolves
      // ui/demo.tsx purely by convention, so eject must carry it.
      const result = ejectPack("cli-pack:demo", { from: workspace });
      expect(result.files).toContain(join(workspace, ".smithers", "ui", "demo.tsx"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("binary and xml-declared assets are copied as leaves, never parsed", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writePack(source);
    // An SVG with an XML declaration and a binary PNG — both crash a TSX lexer.
    writeFileSync(join(source, "ui", "demo.css"), 'body { background: url("./logo.svg"); border-image: url("./logo.png"); }\n');
    writeFileSync(join(source, "ui", "logo.svg"), '<?xml version="1.0" encoding="UTF-8"?><svg/>\n');
    writeFileSync(join(source, "ui", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
    try {
      await addPack(`file:${source}`, { from: workspace, yes: true });
      const result = ejectPack("demo-pack:demo", { from: workspace });
      expect(result.files).toContain(join(workspace, ".smithers", "ui", "logo.svg"));
      expect(result.files).toContain(join(workspace, ".smithers", "ui", "logo.png"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("refuses when the same workflow id exists locally in the alternate layout", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writePack(source);
    try {
      await addPack(`file:${source}`, { from: workspace, yes: true });
      // Pack ships flat workflows/demo.tsx; local has dir-form demo/workflow.tsx.
      mkdirSync(join(workspace, ".smithers", "workflows", "demo"), { recursive: true });
      writeFileSync(join(workspace, ".smithers", "workflows", "demo", "workflow.tsx"), "export default null;\n");
      expect(() => ejectPack("demo-pack:demo", { from: workspace })).toThrow(/already exists/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("sass closures follow @use/@forward and unprefixed url() assets", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writePack(source);
    writeFileSync(join(source, "ui", "demo.tsx"), 'import "./demo.scss";\nexport const uiMarker = "scss";\n');
    writeFileSync(join(source, "ui", "demo.scss"), '@use "./tokens";\n@forward "./mixins";\nbody { background: url("logo.svg"); }\n');
    writeFileSync(join(source, "ui", "tokens.scss"), "$accent: #5e6ad2;\n");
    writeFileSync(join(source, "ui", "mixins.scss"), "@mixin pad { padding: 1px; }\n");
    try {
      await addPack(`file:${source}`, { from: workspace, yes: true });
      const files = ejectPack("demo-pack:demo", { from: workspace }).files;
      expect(files).toContain(join(workspace, ".smithers", "ui", "tokens.scss"));
      expect(files).toContain(join(workspace, ".smithers", "ui", "mixins.scss"));
      expect(files).toContain(join(workspace, ".smithers", "ui", "logo.svg"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("convention UI is not dragged in when the workflow declares an explicit UI", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writePack(source);
    // writePack's demo.tsx declares <UI entry="../ui/demo.tsx">. Point the
    // explicit entry elsewhere and leave ui/demo.tsx as an unrelated file.
    writeFileSync(join(source, "workflows", "demo.tsx"), [
      'import { UI, Workflow, createSmithers } from "smithers-orchestrator";',
      "const { smithers } = createSmithers({});",
      'export default smithers(() => <Workflow name="demo"><UI entry="../ui/explicit.tsx" /></Workflow>);',
    ].join("\n"));
    writeFileSync(join(source, "ui", "explicit.tsx"), "export const explicit = true;\n");
    try {
      await addPack(`file:${source}`, { from: workspace, yes: true });
      const files = ejectPack("demo-pack:demo", { from: workspace }).files;
      expect(files).toContain(join(workspace, ".smithers", "ui", "explicit.tsx"));
      expect(files).not.toContain(join(workspace, ".smithers", "ui", "demo.tsx"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("a failed eject rolls back instead of stranding a partial shadow", async () => {
    const workspace = tempWorkspace();
    const source = mkdtempSync(join(tmpdir(), "smithers-pack-source-"));
    writePack(source);
    try {
      await addPack(`file:${source}`, { from: workspace, yes: true });
      // .smithers/ui exists as a FILE: the parent-path validation must refuse
      // up front, leaving no partial workflow copy to shadow the pack.
      writeFileSync(join(workspace, ".smithers", "ui"), "not a directory");
      expect(() => ejectPack("demo-pack:demo", { from: workspace })).toThrow(/is not a directory/);
      expect(existsSync(join(workspace, ".smithers", "workflows", "demo.tsx"))).toBe(false);
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
      // Convention UI must ride along through the CLI path too.
      expect(readFileSync(join(workspace, ".smithers", "ui", "demo.tsx"), "utf8")).toContain("Demo");
      const listAfter = runSmithers(["workflow", "list", "--json"], { cwd: workspace, format: "json", env, timeoutMs: 60_000 });
      expect(listAfter.exitCode, `${listAfter.stdout}\n${listAfter.stderr}`).toBe(0);
      expect(listAfter.stdout).toContain('"source": "local"');
      // Make the ejected copy observably different from the pack's, so the
      // completed run PROVES the local shadow executed (exit 0 alone would
      // pass even if the pack copy ran).
      writeFileSync(join(workspace, ".smithers", "lib", "marker.ts"), 'export default "ejected-local";\n');
      const run = runSmithers(["workflow", "run", "demo", "--run-id", "eject-shadow"], { cwd: workspace, format: "json", env, timeoutMs: 120_000 });
      expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
      const output = runSmithers(["output", "eject-shadow", "done"], { cwd: workspace, format: "json", env, timeoutMs: 60_000 });
      expect(output.exitCode, `${output.stdout}\n${output.stderr}`).toBe(0);
      expect(output.stdout).toContain("ejected-local");
      expect(output.stdout).not.toContain('"marker": "pack"');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });
});
