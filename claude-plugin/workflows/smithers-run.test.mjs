// The /workflows mirror script.
//
// The mirror is a sandboxed Claude Code Workflow script: it runs inside a
// harness that supplies `args`, `agent`, `phase`, and `log` as free variables,
// so it cannot be imported and unit-tested the ordinary way. What can be
// checked, and what actually breaks in practice, is its contract with the CLI:
// the version it speaks, the commands it builds, and the vocabulary it treats
// as terminal. This suite compiles the body in the same shape the harness does
// and then reads it.
//
// Run: node --test "claude-plugin/**/*.test.mjs"

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./smithers-run.mjs", import.meta.url)), "utf8");

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sourceCli = join(repoRoot, "packages/cli/bin/smithers.mjs");

/** The script body, with the `export const meta` block the harness strips. */
const body = source.replace(/^export const meta = \{[\s\S]*?^\}\n/m, "");

/** The script with its `//` comment lines removed, for "names nothing removed" checks. */
const code = source
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

describe("the script shape", () => {
  it("declares the metadata the /workflows harness reads", () => {
    const meta = /export const meta = \{([\s\S]*?)^\}/m.exec(source);
    assert.ok(meta, "the script must export a meta block");
    for (const field of ["name:", "description:", "whenToUse:", "phases:"]) {
      assert.ok(meta[1].includes(field), `meta is missing ${field}`);
    }
    assert.match(meta[1], /name: 'smithers-run'/);
  });

  it("compiles as a sandbox body, where top-level await and return are legal", () => {
    assert.doesNotThrow(() => new AsyncFunction("args", "agent", "phase", "log", body));
  });

  it("uses only the four names the harness supplies, plus optional globals", () => {
    // `globalThis` guarded access is allowed; a bare `process` or `require` is
    // not, because the sandbox has neither.
    assert.ok(!/(^|[^.\w])require\(/.test(body), "the sandbox has no require");
    assert.ok(!/(^|[^.\w])process\./.test(body), "the sandbox may have no process global");
    assert.ok(!/^import /m.test(body), "the sandbox cannot import");
  });
});

describe("the mirror contract", () => {
  it("speaks claudeMirrorContract 2", () => {
    assert.match(source, /^const CONTRACT = 2$/m);
  });

  it("treats the three rc.0 terminal run statuses as terminal", () => {
    const terminal = /const TERMINAL_RUN_STATUSES = new Set\(\[([^\]]*)\]\)/.exec(source);
    assert.ok(terminal, "the script must declare its terminal run statuses");
    const values = [...terminal[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]).sort();
    assert.deepEqual(values, ["cancelled", "completed", "failed"]);
  });

  it("has no continue-as-new handling, which rc.0 does not have either", () => {
    // The header comment explains the removal, so the code is what is checked.
    for (const removed of ["continuedAs", "'continued'", "continue-as-new"]) {
      assert.ok(!code.includes(removed), `the mirror still handles ${removed}`);
    }
  });

  it("has no human-request handling, because approvals park the run instead", () => {
    for (const removed of ["humanRequests", "ask_human", "ask-human", "human answer"]) {
      assert.ok(!code.includes(removed), `the mirror still handles ${removed}`);
    }
  });

  it("declares the tick schema fields the contract carries, and no more", () => {
    const schema = /const TICK_SCHEMA = \{([\s\S]*?)^\}$/m.exec(source);
    assert.ok(schema, "the script must declare a tick schema");
    assert.match(schema[1], /required: \['contract', 'runId', 'status', 'seq', 'phases', 'nodes'\]/);
    assert.ok(schema[1].includes("approvals:"));
    assert.ok(!schema[1].includes("humanRequests:"));
    assert.ok(!schema[1].includes("continuedAs:"));
  });
});

/** Every command template the mirror writes as a RUN-EXACTLY line. */
const commands = [...source.matchAll(/RUN-EXACTLY: \$\{CLI\} ([^\\\n]*)/g)].map((match) => match[1]);

describe("the commands it builds", () => {
  it("builds exactly three CLI commands: launch, tick, and node-wait", () => {
    assert.deepEqual(commands.map((command) => command.split(" ").slice(0, 2).join(" ")).sort(), [
      "claude node-wait",
      "claude tick",
      "up ${shellQuote(String(workflowArgs.flow))}",
    ]);
    const find = (prefix) => commands.find((command) => command.startsWith(prefix));
    assert.equal(find("up "), "up ${shellQuote(String(workflowArgs.flow))} -d${dataFlag} --json");
    assert.equal(find("claude tick"), "claude tick ${shellQuote(runId)} --after-seq ${seq}${waitFlag} --json");
    assert.equal(
      find("claude node-wait"),
      "claude node-wait ${shellQuote(nodeId)} --run-id ${shellQuote(runId)} --timeout-ms ${NODE_WAIT_TIMEOUT_MS} --json",
    );
  });

  it("passes flow data with --data, the rc.0 flag", () => {
    assert.match(source, /` --data \$\{shellQuote\(JSON\.stringify\(workflowArgs\.data\)\)\}`/);
    assert.ok(!code.includes("--input"), "--input was the 0.x flag");
  });

  it("asks for JSON with the global --json flag, not the removed --format", () => {
    assert.ok(!code.includes("--format"), "--format json was the 0.x spelling");
    for (const command of commands) assert.ok(command.endsWith("--json"), command);
  });

  it("defaults to naming the package and the bin separately", () => {
    assert.match(source, /'npx --package @smthrs\/cli smithers'/);
    assert.ok(!code.includes("bunx smthrs"), "a bare bin-name lookup is what the resolver exists to avoid");
  });

  it("stamps no attribution flags, because rc.0 stamps the principal server-side", () => {
    for (const removed of ["--started-by-harness", "--started-by-session", "--started-by-prompt"]) {
      assert.ok(!code.includes(removed), `the mirror still passes ${removed}`);
    }
  });
});

describe("the CLI in this tree serves those commands", () => {
  /**
   * The mirror is a string builder: the flags it writes are never type-checked
   * against the CLI, so a verb that quietly drops one turns every tick into an
   * exit-2 usage error at runtime. `effect/unstable/cli` rejects an undeclared
   * flag rather than ignoring it, so a `--help` listing is a sufficient and
   * cheap check that the command the mirror emits will parse.
   */
  const help = (argv) =>
    spawnSync(process.execPath, [sourceCli, ...argv, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 180_000,
    });

  /** Whether the CLI in this tree carries the mirror's `claude` verb yet. */
  const hasClaudeVerb = () => {
    const listing = help([]);
    return listing.status === 0 && /^\s+claude\s/m.test(listing.stdout);
  };

  /** Every long flag one RUN-EXACTLY template writes, template holes ignored. */
  const flagsOf = (command) => [...command.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]);

  const cases = [
    { argv: ["up"], template: commands.find((command) => command.startsWith("up ")), extra: ["data"] },
    { argv: ["claude", "tick"], template: commands.find((command) => command.startsWith("claude tick")), extra: ["wait", "timeout-ms"] },
    { argv: ["claude", "node-wait"], template: commands.find((command) => command.startsWith("claude node-wait")), extra: [] },
  ];

  for (const { argv, template, extra } of cases) {
    it(`\`smithers ${argv.join(" ")}\` declares every flag the mirror writes`, (t) => {
      if (!hasClaudeVerb()) {
        t.skip(
          "the `claude` mirror verbs are not in this CLI yet. They are the cli-ops lane's " +
            "(rc-contract.md section 4.1, claudeMirrorContract 2) and this suite is their consumer.",
        );
        return;
      }
      const listing = help(argv);
      assert.equal(listing.status, 0, listing.stderr);
      // `extra` names flags the mirror writes conditionally, outside the
      // template literal, so the template alone does not carry them.
      for (const flag of [...new Set([...flagsOf(template), ...extra])]) {
        assert.ok(
          listing.stdout.includes(`--${flag}`),
          `smithers ${argv.join(" ")} does not declare --${flag}, which the mirror writes; ` +
            "effect/unstable/cli exits 2 on an undeclared flag",
        );
      }
    });
  }

  it("passes node-wait its run id the way the CLI reads it", (t) => {
    if (!hasClaudeVerb()) {
      t.skip("the `claude` mirror verbs are not in this CLI yet.");
      return;
    }
    const listing = help(["claude", "node-wait"]);
    assert.equal(listing.status, 0, listing.stderr);
    // 0.x took the run id as `--run-id` and the node id as the single
    // positional. A CLI that takes two positionals instead needs the mirror
    // template changed with it; either shape is fine, a disagreement is not.
    const template = commands.find((command) => command.startsWith("claude node-wait"));
    const declaresRunIdFlag = listing.stdout.includes("--run-id");
    assert.equal(
      template.includes("--run-id"),
      declaresRunIdFlag,
      declaresRunIdFlag
        ? "the CLI takes --run-id but the mirror does not write it"
        : "the mirror writes --run-id but the CLI takes the run id as a positional argument",
    );
  });
});

describe("what it tells the operator", () => {
  it("points at rc.0 verbs for diagnosis and approval", () => {
    assert.match(source, /smithers status \$\{runId\}/);
    assert.match(source, /smithers approve <payload>/);
    assert.match(source, /smithers logs \$\{runId\} --follow/);
  });

  it("names no removed verb", () => {
    for (const removed of [
      "smithers ui ",
      "smithers inspect",
      "workflow list",
      "smithers workflow run",
      "smithers monitor",
      "smithers graph",
      "docs-full",
    ]) {
      assert.ok(!code.includes(removed), `the mirror still names the removed \`${removed}\``);
    }
  });

  it("attaches by runId and launches by flow, the two documented argument shapes", () => {
    assert.match(source, /args\.runId \(attach\) or args\.flow \(launch\) is required/);
    assert.ok(!code.includes("workflowArgs.workflow"), "`workflow` was the 0.x argument name");
  });
});
