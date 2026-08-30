// The Claude Code SessionStart hook: the context it builds, the CLI shapes it
// reads, and one end-to-end run against the real `smithers` binary from this
// working tree.
//
// Run: node --test "claude-plugin/**/*.test.mjs"

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildContext,
  countActiveRuns,
  FLOWS_DIRECTORY,
  listProjectFlows,
  MIRROR_DEFAULT_CLI,
  PROBE_TIMEOUT_MS,
  probeJson,
  TERMINAL_RUN_STATUSES,
} from "./session-start.mjs";

const hook = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, ".mjs");
const pluginRoot = dirname(dirname(hook));
const repoRoot = dirname(pluginRoot);
const sourceCli = join(repoRoot, "packages/cli/bin/smithers.mjs");

const created = [];
const scratch = (name) => {
  const directory = mkdtempSync(join(tmpdir(), `session-start-${name}-`));
  created.push(directory);
  return directory;
};
after(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

/** A CLI stand-in that prints one canned payload for `ls` and one for `ps`. */
function scriptedCli(payloads) {
  const directory = scratch("scripted");
  const script = join(directory, "cli.mjs");
  writeFileSync(
    script,
    `const verb = process.argv[2];\n` +
      `const payloads = ${JSON.stringify(payloads)};\n` +
      `if (!(verb in payloads)) process.exit(1);\n` +
      `process.stdout.write(payloads[verb]);\n`,
  );
  return { command: process.execPath, args: [script], source: "installed", root: null };
}

const project = () => {
  const root = scratch("project");
  mkdirSync(join(root, FLOWS_DIRECTORY), { recursive: true });
  return root;
};

describe("the probe budget", () => {
  it("is long enough for a real CLI start, which the 0.x two seconds was not", () => {
    assert.ok(PROBE_TIMEOUT_MS >= 15000, "a source-checkout `smithers ls` takes about five seconds cold");
  });
});

describe("the terminal run statuses", () => {
  it("are the three rc.0 terminal statuses, and `continued` is not one", () => {
    assert.deepEqual([...TERMINAL_RUN_STATUSES].sort(), ["cancelled", "completed", "failed"]);
    assert.ok(!TERMINAL_RUN_STATUSES.includes("continued"), "rc.0 has no continued status");
    assert.ok(!TERMINAL_RUN_STATUSES.includes("finished"), "the 0.x `finished` status is gone");
  });

  it("agree with the control plane's own RunStatus literals", () => {
    const schema = spawnSync(
      process.execPath,
      ["-e", "console.log(require('node:fs').readFileSync('packages/control/src/ControlSchema.ts','utf8'))"],
      { cwd: repoRoot, encoding: "utf8" },
    ).stdout;
    const literals = /export const RunStatus = Schema\.Literals\(\[([^\]]+)\]\)/.exec(schema);
    assert.ok(literals, "ControlSchema must declare RunStatus as a literal union");
    const values = [...literals[1].matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
    for (const status of TERMINAL_RUN_STATUSES) {
      assert.ok(values.includes(status), `${status} must be a real RunStatus value`);
    }
    assert.ok(!values.includes("continued"), "RunStatus must not gain a continued value");
  });
});

describe("listProjectFlows", () => {
  it("reads the `_tag: flows` listing and drops the reserved system flows", async () => {
    const cli = scriptedCli({
      ls: JSON.stringify({
        _tag: "flows",
        items: [
          { flowId: "system/plan", description: "Reserved plan system flow" },
          { flowId: "review", description: "Reviews a change." },
          { flowId: "create-flow/clarify", description: "Clarifies a request." },
        ],
      }),
    });
    assert.deepEqual(await listProjectFlows(cli), ["create-flow/clarify", "review"]);
  });

  it("answers undefined when the CLI cannot be reached", async () => {
    assert.equal(await listProjectFlows({ command: process.execPath, args: ["-e", "process.exit(1)"] }), undefined);
  });

  it("answers undefined on output that is not the listing shape", async () => {
    assert.equal(await listProjectFlows(scriptedCli({ ls: "not json" })), undefined);
  });

  it("answers undefined when the CLI outlives its budget, instead of stalling the session", async () => {
    const started = Date.now();
    const stalled = { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] };
    assert.equal(await probeJson(stalled, ["ls"], 250), undefined);
    assert.ok(Date.now() - started < 10_000, "the probe must be killed at its budget, not awaited");
  });
});

describe("countActiveRuns", () => {
  it("counts every run that is not in a terminal status", async () => {
    const cli = scriptedCli({
      ps: JSON.stringify({
        _tag: "runs",
        items: [
          { runId: "a", status: "running" },
          { runId: "b", status: "waiting-approval" },
          { runId: "c", status: "parked" },
          { runId: "d", status: "completed" },
          { runId: "e", status: "failed" },
          { runId: "f", status: "cancelled" },
        ],
      }),
    });
    assert.equal(await countActiveRuns(cli), 3);
  });

  it("does not read the 0.x dbStatus field, which no longer exists", async () => {
    const cli = scriptedCli({
      ps: JSON.stringify({ _tag: "runs", items: [{ runId: "a", dbStatus: "finished", status: "completed" }] }),
    });
    assert.equal(await countActiveRuns(cli), 0);
  });

  it("answers undefined when the CLI cannot be reached", async () => {
    assert.equal(await countActiveRuns({ command: process.execPath, args: ["-e", "process.exit(1)"] }), undefined);
  });
});

describe("buildContext", () => {
  const base = {
    cli: { command: "node", args: ["/x/smithers.mjs"], source: "installed", root: null },
    cliCommand: "node /x/smithers.mjs",
    mirrorScript: "/plugins/smithers/workflows/smithers-run.mjs",
    flows: ["review"],
    activeRuns: 0,
  };

  it("injects nothing when the project has neither flows nor a flows directory", () => {
    assert.equal(buildContext({ ...base, cwd: scratch("bare"), flows: [] }), "");
  });

  it("injects a scaffolding hint for a flows directory that is still empty", () => {
    const context = buildContext({ ...base, cwd: project(), flows: [] });
    assert.match(context, /No flows in flows\/ yet/);
    assert.match(context, /init <name>/);
  });

  it("lists the discovered flows", () => {
    const context = buildContext({ ...base, cwd: project(), flows: ["create-flow/clarify", "review"] });
    assert.match(context, /Flows in flows\/: create-flow\/clarify, review\./);
  });

  it("names the mirror script and the 1.0 mirror arguments", () => {
    const context = buildContext({ ...base, cwd: project() });
    assert.match(context, /smithers-run\.mjs/);
    assert.match(context, /flow: "<flow-id>"/);
    assert.match(context, /data: \{ \.\.\. \}/);
    assert.ok(!context.includes("workflow: \"<id>\""), "the 0.x mirror argument is gone");
    assert.ok(!context.includes("input: {"), "the 0.x input argument is gone");
  });

  it("passes an explicit cli argument only when it differs from the mirror's default", () => {
    const withDefault = buildContext({
      ...base,
      cwd: project(),
      cli: { ...base.cli, source: "published" },
      cliCommand: MIRROR_DEFAULT_CLI,
    });
    assert.ok(!withDefault.includes("cli:"), "naming the mirror's own default would be noise");
    assert.match(buildContext({ ...base, cwd: project() }), /cli: "node \/x\/smithers\.mjs"/);
  });

  it("adds the source-checkout rule only inside a checkout", () => {
    assert.ok(!buildContext({ ...base, cwd: project() }).includes("SOURCE-CHECKOUT RULE"));
    const inside = buildContext({
      ...base,
      cwd: project(),
      cli: { ...base.cli, source: "workspace", root: "/src/smithers" },
    });
    assert.match(inside, /SOURCE-CHECKOUT RULE/);
    assert.match(inside, /\/src\/smithers/);
  });

  it("reports non-terminal runs, with correct grammar for one", () => {
    assert.match(buildContext({ ...base, cwd: project(), activeRuns: 1 }), /is 1 non-terminal Smithers run/);
    assert.match(buildContext({ ...base, cwd: project(), activeRuns: 4 }), /are 4 non-terminal Smithers runs/);
    assert.ok(!buildContext({ ...base, cwd: project(), activeRuns: 0 }).includes("non-terminal"));
    assert.ok(!buildContext({ ...base, cwd: project(), activeRuns: undefined }).includes("non-terminal"));
  });

  it("names the docs verb, never the removed docs-full alias", () => {
    const context = buildContext({ ...base, cwd: project() });
    assert.match(context, /docs --full/);
    assert.ok(!context.includes("docs-full"));
  });

  it("carries no removed verb, no JSX authoring API, and no .smithers/ui mandate", () => {
    const context = buildContext({
      ...base,
      cwd: project(),
      cli: { ...base.cli, source: "workspace", root: "/src/smithers" },
      activeRuns: 2,
    });
    for (const removed of [
      ".smithers/ui",
      "MANDATORY UI RULE",
      "gateway-ui",
      "gateway-react",
      "smithers ui ",
      "workflow run",
      "smithers monitor",
      "ask_human",
      "--backend",
      "bunx smthrs",
      "check:dts",
    ]) {
      assert.ok(!context.includes(removed), `the injected context still mentions "${removed}"`);
    }
    // `<Task>` appears exactly once, in the sentence that says it is gone.
    assert.equal(context.split("<Task>").length - 1, 1);
    assert.match(context, /There is no JSX authoring API, no `<Task>`, and no React reconciler/);
  });

  it("names only MCP tools the rc.0 server actually supports", () => {
    const context = buildContext({ ...base, cwd: project() });
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
    for (const named of context.match(/\b[a-z_]+_[a-z_]+\b/g) ?? []) {
      if (named.endsWith("_run") || named.startsWith("list_") || named.startsWith("get_") || named.startsWith("resolve_")) {
        assert.ok(supported.has(named), `${named} is not a supported rc.0 MCP tool`);
      }
    }
  });
});

describe("the hook, executed against the real CLI in this working tree", () => {
  /** Runs the hook exactly as Claude Code runs it, and decodes its stdout. */
  const emitFrom = (cwd) => {
    // The live suite runs several source-mode CLI starts at once, so the
    // hook is given an explicit budget rather than racing its own default.
    const result = spawnSync(process.execPath, [hook], {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, SMITHERS_HOOK_TIMEOUT_MS: "150000" },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput;
  };

  it("emits a well-formed SessionStart payload", () => {
    const output = emitFrom(repoRoot);
    assert.equal(output.hookEventName, "SessionStart");
    assert.equal(typeof output.additionalContext, "string");
  });

  it("injects nothing outside a Smithers project", () => {
    assert.equal(emitFrom(scratch("outside")).additionalContext, "");
  });

  it("lists the flows the real `smithers ls` discovers in this repository", () => {
    const listing = spawnSync(process.execPath, [sourceCli, "ls", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(listing.status, 0, listing.stderr);
    const discovered = JSON.parse(listing.stdout).items
      .map((item) => item.flowId)
      .filter((flowId) => !flowId.startsWith("system/"))
      .sort();
    assert.ok(discovered.length > 0, "this repository must ship project flows for this test to mean anything");

    const context = emitFrom(repoRoot).additionalContext;
    assert.match(context, /Flows in flows\/:/);
    for (const flowId of discovered) {
      assert.ok(context.includes(flowId), `the injected context omits the discovered flow ${flowId}`);
    }
  });

  it("resolves this checkout as the source tree and says so", () => {
    const context = emitFrom(repoRoot).additionalContext;
    assert.match(context, /SOURCE-CHECKOUT RULE/);
    assert.ok(context.includes(sourceCli), "the context must name this tree's CLI entry");
  });
});
