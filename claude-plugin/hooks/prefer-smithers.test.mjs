// The PreToolUse hook, driven the way Claude Code drives it: one JSON document
// on stdin, one JSON document on stdout.
//
// The hook fires on every native Task, Agent, and Workflow call, so a throw or
// a malformed document here degrades every orchestration call in a session.
// It is also the one place the plugin advertises a Smithers verb and an MCP
// tool to Claude, so both are checked against the CLI's own tables rather than
// against a copy.
//
// Run: node --test "claude-plugin/**/*.test.mjs"

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import * as McpServer from "../../packages/cli/src/McpServer.ts";
import * as Unsupported from "../../packages/cli/src/Unsupported.ts";
import * as Verb from "../../packages/cli/src/Verb.ts";

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, "prefer-smithers.mjs");

/** Runs the hook with one stdin payload and returns its parsed stdout. */
const run = (payload) => {
  const result = spawnSync(process.execPath, [hook], {
    input: payload === undefined ? "" : JSON.stringify(payload),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "", "the hook must not write to stderr, which Claude surfaces to the user");
  return { text: result.stdout, json: JSON.parse(result.stdout) };
};

/** The advisory text the hook injects, for one tool name. */
const contextFor = (toolName) => run({ tool_name: toolName }).json.hookSpecificOutput.additionalContext;

describe("the PreToolUse nudge", () => {
  it("injects advisory context and never a permission decision", () => {
    const { json } = run({ tool_name: "Task", tool_input: {} });

    assert.equal(json.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.match(json.hookSpecificOutput.additionalContext, /Smithers reminder/);
    // Denying here would break every subagent call in a session. The hook is
    // a nudge, so the deciding field must be absent, not set to "allow".
    assert.ok(
      !("permissionDecision" in json.hookSpecificOutput),
      "the hook decided a permission, and it is advisory only",
    );
  });

  it("names the tool the call is about", () => {
    assert.match(contextFor("Agent"), /the native Agent tool/);
    assert.match(contextFor("Workflow"), /the native Workflow tool/);
  });

  it("stays silent for the plugin's own mirror, by script path and by name", () => {
    // The mirror is the Smithers path. Nudging it would tell Claude to
    // second-guess the launch it just made.
    assert.deepEqual(run({ tool_name: "Workflow", tool_input: { scriptPath: "/x/smithers-run.mjs" } }).json, {});
    assert.deepEqual(run({ tool_name: "Workflow", tool_input: { name: "smithers-run" } }).json, {});
    // A different script through the same tool is still nudged.
    assert.match(
      run({ tool_name: "Workflow", tool_input: { scriptPath: "/x/other.mjs" } }).json
        .hookSpecificOutput.additionalContext,
      /Smithers reminder/,
    );
  });

  it("answers on malformed and empty input rather than failing the tool call", () => {
    // Claude has no output to read if the hook dies, and the tool call it
    // guards is the one that suffers.
    const broken = spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8", timeout: 30_000 });
    assert.equal(broken.status, 0, broken.stderr);
    assert.match(JSON.parse(broken.stdout).hookSpecificOutput.additionalContext, /this orchestration tool/);

    assert.match(run(undefined).json.hookSpecificOutput.additionalContext, /this orchestration tool/);
  });

  it("advertises only a verb this release ships and a tool this release serves", () => {
    const context = contextFor("Task");
    const shipped = new Set(Verb.shipped.flatMap((verb) => [verb.name, ...verb.aliases]));
    const supported = new Set(McpServer.supportedTools.map((tool) => tool.name));

    for (const [, named] of context.matchAll(/`smithers ([a-z][a-z-]*)/g)) {
      assert.ok(shipped.has(named), `the nudge tells Claude to run \`smithers ${named}\`, which 1.0 removed`);
    }
    for (const [, named] of context.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
      assert.ok(supported.has(named), `the nudge names the MCP tool ${named}, which the rc.0 server does not serve`);
    }
    // Non-vacuous: the nudge has to point somewhere.
    assert.match(context, /`smithers up`/);
    assert.match(context, /`run_workflow`/);
  });

  it("names no removed verb at all", () => {
    const context = contextFor("Task");
    for (const entry of Unsupported.removedVerbs) {
      const names = entry.subcommands === undefined
        ? [`smithers ${entry.name}`]
        : entry.subcommands.map((subcommand) => `smithers ${entry.name} ${subcommand}`);
      for (const removed of names) {
        assert.ok(!context.includes(removed), `the nudge names the removed verb "${removed}"`);
      }
    }
  });
});
