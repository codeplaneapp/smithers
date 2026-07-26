/**
 * Tests that verify the `./conventions` subpath export resolves correctly
 * under plain Node.js (not Bun) and that the loader handles block-comment
 * frontmatter in executable workflow files.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadWorkflowsFromDir } from "../src/conventions/loader.js";

// Derive the package root from this test file's location: tests/../ = package root.
const packageRoot = resolve(fileURLToPath(import.meta.url), "../..");

// ---------------------------------------------------------------------------
// Node.js resolution test
// ---------------------------------------------------------------------------

describe("conventions subpath export — plain node resolution", () => {
  test("import('@smithers-orchestrator/agent-eliza/conventions') exposes defineWorkflow as a function", () => {
    // Spawn a plain `node` process — this exercises the `./conventions` export map
    // entry which points to `./src/conventions/index.js`. If only `.ts` exists,
    // node cannot load it and exits non-zero.
    const script = [
      "import('@smithers-orchestrator/agent-eliza/conventions').then(m => {",
      "  if (typeof m.defineWorkflow !== 'function') {",
      "    console.error('defineWorkflow is not a function:', typeof m.defineWorkflow);",
      "    process.exit(1);",
      "  }",
      "  console.log('ok');",
      "}).catch(err => {",
      "  console.error(err.message);",
      "  process.exit(1);",
      "});",
    ].join("\n");
    let stdout = "";
    try {
      // Run from the package root so Node picks up the package exports map.
      // Use `node` from PATH, not `process.execPath` (which is Bun when run under bun test).
      const nodeBin = process.env["NODE"] ?? "node";
      stdout = execFileSync(nodeBin, ["--input-type=module"], {
        input: script,
        cwd: packageRoot,
        encoding: "utf8",
        timeout: 15_000,
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        `node resolution failed:\nstdout: ${e.stdout ?? ""}\nstderr: ${e.stderr ?? ""}\n${e.message ?? ""}`,
      );
    }
    expect(stdout.trim()).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Block-comment frontmatter loader tests
// ---------------------------------------------------------------------------

describe("loadWorkflowsFromDir — block-comment frontmatter in executable files", () => {
  test("loads a .tsx workflow file with /* --- yaml --- */ leading comment block and parses metadata from frontmatter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-tsx-fm-test-"));
    // A .tsx workflow file where name/description/tags are ONLY in the block-comment
    // frontmatter — the default export deliberately omits them so we can verify
    // that metadata comes from frontmatter parsing, not from the export object.
    writeFileSync(
      join(dir, "tsx-workflow.tsx"),
      `/* ---
name: tsx-workflow
description: TSX workflow loaded via block-comment frontmatter
tags:
  - tsx
  - test
--- */
export default { workflow: { build: () => null, opts: {} } };
`,
      "utf8",
    );

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    const errors = result.diagnostics.filter((d) => d.type === "error");
    expect(errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);

    const wf = result.workflows[0]!;
    // Default export has no workflow property in smithers sense but has a .workflow key,
    // so it IS a recognized workflow object. Name/description/tags must come from frontmatter.
    expect(wf.name).toBe("tsx-workflow");
    expect(wf.description).toBe("TSX workflow loaded via block-comment frontmatter");
    expect(wf.tags).toEqual(["tsx", "test"]);
    // The default export itself (the module object) is present
    expect(wf.workflow).toBeDefined();
  });

  test("loads a .js workflow file with /* --- yaml --- */ leading comment block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-comment-fm-test-"));
    writeFileSync(
      join(dir, "my-workflow.js"),
      `/* ---
name: my-workflow
description: A workflow with block-comment frontmatter
tags:
  - demo
--- */
export default { workflow: { build: () => null, opts: {} }, name: "my-workflow", description: "A workflow with block-comment frontmatter" };
`,
      "utf8",
    );

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    const errors = result.diagnostics.filter((d) => d.type === "error");
    expect(errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);

    const wf = result.workflows[0]!;
    expect(wf.name).toBe("my-workflow");
    expect(wf.description).toBe("A workflow with block-comment frontmatter");
    expect(wf.tags).toEqual(["demo"]);
  });

  test("block-comment frontmatter tags are parsed when export has name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-comment-fm2-test-"));
    writeFileSync(
      join(dir, "tagged.js"),
      `/* ---
name: tagged
description: Tagged workflow
tags:
  - alpha
  - beta
--- */
export default { workflow: {}, name: "tagged", description: "Tagged workflow" };
`,
      "utf8",
    );

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    expect(result.diagnostics.filter((d) => d.type === "error")).toHaveLength(0);
    expect(result.workflows[0]!.tags).toEqual(["alpha", "beta"]);
  });

  test("file with no frontmatter (no comment block, no companion .md) still loads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-no-fm-test-"));
    writeFileSync(
      join(dir, "simple.js"),
      `export default { workflow: {}, name: "simple", description: "No frontmatter" };`,
      "utf8",
    );

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    expect(result.diagnostics.filter((d) => d.type === "error")).toHaveLength(0);
    expect(result.workflows[0]!.name).toBe("simple");
  });
});
