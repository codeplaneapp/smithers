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
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as Frontmatter from "../../../packages/registry/src/internal/Frontmatter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(dirname(here)));
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

const PLUGIN_SKILLS = {
  claude: "claude-plugin/skills/smithers/SKILL.md",
  codex: "codex-plugin/skills/smithers/SKILL.md",
};

/** Commands, flags, and APIs 1.0 removed (rc-contract.md section 4.2). */
// rc-contract section 4.2 keeps `inspect`, `why`, `events`, `resume`,
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
    const { fields, warnings } = Frontmatter.parse({ text, path });

    it("has frontmatter that parses", () => {
      assert.deepEqual(warnings.map((warning) => warning.code), []);
      assert.equal(fields.name, "smithers");
      assert.equal(typeof fields.description, "string");
    });

    it("has a description inside the 1024-character Agent Skills limit", () => {
      assert.ok(
        [...String(fields.description)].length <= 1024,
        `${path}: description is ${[...String(fields.description)].length} characters`,
      );
    });

    it("carries Rule 0, route sizing, and the no-JSX rule", () => {
      assert.match(String(fields.description), /SMITHERS_INSIDE_RUN/);
      assert.match(String(fields.description), /right-size the route first/);
      assert.match(String(fields.description), /no JSX API/);
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
      const supported = new Set([
        "list_workflows",
        "run_workflow",
        "list_runs",
        "get_run",
        "watch_run",
        "get_run_events",
        "explain_run",
        "list_pending_approvals",
        "resolve_approval",
        "get_node_detail",
        "get_chat_transcript",
      ]);
      const unsupported = [
        "revert_attempt",
        "fork_run",
        "replay_run",
        "rewind_run",
        "restore_checkpoint",
        "list_snapshots",
        "get_timeline",
        "time_travel",
        "list_artifacts",
      ];
      for (const tool of unsupported) {
        // The Codex skill documents the unsupported set by name on purpose;
        // the Claude skill must not present one as available.
        if (agent === "claude") assert.ok(!text.includes(tool), `${path} names the unsupported tool ${tool}`);
      }
      // Only the part before the unsupported roster is a claim of support.
      const claimed = text.split(/Ten more keep|Ten keep their names/)[0];
      for (const named of claimed.match(/`(list_[a-z_]+|get_[a-z_]+|run_workflow|watch_run|resolve_approval)`/g) ?? []) {
        const tool = named.slice(1, -1);
        assert.ok(supported.has(tool), `${path} presents ${tool} as a working tool`);
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
    const supported = new Set(["list_workflows", "run_workflow", "watch_run"]);
    for (const named of hint[1].match(/\b[a-z]+_[a-z_]+\b/g) ?? []) {
      assert.ok(supported.has(named), `HINT_TEXT names ${named}, which the rc.0 MCP server does not support`);
    }
  });
});
