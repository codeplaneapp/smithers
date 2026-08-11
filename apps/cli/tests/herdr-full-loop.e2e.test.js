// Spec D5: the full-loop end-to-end test for the herdr mirror plane. One real,
// throwaway herdr server per file (spawned in beforeAll, disposed in afterAll,
// never the `smithers-dev`/default sessions) drives four cross-cutting CLI+herdr
// flows against fresh workspaces (each test uses a unique run id -> unique
// deterministic label -> its own workspace):
//
//   1. `smithers up --herdr` mirrors a live 2-agent-node run: the deterministic
//      workspace exists, both agent nodes get `smithers:<runId>:*` panes whose
//      status transitions working -> idle as the run completes, and a non-agent
//      node gets no pane.
//   2. Killing the herdr server MID-run: the run still finishes with exit 0 (the
//      degradability contract - herdr is never on the run's hot path).
//   3. `smithers tail --format jsonl` on the finished run: every line parses as
//      JSON and the agent nodes' output text is present.
//   4. `smithers herdr attach` on a still-running run: it adopts the existing
//      workspace/panes without duplicating them, and a status change lands
//      post-attach (proving the adopted panes are not frozen).
//
// Real-backend, no mocks: a fake `claude` CLI on PATH (the repo's e2e pattern)
// drives real agent nodes, and the real `herdr` binary is the fixture. The whole
// suite skips cleanly when `herdr` is absent (CI has neither herdr nor agent
// CLIs), so it stays green there.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { herdrRunIdFromWorkspaceLabel, herdrWorkspaceLabel } from "../src/herdr.js";
import {
  createExecutableDir,
  createTempRepo,
  pinSqliteBackend,
  prependPath,
  runSmithers,
  writeExecutable,
} from "../../../packages/smithers/tests/e2e-helpers.js";
import { isHerdrInstalled, randomSessionName, startHerdrServer } from "../../../packages/herdr/tests/herdr-server.js";

setDefaultTimeout(180_000);

const BUN_BINARY = process.execPath;
const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");
const herdrInstalled = isHerdrInstalled();

// Keep the fake-agent runs' stderr quiet and deterministic: no skill self-heal /
// update notices (best-effort side effects that just add latency + noise).
const QUIET_ENV = { SMITHERS_NO_SKILL_REFRESH: "1", SMITHERS_NO_UPDATE_CHECK: "1" };

/**
 * A fake `claude` CLI: answers `auth status` immediately, then sleeps
 * FAKE_CLAUDE_DELAY_MS before emitting a schema-valid turn carrying
 * `{"answer":"ok"}`. The delay keeps a sequential multi-node run observably live
 * long enough to inspect the mirror between node transitions.
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

// A 3-node sequence: a non-agent (literal) node FIRST, then two agent nodes. The
// static node runs before either agent, so once an agent pane is observably live
// the static node has already executed - a robust check that the agent-only
// nodeFilter never gave it a pane. The two agents run one after another, so a
// finished agent's pane (following the RUN's terminal state) stays alive/idle
// while the next agent works: an observable working -> idle transition.
const LOOP_WORKFLOW = [
  "/** @jsxImportSource smthrs */",
  'import { ClaudeCodeAgent, createSmithers } from "smthrs";',
  'import { z } from "zod";',
  "",
  "const schema = z.object({ answer: z.string() });",
  "const stat = z.object({ ok: z.boolean() });",
  'const claude = new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: process.cwd() });',
  "const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({ a: schema, b: schema, s: stat });",
  "",
  "export default smithers(() => (",
  '  <Workflow name="loop-wf">',
  "    <Sequence>",
  '      <Task id="static-s" output={outputs.s}>{{ ok: true }}</Task>',
  '      <Task id="node-a" output={outputs.a} agent={claude} timeoutMs={120000}>{\'Return JSON {"answer":"ok"}\'}</Task>',
  '      <Task id="node-b" output={outputs.b} agent={claude} timeoutMs={120000}>{\'Return JSON {"answer":"ok"}\'}</Task>',
  "    </Sequence>",
  "  </Workflow>",
  "));",
  "",
].join("\n");

// ── herdr CLI JSON query helpers (the CLI mirrors the socket API 1:1) ─────────

/**
 * @param {string[]} args
 * @param {string} session
 * @returns {any}
 */
/** @type {string} */
let activeHerdrSocketPath = "";

/**
 * herdr 0.7+ finished panes report agent_status "done" (older: "idle").
 * @param {string | undefined} status
 */
function isFinishedAgentStatus(status) {
  return status === "idle" || status === "done";
}

function herdrJson(args, session) {
  const res = spawnSync("herdr", args, {
    env: {
      ...process.env,
      HERDR_SESSION: session,
      // Parent herdr may set HERDR_SOCKET_PATH; pin the throwaway test server.
      HERDR_SOCKET_PATH: activeHerdrSocketPath || "",
    },
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
function listAgents(session) {
  return herdrJson(["agent", "list"], session)?.result?.agents ?? [];
}

/**
 * @param {string} session
 * @returns {any[]}
 */
function listWorkspaces(session) {
  return herdrJson(["workspace", "list"], session)?.result?.workspaces ?? [];
}

/**
 * @param {string} session
 * @param {string} name
 * @returns {string | undefined}
 */
function statusOf(session, name) {
  return listAgents(session).find((a) => a && a.name === name)?.agent_status;
}

/**
 * The sorted set of `smithers:<runId>:*` pane names currently in the session.
 *
 * @param {string} session
 * @param {string} runId
 * @returns {string[]}
 */
function runPaneNames(session, runId) {
  return listAgents(session)
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
 * Close the run's workspace so the shared throwaway server has no lingering
 * mirror between tests (the surface never closes it - it is left for humans).
 *
 * @param {string} session
 * @param {string} label
 */
function closeWorkspace(session, label) {
  // Prefix-tolerant: a run that finished renames its workspace with an outcome
  // marker (`✓ <label>`), so match on the run id (via herdrRunIdFromWorkspaceLabel)
  // as well as the exact label, or the cleanup would miss a just-finished run.
  const targetRunId = herdrRunIdFromWorkspaceLabel(label);
  const ws = listWorkspaces(session).find(
    (w) => w.label === label || (targetRunId && herdrRunIdFromWorkspaceLabel(w.label) === targetRunId),
  );
  if (ws) {
    spawnSync("herdr", ["workspace", "close", ws.workspace_id], {
      env: {
        ...process.env,
        HERDR_SESSION: session,
        HERDR_SOCKET_PATH: activeHerdrSocketPath || "",
      },
    });
  }
}

/**
 * Spawn `smithers up` in the FOREGROUND (non-detached) so the child's own exit
 * code is the run's outcome. Captures stdout/stderr and resolves on close.
 *
 * @param {string[]} args
 * @param {{ cwd: string; env: Record<string, string | undefined> }} options
 */
function spawnUp(args, options) {
  const child = spawn(BUN_BINARY, ["run", CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (c) => (stdout += c));
  child.stderr?.on("data", (c) => (stderr += c));
  const exited = new Promise((res) => child.once("close", (code) => res(code ?? 1)));
  return { child, readStdout: () => stdout, readStderr: () => stderr, exited };
}

/**
 * Build the CLI env for a fake-agent run pointed at the shared herdr server.
 * Uses the ABSOLUTE socket path (not HERDR_SESSION) because HOME is overridden
 * to the temp repo for agent isolation, which would otherwise reroute herdr's
 * homedir-relative session-socket lookup to a nonexistent path.
 *
 * @param {string} binDir
 * @param {string} repoDir
 * @param {string} socketPath
 * @param {number} delayMs
 */
function runEnv(binDir, repoDir, socketPath, delayMs) {
  return prependPath(binDir, {
    ...QUIET_ENV,
    HOME: repoDir,
    HERDR_SOCKET_PATH: socketPath,
    // Never dock into a leftover workspace from a prior test / parent herdr.
    HERDR_ENV: "0",
    SMITHERS_HERDR_DOCK: "0",
    ANTHROPIC_API_KEY: "",
    FAKE_CLAUDE_DELAY_MS: String(delayMs),
  });
}

/**
 * A temp repo primed for a fake-claude agent run: sqlite backend pinned, empty
 * claude credentials (so the fake `auth status` path is taken), and the loop
 * workflow written to `<name>.tsx` (whose basename is the workflow id in the
 * deterministic label).
 *
 * @param {string} workflowFile
 */
function primeRepo(workflowFile) {
  const repo = createTempRepo();
  pinSqliteBackend(repo.dir);
  repo.write(".claude/.credentials.json", "{}\n");
  repo.write(workflowFile, LOOP_WORKFLOW);
  return repo;
}

describe.skipIf(!herdrInstalled)("herdr full loop (real herdr server + fake agent CLI)", () => {
  /** @type {Awaited<ReturnType<typeof startHerdrServer>>} */
  let server;

  beforeAll(async () => {
    server = await startHerdrServer();
    activeHerdrSocketPath = server.socketPath;
  });

  afterAll(async () => {
    activeHerdrSocketPath = "";
    await server?.dispose();
  });

  // ── Scenario 1: up --herdr mirrors a live run ────────────────────────────
  test("(1) up --herdr mirrors a live 2-agent run: deterministic workspace, agent panes transition working->idle, non-agent node gets no pane", async () => {
    const binDir = createExecutableDir();
    writeSlowFakeClaude(binDir);
    const repo = primeRepo("mirror.tsx");
    const runId = `mirror-${randomSessionName()}`;
    const label = herdrWorkspaceLabel("mirror", runId);
    const env = runEnv(binDir, repo.dir, server.socketPath, 3000);
    const nameA = `smithers:${runId}:node-a`;
    const nameB = `smithers:${runId}:node-b`;
    const nameStatic = `smithers:${runId}:static-s`;

    try {
      // Detached: the surface runs in the child (env handoff), so this returns
      // immediately with the run id while the run keeps executing.
      const launch = runSmithers(["up", "mirror.tsx", "--herdr", "--run-id", runId, "-d"], {
        cwd: repo.dir,
        env,
        format: "json",
        timeoutMs: 60_000,
      });
      expect(launch.exitCode).toBe(0);

      // node-a's pane appears (working). The static node ran BEFORE node-a, so
      // by now it has executed - yet it must never have a pane (agent-only filter).
      const aWorking = await waitFor(() => statusOf(server.session, nameA) === "working", 60_000);
      expect(aWorking).toBe(true);
      expect(listAgents(server.session).some((a) => a.name === nameStatic)).toBe(false);

      // The deterministic workspace exists exactly once (find-or-create key).
      expect(
        listWorkspaces(server.session).filter(
          (w) => w.label === label || w.label === `✓ ${label}` || herdrRunIdFromWorkspaceLabel(w.label) === runId,
        ).length,
      ).toBe(1);

      // The working -> idle transition: node-a finishes (idle) while node-b is
      // still working. Both agent panes exist at this point; the non-agent node
      // still has none.
      const transitioned = await waitFor(
        () => isFinishedAgentStatus(statusOf(server.session, nameA)) && statusOf(server.session, nameB) === "working",
        90_000,
      );
      expect(transitioned).toBe(true);
      expect(runPaneNames(server.session, runId)).toEqual([nameA, nameB].sort());

      // Mirror panes now run `smithers tail --linger`, so they deliberately stay
      // registered after the run reaches its terminal state (the human comes back
      // to read the output) instead of draining on their own. The workspace close
      // in `finally` tears their PTYs down.
    } finally {
      closeWorkspace(server.session, label);
    }
  });

  // ── Scenario 4: herdr attach adopts a live run without duplicating ───────
  test("(4) herdr attach on a still-running run adopts the mirror without duplicates and a status change lands post-attach", async () => {
    const binDir = createExecutableDir();
    writeSlowFakeClaude(binDir);
    const repo = primeRepo("attach.tsx");
    const runId = `attach-${randomSessionName()}`;
    // Label uses workflowIdFromPath(file) = "attach", not Workflow name="loop-wf".
    const label = herdrWorkspaceLabel("attach", runId);
    const env = runEnv(binDir, repo.dir, server.socketPath, 3500);
    const nameA = `smithers:${runId}:node-a`;
    const nameB = `smithers:${runId}:node-b`;

    let attachChild;
    try {
      const launch = runSmithers(["up", "attach.tsx", "--herdr", "--run-id", runId, "-d"], {
        cwd: repo.dir,
        env,
        format: "json",
        timeoutMs: 60_000,
      });
      expect(launch.exitCode).toBe(0);

      // Wait until the up-surface has established the mirror (node-a working).
      expect(await waitFor(() => statusOf(server.session, nameA) === "working", 60_000)).toBe(true);

      // The pre-attach mirror is exactly one workspace with a single node-a pane
      // (node-b is sequential and has not started while node-a works).
      const wsForRun = listWorkspaces(server.session).filter(
        (w) => w.label === label || w.label === `✓ ${label}` || herdrRunIdFromWorkspaceLabel(w.label) === runId,
      );
      if (wsForRun.length !== 1) {
        const pane = listAgents(server.session).find((a) => a.name === nameA);
        throw new Error(
          `workspace missing for ${label}. labels=${JSON.stringify(listWorkspaces(server.session).map((w) => w.label))} paneWs=${pane?.workspace_id} agents=${JSON.stringify(listAgents(server.session).map((a) => a.name))}`,
        );
      }
      expect(wsForRun.length).toBe(1);
      expect(runPaneNames(server.session, runId)).toEqual([nameA]);

      // Attach a SECOND surface to the live run.
      attachChild = spawn(process.execPath, [CLI_ENTRY, "herdr", "attach", runId], {
        cwd: repo.dir,
        env: { ...process.env, ...env },
        stdio: "ignore",
      });

      // Adopts, not duplicates. Assert the no-duplication INVARIANTS continuously
      // while the attach surface reconciles (find-or-create the workspace by label,
      // adopt the existing panes by name): the run's workspace count never leaves 1
      // and no pane name outside the two agent nodes ever appears. Polling the
      // invariant is race-free w.r.t. node-b legitimately starting mid-window
      // (which adds nameB) - unlike a point-in-time snapshot equality, a duplicate
      // workspace or a stray pane is sticky and would be caught on any tick. The
      // window spans node-a -> node-b so adoption is verified as the pane set grows.
      const allowedPaneNames = new Set([nameA, nameB]);
      const settleDeadline = Date.now() + 4_500;
      do {
        expect(
          listWorkspaces(server.session).filter(
            (w) => w.label === label || w.label === `✓ ${label}` || herdrRunIdFromWorkspaceLabel(w.label) === runId,
          ).length,
        ).toBe(1);
        const names = runPaneNames(server.session, runId);
        expect(names.includes(nameA)).toBe(true);
        expect(names.every((n) => allowedPaneNames.has(n))).toBe(true);
        await new Promise((r) => setTimeout(r, 250));
      } while (Date.now() < settleDeadline);

      // A status change lands post-attach: node-a goes idle while node-b works.
      // (The adopted pane's per-pane seq is seeded from Date.now(), so the second
      // surface's reports are not silently dropped as stale - the mirror is live.)
      const changed = await waitFor(
        () => isFinishedAgentStatus(statusOf(server.session, nameA)) && statusOf(server.session, nameB) === "working",
        90_000,
      );
      expect(changed).toBe(true);

      // Mirror panes now `--linger` past the run's terminal state; the workspace
      // close in `finally` is what cleans them up.
    } finally {
      attachChild?.kill("SIGINT");
      closeWorkspace(server.session, label);
    }
  });

  // ── Scenario 3: tail --format jsonl on the finished run ──────────────────
  test("(3) tail --format jsonl on the finished run emits only parseable JSON with the agent node output text present", () => {
    const binDir = createExecutableDir();
    writeSlowFakeClaude(binDir);
    const repo = primeRepo("tailed.tsx");
    const runId = `tailed-${randomSessionName()}`;
    const label = herdrWorkspaceLabel("tailed", runId);
    // Foreground + a short delay: drive the mirrored run to completion, then tail.
    const env = runEnv(binDir, repo.dir, server.socketPath, 150);

    try {
      const done = runSmithers(["up", "tailed.tsx", "--herdr", "--run-id", runId], {
        cwd: repo.dir,
        env,
        format: "json",
        timeoutMs: 120_000,
      });
      expect(done.exitCode).toBe(0);
      expect(done.json?.status).toBe("finished");

      const tail = runSmithers(["tail", runId, "--format", "jsonl"], {
        cwd: repo.dir,
        env: { ...QUIET_ENV, HOME: repo.dir },
        timeoutMs: 30_000,
      });
      expect(tail.exitCode).toBe(0);

      const lines = tail.stdout.split("\n").filter((line) => line.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);
      // Every emitted line is a standalone JSON event object.
      const events = lines.map((line) => JSON.parse(line));
      for (const event of events) {
        expect(event.runId).toBe(runId);
        expect(typeof event.seq).toBe("number");
        expect(typeof event.type).toBe("string");
        expect(typeof event.payload).toBe("object");
      }
      expect(events.some((e) => e.type === "RunFinished")).toBe(true);

      // The agent nodes' output text survived verbatim: each agent emitted the
      // fenced `{"answer":"ok"}` turn, so its NodeOutput text is present.
      const nodeOutputs = events.filter((e) => e.type === "NodeOutput" && typeof e.payload.text === "string");
      expect(nodeOutputs.length).toBeGreaterThan(0);
      const outputText = nodeOutputs.map((e) => e.payload.text).join("");
      expect(outputText).toContain("answer");
      const outputNodes = new Set(nodeOutputs.map((e) => e.payload.nodeId));
      expect(outputNodes.has("node-a")).toBe(true);
      expect(outputNodes.has("node-b")).toBe(true);
    } finally {
      closeWorkspace(server.session, label);
    }
  });

  // ── Scenario 2: kill herdr MID-run (degradability). Runs LAST because it
  //    hard-kills the shared server; nothing after it needs herdr. ──────────
  test("(2) killing the herdr server mid-run leaves the run unaffected: it finishes with exit 0", async () => {
    const binDir = createExecutableDir();
    writeSlowFakeClaude(binDir);
    const repo = primeRepo("degrade.tsx");
    const runId = `degrade-${randomSessionName()}`;
    const env = runEnv(binDir, repo.dir, server.socketPath, 3000);
    const nameA = `smithers:${runId}:node-a`;

    // Foreground so the child's exit code is the run's own outcome.
    const up = spawnUp(["up", "degrade.tsx", "--herdr", "--run-id", runId, "--format", "json"], {
      cwd: repo.dir,
      env,
    });

    // Wait until the mirror is live (node-a working) so the kill is genuinely
    // mid-run, then hard-kill the herdr server out from under the surface.
    const live = await waitFor(() => statusOf(server.session, nameA) === "working", 60_000);
    expect(live).toBe(true);
    await server.stopServer();

    // The run is unaffected by herdr dying: it reaches terminal state and the
    // foreground process exits 0 with a finished status. (herdr calls soft-fail;
    // the mirror is never on the run's hot path.)
    const code = await up.exited;
    expect(code).toBe(0);
    const trimmed = up.readStdout().trim();
    const lastObj = trimmed.lastIndexOf("\n{");
    /** @type {any} */
    let json;
    try {
      json = JSON.parse(lastObj >= 0 ? trimmed.slice(lastObj + 1) : trimmed);
    } catch {
      json = undefined;
    }
    expect(json?.status).toBe("finished");
  });
});
