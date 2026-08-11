import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { delimiter, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import {
  buildAgentNodeFilter,
  buildTailCommand,
  followRunIntoHerdr,
  herdrRunIdFromWorkspaceLabel,
  herdrWorkspaceLabel,
  reconcileHerdrResumeGates,
  resolveHerdrOption,
  wrapHijackPaneAfterlife,
} from "../src/herdr.js";
import { createHerdrClient, createHerdrRunSurface } from "@smthrs/herdr";
import {
  createExecutableDir,
  createTempRepo,
  pinSqliteBackend,
  prependPath,
  runSmithers,
  writeExecutable,
  writeTestWorkflow,
} from "../../../packages/smithers/tests/e2e-helpers.js";
import { isHerdrInstalled, randomSessionName, startHerdrServer } from "../../../packages/herdr/tests/herdr-server.js";

setDefaultTimeout(180_000);

const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");
const herdrInstalled = isHerdrInstalled();
/** Set by live-server suite `beforeAll` so herdr CLI listings hit the test socket. */
let activeHerdrSocketPath = "";

// Keep the spawned CLI's stderr quiet and deterministic: no skill self-heal /
// update notices (best-effort side effects that just add latency + noise). Spread
// into every smithers-CLI env below (copied from herdr-full-loop.e2e.test.js).
const QUIET_ENV = { SMITHERS_NO_SKILL_REFRESH: "1", SMITHERS_NO_UPDATE_CHECK: "1" };

// ── pure-unit coverage (always runs, no herdr binary needed) ─────────────────

describe("herdr option / label / tail-command helpers", () => {
  test("resolveHerdrOption honors the flag, then SMITHERS_HERDR", () => {
    expect(resolveHerdrOption(true, {})).toBe(true);
    expect(resolveHerdrOption("mysession", {})).toBe("mysession");
    expect(resolveHerdrOption("", {})).toBe(true);
    expect(resolveHerdrOption(false, {})).toBeUndefined();
    expect(resolveHerdrOption(undefined, {})).toBeUndefined();
    // env handoff (detached child)
    expect(resolveHerdrOption(undefined, { SMITHERS_HERDR: "1" })).toBe(true);
    expect(resolveHerdrOption(undefined, { SMITHERS_HERDR: "sess" })).toBe("sess");
    expect(resolveHerdrOption(undefined, { SMITHERS_HERDR: "0" })).toBeUndefined();
    expect(resolveHerdrOption(undefined, { SMITHERS_HERDR: "" })).toBeUndefined();
    // flag wins over env
    expect(resolveHerdrOption("flagsession", { SMITHERS_HERDR: "envsession" })).toBe("flagsession");
  });

  test("herdrWorkspaceLabel includes the versioned Smithers ownership marker", () => {
    expect(herdrWorkspaceLabel("my-workflow", "run-1783720000000-abcd")).toBe(
      "my-workflow [smithers:v1:run-1783720000000-abcd]",
    );
  });

  test("buildTailCommand runs the real `smithers tail` via this interpreter + entry, with --linger", () => {
    const argv = buildTailCommand("/abs/apps/cli/src/index.js")({ runId: "run-1", nodeId: "node-a" });
    // --linger keeps the mirror pane open after the run reaches a terminal state
    // instead of exiting and letting herdr tear the pane down.
    expect(argv).toEqual([
      process.execPath,
      "/abs/apps/cli/src/index.js",
      "tail",
      "run-1",
      "--node",
      "node-a",
      "--hud",
      "--linger",
    ]);
  });

  test("buildAgentNodeFilter does not memoize a transient DB error (retries on the next event)", async () => {
    let calls = 0;
    const adapter = {
      listAttemptsForRun: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("transient db error");
        }
        return [{ nodeId: "node-a", metaJson: JSON.stringify({ kind: "agent" }) }];
      },
    };
    const filter = buildAgentNodeFilter(adapter, "run-1");
    // First evaluation hits the throw -> `undefined` (the surface's "unknown"
    // channel, NOT a sticky `false`), and the error must NOT be cached.
    expect(await filter({ runId: "run-1", nodeId: "node-a" })).toBeUndefined();
    // The next event re-queries (the error was not memoized) and now resolves true.
    expect(await filter({ runId: "run-1", nodeId: "node-a" })).toBe(true);
    // A subsequent evaluation is served from cache - no third DB read.
    expect(await filter({ runId: "run-1", nodeId: "node-a" })).toBe(true);
    expect(calls).toBe(2);
  });

  test("herdrRunIdFromWorkspaceLabel inverts herdrWorkspaceLabel and tolerates the outcome-marker prefix", () => {
    expect(herdrRunIdFromWorkspaceLabel(herdrWorkspaceLabel("my-wf", "run-1"))).toBe("run-1");
    expect(herdrRunIdFromWorkspaceLabel("my-wf [smithers:v1:run-1783720000000-abcd]")).toBe("run-1783720000000-abcd");
    // A finished/failed/cancelled workspace keeps the run id after its marker.
    expect(herdrRunIdFromWorkspaceLabel("✓ my-wf [smithers:v1:run-1]")).toBe("run-1");
    expect(herdrRunIdFromWorkspaceLabel("✗ my-wf [smithers:v1:run-1]")).toBe("run-1");
    expect(herdrRunIdFromWorkspaceLabel("◻ my-wf [smithers:v1:run-1]")).toBe("run-1");
    expect(herdrRunIdFromWorkspaceLabel(herdrWorkspaceLabel("my-wf", "run/with spaces"))).toBe("run/with spaces");
    // Ordinary multi-word labels and malformed markers never establish ownership.
    expect(herdrRunIdFromWorkspaceLabel("my-wf run-1783720000000-abcd")).toBeUndefined();
    expect(herdrRunIdFromWorkspaceLabel("my-wf [smithers:v1:%not-encoded]")).toBeUndefined();
    expect(herdrRunIdFromWorkspaceLabel("just-a-name")).toBeUndefined();
    expect(herdrRunIdFromWorkspaceLabel("")).toBeUndefined();
    expect(herdrRunIdFromWorkspaceLabel(/** @type {any} */ (undefined))).toBeUndefined();
  });
});

describe("wrapHijackPaneAfterlife (hijack pane handback + linger)", () => {
  test("preserves command/args/cwd/env exactly and embeds the handback + a linger read", () => {
    const spec = { command: "claude", args: ["--resume", "sess-123"], cwd: "/some/run/dir", env: { FOO: "bar" } };
    const wrapped = wrapHijackPaneAfterlife(spec, [
      "[smithers] hijack session ended.",
      "  smithers up wf --resume --run-id r1",
    ]);
    expect(wrapped.command).toBe("sh");
    expect(wrapped.args[0]).toBe("-c");
    // The original argv is embedded verbatim as sh positional args after the $0 label.
    expect(wrapped.args.slice(2)).toEqual(["smithers-hijack", "claude", "--resume", "sess-123"]);
    // cwd/env preserved EXACTLY (same env object reference — no injected vars).
    expect(wrapped.cwd).toBe("/some/run/dir");
    expect(wrapped.env).toBe(spec.env);
    // The script runs `"$@"`, prints the handback, and lingers for a keypress.
    const script = wrapped.args[1];
    expect(script).toContain('"$@"');
    expect(script).toContain("smithers up wf --resume --run-id r1");
    expect(script).toContain("press any key");
    expect(script).toContain("exit $__smithers_code");
  });

  test("runs the inner command, prints the handback AFTER it, then exits with the inner code (real sh)", () => {
    // A no-TTY stdin drives the wrapper's `read` linger fallback (a piped byte),
    // so the behavior is exercisable without a PTY. printf's `\n`/`%s` prove the
    // inner argv reached the process verbatim.
    const spec = {
      command: "printf",
      args: ["INNER_RAN:%s\\n", "ok"],
      cwd: process.cwd(),
      env: { ...process.env },
    };
    const wrapped = wrapHijackPaneAfterlife(spec, ["HANDBACK_MARKER resume with: smithers up wf --resume"]);
    const res = spawnSync(wrapped.command, wrapped.args, {
      cwd: wrapped.cwd,
      env: wrapped.env,
      input: "x\n",
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("INNER_RAN:ok");
    expect(res.stdout).toContain("HANDBACK_MARKER resume with: smithers up wf --resume");
    // The handback prints AFTER the interactive session's own output.
    expect(res.stdout.indexOf("INNER_RAN:ok")).toBeLessThan(res.stdout.indexOf("HANDBACK_MARKER"));
  });

  test("propagates a non-zero inner exit code through the wrapper", () => {
    const spec = { command: "sh", args: ["-c", "exit 7"], cwd: process.cwd(), env: { ...process.env } };
    const wrapped = wrapHijackPaneAfterlife(spec, ["done"]);
    const res = spawnSync(wrapped.command, wrapped.args, { input: "x\n", encoding: "utf8", timeout: 15_000 });
    expect(res.status).toBe(7);
  });
});

// ── degradability (always runs; no herdr server, no agent CLI) ────────────────

describe("smithers up --herdr degrades when no herdr server is reachable", () => {
  test("a static workflow still completes (exit 0) with a single stderr warning", () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    writeTestWorkflow(repo, "workflow.tsx");
    const env = {
      ...QUIET_ENV,
      HOME: repo.dir,
      // Point the herdr client at a socket that cannot exist so the probe
      // fails fast (ENOENT) and the surface degrades.
      HERDR_SOCKET_PATH: "/smithers-herdr-nonexistent-xyz/deeper/herdr.sock",
    };
    const run = runSmithers(["up", "workflow.tsx", "--herdr", "--run-id", "degrade-run"], {
      cwd: repo.dir,
      env,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(run.exitCode).toBe(0);
    expect(run.json?.status).toBe("finished");
    expect(run.stderr).toContain("no herdr server is reachable");
    // Stdout purity: the degradability warning goes to stderr only, so `--format
    // json` stdout stays a single clean JSON document (parse succeeded above) with
    // no herdr diagnostics leaking into it.
    expect(run.stdout).not.toContain("herdr");
  });
});

// ── detached-run hint: herdr attach leads the watch options (#5, no herdr needed) ─

describe("smithers up -d --herdr leads the detached watch options with `herdr attach`", () => {
  test("the detach cta lists `herdr attach <run>` FIRST when the mirror is active; a plain -d run does not", () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    writeTestWorkflow(repo, "workflow.tsx");
    const baseEnv = {
      ...QUIET_ENV,
      HOME: repo.dir,
      // No reachable herdr: the detached CHILD degrades silently, but the PARENT's
      // detach guidance is driven by the --herdr flag being set, so the hint stands.
      HERDR_SOCKET_PATH: "/smithers-herdr-nonexistent-xyz/deeper/herdr.sock",
    };

    const withHerdr = runSmithers(["up", "workflow.tsx", "-d", "--herdr", "--run-id", "detach-herdr-hint"], {
      cwd: repo.dir,
      env: baseEnv,
      format: "json",
      timeoutMs: 60_000,
    });
    expect(withHerdr.exitCode).toBe(0);
    expect(withHerdr.json?.runId).toBe("detach-herdr-hint");
    const herdrCommands = withHerdr.json?.cta?.commands ?? [];
    expect(herdrCommands.length).toBeGreaterThan(0);
    // FIRST among the watch options — ahead of logs/chat/ps/inspect/ui. The cta
    // renders command strings with the `smithers ` prefix in --json output.
    expect(herdrCommands[0].command).toBe("smithers herdr attach detach-herdr-hint");

    const noHerdr = runSmithers(["up", "workflow.tsx", "-d", "--run-id", "detach-plain-hint"], {
      cwd: repo.dir,
      env: baseEnv,
      format: "json",
      timeoutMs: 60_000,
    });
    expect(noHerdr.exitCode).toBe(0);
    const plainCommands = noHerdr.json?.cta?.commands ?? [];
    // Without the mirror, no herdr attach hint appears at all.
    expect(plainCommands.some((cmd) => typeof cmd.command === "string" && cmd.command.startsWith("herdr attach"))).toBe(
      false,
    );
  }, 90_000);
});

// ── herdr attach: nonexistent run → clean error (always runs; no herdr needed) ─

describe("smithers herdr attach on a missing run", () => {
  test("nonexistent run id → RUN_NOT_FOUND, non-zero exit, no herdr contact", () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    writeTestWorkflow(repo, "workflow.tsx");
    // Seed a real store so find-db resolves; the run lookup then fails cleanly
    // (getRun returns undefined before any herdr socket is touched).
    const seed = runSmithers(["up", "workflow.tsx", "--run-id", "seed-run"], {
      cwd: repo.dir,
      env: { ...QUIET_ENV, HOME: repo.dir },
      format: "json",
      timeoutMs: 120_000,
    });
    expect(seed.exitCode).toBe(0);

    const attach = runSmithers(["herdr", "attach", "does-not-exist"], {
      cwd: repo.dir,
      env: {
        ...QUIET_ENV,
        HOME: repo.dir,
        // Even if the lookup somehow reached herdr, this socket cannot exist.
        HERDR_SOCKET_PATH: "/smithers-herdr-nonexistent-xyz/deeper/herdr.sock",
      },
      format: "json",
      timeoutMs: 30_000,
    });
    expect(attach.exitCode).toBe(4);
    expect(attach.json?.code).toBe("RUN_NOT_FOUND");
  });
});

// ── herdr status: absent path (always runs; pure socket client) ───────────────

describe("smithers herdr status", () => {
  test("absent server → clear message and non-zero exit", () => {
    const run = runSmithers(["herdr", "status"], {
      cwd: process.cwd(),
      env: { ...QUIET_ENV, HERDR_SOCKET_PATH: "/smithers-herdr-nonexistent-xyz/deeper/herdr.sock" },
      format: "json",
      timeoutMs: 30_000,
    });
    expect(run.exitCode).toBe(4);
    expect(run.json?.code).toBe("HERDR_UNAVAILABLE");
  });
});

// ── real-herdr integration (skips cleanly when herdr is absent, e.g. in CI) ────

/**
 * Query the herdr socket via the CLI (which prints the raw JSON envelope) against
 * a specific session.
 *
 * @param {string[]} args
 * @param {string} session
 * @returns {any}
 */
/**
 * @param {string[]} args
 * @param {string} session
 * @param {string} [socketPath] absolute socket for the test server (required when
 *   the parent process may set HERDR_SOCKET_PATH to a different session)
 */
/**
 * Env for `herdr` CLI against the throwaway test server (not the parent TUI).
 * @param {string} session
 * @param {string} [socketPath]
 */
function herdrCliEnv(session, socketPath = activeHerdrSocketPath) {
  return {
    ...process.env,
    HERDR_SESSION: session,
    // Prefer the throwaway server socket. Parent herdr (ops) often exports
    // HERDR_SOCKET_PATH; that would otherwise win over HERDR_SESSION.
    HERDR_SOCKET_PATH: socketPath || "",
  };
}

function herdrJson(args, session, socketPath = activeHerdrSocketPath) {
  const res = spawnSync("herdr", args, {
    env: herdrCliEnv(session, socketPath),
    encoding: "utf8",
  });
  try {
    return JSON.parse(res.stdout);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} session
 * @returns {any[]}
 */
/**
 * @param {string} session
 * @param {string} [socketPath]
 * @returns {any[]}
 */
function listAgents(session, socketPath) {
  const parsed = herdrJson(["agent", "list"], session, socketPath);
  return parsed?.result?.agents ?? [];
}

/**
 * @param {string} session
 * @param {string} [socketPath]
 * @returns {any[]}
 */
function listWorkspaces(session, socketPath) {
  const parsed = herdrJson(["workspace", "list"], session, socketPath);
  return parsed?.result?.workspaces ?? [];
}

/**
 * @param {string} session
 * @param {string} name
 * @param {string} [socketPath]
 * @returns {string | undefined}
 */
function statusOf(session, name, socketPath) {
  const agent = listAgents(session, socketPath).find((a) => a && a.name === name);
  return agent?.agent_status;
}

/**
 * herdr 0.7+ surfaces finished panes as agent_status "done" (older builds used "idle"
 * after report_agent state=idle). Treat both as finished for e2e transitions.
 * @param {string | undefined} status
 */
function isFinishedAgentStatus(status) {
  return status === "idle" || status === "done";
}

/**
 * Match a workspace by exact label, finished marker (`✓ label`), or embedded run id.
 * @param {string} label
 * @param {string} [runId]
 */
function workspaceMatches(label, runId) {
  return (w) =>
    w &&
    (w.label === label ||
      w.label === `✓ ${label}` ||
      w.label === `✗ ${label}` ||
      w.label === `◻ ${label}` ||
      (runId != null && herdrRunIdFromWorkspaceLabel(w.label) === runId));
}

/**
 * @param {string} session
 * @param {string} name
 * @param {string} [socketPath]
 * @returns {string | undefined}
 */
function customStatusOf(session, name, socketPath) {
  const agent = listAgents(session, socketPath).find((a) => a && a.name === name);
  return agent?.custom_status;
}

/**
 * The sorted set of `smithers:<runId>:*` pane names currently in the session.
 *
 * @param {string} session
 * @param {string} runId
 * @param {string} [socketPath]
 * @returns {string[]}
 */
function runPaneNames(session, runId, socketPath) {
  return listAgents(session, socketPath)
    .filter((a) => typeof a.name === "string" && a.name.startsWith(`smithers:${runId}:`))
    .map((a) => a.name)
    .sort();
}

/**
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, timeoutMs = 60_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return Boolean(await predicate());
}

/**
 * A fake `claude` binary that answers `auth status` immediately, then sleeps
 * FAKE_CLAUDE_DELAY_MS before emitting a schema-valid turn — long enough that a
 * sequential multi-node run stays observably live while a test inspects herdr.
 *
 * @param {string} dir
 */
function writeSlowFakeClaude(dir) {
  return writeExecutable(
    dir,
    "claude",
    [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2);",
      "if (args.join(' ') === 'auth status') {",
      "  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) + '\\n');",
      "  process.exit(0);",
      "}",
      "const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? '3000');",
      "await new Promise((r) => setTimeout(r, delay));",
      'const payload = \'{"answer":"ok"}\';',
      "process.stdout.write(JSON.stringify({",
      '  type: "turn_end",',
      '  message: { role: "assistant", content: [{ type: "text", text: "```json\\n" + payload + "\\n```\\n" }] },',
      '}) + "\\n");',
      "",
    ].join("\n"),
  );
}

const THREE_AGENT_WORKFLOW = [
  "/** @jsxImportSource smthrs */",
  'import { ClaudeCodeAgent, createSmithers } from "smthrs";',
  'import { z } from "zod";',
  "",
  "const schema = z.object({ answer: z.string() });",
  'const claude = new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: process.cwd() });',
  "const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({",
  "  a: schema, b: schema, c: schema,",
  "});",
  "",
  "export default smithers(() => (",
  '  <Workflow name="herdr-live">',
  "    <Sequence>",
  '      <Task id="node-a" output={outputs.a} agent={claude} timeoutMs={120000}>{\'Return JSON {"answer":"ok"}\'}</Task>',
  '      <Task id="node-b" output={outputs.b} agent={claude} timeoutMs={120000}>{\'Return JSON {"answer":"ok"}\'}</Task>',
  '      <Task id="node-c" output={outputs.c} agent={claude} timeoutMs={120000}>{\'Return JSON {"answer":"ok"}\'}</Task>',
  "    </Sequence>",
  "  </Workflow>",
  "));",
  "",
].join("\n");

// A single-agent workflow (fast) for the concurrent-run collision test.
const ONE_AGENT_WORKFLOW = [
  "/** @jsxImportSource smthrs */",
  'import { ClaudeCodeAgent, createSmithers } from "smthrs";',
  'import { z } from "zod";',
  "",
  "const schema = z.object({ answer: z.string() });",
  'const claude = new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: process.cwd() });',
  "const { Workflow, Task, smithers, outputs } = createSmithers({ a: schema });",
  "",
  "export default smithers(() => (",
  '  <Workflow name="one-agent">',
  '    <Task id="node-a" output={outputs.a} agent={claude} timeoutMs={120000}>{\'Return JSON {"answer":"ok"}\'}</Task>',
  "  </Workflow>",
  "));",
  "",
].join("\n");

// A mixed workflow: one agent node + one static (compute-less literal) node. The
// static node's attempt is recorded with kind !== "agent", so the surface's
// agent-only nodeFilter must NOT give it a pane.
const MIXED_WORKFLOW = [
  "/** @jsxImportSource smthrs */",
  'import { ClaudeCodeAgent, createSmithers } from "smthrs";',
  'import { z } from "zod";',
  "",
  "const schema = z.object({ answer: z.string() });",
  "const stat = z.object({ ok: z.boolean() });",
  'const claude = new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: process.cwd() });',
  "const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({ a: schema, b: stat });",
  "",
  "export default smithers(() => (",
  '  <Workflow name="mixed-wf">',
  "    <Sequence>",
  '      <Task id="agent-a" output={outputs.a} agent={claude} timeoutMs={120000}>{\'Return JSON {"answer":"ok"}\'}</Task>',
  '      <Task id="static-b" output={outputs.b}>{{ ok: true }}</Task>',
  "    </Sequence>",
  "  </Workflow>",
  "));",
  "",
].join("\n");

describe.skipIf(!herdrInstalled)("smithers herdr against a real herdr server", () => {
  /** @type {Awaited<ReturnType<typeof startHerdrServer>>} */
  let server;
  /** Absolute socket for listAgents/listWorkspaces (see herdrJson). */
  let sock = "";

  beforeAll(async () => {
    server = await startHerdrServer();
    sock = server.socketPath;
    activeHerdrSocketPath = server.socketPath;
  });

  afterAll(async () => {
    await server?.dispose();
    sock = "";
    activeHerdrSocketPath = "";
  });

  test("herdr status reports version, protocol, and compatibility", () => {
    const run = runSmithers(["herdr", "status"], {
      cwd: process.cwd(),
      env: { ...QUIET_ENV, ...herdrCliEnv(server.session) },
      format: "json",
      timeoutMs: 30_000,
    });
    expect(run.exitCode).toBe(0);
    expect(run.json?.protocol).toBe(16);
    expect(run.json?.compatible).toBe(true);
    expect(typeof run.json?.version).toBe("string");
  });

  test("up --herdr mirrors a live run; herdr attach adopts it and keeps following", async () => {
    const binDir = createExecutableDir();
    writeSlowFakeClaude(binDir);
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    repo.write(".claude/.credentials.json", "{}\n");
    repo.write("herdr-live.tsx", THREE_AGENT_WORKFLOW);
    const runId = `herdr-live-${randomSessionName()}`;
    const label = herdrWorkspaceLabel("herdr-live", runId);
    // Use the absolute socket path (not HERDR_SESSION): the run/CLI env sets
    // HOME=repo.dir for agent isolation, which would otherwise reroute herdr's
    // homedir-relative session socket lookup to a nonexistent path.
    const env = prependPath(binDir, {
      ...QUIET_ENV,
      HOME: repo.dir,
      HERDR_SOCKET_PATH: server.socketPath,
      ANTHROPIC_API_KEY: "",
      FAKE_CLAUDE_DELAY_MS: "3500",
    });
    const nameA = `smithers:${runId}:node-a`;
    const nameB = `smithers:${runId}:node-b`;
    const nameC = `smithers:${runId}:node-c`;

    try {
      // Detached: the surface runs in the child (env handoff), so this returns
      // immediately with the run id while the run keeps executing.
      const launch = runSmithers(["up", "herdr-live.tsx", "--herdr", "--run-id", runId, "-d"], {
        cwd: repo.dir,
        env,
        format: "json",
        timeoutMs: 60_000,
      });
      expect(launch.exitCode).toBe(0);

      // up --herdr end-to-end: the deterministic workspace exists and the first
      // node's pane transitions working -> idle while the second is still working
      // (its tail pane follows the RUN's terminal state, so a finished node's
      // pane stays alive/idle while later nodes run — an observable transition).
      const transitioned = await waitFor(
        () => isFinishedAgentStatus(statusOf(server.session, nameA)) && statusOf(server.session, nameB) === "working",
        90_000,
      );
      expect(transitioned).toBe(true);
      // Workspace may already carry the finished marker (✓) if the run raced ahead.
      expect(
        listWorkspaces(server.session).filter(
          (w) => w.label === label || w.label === `✓ ${label}` || herdrRunIdFromWorkspaceLabel(w.label) === runId,
        ).length,
      ).toBe(1);

      // Attach a SECOND surface to the live run.
      const attach = spawn(process.execPath, [CLI_ENTRY, "herdr", "attach", runId], {
        cwd: repo.dir,
        env: { ...process.env, ...env },
        stdio: "ignore",
      });
      try {
        // Adopts, not duplicates. Assert the no-duplication INVARIANTS continuously
        // while the attach surface reconciles (find-or-create the workspace by label,
        // adopt the existing panes by name): the run's workspace count never leaves 1
        // and no pane name outside the run's own agent nodes ever appears. Polling the
        // invariant is race-free w.r.t. node-c legitimately starting mid-window (which
        // adds nameC) - unlike a point-in-time snapshot equality, a duplicate workspace
        // or a stray pane is sticky and would be caught on any tick.
        const allowedPaneNames = new Set([nameA, nameB, nameC]);
        const settleDeadline = Date.now() + 4_500;
        do {
          expect(listWorkspaces(server.session).filter((w) => w.label === label).length).toBe(1);
          const names = runPaneNames(server.session, runId);
          expect(names.includes(nameA)).toBe(true);
          expect(names.every((n) => allowedPaneNames.has(n))).toBe(true);
          await new Promise((r) => setTimeout(r, 250));
        } while (Date.now() < settleDeadline);

        // A status change lands post-attach: node-b finishes (idle) while node-c
        // is still working, so the mirror stays live after the adoption — the
        // per-pane seq is seeded from Date.now() so the adopted pane is not frozen.
        const bWentIdle = await waitFor(
          () => isFinishedAgentStatus(statusOf(server.session, nameB)) && statusOf(server.session, nameC) === "working",
          90_000,
        );
        expect(bWentIdle).toBe(true);
      } finally {
        attach.kill("SIGINT");
      }

      // Mirror panes now run `smithers tail --linger`, so they deliberately stay
      // registered after the run reaches its terminal state; the workspace close
      // in `finally` tears their PTYs down.
    } finally {
      const ws = listWorkspaces(server.session).find((w) => w.label === label);
      if (ws) {
        spawnSync("herdr", ["workspace", "close", ws.workspace_id], {
          env: herdrCliEnv(server.session),
        });
      }
    }
  });

  test("herdr attach on a finished run prints a summary and creates no panes", () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    writeTestWorkflow(repo, "workflow.tsx");
    const runId = `herdr-done-${randomSessionName()}`;
    // Absolute socket path so the HOME override does not break herdr resolution.
    const env = { ...QUIET_ENV, HOME: repo.dir, HERDR_SOCKET_PATH: server.socketPath };

    // Drive a static run to completion (no agent, no mirror).
    const done = runSmithers(["up", "workflow.tsx", "--run-id", runId], {
      cwd: repo.dir,
      env,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(done.exitCode).toBe(0);
    expect(done.json?.status).toBe("finished");

    // Attaching to an already-terminal run summarizes and exits without panes.
    const attach = runSmithers(["herdr", "attach", runId], {
      cwd: repo.dir,
      env,
      format: "json",
      timeoutMs: 30_000,
    });
    expect(attach.exitCode).toBe(0);
    expect(attach.json?.attached).toBe(false);
    expect(
      listAgents(server.session).some((a) => typeof a.name === "string" && a.name.startsWith(`smithers:${runId}:`)),
    ).toBe(false);
  });

  test("nodeFilter: only agent nodes get a pane; the pane runs `smithers tail` in the run dir", async () => {
    const binDir = createExecutableDir();
    writeSlowFakeClaude(binDir);
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    repo.write(".claude/.credentials.json", "{}\n");
    repo.write("mixed.tsx", MIXED_WORKFLOW);
    const runId = `mixed-${randomSessionName()}`;
    const label = herdrWorkspaceLabel("mixed", runId);
    const env = prependPath(binDir, {
      ...QUIET_ENV,
      HOME: repo.dir,
      HERDR_SOCKET_PATH: server.socketPath,
      ANTHROPIC_API_KEY: "",
      // Keep the agent node observably live long enough to inspect its pane.
      FAKE_CLAUDE_DELAY_MS: "6000",
    });
    const nameA = `smithers:${runId}:agent-a`;
    const nameB = `smithers:${runId}:static-b`;
    try {
      const launch = runSmithers(["up", "mixed.tsx", "--herdr", "--run-id", runId, "-d"], {
        cwd: repo.dir,
        env,
        format: "json",
        timeoutMs: 60_000,
      });
      expect(launch.exitCode).toBe(0);

      // The agent node gets a pane...
      const paneAppeared = await waitFor(
        () => Boolean(listAgents(server.session).find((a) => a.name === nameA)),
        60_000,
      );
      expect(paneAppeared).toBe(true);
      // ...the static node never does. Give the sequence a beat past agent-a so a
      // (buggy) static pane would have had time to appear.
      await new Promise((r) => setTimeout(r, 1_500));
      const paneA = listAgents(server.session).find((a) => a.name === nameA);
      const paneB = listAgents(server.session).find((a) => a.name === nameB);
      expect(paneA).toBeDefined();
      expect(paneB).toBeUndefined();

      // The pane actually ran `smithers tail RUN --node agent-a` in the run
      // directory: if the cwd were wrong the viewer could not open the run's
      // store, so seeing agent-a's own lifecycle lines proves the tail command
      // resolved (dev checkout) AND launched in the correct directory.
      const client = createHerdrClient({ socketPath: server.socketPath, logger: () => {} });
      const sawTail = await waitFor(
        async () => {
          const read = /** @type {any} */ (
            await client.call("pane.read", { pane_id: paneA.pane_id, source: "visible" }).catch(() => undefined)
          );
          const text = read?.read?.text;
          return typeof text === "string" && text.includes("agent-a");
        },
        30_000,
        500,
      );
      expect(sawTail).toBe(true);

      // Mirror panes now run `smithers tail --linger`, so they deliberately do
      // NOT drain themselves when the run finishes (the human comes back to read
      // what happened). Cleanup is by closing the workspace below, which tears the
      // pane's PTY down and terminates the lingering tail.
    } finally {
      const ws = listWorkspaces(server.session).find((w) => w.label === label);
      if (ws) {
        spawnSync("herdr", ["workspace", "close", ws.workspace_id], {
          env: herdrCliEnv(server.session),
        });
      }
    }
  });

  test("two concurrent up --herdr runs in one session stay isolated (distinct workspaces, disjoint panes)", async () => {
    const binDir = createExecutableDir();
    writeSlowFakeClaude(binDir);
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    repo.write(".claude/.credentials.json", "{}\n");
    repo.write("one-agent.tsx", ONE_AGENT_WORKFLOW);
    const run1 = `concur1-${randomSessionName()}`;
    const run2 = `concur2-${randomSessionName()}`;
    const label1 = herdrWorkspaceLabel("one-agent", run1);
    const label2 = herdrWorkspaceLabel("one-agent", run2);
    // Keep both agents "working" for the whole assertion window so neither
    // run's panes are GC'd mid-check (herdr may drop finished agents).
    const longDelay = { FAKE_CLAUDE_DELAY_MS: "120000" };
    const env = prependPath(binDir, {
      ...QUIET_ENV,
      HOME: repo.dir,
      HERDR_SOCKET_PATH: server.socketPath,
      HERDR_ENV: "0",
      SMITHERS_HERDR_DOCK: "0",
      ANTHROPIC_API_KEY: "",
      ...longDelay,
    });
    const name1 = `smithers:${run1}:node-a`;
    const name2 = `smithers:${run2}:node-a`;
    try {
      // Launch both runs (detached) into the SAME herdr session. The pre-review
      // bug collapsed them onto one workspace + colliding pane names (identity
      // keyed on the shared first-8-chars of the default run id); full-runId
      // identity keeps them apart.
      const l1 = runSmithers(["up", "one-agent.tsx", "--herdr", "--run-id", run1, "-d"], {
        cwd: repo.dir,
        env,
        format: "json",
        timeoutMs: 60_000,
      });
      expect(l1.exitCode).toBe(0);
      // Wait until run1's mirror is up before starting run2 — two cold
      // opens of the same SQLite store from detached children can lose a
      // surface. Isolation under test is herdr session (two live mirrors).
      expect(await waitFor(() => Boolean(listAgents(server.session).find((a) => a.name === name1)), 60_000)).toBe(true);
      const pane1Early = listAgents(server.session).find((a) => a.name === name1);
      expect(pane1Early?.workspace_id).toBeTruthy();

      // Second store so SQLite single-writer does not contend with run1.
      const repo2 = createTempRepo();
      pinSqliteBackend(repo2.dir);
      repo2.write(".claude/.credentials.json", "{}\n");
      repo2.write("one-agent.tsx", ONE_AGENT_WORKFLOW);
      const env2 = prependPath(binDir, {
        ...QUIET_ENV,
        HOME: repo2.dir,
        HERDR_SOCKET_PATH: server.socketPath,
        HERDR_ENV: "0",
        SMITHERS_HERDR_DOCK: "0",
        ANTHROPIC_API_KEY: "",
        ...longDelay,
      });

      const l2 = runSmithers(["up", "one-agent.tsx", "--herdr", "--run-id", run2, "-d"], {
        cwd: repo2.dir,
        env: env2,
        format: "json",
        timeoutMs: 60_000,
      });
      expect(l2.exitCode).toBe(0);

      // Isolation: both run workspaces must exist as distinct herdr workspaces.
      // Prefer workspace inventory (stable) over simultaneous agent-list rows
      // (some herdr builds only list agents in the focused workspace).
      expect(await waitFor(() => listWorkspaces(server.session).some(workspaceMatches(label2, run2)), 60_000)).toBe(
        true,
      );
      const w1 = listWorkspaces(server.session).find(workspaceMatches(label1, run1));
      const w2 = listWorkspaces(server.session).find(workspaceMatches(label2, run2));
      if (!w1 || !w2) {
        throw new Error(
          `workspace isolation failed. labels=${JSON.stringify(listWorkspaces(server.session).map((w) => w.label))} agents=${JSON.stringify(listAgents(server.session).map((a) => ({ n: a.name, w: a.workspace_id })))} early=${pane1Early.workspace_id}`,
        );
      }
      expect(w1.workspace_id).toBe(pane1Early.workspace_id);
      expect(w2.workspace_id).not.toBe(w1.workspace_id);

      // Mirror panes now `--linger` past each run's terminal state; the workspace
      // closes in `finally` are what clean them up.
    } finally {
      for (const [l, id] of [
        [label1, run1],
        [label2, run2],
      ]) {
        const ws = listWorkspaces(server.session).find(workspaceMatches(l, id));
        if (ws) {
          spawnSync("herdr", ["workspace", "close", ws.workspace_id], { env: herdrCliEnv(server.session) });
        }
      }
    }
  });

  test("reconcileHerdrResumeGates re-flags an adopted approved gate so resume resolves it idle/approved (not stuck blocked)", async () => {
    // Regression for the park -> approve -> resume flow across TWO processes. The
    // default `smithers up` EXITS when it parks at a gate (exit 3); the human
    // approves (node re-armed to `pending`, approval row `approved`) and resumes
    // in a fresh process. That process's agent-only nodeFilter rejects the
    // attempt-less gate node, so without reconciliation it never touches the
    // parked pane and the gate sits stuck "blocked". reconcileHerdrResumeGates
    // must adopt the pane and re-flag the gate so the live resolution reads
    // idle/approved.
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const runId = `run-resume-gate-${Date.now()}`;
    const label = `smithers-test-cli-resume-gate-${randomSessionName()}`;
    const gateName = `smithers:${runId}:ship-approval`;
    const stubTail = () => ["bash", "-c", "sleep 120"];
    const now = Date.now();
    try {
      // Seed the exact post-approve DB state: run live, gate node re-armed to
      // `pending`, and an `approved` approval row carrying the gate question.
      await adapter.insertRun({
        runId,
        workflowName: "resume-gate-fixture",
        status: "running",
        createdAtMs: now - 2000,
        startedAtMs: now - 2000,
        finishedAtMs: null,
      });
      await adapter.insertNode({
        runId,
        nodeId: "ship-approval",
        iteration: 0,
        state: "pending",
        lastAttempt: 1,
        updatedAtMs: now,
        outputTable: "",
        label: "Ship the haiku?",
      });
      await adapter.insertOrUpdateApproval({
        runId,
        nodeId: "ship-approval",
        iteration: 0,
        status: "approved",
        requestedAtMs: now - 1000,
        decidedAtMs: now,
        note: null,
        decidedBy: "tester",
        requestJson: JSON.stringify({ title: "Ship the haiku?" }),
        decisionJson: null,
        autoApproved: false,
      });

      // Process 1: parked the gate blocked, then exited (close()).
      const client1 = createHerdrClient({ socketPath: server.socketPath, logger: () => {} });
      const s1 = createHerdrRunSurface({
        client: client1,
        workspaceLabel: label,
        logger: () => {},
        tailCommand: stubTail,
      });
      s1.onEvent({
        type: "NodeWaitingApproval",
        runId,
        nodeId: "ship-approval",
        iteration: 0,
        request: { title: "Ship the haiku?" },
        timestampMs: Date.now(),
      });
      expect(await waitFor(() => statusOf(server.session, gateName) === "blocked", 60_000)).toBe(true);
      await s1.close();

      // Process 2: resume with the REAL agent-only filter (rejects the gate node).
      const client2 = createHerdrClient({ socketPath: server.socketPath, logger: () => {} });
      const s2 = createHerdrRunSurface({
        client: client2,
        workspaceLabel: label,
        logger: () => {},
        tailCommand: stubTail,
        nodeFilter: buildAgentNodeFilter(adapter, runId),
      });
      await reconcileHerdrResumeGates(adapter, runId, s2);
      // The re-armed gate re-runs as a compute node on resume: NodeStarted ->
      // NodeFinished, with NO NodeWaitingApproval this time.
      s2.onEvent({
        type: "NodeStarted",
        runId,
        nodeId: "ship-approval",
        iteration: 0,
        attempt: 1,
        timestampMs: Date.now(),
      });
      s2.onEvent({
        type: "NodeFinished",
        runId,
        nodeId: "ship-approval",
        iteration: 0,
        attempt: 1,
        timestampMs: Date.now(),
      });

      // Lands idle "approved" (not stuck "blocked", not the "done" of an agent node).
      expect(await waitFor(() => isFinishedAgentStatus(statusOf(server.session, gateName)), 60_000)).toBe(true);
      expect(
        await waitFor(
          () => listAgents(server.session).find((a) => a && a.name === gateName)?.custom_status === "approved",
          60_000,
        ),
      ).toBe(true);
      // Adopted, not duplicated.
      expect(listAgents(server.session).filter((a) => a && a.name === gateName).length).toBe(1);
      await s2.close();
    } finally {
      sqlite.close();
      const ws = listWorkspaces(server.session).find((w) => w.label === label);
      if (ws) {
        spawnSync("herdr", ["workspace", "close", ws.workspace_id], { env: herdrCliEnv(server.session) });
      }
    }
  });

  test("herdr attach re-flags an adopted parked gate so a live approval resolves it idle/approved (not working/done)", async () => {
    // Sibling of the resume-gate regression, for the `herdr attach` path. Attach
    // runs followRunIntoHerdr, which ADOPTS the parked gate pane (entry.paneId is
    // set) — and that is exactly why the surface's own NodeWaitingApproval
    // gate-discriminator (`!entry.paneId`) can no longer fire, so the synth event
    // alone would leave the gate resolving working -> "done". followRunIntoHerdr
    // must itself re-flag the gate (markApprovalGate) so a LIVE approval resolves
    // the adopted pane idle/"approved", consistent with reconcileHerdrResumeGates.
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const runId = `run-attach-gate-${Date.now()}`;
    const label = `smithers-test-cli-attach-gate-${randomSessionName()}`;
    const gateName = `smithers:${runId}:ship-approval`;
    const stubTail = () => ["bash", "-c", "sleep 120"];
    const now = Date.now();
    let s2;
    let cancelled = false;
    try {
      // Seed a LIVE run parked at a pure approval gate: run + node waiting-approval,
      // with a `requested` approval row carrying the gate question. The waiting
      // run status keeps computeRunStateFromRow reporting an ACTIVE state (so the
      // follow loop keeps polling) until we flip it terminal below.
      await adapter.insertRun({
        runId,
        workflowName: "attach-gate-fixture",
        status: "waiting-approval",
        createdAtMs: now - 2000,
        startedAtMs: now - 2000,
        finishedAtMs: null,
      });
      await adapter.insertNode({
        runId,
        nodeId: "ship-approval",
        iteration: 0,
        state: "waiting-approval",
        lastAttempt: 1,
        updatedAtMs: now,
        outputTable: "",
        label: "Ship the haiku?",
      });
      await adapter.insertOrUpdateApproval({
        runId,
        nodeId: "ship-approval",
        iteration: 0,
        status: "requested",
        requestedAtMs: now - 1000,
        decidedAtMs: null,
        note: null,
        decidedBy: null,
        requestJson: JSON.stringify({ title: "Ship the haiku?" }),
        decisionJson: null,
        autoApproved: false,
      });

      // Process 1: parked the gate blocked, then exited (close()) — leaving a pane
      // a fresh attach must adopt (paneId set), not recreate. Its gate message is
      // deliberately DISTINCT from the DB approval's title so the pane's
      // custom_status is a reliable "process 2 has re-flagged and re-synthed the
      // gate" signal below (herdr keeps the last pushed custom_status).
      const client1 = createHerdrClient({ socketPath: server.socketPath, logger: () => {} });
      const s1 = createHerdrRunSurface({
        client: client1,
        workspaceLabel: label,
        logger: () => {},
        tailCommand: stubTail,
      });
      s1.onEvent({
        type: "NodeWaitingApproval",
        runId,
        nodeId: "ship-approval",
        iteration: 0,
        request: { title: "parked by process 1" },
        timestampMs: Date.now(),
      });
      expect(await waitFor(() => customStatusOf(server.session, gateName) === "parked by process 1", 60_000)).toBe(
        true,
      );
      await s1.close();

      // Process 2: `herdr attach` follows the live run with the REAL agent-only
      // filter (which rejects the attempt-less gate node).
      const client2 = createHerdrClient({ socketPath: server.socketPath, logger: () => {} });
      s2 = createHerdrRunSurface({
        client: client2,
        workspaceLabel: label,
        logger: () => {},
        tailCommand: stubTail,
        nodeFilter: buildAgentNodeFilter(adapter, runId),
      });
      const run = await adapter.getRun(runId);
      const followDone = followRunIntoHerdr(adapter, run, s2, { pollIntervalMs: 150, isCancelled: () => cancelled });

      // Wait for the adopted pane's custom_status to become the DB gate question.
      // This is precisely the fix under test: followRunIntoHerdr adopts the pane
      // (entry.paneId set), so the NodeWaitingApproval handler's own `!entry.paneId`
      // self-flag can NOT fire; only followRunIntoHerdr's own markApprovalGate makes
      // the synth push the gate question as custom_status. Without the fix the pane
      // keeps process 1's "parked by process 1" and never reaches this state. Reaching
      // it also proves setup finished (event-seq snapshot taken) BEFORE we append the
      // resolution events below, so they are guaranteed to be drained live.
      expect(await waitFor(() => customStatusOf(server.session, gateName) === "Ship the haiku?", 60_000)).toBe(true);
      // Adopted, never duplicated.
      expect(listAgents(server.session).filter((a) => a && a.name === gateName).length).toBe(1);

      // Approve + finish the gate LIVE: mark the approval decided and append the
      // events the engine emits, then flip the run terminal so the follow loop
      // drains them and stops. NodeFinished on a re-flagged gate resolves the pane
      // to idle "approved" (an un-flagged gate would resolve to the "done" of an
      // ordinary agent node — the bug this guards).
      await adapter.insertOrUpdateApproval({
        runId,
        nodeId: "ship-approval",
        iteration: 0,
        status: "approved",
        requestedAtMs: now - 1000,
        decidedAtMs: Date.now(),
        note: null,
        decidedBy: "tester",
        requestJson: JSON.stringify({ title: "Ship the haiku?" }),
        decisionJson: null,
        autoApproved: false,
      });
      await adapter.insertEventWithNextSeq({
        runId,
        timestampMs: Date.now(),
        type: "ApprovalGranted",
        payloadJson: JSON.stringify({
          type: "ApprovalGranted",
          runId,
          nodeId: "ship-approval",
          iteration: 0,
          timestampMs: Date.now(),
        }),
      });
      await adapter.insertEventWithNextSeq({
        runId,
        timestampMs: Date.now(),
        type: "NodeFinished",
        payloadJson: JSON.stringify({
          type: "NodeFinished",
          runId,
          nodeId: "ship-approval",
          iteration: 0,
          attempt: 1,
          timestampMs: Date.now(),
        }),
      });
      await adapter.updateRun(runId, { status: "finished", finishedAtMs: Date.now() });

      const finalStatus = await followDone;
      expect(finalStatus).toBe("finished");
      // Lands idle "approved" (not stuck "blocked", not the "done" of an agent node).
      expect(await waitFor(() => isFinishedAgentStatus(statusOf(server.session, gateName)), 60_000)).toBe(true);
      expect(await waitFor(() => customStatusOf(server.session, gateName) === "approved", 60_000)).toBe(true);
      // Still a single adopted pane.
      expect(listAgents(server.session).filter((a) => a && a.name === gateName).length).toBe(1);
    } finally {
      cancelled = true;
      if (s2) {
        await s2.close();
      }
      sqlite.close();
      const ws = listWorkspaces(server.session).find((w) => w.label === label);
      if (ws) {
        spawnSync("herdr", ["workspace", "close", ws.workspace_id], { env: herdrCliEnv(server.session) });
      }
    }
  });

  test("herdr open places an on-demand node pane and an overview pane, adopting on re-open", async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const runId = `herdr-open-${randomSessionName()}`;
    const now = Date.now();
    // A finished run whose node was never paned by the mirror — `herdr open` must
    // still surface its lingering output tail on demand.
    await adapter.insertRun({
      runId,
      workflowName: "open-wf",
      workflowPath: "open-wf.tsx",
      status: "finished",
      createdAtMs: now - 3000,
      startedAtMs: now - 3000,
      finishedAtMs: now - 1000,
    });
    await adapter.insertNode({
      runId,
      nodeId: "node-a",
      iteration: 0,
      state: "finished",
      lastAttempt: 1,
      updatedAtMs: now,
      outputTable: "",
      label: "Node A",
    });
    sqlite.close();
    const env = { ...QUIET_ENV, HOME: repo.dir, HERDR_SOCKET_PATH: server.socketPath };
    const nodeName = `smithers:${runId}:node-a`;
    const overviewName = `smithers:${runId}:overview`;
    try {
      const open1 = runSmithers(["herdr", "open", runId, "node-a"], {
        cwd: repo.dir,
        env,
        format: "json",
        timeoutMs: 30_000,
      });
      expect(open1.exitCode).toBe(0);
      expect(open1.json?.name).toBe(nodeName);
      expect(await waitFor(() => Boolean(listAgents(server.session).find((a) => a.name === nodeName)), 30_000)).toBe(
        true,
      );

      // Re-open adopts the same pane (agent name identity), never duplicates.
      const open2 = runSmithers(["herdr", "open", runId, "node-a"], {
        cwd: repo.dir,
        env,
        format: "json",
        timeoutMs: 30_000,
      });
      expect(open2.exitCode).toBe(0);
      expect(listAgents(server.session).filter((a) => a.name === nodeName).length).toBe(1);

      // No node id → the run-level overview pane.
      const openOverview = runSmithers(["herdr", "open", runId], {
        cwd: repo.dir,
        env,
        format: "json",
        timeoutMs: 30_000,
      });
      expect(openOverview.exitCode).toBe(0);
      expect(openOverview.json?.name).toBe(overviewName);
      expect(
        await waitFor(() => Boolean(listAgents(server.session).find((a) => a.name === overviewName)), 30_000),
      ).toBe(true);
    } finally {
      const ws = listWorkspaces(server.session).find((w) => herdrRunIdFromWorkspaceLabel(w.label) === runId);
      if (ws) {
        spawnSync("herdr", ["workspace", "close", ws.workspace_id], { env: herdrCliEnv(server.session) });
      }
    }
  });

  test("herdr clean closes terminal-run workspaces, leaving active and unknown-run workspaces untouched", async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const now = Date.now();
    const finishedRun = `clean-fin-${randomSessionName()}`;
    const activeRun = `clean-run-${randomSessionName()}`;
    // A) terminal run known to the DB → its workspace should be closed.
    await adapter.insertRun({
      runId: finishedRun,
      workflowName: "clean-wf",
      workflowPath: "clean-wf.tsx",
      status: "finished",
      createdAtMs: now - 3000,
      startedAtMs: now - 3000,
      finishedAtMs: now - 1000,
    });
    await adapter.insertNode({
      runId: finishedRun,
      nodeId: "node-a",
      iteration: 0,
      state: "finished",
      lastAttempt: 1,
      updatedAtMs: now,
      outputTable: "",
      label: "Node A",
    });
    // B) active run known to the DB → its workspace must be left open.
    await adapter.insertRun({
      runId: activeRun,
      workflowName: "clean-wf",
      workflowPath: "clean-wf.tsx",
      status: "running",
      createdAtMs: now - 2000,
      startedAtMs: now - 2000,
      finishedAtMs: null,
      heartbeatAtMs: now,
    });
    await adapter.insertNode({
      runId: activeRun,
      nodeId: "node-a",
      iteration: 0,
      state: "in-progress",
      lastAttempt: 1,
      updatedAtMs: now,
      outputTable: "",
      label: "Node A",
    });
    sqlite.close();
    const env = { ...QUIET_ENV, HOME: repo.dir, HERDR_SOCKET_PATH: server.socketPath };
    const finishedLabel = herdrWorkspaceLabel("clean-wf", finishedRun);
    const activeLabel = herdrWorkspaceLabel("clean-wf", activeRun);
    // C) a workspace whose label maps to NO known run → never touched.
    const ghostLabel = herdrWorkspaceLabel("clean-wf", `clean-ghost-${randomSessionName()}`);
    // D) an operator workspace that mentions a known terminal run id but lacks
    // the ownership marker → never touched.
    const collisionLabel = `operator notes ${finishedRun}`;
    try {
      // Create the finished- and active-run workspaces via `herdr open` (overview).
      const openFin = runSmithers(["herdr", "open", finishedRun], {
        cwd: repo.dir,
        env,
        format: "json",
        timeoutMs: 30_000,
      });
      const openAct = runSmithers(["herdr", "open", activeRun], {
        cwd: repo.dir,
        env,
        format: "json",
        timeoutMs: 30_000,
      });
      expect(openFin.exitCode).toBe(0);
      expect(openAct.exitCode).toBe(0);
      // The ghost workspace, created directly via herdr (no smithers run behind it).
      const ghostCreate = spawnSync("herdr", ["workspace", "create", "--label", ghostLabel], {
        env: herdrCliEnv(server.session),
        encoding: "utf8",
      });
      expect(ghostCreate.status ?? ghostCreate.exitCode ?? 0).toBe(0);
      const collisionCreate = spawnSync("herdr", ["workspace", "create", "--label", collisionLabel], {
        env: herdrCliEnv(server.session),
        encoding: "utf8",
      });
      expect(collisionCreate.status ?? collisionCreate.exitCode ?? 0).toBe(0);

      const sawFin = await waitFor(
        () => Boolean(listWorkspaces(server.session).find(workspaceMatches(finishedLabel, finishedRun))),
        30_000,
      );
      const sawAct = await waitFor(
        () => Boolean(listWorkspaces(server.session).find(workspaceMatches(activeLabel, activeRun))),
        30_000,
      );
      if (!sawFin || !sawAct) {
        throw new Error(
          `clean workspaces missing fin=${sawFin} act=${sawAct} labels=${JSON.stringify(listWorkspaces(server.session).map((w) => w.label))} wantFin=${finishedLabel} wantAct=${activeLabel} openFin=${JSON.stringify(openFin.json)} openAct=${JSON.stringify(openAct.json)}`,
        );
      }
      expect(sawFin).toBe(true);
      expect(sawAct).toBe(true);
      expect(
        await waitFor(() => Boolean(listWorkspaces(server.session).find((w) => w.label === ghostLabel)), 30_000),
      ).toBe(true);
      expect(
        await waitFor(() => Boolean(listWorkspaces(server.session).find((w) => w.label === collisionLabel)), 30_000),
      ).toBe(true);

      const clean = runSmithers(["herdr", "clean"], { cwd: repo.dir, env, format: "json", timeoutMs: 30_000 });
      expect(clean.exitCode).toBe(0);
      // Only the terminal run's workspace is reported closed.
      const closedRunIds = (clean.json?.closed ?? []).map((entry) => entry.runId);
      expect(closedRunIds).toContain(finishedRun);
      expect(closedRunIds).not.toContain(activeRun);

      // The terminal workspace is gone; the active and ghost ones remain.
      expect(listWorkspaces(server.session).some(workspaceMatches(finishedLabel, finishedRun))).toBe(false);
      expect(listWorkspaces(server.session).some(workspaceMatches(activeLabel, activeRun))).toBe(true);
      expect(listWorkspaces(server.session).some((w) => w.label === ghostLabel)).toBe(true);
      expect(listWorkspaces(server.session).some((w) => w.label === collisionLabel)).toBe(true);
    } finally {
      for (const [label, runId] of [
        [finishedLabel, finishedRun],
        [activeLabel, activeRun],
        [ghostLabel, undefined],
        [collisionLabel, undefined],
      ]) {
        const ws = listWorkspaces(server.session).find(
          runId ? workspaceMatches(label, runId) : (w) => w.label === label,
        );
        if (ws) {
          spawnSync("herdr", ["workspace", "close", ws.workspace_id], { env: herdrCliEnv(server.session) });
        }
      }
    }
  });
});
