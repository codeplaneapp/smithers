import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cli } from "incur";

// Drift guard for the Claude Code plugin's live-mirror script
// (claude-plugin/workflows/smithers-run.mjs). The mirror launches and
// attaches to runs by handing subagents literal `RUN-EXACTLY:` CLI command
// lines, so a command the CLI does not expose fails only at mirror time, for
// every Claude Code user, with no signal here. Pin every command path and
// option the script uses against the real command registry.

const SCRIPT_PATH = resolve(import.meta.dir, "../../../claude-plugin/workflows/smithers-run.mjs");

const previousDisableAutoMain = process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN;
process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN = "1";
const { cli } = await import("../src/index.js");
if (previousDisableAutoMain === undefined) {
  delete process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN;
} else {
  process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN = previousDisableAutoMain;
}

function rootCommands() {
  const commands = Cli.toCommands.get(cli);
  if (!(commands instanceof Map)) throw new Error("Smithers CLI command registry was not available");
  return commands;
}

function leaf(commandPath) {
  let entry;
  let scope = rootCommands();
  for (const token of commandPath.split(" ")) {
    entry = scope?.get(token);
    if (!entry) throw new Error(`Missing CLI command: ${commandPath}`);
    scope = entry._group ? entry.commands : undefined;
  }
  if (entry?._group) throw new Error(`Expected leaf command, got group: ${commandPath}`);
  return entry;
}

const source = readFileSync(SCRIPT_PATH, "utf8");

/**
 * Every `${CLI} <command path> ...` invocation template in the mirror script.
 * The command path is the literal token run between `${CLI}` and the first
 * interpolated argument (`${...}`), e.g. "up" or "claude node-wait".
 * @returns {string[]}
 */
function mirrorCommandPaths() {
  const paths = new Set();
  for (const match of source.matchAll(/\$\{CLI\}\s+([a-z-]+(?:\s+[a-z-]+)?)\s+\$\{/g)) {
    paths.add(match[1].replace(/\s+/, " "));
  }
  return [...paths].sort();
}

describe("claude-plugin mirror script CLI surface", () => {
  test("every RUN-EXACTLY command path the mirror uses is a real CLI leaf", () => {
    const paths = mirrorCommandPaths();
    // The mirror must at least launch (up), poll (claude tick), and watch
    // single nodes (claude node-wait).
    expect(paths).toContain("up");
    expect(paths).toContain("claude tick");
    expect(paths).toContain("claude node-wait");
    for (const commandPath of paths) {
      expect(() => leaf(commandPath), `mirror uses unknown CLI command: ${commandPath}`).not.toThrow();
    }
  });

  test("the launch command is `up` in detached mode and its options parse", () => {
    // `up <workflow> -d` is the documented detached-launch surface and takes
    // both discovered workflow IDs and file paths.
    const launch = source.match(/\$\{CLI\} up \$\{shellQuote\(String\(workflowArgs\.workflow\)\)\} -d/);
    expect(launch, "mirror launch must be `${CLI} up <workflow> -d`").toBeTruthy();
    const parsed = leaf("up").options.parse({
      detach: true,
      input: '{"prompt":"hello"}',
      startedByHarness: "claude-code",
      startedBySession: "session-1",
      startedByPrompt: "launch context",
    });
    expect(parsed).toMatchObject({
      detach: true,
      startedByHarness: "claude-code",
      startedBySession: "session-1",
      startedByPrompt: "launch context",
    });
  });

  test("the attach-path options the mirror passes parse on their leaves", () => {
    expect(leaf("claude tick").options.parse({ afterSeq: 0, wait: true, timeoutMs: 420000 })).toMatchObject({
      afterSeq: 0,
      wait: true,
      timeoutMs: 420000,
    });
    expect(leaf("claude tick").args.parse({ runId: "run-1" })).toEqual({ runId: "run-1" });
    expect(leaf("claude node-wait").options.parse({ runId: "run-1", timeoutMs: 480000 })).toMatchObject({
      runId: "run-1",
      timeoutMs: 480000,
    });
    expect(leaf("claude node-wait").args.parse({ nodeId: "node-1" })).toEqual({ nodeId: "node-1" });
  });
});
