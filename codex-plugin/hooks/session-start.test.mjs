// The Codex SessionStart hook: the root it resolves, the context it builds, the
// CLI shapes it reads, and one end-to-end run against the real `smithers`
// binary from this working tree.
//
// Run: cd codex-plugin && bun test

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOUNDARY_MARKERS,
  buildContext,
  countActiveRuns,
  findFlowsRoot,
  FLOWS_DIRECTORY,
  listProjectFlows,
  MAX_LISTED,
  probeJson,
  PROBE_TIMEOUT_MS,
  TERMINAL_RUN_STATUSES,
} from "./session-start.mjs";

const hook = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, ".mjs");
const pluginRoot = dirname(dirname(hook));
const repoRoot = dirname(pluginRoot);
const sourceCli = join(repoRoot, "packages/cli/bin/smithers.mjs");

/**
 * The Node executable. This suite runs under bun, so `process.execPath` is the
 * bun binary, and handing it a script bypasses the shebang. The hook and the
 * CLI are both Node programs and the durable engine is unsupported on bun, so
 * they are spawned with Node explicitly.
 */
const node = process.versions.bun ? "node" : process.execPath;

const created = [];
const scratch = (name) => {
  const directory = mkdtempSync(join(tmpdir(), `codex-session-start-${name}-`));
  created.push(directory);
  return directory;
};
afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

/** A CLI stand-in that prints one canned payload per verb. */
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
  return { command: node, args: [script], source: "installed", root: null };
}

describe("findFlowsRoot", () => {
  test("finds the nearest ancestor holding a flows directory", () => {
    const root = scratch("project");
    mkdirSync(join(root, FLOWS_DIRECTORY, "review"), { recursive: true });
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(findFlowsRoot(nested, "/nowhere")).toBe(root);
  });

  test("stops at a checkout marker rather than escaping the repository", () => {
    // `flows` is an ordinary directory name. An unbounded walk reported a
    // Smithers project for any session started below an unrelated one.
    const outer = scratch("outer");
    mkdirSync(join(outer, FLOWS_DIRECTORY), { recursive: true });
    const inner = join(outer, "unrelated-checkout");
    mkdirSync(join(inner, BOUNDARY_MARKERS[0]), { recursive: true });
    expect(findFlowsRoot(inner, "/nowhere")).toBeUndefined();
  });

  test("stops at the home directory", () => {
    const home = scratch("home");
    mkdirSync(join(home, FLOWS_DIRECTORY), { recursive: true });
    const below = join(home, "projects", "thing");
    mkdirSync(below, { recursive: true });
    expect(findFlowsRoot(below, home)).toBe(home);
    expect(findFlowsRoot(join(home, ".."), home)).toBeUndefined();
  });

  test("answers undefined when nothing above holds a flows directory", () => {
    const bare = scratch("bare");
    expect(findFlowsRoot(bare, bare)).toBeUndefined();
  });
});

describe("the probe budget", () => {
  test("is long enough for a real CLI start, which the 0.x two seconds was not", () => {
    expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(15000);
  });

  test("kills a wedged CLI instead of stalling the session", async () => {
    const started = Date.now();
    const stalled = { command: node, args: ["-e", "setTimeout(() => {}, 60000)"] };
    expect(await probeJson(stalled, ["ls"], process.cwd(), 250)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("the run status vocabulary", () => {
  test("is the three rc.0 terminal statuses, with no continued and no finished", () => {
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(["cancelled", "completed", "failed"]);
    expect(TERMINAL_RUN_STATUSES).not.toContain("continued");
    expect(TERMINAL_RUN_STATUSES).not.toContain("finished");
  });
});

describe("listProjectFlows", () => {
  test("reads the `_tag: flows` listing and drops the reserved system flows", async () => {
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
    expect(await listProjectFlows(cli, process.cwd())).toEqual(["create-flow/clarify", "review"]);
  });

  test("answers undefined when the CLI cannot be reached", async () => {
    const broken = { command: node, args: ["-e", "process.exit(1)"] };
    expect(await listProjectFlows(broken, process.cwd())).toBeUndefined();
  });
});

describe("countActiveRuns", () => {
  test("counts every run that is not in a terminal status", async () => {
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
    expect(await countActiveRuns(cli, process.cwd())).toBe(3);
  });

  test("does not read the 0.x dbStatus field, which no longer exists", async () => {
    const cli = scriptedCli({
      ps: JSON.stringify({ _tag: "runs", items: [{ runId: "a", dbStatus: "finished", status: "completed" }] }),
    });
    expect(await countActiveRuns(cli, process.cwd())).toBe(0);
  });
});

describe("buildContext", () => {
  const base = {
    cli: { command: "node", args: ["/x/smithers.mjs"], source: "installed", root: null },
    cliCommand: "node /x/smithers.mjs",
    flows: ["review"],
    activeRuns: 0,
  };

  test("lists the discovered flows and caps the inline list", () => {
    const many = Array.from({ length: MAX_LISTED + 3 }, (_, index) => `flow-${index}`);
    const context = buildContext({ ...base, flows: many });
    expect(context).toContain(`${many.length} flow(s) in flows/:`);
    expect(context).toContain("+3 more (call list_workflows for the full set)");
  });

  test("offers to scaffold when the directory is empty", () => {
    expect(buildContext({ ...base, flows: [] })).toContain("No flows in flows/ yet");
  });

  test("adds the source-checkout rule only inside a checkout", () => {
    expect(buildContext(base)).not.toContain("SOURCE-CHECKOUT RULE");
    const inside = buildContext({ ...base, cli: { ...base.cli, source: "workspace", root: "/src/smithers" } });
    expect(inside).toContain("SOURCE-CHECKOUT RULE");
    expect(inside).toContain("/src/smithers");
  });

  test("reports non-terminal runs, with correct grammar for one", () => {
    expect(buildContext({ ...base, activeRuns: 1 })).toContain("is 1 non-terminal Smithers run");
    expect(buildContext({ ...base, activeRuns: 4 })).toContain("are 4 non-terminal Smithers runs");
    expect(buildContext({ ...base, activeRuns: 0 })).not.toContain("non-terminal");
    expect(buildContext({ ...base, activeRuns: undefined })).not.toContain("non-terminal");
  });

  test("names the docs verb, never the removed docs-full alias", () => {
    const context = buildContext(base);
    expect(context).toContain("docs --full");
    expect(context).not.toContain("docs-full");
  });

  test("carries no removed verb, no JSX authoring API, and no .smithers/ui mandate", () => {
    const context = buildContext({
      ...base,
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
      expect(context).not.toContain(removed);
    }
    expect(context).toContain("There is no JSX authoring API, no `<Task>`, and no React reconciler");
  });
});

describe("the hook, executed against the real CLI in this working tree", () => {
  /** A source-mode CLI start costs several seconds; bun's default is five. */
  const LIVE_TIMEOUT_MS = 300_000;

  /** Runs the hook the way Codex runs it: event JSON on stdin, JSON on stdout. */
  const emitFor = (cwd) => {
    const result = spawnSync(node, [hook], {
      cwd: repoRoot,
      input: JSON.stringify({ cwd }),
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, SMITHERS_HOOK_TIMEOUT_MS: "150000" },
    });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout).hookSpecificOutput;
  };

  test("emits a well-formed SessionStart payload", () => {
    const output = emitFor(repoRoot);
    expect(output.hookEventName).toBe("SessionStart");
    expect(typeof output.additionalContext).toBe("string");
  }, LIVE_TIMEOUT_MS);

  test("injects nothing outside a Smithers project", () => {
    expect(emitFor(scratch("outside")).additionalContext).toBe("");
  }, LIVE_TIMEOUT_MS);

  test("lists the flows the real `smithers ls` discovers in this repository", () => {
    const listing = spawnSync(node, [sourceCli, "ls", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(listing.status).toBe(0);
    const discovered = listing.stdout === ""
      ? []
      : JSON.parse(listing.stdout).items
        .map((item) => item.flowId)
        .filter((flowId) => !flowId.startsWith("system/"));
    expect(discovered.length).toBeGreaterThan(0);

    const context = emitFor(repoRoot).additionalContext;
    expect(context).toContain(`${discovered.length} flow(s) in flows/:`);
    for (const flowId of discovered.slice(0, MAX_LISTED)) {
      expect(context).toContain(flowId);
    }
  }, LIVE_TIMEOUT_MS);

  test("resolves this checkout as the source tree and says so", () => {
    const context = emitFor(repoRoot).additionalContext;
    expect(context).toContain("SOURCE-CHECKOUT RULE");
    expect(context).toContain(sourceCli);
  }, LIVE_TIMEOUT_MS);
});
