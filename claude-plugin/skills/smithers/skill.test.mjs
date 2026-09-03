// The plugin skills, and the plugin manifests that register them.
//
// A plugin skill is loaded by its frontmatter description, so the description
// is a contract with a length limit, and the body is the only description of
// Smithers an agent gets. Both plugins are checked here because the Codex copy
// mirrors the Claude one minus the /workflows mirror.
//
// Run: node --test "claude-plugin/**/*.test.mjs"

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as Option from "effect/Option";
import * as McpServer from "../../../packages/cli/src/McpServer.ts";
import * as MarkdownFlow from "../../../packages/registry/src/MarkdownFlow.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(dirname(here)));
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

/**
 * The rc.0 MCP tool split, read from the server rather than copied.
 *
 * A copy of this list drifted once already: it named nine unsupported tools
 * when the server answers ten, so a skill could have presented `ask_human` as
 * available and the check would have passed.
 */
const SUPPORTED_TOOLS = new Set(McpServer.supportedTools.map((tool) => tool.name));
const UNSUPPORTED_TOOLS = McpServer.unsupportedTools.map((tool) => tool.name);

const PLUGIN_SKILLS = {
  claude: "claude-plugin/skills/smithers/SKILL.md",
  codex: "codex-plugin/skills/smithers/SKILL.md",
};

/** Commands, flags, and APIs 1.0 removed. */
// The CLI keeps `inspect`, `why`, `events`, `resume`,
// `gateway`, and `workflow list` as aliases, so none of them belongs here.
const REMOVED = [
  "smithers ui",
  "smithers gui",
  "smithers monitor",
  "smithers graph",
  "smithers tree",
  "smithers eval",
  "smithers workflow run",
  "smithers make-workflow",
  "smithers ask-human",
  "ask-human",
  "docs-full",
  "--backend",
  "--interactive",
  "gateway-react",
  "gateway-ui",
  "smthrs/ui",
  "bunx smthrs",
  ".smithers/workflows",
  ".smithers/ui",
  "MANDATORY UI RULE",
];

for (const [agent, path] of Object.entries(PLUGIN_SKILLS)) {
  describe(`the ${agent} plugin skill`, () => {
    const text = read(path);
    // Read through the registry's public surface, the same call
    // `skills/skills.test.mjs` uses on the curated skills, so a plugin skill
    // is held to the loader that actually reads it rather than to an internal
    // module the package does not export.
    const skillDirectory = dirname(join(repoRoot, path));
    const result = MarkdownFlow.fromMarkdown({
      text,
      path,
      baseDirectory: skillDirectory,
      naming: "frontmatter",
      name: Option.none(),
      dirBasename: basename(skillDirectory),
      provenance: { source: "project", root: dirname(skillDirectory) },
    });
    // A skill declares no capabilities of its own, so the conservative
    // wildcard warning is the expected outcome for a document.
    const warnings = result.warnings.filter((warning) => warning.code !== "unprojectable_authority");
    const description = Option.isSome(result.descriptor) ? result.descriptor.value.description : "";

    it("has frontmatter the registry loader reads", () => {
      assert.deepEqual(warnings.map((warning) => `${warning.code}: ${warning.message}`), []);
      assert.ok(Option.isSome(result.descriptor), `${path} produced no descriptor`);
      assert.equal(result.descriptor.value.name, "smithers");
      assert.equal(typeof result.descriptor.value.description, "string");
    });

    it("has a description inside the 1024-character Agent Skills limit", () => {
      assert.ok(
        [...description].length <= 1024,
        `${path}: description is ${[...description].length} characters`,
      );
    });

    it("carries Rule 0, route sizing, and the no-JSX rule", () => {
      assert.match(description, /SMITHERS_INSIDE_RUN/);
      assert.match(description, /right-size the route first/);
      assert.match(description, /no JSX API/);
      assert.match(text, /Rule 0: if you are already inside a Smithers run/);
      assert.match(text, /Right-size the route first/);
    });

    it("teaches the 1.0 authoring model", () => {
      for (const term of ["Flow.make", "Action.make", "flows/<name>/", "smithers plan", "smithers up"]) {
        assert.ok(text.includes(term), `${path} never mentions ${term}`);
      }
    });

    it("names nothing 1.0 removed", () => {
      // The migration section has to name 0.x paths to describe what to detect,
      // so the guidance above it is what is checked.
      const [guidance, migration] = text.split("## Migrating a 0.x project");
      assert.ok(migration !== undefined, `${path} must tell an agent what to do with a 0.x project`);
      for (const removed of REMOVED) {
        // Whole tokens: `smithers logs` is a shipped verb that starts with the
        // removed alias `smithers log`, and substring matching confuses them.
        const named = new RegExp(`${removed.replaceAll(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![A-Za-z0-9_-])`);
        assert.ok(!named.test(guidance), `${path} still names "${removed}"`);
      }
      assert.ok(migration.includes(".smithers/workflows/"), "the detection hint names the 0.x pack path");
    });

    it("names the removed JSX authoring API only in the sentence that retires it", () => {
      // The clean-break paragraph has to name `createSmithers` and `<Task>` to
      // say they are gone. Each may appear exactly once, and only there.
      assert.equal(text.split("createSmithers").length - 1, 1);
      assert.equal(text.split("<Task>").length - 1, 1);
      assert.match(
        text,
        /There is no JSX authoring API, no `<Task>`, no `createSmithers`, and no `\.smithers\/` pack/,
      );
    });

    it("lists only MCP tools the rc.0 server supports", () => {
      assert.equal(SUPPORTED_TOOLS.size + UNSUPPORTED_TOOLS.length, 21, "the rc.0 server serves 21 tool names");
      for (const tool of UNSUPPORTED_TOOLS) {
        // The Codex skill documents the unsupported set by name on purpose;
        // the Claude skill must not present one as available.
        if (agent === "claude") assert.ok(!text.includes(tool), `${path} names the unsupported tool ${tool}`);
      }
      // Only the part before the unsupported roster is a claim of support.
      const claimed = text.split(/Ten more keep|Ten keep their names/)[0];
      for (const named of claimed.match(/`([a-z]+_[a-z_]+)`/g) ?? []) {
        const tool = named.slice(1, -1);
        if (!SUPPORTED_TOOLS.has(tool) && !UNSUPPORTED_TOOLS.includes(tool)) continue;
        assert.ok(SUPPORTED_TOOLS.has(tool), `${path} presents ${tool} as a working tool`);
      }
    });

    it("points at the migration skill for a 0.x project", () => {
      assert.match(text, /smithers migrate/);
      assert.match(text, /migrate-smithers-v1/);
    });
  });
}

describe("the Claude plugin manifests", () => {
  it("registers the MCP server through the plugin launcher", () => {
    const mcp = JSON.parse(read("claude-plugin/.mcp.json"));
    assert.deepEqual(mcp.mcpServers.smithers, {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/bin/smithers.mjs", "--mcp"],
    });
  });

  it("declares the background monitor over the rc.0 claude verbs", () => {
    const monitors = JSON.parse(read("claude-plugin/monitors/monitors.json"));
    assert.equal(monitors.length, 1);
    assert.equal(monitors[0].name, "smithers-runs");
    assert.match(monitors[0].command, /bin\/smithers\.mjs" claude monitor$/);
    assert.match(monitors[0].description, /smithers claude subscribe <runId>/);
    assert.ok(!monitors[0].description.includes("human request"), "human requests are gone in 1.0");
    assert.match(monitors[0].description, /Completed, failed, and cancelled runs are not broadcast/);
  });

  it("carries the rc.0 version and points the monitor at itself", () => {
    const plugin = JSON.parse(read("claude-plugin/.claude-plugin/plugin.json"));
    assert.equal(plugin.name, "smithers");
    assert.equal(plugin.version, "1.0.0-rc.0");
    assert.equal(plugin.experimental.monitors, "./monitors/monitors.json");
  });

  it("keeps the SessionStart and PreToolUse hooks the plugin ships", () => {
    const hooks = JSON.parse(read("claude-plugin/hooks/hooks.json"));
    assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /session-start\.mjs/);
    assert.equal(hooks.hooks.PreToolUse[0].matcher, "Task|Agent|Workflow");
  });

  it("is pointed at by the repository-root marketplace manifest", () => {
    const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
    assert.equal(marketplace.plugins[0].source, "./claude-plugin");
  });
});

describe("the Codex plugin manifests", () => {
  it("launches the MCP server by naming the package and the bin separately", () => {
    // Codex does not substitute ${PLUGIN_ROOT} in .mcp.json, so this entry
    // cannot go through the resolver and must not ask a runner to guess a bin
    // from a package name.
    const mcp = JSON.parse(read("codex-plugin/.mcp.json"));
    assert.deepEqual(mcp.mcpServers.smithers, {
      command: "npx",
      args: ["--package", "@smthrs/cli", "smithers", "--mcp"],
    });
  });

  it("carries the rc.0 version and auto-discovered components", () => {
    const plugin = JSON.parse(read("codex-plugin/.codex-plugin/plugin.json"));
    assert.equal(plugin.name, "smithers");
    assert.equal(plugin.version, "1.0.0-rc.0");
    assert.equal(plugin.skills, "./skills/");
    assert.equal(plugin.mcpServers, "./.mcp.json");
    assert.ok(!("hooks" in plugin), "Codex 0.142 and newer reject a hooks field in plugin.json");
  });

  it("is pointed at by the .agents marketplace manifest", () => {
    const marketplace = JSON.parse(read(".agents/plugins/marketplace.json"));
    assert.equal(marketplace.plugins[0].source.path, "./codex-plugin");
  });

  it("keeps the App Server routing hint on supported MCP tool names", () => {
    const routing = read("codex-plugin/scripts/configure-codex-routing.mjs");
    const hint = /export const HINT_TEXT = "([^"]+)"/.exec(routing);
    assert.ok(hint, "the routing script must export HINT_TEXT");
    // The hint is the one sentence Codex reads before it decides whether to
    // route work to Smithers, so a tool name it advertises has to be one of
    // the 21 the server serves, and a supported one.
    const named = hint[1].match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
    assert.ok(named.length > 0, "the hint must name the tools it routes to");
    for (const tool of named) {
      assert.ok(
        SUPPORTED_TOOLS.has(tool),
        `HINT_TEXT names ${tool}, which the rc.0 MCP server ${
          UNSUPPORTED_TOOLS.includes(tool) ? "answers with an unsupported envelope" : "does not serve"
        }`,
      );
    }
  });
});
