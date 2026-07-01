/**
 * Tests for `@smithers-orchestrator/agent-eliza/conventions`
 *
 * Uses bun:test — no mock frameworks. Uses real implementations throughout.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseWorkflowFrontmatter,
  serializeWorkflowFrontmatter,
} from "../src/conventions/frontmatter.js";
import { defineWorkflow, defineWorkflowPlugin } from "../src/conventions/define.js";
import { formatWorkflowsForPrompt } from "../src/conventions/formatter.js";
import { registerWorkflows, toSkill, pluginToElizaPlugin } from "../src/conventions/register.js";
import { loadWorkflowsFromDir } from "../src/conventions/loader.js";
import type { WorkflowDefinition } from "../src/conventions/types.js";

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

describe("parseWorkflowFrontmatter", () => {
  test("returns empty object when no block is present", () => {
    expect(parseWorkflowFrontmatter("// just a comment\nexport const x = 1;")).toEqual({});
  });

  test("parses a minimal frontmatter block", () => {
    const source = `
/* smithers
name: close-issues
description: Fix all open issues
*/
export default {};
`.trim();
    const fm = parseWorkflowFrontmatter(source);
    expect(fm.name).toBe("close-issues");
    expect(fm.description).toBe("Fix all open issues");
  });

  test("parses inline list syntax", () => {
    const source = `
/* smithers
tags: [github, maintenance]
aliases: [ci, issues]
*/
`.trim();
    const fm = parseWorkflowFrontmatter(source);
    expect(fm.tags).toEqual(["github", "maintenance"]);
    expect(fm.aliases).toEqual(["ci", "issues"]);
  });

  test("parses block list syntax", () => {
    const source = `
/* smithers
tags:
- alpha
- beta
- gamma
*/
`.trim();
    const fm = parseWorkflowFrontmatter(source);
    expect(fm.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  test("parses boolean values", () => {
    const source = `
/* smithers
disable-model-invocation: true
user-invocable: false
*/
`.trim();
    const fm = parseWorkflowFrontmatter(source);
    expect(fm["disable-model-invocation"]).toBe(true);
    expect(fm["user-invocable"]).toBe(false);
  });

  test("strips surrounding quotes from values", () => {
    const source = `
/* smithers
name: "quoted-name"
description: 'single quoted desc'
*/
`.trim();
    const fm = parseWorkflowFrontmatter(source);
    expect(fm.name).toBe("quoted-name");
    expect(fm.description).toBe("single quoted desc");
  });
});

describe("serializeWorkflowFrontmatter", () => {
  test("round-trips a frontmatter object", () => {
    const fm = {
      name: "my-workflow",
      description: "A test workflow",
      tags: ["a", "b"],
    };
    const serialized = serializeWorkflowFrontmatter(fm);
    expect(serialized).toContain("/* smithers");
    expect(serialized).toContain("name: my-workflow");
    expect(serialized).toContain("description: A test workflow");
    expect(serialized).toContain("tags: [a, b]");
    expect(serialized).toContain("*/");
  });

  test("skips undefined/null values", () => {
    const fm = { name: "x", description: undefined };
    const serialized = serializeWorkflowFrontmatter(fm);
    expect(serialized).not.toContain("description");
  });

  test("round-trip: serialized output can be re-parsed", () => {
    const fm = { name: "roundtrip", description: "Yep", tags: ["x", "y"] };
    const serialized = serializeWorkflowFrontmatter(fm);
    const reparsed = parseWorkflowFrontmatter(serialized);
    expect(reparsed.name).toBe("roundtrip");
    expect(reparsed.description).toBe("Yep");
    expect(reparsed.tags).toEqual(["x", "y"]);
  });
});

// ---------------------------------------------------------------------------
// define
// ---------------------------------------------------------------------------

describe("defineWorkflow", () => {
  test("returns a WorkflowDefinition with the provided fields", () => {
    const fakeWorkflow = { build: () => null, opts: {} };
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

  test("throws when name is missing", () => {
    expect(() =>
      // @ts-expect-error intentionally missing name
      defineWorkflow({ description: "no name", workflow: {} })
    ).toThrow(/name is required/);
  });

  test("throws when workflow is missing", () => {
    expect(() =>
      // @ts-expect-error intentionally missing workflow
      defineWorkflow({ name: "x", description: "no wf" })
    ).toThrow(/workflow.*required/);
  });
});

describe("defineWorkflowPlugin", () => {
  test("returns a WorkflowPlugin with the provided fields", () => {
    const workflows: WorkflowDefinition[] = [
      defineWorkflow({ name: "a", description: "A", workflow: {} }),
    ];
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
      defineWorkflowPlugin({ description: "x", workflows: [] })
    ).toThrow(/name is required/);
  });

  test("throws when workflows is not an array", () => {
    expect(() =>
      // @ts-expect-error intentionally wrong type
      defineWorkflowPlugin({ name: "x", description: "y", workflows: null })
    ).toThrow(/workflows.*must be an array/);
  });
});

// ---------------------------------------------------------------------------
// formatter
// ---------------------------------------------------------------------------

describe("formatWorkflowsForPrompt", () => {
  const wf1 = defineWorkflow({
    name: "close-issues",
    description: "Fix all open issues",
    tags: ["github"],
    workflow: {},
  });
  const wf2 = defineWorkflow({
    name: "deploy",
    description: "Deploy to prod",
    aliases: ["ship"],
    workflow: {},
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
// register
// ---------------------------------------------------------------------------

describe("registerWorkflows", () => {
  test("calls registry.register for each workflow", () => {
    const registered: [string, unknown][] = [];
    const registry = {
      register(name: string, wf: unknown) {
        registered.push([name, wf]);
      },
    };

    const fakeWf = { build: () => null, opts: {} };
    const workflows = [
      defineWorkflow({ name: "alpha", description: "A", workflow: fakeWf }),
      defineWorkflow({ name: "beta", description: "B", workflow: fakeWf }),
    ];

    registerWorkflows(registry, workflows);
    expect(registered).toHaveLength(2);
    expect(registered[0]![0]).toBe("alpha");
    expect(registered[1]![0]).toBe("beta");
    expect(registered[0]![1]).toBe(fakeWf);
  });
});

describe("toSkill", () => {
  const def = defineWorkflow({
    name: "close-issues",
    description: "Fix issues",
    aliases: ["ci", "issues"],
    workflow: {},
  });

  test("name is uppercased and hyphenated to underscore", () => {
    const skill = toSkill(def);
    expect(skill.name).toBe("CLOSE_ISSUES");
  });

  test("description is forwarded", () => {
    expect(toSkill(def).description).toBe("Fix issues");
  });

  test("similes are the aliases", () => {
    expect(toSkill(def).similes).toEqual(["ci", "issues"]);
  });

  test("validate() resolves true", async () => {
    const skill = toSkill(def);
    await expect(skill.validate()).resolves.toBe(true);
  });

  test("handler() is callable and resolves false (stub)", async () => {
    const skill = toSkill(def);
    await expect(
      skill.handler(null, null, null, null, null)
    ).resolves.toBe(false);
  });

  test("examples is an empty array", () => {
    expect(toSkill(def).examples).toEqual([]);
  });
});

describe("pluginToElizaPlugin", () => {
  test("converts a WorkflowPlugin to an eliza plugin shape", () => {
    const plugin = defineWorkflowPlugin({
      name: "my-plugin",
      description: "Desc",
      workflows: [
        defineWorkflow({ name: "wf-one", description: "One", workflow: {} }),
        defineWorkflow({ name: "wf-two", description: "Two", workflow: {} }),
      ],
    });
    const elizaPlugin = pluginToElizaPlugin(plugin);
    expect(elizaPlugin.name).toBe("my-plugin");
    expect(elizaPlugin.description).toBe("Desc");
    expect(elizaPlugin.actions).toHaveLength(2);
    expect(elizaPlugin.actions[0]!.name).toBe("WF_ONE");
  });
});

// ---------------------------------------------------------------------------
// loader
// ---------------------------------------------------------------------------

describe("loadWorkflowsFromDir", () => {
  test("returns empty with a warning for a non-existent directory", async () => {
    const result = await loadWorkflowsFromDir("/nonexistent/path/xyz");
    expect(result.workflows).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.type).toBe("warning");
  });

  test("loads a workflow file that exports a WorkflowDefinition shape", async () => {
    // Write a real temp file with a default export that is a WorkflowDefinition
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    const content = `
/* smithers
name: temp-workflow
description: A temporary test workflow
tags: [test]
*/
export default {
  workflow: { build: () => null, opts: {} },
  name: "temp-workflow",
  description: "A temporary test workflow",
};
`;
    writeFileSync(join(dir, "temp-workflow.js"), content, "utf8");

    const result = await loadWorkflowsFromDir(dir);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]!.name).toBe("temp-workflow");
    expect(result.workflows[0]!.description).toBe("A temporary test workflow");
  });

  test("skips files without a recognizable export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    writeFileSync(join(dir, "not-a-workflow.js"), "export default 42;", "utf8");

    const result = await loadWorkflowsFromDir(dir);
    expect(result.workflows).toHaveLength(0);
    expect(result.diagnostics[0]!.type).toBe("warning");
  });

  test("skips non-JS/TS files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    writeFileSync(join(dir, "readme.md"), "# hello", "utf8");
    writeFileSync(
      join(dir, "valid.js"),
      "export default { workflow: {}, name: 'v', description: 'd' };",
      "utf8"
    );

    const result = await loadWorkflowsFromDir(dir);
    expect(result.workflows).toHaveLength(1);
  });

  test("derives name from filename when frontmatter has no name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-conventions-test-"));
    writeFileSync(
      join(dir, "my-cool-flow.js"),
      "export default { workflow: {}, description: 'Cool flow' };",
      "utf8"
    );

    const result = await loadWorkflowsFromDir(dir);
    expect(result.workflows[0]!.name).toBe("my-cool-flow");
  });
});
