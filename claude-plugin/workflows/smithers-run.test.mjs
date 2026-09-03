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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
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

/**
 * Every command template the mirror writes as a RUN-EXACTLY line.
 *
 * A template may carry shell prefixes before `${CLI}` (the tick line pauses
 * first), so the prefix holes are skipped and the CLI argv is what is read.
 */
const commands = [...source.matchAll(/RUN-EXACTLY: (?:\$\{\w+\})*\$\{CLI\} ([^\\\n]*)/g)].map(
  (match) => match[1],
);

describe("the commands it builds", () => {
  it("builds exactly three CLI commands: launch, tick, and node-wait", () => {
    assert.deepEqual(commands.map((command) => command.split(" ").slice(0, 2).join(" ")).sort(), [
      "claude node-wait",
      "claude tick",
      "up ${shellQuote(String(workflowArgs.flow))}",
    ]);
    const find = (prefix) => commands.find((command) => command.startsWith(prefix));
    assert.equal(find("up "), "up ${shellQuote(String(workflowArgs.flow))} -d${dataFlag} --json");
    assert.equal(find("claude tick"), "claude tick ${shellQuote(runId)} --after-seq ${seq} --json");
    // Two positionals in the CLI's own order, run id first. 0.x wrote the node
    // id positionally and the run id as `--run-id`; rc.0 takes both
    // positionally, and `effect/unstable/cli` exits 2 on the undeclared flag.
    assert.equal(
      find("claude node-wait"),
      "claude node-wait ${shellQuote(runId)} ${shellQuote(nodeId)} --timeout-ms ${NODE_WAIT_TIMEOUT_MS} --json",
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

  it("paces its own polling, because the shipped `claude tick` does not block", () => {
    // `claude tick` prints the current frame and exits. Without a pause the
    // mirror spends one Haiku turn per poll on a run that has not moved, and
    // the backstop is the only thing between a quiet run and MAX_TICKS turns.
    // So the pause is part of the command, and the backstop is a spend number
    // a reader can multiply out.
    const tick = commands.find((command) => command.startsWith("claude tick"));
    assert.ok(!tick.includes("--wait"), "the shipped `claude tick` has no blocking mode");
    assert.match(source, /RUN-EXACTLY: \$\{sleepPrefix\}\$\{CLI\} claude tick/);
    assert.match(source, /const sleepPrefix = pause === 0 \? '' : `sleep \$\{pause\} && `/);
    const cap = /^const MAX_TICKS = (\d+)$/m.exec(source);
    assert.ok(cap, "the tick loop must declare its backstop");
    assert.ok(
      Number(cap[1]) <= 1000,
      `MAX_TICKS is ${cap[1]}; every tick is one agent turn, so the backstop is a spend cap`,
    );
    const min = /^const TICK_PAUSE_MIN_S = (\d+)$/m.exec(source);
    const max = /^const TICK_PAUSE_MAX_S = (\d+)$/m.exec(source);
    assert.ok(min && max, "the mirror must declare its pause floor and ceiling");
    assert.ok(Number(min[1]) >= 1 && Number(max[1]) >= Number(min[1]));
    // The pause doubles while the run is quiet and resets when it moves.
    assert.match(source, /pauseSeconds = moved \? TICK_PAUSE_MIN_S : Math\.min\(TICK_PAUSE_MAX_S, pauseSeconds \* 2\)/);
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
    { argv: ["claude", "tick"], template: commands.find((command) => command.startsWith("claude tick")), extra: [] },
    { argv: ["claude", "node-wait"], template: commands.find((command) => command.startsWith("claude node-wait")), extra: [] },
  ];

  for (const { argv, template, extra } of cases) {
    it(`\`smithers ${argv.join(" ")}\` declares every flag the mirror writes`, (t) => {
      if (!hasClaudeVerb()) {
        t.skip(
          "the `claude` mirror verbs are not in this CLI yet. They are the cli-ops lane's " +
            "(claudeMirrorContract 2) and this suite is their consumer.",
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

  /**
   * One spawned-bin smoke per mirror invocation. The `--help` checks above read
   * the parser's declaration; these run the argv the mirror actually writes
   * through the real binary, in a throwaway project, and read the exit status.
   * `effect/unstable/cli` answers an undeclared flag with exit 2, so a status
   * that is anything else proves the line parsed and reached its handler.
   */
  describe("the argv the mirror writes runs through the real binary", () => {
    const created = [];
    after(() => {
      for (const directory of created) rmSync(directory, { recursive: true, force: true });
    });

    /** An empty project directory: a real root with no flows and no run state. */
    const project = () => {
      const root = mkdtempSync(join(tmpdir(), "mirror-smoke-"));
      created.push(root);
      mkdirSync(join(root, "flows"), { recursive: true });
      return root;
    };

    const run = (argv, cwd) =>
      spawnSync(process.execPath, [sourceCli, ...argv], { cwd, encoding: "utf8", timeout: 180_000 });

    const skipUnlessClaude = (t) => {
      if (hasClaudeVerb()) return false;
      t.skip("the `claude` mirror verbs are not in this CLI yet.");
      return true;
    };

    it("`claude tick` prints a contract-2 frame for a run this project has never seen", (t) => {
      if (skipUnlessClaude(t)) return;
      const result = run(["claude", "tick", "run-nope", "--after-seq", "0", "--json"], project());
      assert.equal(result.status, 0, result.stderr);
      const frame = JSON.parse(result.stdout);
      assert.equal(frame.contract, 2, "the mirror stops on any other contract number");
      assert.equal(frame.runId, "run-nope");
      // Every field the mirror reads off a tick, present on the emptiest frame.
      for (const field of ["status", "seq", "phases", "nodes"]) {
        assert.ok(field in frame, `the tick frame has no ${field}, which the mirror reads`);
      }
    });

    it("`claude node-wait` returns a timed-out verdict rather than hanging", (t) => {
      if (skipUnlessClaude(t)) return;
      const result = run(
        ["claude", "node-wait", "run-nope", "node-nope", "--timeout-ms", "500", "--json"],
        project(),
      );
      assert.equal(result.status, 0, result.stderr);
      const verdict = JSON.parse(result.stdout);
      assert.equal(verdict.nodeId, "node-nope");
      // The watcher prompt re-runs the command while this is true.
      assert.equal(verdict.timedOut, true);
    });

    it("`up -d --data --json` reaches the launcher, and reports an unknown flow as one", () => {
      const result = run(["up", "no-such-flow", "-d", "--data", "{}", "--json"], project());
      assert.notEqual(result.status, 2, `usage error, not a launch attempt: ${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /FlowNotFound/);
    });

    it("exits 2 on a flag the parser does not declare, which is what these smokes detect", (t) => {
      if (skipUnlessClaude(t)) return;
      // The teeth of the three cases above: a mirror template that writes a
      // flag the CLI dropped fails here, not in a live run.
      const result = run(["claude", "tick", "run-nope", "--wait", "--json"], project());
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Unrecognized flag: --wait/);
    });
  });

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
    // The CLI keeps `inspect`, `why`, `events`, `resume`,
    // `gateway`, and `workflow list` as aliases; naming one is correct.
    for (const removed of [
      "smithers ui ",
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
