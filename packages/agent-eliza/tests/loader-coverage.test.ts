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
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadWorkflows, loadWorkflowsFromDir } from "../src/conventions/loader.js";

describe("loadWorkflowsFromDir — dangling symlink", () => {
  test("skips a dangling symlink with an error diagnostic and still loads sibling workflows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-loader-cov-"));
    writeFileSync(
      join(dir, "valid-wf.js"),
      `export default { workflow: {}, name: "valid-wf", description: "Valid" };`,
      "utf8"
    );
    const brokenPath = join(dir, "broken.js");
    symlinkSync(join(dir, "missing-target"), brokenPath);

    const result = await loadWorkflowsFromDir({ dir, source: "test" });

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]!.name).toBe("valid-wf");

    const errors = result.diagnostics.filter((d) => d.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe(brokenPath);
    expect(errors[0]!.message).toMatch(/stat/i);
  });
});

describe("loadWorkflowsFromDir — non-object export", () => {
  test("emits 'no recognizable export' error when the module default is not an object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-loader-cov-"));
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

describe("loadWorkflows — explicit workflowPaths edge cases", () => {
  test("emits an import error and read-failure fallback for a non-existent workflowPath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-loader-cov-"));
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
    const dir = mkdtempSync(join(tmpdir(), "smithers-loader-cov-"));
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
    const cwd = mkdtempSync(join(tmpdir(), "smithers-loader-cov-cwd-"));

    // Managed dir (existsSync true) — covers the includeDefaults managed branch.
    const managed = mkdtempSync(join(tmpdir(), "smithers-loader-cov-managed-"));
    writeFileSync(
      join(managed, "managed-wf.js"),
      `export default { workflow: {}, name: "managed-wf", description: "Managed" };`,
      "utf8"
    );

    // Project dir <cwd>/.smithers/workflows (existsSync true) — covers the
    // highest-precedence project branch.
    const projectDir = join(cwd, ".smithers", "workflows");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "project-wf.js"),
      `export default { workflow: {}, name: "project-wf", description: "Project" };`,
      "utf8"
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
