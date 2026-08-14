/**
 * Additional coverage for `src/conventions/loader.js` — exercises the
 * defensive / lower-precedence branches not hit by conventions.test.ts:
 *
 *  - readExecutableSource() read failure -> "" fallback
 *  - buildDefinition() returning null (non-object export) in both the
 *    directory loader and the explicit-workflowPaths loader
 *  - importWorkflowFile() failure diagnostic on an explicit workflowPath
 *  - the includeDefaults branches for the managed dir and the project
 *    <cwd>/.smithers/workflows dir
 *
 * Uses bun:test with real filesystem fixtures — no mocks.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadWorkflows, loadWorkflowsFromDir } from "../src/conventions/loader.js";
import { makeTempDirPath } from "../../testing/src/cleanup/tempDir.ts";

describe("loadWorkflowsFromDir — dangling symlink", () => {
  test("skips a dangling symlink with a diagnostic instead of aborting the whole directory", async () => {
    const dir = makeTempDirPath("smithers-loader-cov-");
    // A valid workflow file that must still be discovered.
    writeFileSync(join(dir, "good.js"), "export default { name: 'good', steps: [] };", "utf8");
    // A symlink pointing at a non-existent target -> statSync throws ENOENT.
    symlinkSync(join(dir, "missing-target.js"), join(dir, "broken.js"));

    const result = await loadWorkflowsFromDir({ dir, source: "test" });

    // The valid workflow still loads.
    expect(result.workflows).toHaveLength(1);
    // The broken symlink is reported, not thrown.
    const statErrors = result.diagnostics.filter(
      (d) => d.type === "error" && /Could not stat workflow entry/.test(d.message),
    );
    expect(statErrors).toHaveLength(1);
    expect(statErrors[0]!.path).toBe(join(dir, "broken.js"));
  });
});

describe("loadWorkflowsFromDir — non-object export", () => {
  test("emits 'no recognizable export' error when the module default is not an object", async () => {
    const dir = makeTempDirPath("smithers-loader-cov-");
    // Valid, importable module whose default export is a primitive number.
    // buildDefinition() rejects this (typeof !== "object") -> null -> error diagnostic.
    writeFileSync(join(dir, "primitive.js"), "export default 42;", "utf8");

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    expect(result.workflows).toHaveLength(0);
    const errors = result.diagnostics.filter((d) => d.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/no recognizable export/);
  });
});

describe("workflow paths with URL-significant characters", () => {
  test("loads files containing '#' through directory and explicit-path APIs", async () => {
    const dir = makeTempDirPath("smithers-loader-url-path-");
    const filePath = join(dir, "workflow#query.js");
    writeFileSync(filePath, `export default { workflow: {}, name: "url-safe", description: "URL-safe" };`, "utf8");

    const fromDir = await loadWorkflowsFromDir({ dir, source: "test" });
    expect(fromDir.diagnostics).toHaveLength(0);
    expect(fromDir.workflows.map((workflow) => workflow.name)).toEqual(["url-safe"]);

    const explicit = await loadWorkflows({
      cwd: dir,
      workflowPaths: ["workflow#query.js"],
      includeDefaults: false,
    });
    expect(explicit.diagnostics).toHaveLength(0);
    expect(explicit.workflows.map((workflow) => workflow.name)).toEqual(["url-safe"]);
  });
});

describe("loadWorkflows — explicit workflowPaths edge cases", () => {
  test("emits an import error and read-failure fallback for a non-existent workflowPath", async () => {
    const dir = makeTempDirPath("smithers-loader-cov-");
    const missing = join(dir, "does-not-exist.js");

    const result = await loadWorkflows({
      cwd: dir,
      workflowPaths: [missing],
      includeDefaults: false,
    });

    expect(result.workflows).toHaveLength(0);
    const errors = result.diagnostics.filter((d) => d.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/Could not import workflow file/);
    expect(errors[0]!.path).toBe(missing);
  });

  test("emits 'no recognizable export' for an explicit workflowPath whose default is a primitive", async () => {
    const dir = makeTempDirPath("smithers-loader-cov-");
    const filePath = join(dir, "primitive-explicit.js");
    writeFileSync(filePath, "export default 7;", "utf8");

    const result = await loadWorkflows({
      cwd: dir,
      workflowPaths: [filePath],
      includeDefaults: false,
    });

    expect(result.workflows).toHaveLength(0);
    const errors = result.diagnostics.filter((d) => d.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/no recognizable export/);
    expect(errors[0]!.path).toBe(filePath);
  });
});

describe("loadWorkflows — includeDefaults managed + project dirs", () => {
  test("loads the managed dir and the <cwd>/.smithers/workflows project dir when includeDefaults is true", async () => {
    const cwd = makeTempDirPath("smithers-loader-cov-cwd-");

    // Managed dir (existsSync true) — covers the includeDefaults managed branch.
    const managed = makeTempDirPath("smithers-loader-cov-managed-");
    writeFileSync(
      join(managed, "managed-wf.js"),
      `export default { workflow: {}, name: "managed-wf", description: "Managed" };`,
      "utf8",
    );

    // Project dir <cwd>/.smithers/workflows (existsSync true) — covers the
    // highest-precedence project branch.
    const projectDir = join(cwd, ".smithers", "workflows");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "project-wf.js"),
      `export default { workflow: {}, name: "project-wf", description: "Project" };`,
      "utf8",
    );

    const result = await loadWorkflows({
      cwd,
      managedDir: managed,
      includeDefaults: true,
    });

    const names = result.workflows.map((w) => w.name).sort();
    expect(names).toContain("managed-wf");
    expect(names).toContain("project-wf");
  });
});
