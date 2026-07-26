/**
 * Tests for `@smithers-orchestrator/agent-eliza/conventions`
 *
 * Uses bun:test — no mock frameworks. Uses real implementations throughout.
 * Frontmatter uses `---`-fenced YAML blocks (elizaOS convention).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseWorkflowFrontmatter,
  stripFrontmatter,
  serializeWorkflowFile,
  serializeWorkflowFrontmatter,
} from "../src/conventions/frontmatter.js";
import { defineWorkflow, defineWorkflowPlugin } from "../src/conventions/define.js";
import { formatWorkflowsForPrompt } from "../src/conventions/formatter.js";
import { registerWorkflows, toSkill, pluginToElizaPlugin } from "../src/conventions/register.js";
import { loadWorkflowsFromDir, loadWorkflows } from "../src/conventions/loader.js";
import type { WorkflowDefinition } from "../src/conventions/types.js";
import type { SmithersWorkflow } from "smithers-orchestrator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal smithers-workflow-shaped stub for tests (no LLM, no execution). */
const fakeWorkflow = { build: () => null, opts: {} } as unknown as SmithersWorkflow;

// ---------------------------------------------------------------------------
// parseWorkflowFrontmatter
// ---------------------------------------------------------------------------

describe("parseWorkflowFrontmatter", () => {
  test("returns empty frontmatter and source as body when no --- block", () => {
    const source = "// just a comment\nexport const x = 1;";
    const result = parseWorkflowFrontmatter(source);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(source);
  });

  test("parses a --- YAML frontmatter block: name and description", () => {
    const source = `---
name: close-issues
description: Fix all open issues
---
export default {};`;
    const { frontmatter, body } = parseWorkflowFrontmatter(source);
    expect(frontmatter.name).toBe("close-issues");
    expect(frontmatter.description).toBe("Fix all open issues");
    expect(body).toContain("export default {}");
  });

  test("parses tags and aliases as arrays", () => {
    const source = `---
tags:
  - github
  - maintenance
aliases:
  - ci
  - issues
---
`;
    const { frontmatter } = parseWorkflowFrontmatter(source);
    expect(frontmatter.tags).toEqual(["github", "maintenance"]);
    expect(frontmatter.aliases).toEqual(["ci", "issues"]);
  });

  test("parses boolean disable-model-invocation", () => {
    const source = `---
name: internal-tool
description: Internal
disable-model-invocation: true
user-invocable: false
---
`;
    const { frontmatter } = parseWorkflowFrontmatter(source);
    expect(frontmatter["disable-model-invocation"]).toBe(true);
    expect(frontmatter["user-invocable"]).toBe(false);
  });

  test("body is a string when nothing follows the closing ---", () => {
    const source = `---
name: x
description: y
---
`;
    const { body } = parseWorkflowFrontmatter(source);
    expect(typeof body).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// stripFrontmatter
// ---------------------------------------------------------------------------

describe("stripFrontmatter", () => {
  test("removes the --- block and returns body", () => {
    const source = `---
name: x
description: y
---
export default {};`;
    const stripped = stripFrontmatter(source);
    expect(stripped).not.toContain("name: x");
    expect(stripped).toContain("export default {}");
  });

  test("returns source unchanged when no frontmatter", () => {
    const source = "export const x = 1;";
    expect(stripFrontmatter(source)).toBe(source);
  });
});

// ---------------------------------------------------------------------------
// serializeWorkflowFile + serializeWorkflowFrontmatter
// ---------------------------------------------------------------------------

describe("serializeWorkflowFile", () => {
  test("produces a --- block followed by body", () => {
    const fm = { name: "my-workflow", description: "A test" };
    const body = "export default {};";
    const result = serializeWorkflowFile(fm, body);
    expect(result).toMatch(/^---\n/);
    expect(result).toContain("name: my-workflow");
    expect(result).toContain("description: A test");
    expect(result).toContain(body);
  });

  test("round-trips via parseWorkflowFrontmatter", () => {
    const fm = {
      name: "round-trip",
      description: "Yep",
      tags: ["x", "y"],
      aliases: ["rt"],
    };
    const body = "export default {};";
    const file = serializeWorkflowFile(fm, body);
    const { frontmatter, body: parsedBody } = parseWorkflowFrontmatter(file);
    expect(frontmatter.name).toBe("round-trip");
    expect(frontmatter.description).toBe("Yep");
    expect(frontmatter.tags).toEqual(["x", "y"]);
    expect(frontmatter.aliases).toEqual(["rt"]);
    expect(parsedBody).toBe(body);
  });
});

describe("serializeWorkflowFrontmatter", () => {
  test("produces a standalone --- block", () => {
    const fm = { name: "my-workflow", description: "A test" };
    const result = serializeWorkflowFrontmatter(fm);
    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/---\n$/);
    expect(result).toContain("name: my-workflow");
  });

  test("round-trips via parseWorkflowFrontmatter", () => {
    const fm = { name: "roundtrip", description: "Yep", tags: ["x", "y"] };
    const serialized = serializeWorkflowFrontmatter(fm);
    const { frontmatter } = parseWorkflowFrontmatter(serialized);
    expect(frontmatter.name).toBe("roundtrip");
    expect(frontmatter.description).toBe("Yep");
    expect(frontmatter.tags).toEqual(["x", "y"]);
  });
});

// ---------------------------------------------------------------------------
// defineWorkflow
// ---------------------------------------------------------------------------

describe("defineWorkflow", () => {
  test("returns a WorkflowDefinition with the provided fields", () => {
    const def = defineWorkflow({
      name: "my-workflow",
      description: "Does stuff",
      tags: ["a"],
      workflow: fakeWorkflow,
    });
    expect(def.name).toBe("my-workflow");
    expect(def.description).toBe("Does stuff");
    expect(def.tags).toEqual(["a"]);
    expect(def.workflow).toBe(fakeWorkflow);
  });

  test("normalizes kebab-case disable-model-invocation to camelCase", () => {
    const def = defineWorkflow({
      name: "internal",
      description: "Internal tool",
      "disable-model-invocation": true,
      workflow: fakeWorkflow,
    });
    expect(def.disableModelInvocation).toBe(true);
    expect("disable-model-invocation" in def).toBe(false);
  });

  test("throws when name is missing", () => {
    expect(() =>
      // @ts-expect-error intentionally missing name
      defineWorkflow({ description: "no name", workflow: fakeWorkflow }),
    ).toThrow(/name is required/);
  });

  test("throws when description is missing", () => {
    expect(() =>
      // @ts-expect-error intentionally missing description
      defineWorkflow({ name: "x", workflow: fakeWorkflow }),
    ).toThrow(/description is required/);
  });

  test("throws when workflow is missing", () => {
    expect(() =>
      // @ts-expect-error intentionally missing workflow
      defineWorkflow({ name: "x", description: "no wf" }),
    ).toThrow(/workflow.*required/);
  });
});

describe("defineWorkflowPlugin", () => {
  test("returns a WorkflowPlugin with the provided fields", () => {
    const workflows: WorkflowDefinition[] = [defineWorkflow({ name: "a", description: "A", workflow: fakeWorkflow })];
    const plugin = defineWorkflowPlugin({
      name: "my-plugin",
      description: "A plugin",
      workflows,
    });
    expect(plugin.name).toBe("my-plugin");
    expect(plugin.workflows).toHaveLength(1);
  });

  test("throws when name is missing", () => {
    expect(() =>
      // @ts-expect-error intentionally missing name
      defineWorkflowPlugin({ description: "x", workflows: [] }),
    ).toThrow(/name is required/);
  });

  test("throws when workflows is not an array", () => {
    expect(() =>
      // @ts-expect-error intentionally wrong type
      defineWorkflowPlugin({ name: "x", description: "y", workflows: null }),
    ).toThrow(/workflows.*must be an array/);
  });
});

// ---------------------------------------------------------------------------
// formatWorkflowsForPrompt
// ---------------------------------------------------------------------------

describe("formatWorkflowsForPrompt", () => {
  const wf1 = defineWorkflow({
    name: "close-issues",
    description: "Fix all open issues",
    tags: ["github"],
    workflow: fakeWorkflow,
  });
  const wf2 = defineWorkflow({
    name: "deploy",
    description: "Deploy to production",
    aliases: ["ship"],
    workflow: fakeWorkflow,
  });
  const wfDisabled = defineWorkflow({
    name: "internal-tool",
    description: "Internal only",
    disableModelInvocation: true,
    workflow: fakeWorkflow,
  });

  test("outputs the default heading", () => {
    const out = formatWorkflowsForPrompt([wf1]);
    expect(out).toContain("## Available Workflows");
  });

  test("includes workflow names and descriptions", () => {
    const out = formatWorkflowsForPrompt([wf1, wf2]);
    expect(out).toContain("close-issues");
    expect(out).toContain("Fix all open issues");
    expect(out).toContain("deploy");
  });

  test("includes tags when present", () => {
    const out = formatWorkflowsForPrompt([wf1]);
    expect(out).toContain("github");
  });

  test("includes aliases when present", () => {
    const out = formatWorkflowsForPrompt([wf2]);
    expect(out).toContain("ship");
  });

  test("skips workflows with system: true", () => {
    const wfSystem = defineWorkflow({
      name: "init-plumbing",
      description: "System plumbing",
      system: true,
      workflow: fakeWorkflow,
    });
    const out = formatWorkflowsForPrompt([wf1, wfSystem]);
    expect(out).toContain("close-issues");
    expect(out).not.toContain("init-plumbing");
  });

  test("skips workflows with disableModelInvocation: true", () => {
    const out = formatWorkflowsForPrompt([wf1, wfDisabled]);
    expect(out).toContain("close-issues");
    expect(out).not.toContain("internal-tool");
    expect(out).not.toContain("Internal only");
  });

  test("returns (none) when all workflows are disabled", () => {
    const out = formatWorkflowsForPrompt([wfDisabled]);
    expect(out).toContain("(none)");
  });

  test("returns (none) for empty list", () => {
    const out = formatWorkflowsForPrompt([]);
    expect(out).toContain("(none)");
  });

  test("respects custom heading", () => {
    const out = formatWorkflowsForPrompt([wf1], { heading: "# My Workflows" });
    expect(out).toContain("# My Workflows");
    expect(out).not.toContain("## Available Workflows");
  });

  test("can suppress tags", () => {
    const out = formatWorkflowsForPrompt([wf1], { includeTags: false });
    expect(out).not.toContain("github");
  });

  test("can suppress aliases", () => {
    const out = formatWorkflowsForPrompt([wf2], { includeAliases: false });
    expect(out).not.toContain("ship");
  });
});

// ---------------------------------------------------------------------------
// registerWorkflows
// ---------------------------------------------------------------------------

describe("registerWorkflows", () => {
  test("calls registry.register for each workflow with name and workflow object", () => {
    const registered: [string, unknown][] = [];
    const registry = {
      register(name: string, wf: unknown) {
        registered.push([name, wf]);
      },
    };

    const workflows = [
      defineWorkflow({ name: "alpha", description: "A", workflow: fakeWorkflow }),
      defineWorkflow({ name: "beta", description: "B", workflow: fakeWorkflow }),
    ];

    registerWorkflows(registry, workflows);
    expect(registered).toHaveLength(2);
    expect(registered[0]![0]).toBe("alpha");
    expect(registered[1]![0]).toBe("beta");
    expect(registered[0]![1]).toBe(fakeWorkflow);
    expect(registered[1]![1]).toBe(fakeWorkflow);
  });

  test("gateway seam: passes the workflow object (not the wrapper) to register", () => {
    const received: unknown[] = [];
    const gateway = {
      register(_name: string, wf: unknown) {
        received.push(wf);
      },
    };
    const innerWf = { build: () => null, opts: { id: "seam-test" } } as unknown as SmithersWorkflow;
    const def = defineWorkflow({ name: "seam-test", description: "seam", workflow: innerWf });
    registerWorkflows(gateway, [def]);
    expect(received[0]).toBe(innerWf);
  });
});

// ---------------------------------------------------------------------------
// toSkill
// ---------------------------------------------------------------------------

describe("toSkill", () => {
  const def = defineWorkflow({
    name: "close-issues",
    description: "Fix issues",
    tags: ["github"],
    aliases: ["ci", "issues"],
    workflow: fakeWorkflow,
  });

  test("preserves name as-is (no uppercasing)", () => {
    const skill = toSkill(def);
    expect(skill.name).toBe("close-issues");
  });

  test("preserves description", () => {
    expect(toSkill(def).description).toBe("Fix issues");
  });

  test("preserves tags", () => {
    expect(toSkill(def).tags).toEqual(["github"]);
  });

  test("preserves aliases", () => {
    expect(toSkill(def).aliases).toEqual(["ci", "issues"]);
  });
});

describe("pluginToElizaPlugin", () => {
  test("converts a WorkflowPlugin to an eliza plugin shape with skills", () => {
    const plugin = defineWorkflowPlugin({
      name: "my-plugin",
      description: "Desc",
      workflows: [
        defineWorkflow({ name: "wf-one", description: "One", workflow: fakeWorkflow }),
        defineWorkflow({ name: "wf-two", description: "Two", workflow: fakeWorkflow }),
      ],
    });
    const elizaPlugin = pluginToElizaPlugin(plugin);
    expect(elizaPlugin.name).toBe("my-plugin");
    expect(elizaPlugin.description).toBe("Desc");
    expect(elizaPlugin.skills).toHaveLength(2);
    expect(elizaPlugin.skills[0]!.name).toBe("wf-one");
    expect(elizaPlugin.skills[1]!.name).toBe("wf-two");
  });
});

// ---------------------------------------------------------------------------
// loadWorkflowsFromDir
// ---------------------------------------------------------------------------

describe("loadWorkflowsFromDir", () => {
  test("returns warning for a non-existent directory", async () => {
    const result = await loadWorkflowsFromDir({ dir: "/nonexistent/path/xyz", source: "test" });
    expect(result.workflows).toHaveLength(0);
    expect(result.diagnostics[0]!.type).toBe("warning");
  });

  test("loads a workflow file with companion .md frontmatter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    // Valid JS file (no --- block — that would break JS syntax)
    writeFileSync(
      join(dir, "temp-workflow.js"),
      `export default { workflow: { build: () => null, opts: {} }, name: "temp-workflow", description: "A temporary test workflow" };`,
      "utf8",
    );
    // Companion .md with --- YAML frontmatter
    writeFileSync(
      join(dir, "temp-workflow.md"),
      `---\nname: temp-workflow\ndescription: A temporary test workflow\ntags:\n  - test\n---\n`,
      "utf8",
    );

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    const errors = result.diagnostics.filter((d) => d.type === "error");
    expect(errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]!.name).toBe("temp-workflow");
    expect(result.workflows[0]!.description).toBe("A temporary test workflow");
    expect(result.workflows[0]!.tags).toEqual(["test"]);
  });

  test("falls back to executable frontmatter when a companion .md contains only prose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    const execText = `/* ---
name: cleanup-internal
description: Remove stale workflow state
tags:
  - maintenance
aliases:
  - cleanup
system: true
disable-model-invocation: true
version: "1.2.3"
--- */
export default { build: () => null, opts: {} };`;
    writeFileSync(join(dir, "cleanup.workflow.js"), execText, "utf8");
    writeFileSync(
      join(dir, "cleanup.workflow.md"),
      "# Cleanup workflow\n\nHuman-facing operating notes without frontmatter.\n",
      "utf8",
    );

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    const workflow = result.workflows[0]!;

    expect(result.diagnostics).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);
    expect(workflow.name).toBe("cleanup-internal");
    expect(workflow.description).toBe("Remove stale workflow state");
    expect(workflow.tags).toEqual(["maintenance"]);
    expect(workflow.aliases).toEqual(["cleanup"]);
    expect(workflow.system).toBe(true);
    expect(workflow.disableModelInvocation).toBe(true);
    expect(workflow.version).toBe("1.2.3");
    expect(workflow.source).toBe(execText);
    const prompt = formatWorkflowsForPrompt(result.workflows);
    expect(prompt).toContain("(none)");
    expect(prompt).not.toContain("cleanup-internal");
  });

  test("ignores non-array and non-string frontmatter tags and aliases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    writeFileSync(
      join(dir, "malformed-metadata.js"),
      `export default { workflow: {}, name: "malformed-metadata", description: "d" };`,
      "utf8",
    );
    writeFileSync(
      join(dir, "malformed-metadata.md"),
      `---\ntags: not-an-array\naliases:\n  - valid\n  - 42\n---\n`,
      "utf8",
    );

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    const workflow = result.workflows[0]!;
    expect(workflow.tags).toBeUndefined();
    expect(workflow.aliases).toEqual(["valid"]);
    expect(() => formatWorkflowsForPrompt(result.workflows)).not.toThrow();
  });

  test("yields error diagnostic for a malformed file instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    writeFileSync(join(dir, "bad.js"), "this is not valid js !!@#$%", "utf8");

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    expect(result.workflows).toHaveLength(0);
    const errors = result.diagnostics.filter((d) => d.type === "error");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("loads two workflow files, one with companion .md frontmatter and one without", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    writeFileSync(
      join(dir, "alpha.js"),
      `export default { workflow: {}, name: "alpha", description: "Alpha wf" };`,
      "utf8",
    );
    // companion .md with --- frontmatter for alpha
    writeFileSync(join(dir, "alpha.md"), `---\nname: alpha\ndescription: Alpha wf\n---\n`, "utf8");
    writeFileSync(
      join(dir, "beta.js"),
      `export default { workflow: {}, name: "beta", description: "Beta wf" };`,
      "utf8",
    );

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    expect(result.workflows).toHaveLength(2);
    const names = result.workflows.map((w) => w.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  test("derives name from filename when no frontmatter name field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    writeFileSync(join(dir, "my-cool-flow.js"), "export default { workflow: {}, description: 'Cool flow' };", "utf8");

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    expect(result.workflows[0]!.name).toBe("my-cool-flow");
  });

  test("skips non-JS/TS files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    writeFileSync(join(dir, "readme.md"), "# hello", "utf8");
    writeFileSync(join(dir, "valid.js"), "export default { workflow: {}, name: 'v', description: 'd' };", "utf8");

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    expect(result.workflows).toHaveLength(1);
  });

  test("surfaces the frontmatter version field from a companion .md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    writeFileSync(
      join(dir, "versioned.js"),
      `export default { workflow: {}, name: "versioned", description: "v" };`,
      "utf8",
    );
    writeFileSync(join(dir, "versioned.md"), `---\nname: versioned\ndescription: v\nversion: 1.2.3\n---\n`, "utf8");

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    expect(result.workflows[0]!.version).toBe("1.2.3");
  });

  test("surfaces the frontmatter version from a block-comment header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    writeFileSync(
      join(dir, "bc-versioned.js"),
      `/* ---\nname: bc-versioned\nversion: 2.0.0\n--- */\nexport default { workflow: {}, name: "bc-versioned", description: "d" };`,
      "utf8",
    );

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    expect(result.workflows[0]!.version).toBe("2.0.0");
  });

  test("source is the executable file's own text, not the companion .md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    const execText = `export default { workflow: {}, name: "srccheck", description: "d" };`;
    writeFileSync(join(dir, "srccheck.js"), execText, "utf8");
    writeFileSync(join(dir, "srccheck.md"), `---\nname: srccheck\ndescription: d\n---\n`, "utf8");

    const result = await loadWorkflowsFromDir({ dir, source: "test" });
    expect(result.workflows[0]!.source).toBe(execText);
    // The companion .md frontmatter (with its `---` fences) must not leak into source.
    expect(result.workflows[0]!.source).not.toContain("---");
  });
});

// ---------------------------------------------------------------------------
// loadWorkflows — multi-source collision and precedence
// ---------------------------------------------------------------------------

describe("loadWorkflows", () => {
  test("emits collision diagnostic when two source dirs share a workflow name", async () => {
    const bundled = mkdtempSync(join(tmpdir(), "smithers-bundled-"));
    writeFileSync(
      join(bundled, "shared.js"),
      `export default { workflow: {}, name: "shared", description: "Bundled version" };`,
      "utf8",
    );

    const managed = mkdtempSync(join(tmpdir(), "smithers-managed-"));
    writeFileSync(
      join(managed, "shared.js"),
      `export default { workflow: {}, name: "shared", description: "Managed version" };`,
      "utf8",
    );

    const result = await loadWorkflows({
      includeDefaults: false,
      bundledDir: bundled,
      managedDir: managed,
    });

    // managed overrides bundled
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]!.description).toBe("Managed version");

    const collision = result.diagnostics.find((d) => d.type === "collision");
    expect(collision).toBeDefined();
    expect(collision!.collision?.existing.description).toBe("Bundled version");
    expect(collision!.collision?.incoming.description).toBe("Managed version");
  });

  test("higher-precedence (managed) source overrides lower-precedence (bundled)", async () => {
    const bundled = mkdtempSync(join(tmpdir(), "smithers-bundled-"));
    writeFileSync(
      join(bundled, "my-wf.js"),
      `export default { workflow: {}, name: "my-wf", description: "Bundled" };`,
      "utf8",
    );

    const managed = mkdtempSync(join(tmpdir(), "smithers-managed-"));
    writeFileSync(
      join(managed, "my-wf.js"),
      `export default { workflow: {}, name: "my-wf", description: "Managed" };`,
      "utf8",
    );

    const result = await loadWorkflows({
      includeDefaults: false,
      bundledDir: bundled,
      managedDir: managed,
    });

    expect(result.workflows.find((w) => w.name === "my-wf")?.description).toBe("Managed");
  });

  test("loads workflows from explicit workflowPaths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-explicit-"));
    const filePath = join(dir, "explicit.js");
    writeFileSync(filePath, `export default { workflow: {}, name: "explicit", description: "Explicit path" };`, "utf8");

    const result = await loadWorkflows({
      cwd: dir,
      workflowPaths: [filePath],
      includeDefaults: false,
    });

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]!.name).toBe("explicit");
  });
});
