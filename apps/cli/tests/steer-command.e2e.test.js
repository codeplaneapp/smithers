// Real-backend coverage for `smithers steer` and its two testable seams
// (`listActiveRunsForSteer`, `detectHerdrMirrorForRun`). No mocks: a real seeded
// SQLite store and a real throwaway herdr server (skipped when `herdr` is absent,
// so CI stays green). The command e2e proves the one-key promise end to end —
// `smithers steer RUN_ID --node NODE` opens a hijack pane with ZERO env ceremony
// when a mirror exists, and falls back to the current terminal when it does not.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import {
  createExecutableDir,
  createTempRepo,
  pinSqliteBackend,
  prependPath,
  runSmithers,
  writeExecutable,
} from "../../../packages/smithers/tests/e2e-helpers.js";
import {
  isCompatibleHerdrInstalled,
  randomSessionName,
  startHerdrServer,
} from "../../../packages/herdr/tests/herdr-server.js";
import { herdrWorkspaceLabel } from "../src/herdr.js";
import { workflowIdFromPath } from "../src/monitoring-suggestion.js";
import {
  countInFlightAgentSiblings,
  detectHerdrMirrorForRun,
  formatTakeoverWarning,
  listActiveRunsForSteer,
  nodeExistsInRun,
  resolveSteerTargetNode,
} from "../src/steer.js";

const RESUME = "sess-steer-123";

/**
 * Seed a RUNNING run with one or more in-progress AGENT nodes (each with a live
 * `kind:"agent"` attempt), so steer targeting + the takeover sibling count see a
 * real parallel wave. The first node optionally carries a resumable session.
 *
 * @param {ReturnType<typeof createTempRepo>} repo
 * @param {SmithersDb} adapter
 * @param {{ runId: string, nodes: Array<{ nodeId: string, resume?: string }> }} spec
 */
async function seedRunningWave(repo, adapter, spec) {
  const now = Date.now();
  await adapter.insertRun({
    runId: spec.runId,
    workflowName: "steer-fixture",
    workflowPath: "workflow.tsx",
    status: "running",
    createdAtMs: now - 10_000,
    startedAtMs: now - 9_000,
    finishedAtMs: null,
    heartbeatAtMs: now,
    vcsType: "none",
    vcsRevision: null,
  });
  let i = 0;
  for (const node of spec.nodes) {
    // Stagger start times so the "newest in-flight agent node" is deterministic.
    const startedAtMs = now - 7_000 + i * 100;
    await adapter.insertNode({
      runId: spec.runId,
      nodeId: node.nodeId,
      iteration: 0,
      state: "in-progress",
      lastAttempt: 1,
      updatedAtMs: startedAtMs,
      outputTable: "",
      label: node.nodeId,
    });
    await adapter.insertAttempt({
      runId: spec.runId,
      nodeId: node.nodeId,
      iteration: 0,
      attempt: 1,
      state: "in-progress",
      startedAtMs,
      finishedAtMs: null,
      errorJson: null,
      metaJson: JSON.stringify({
        kind: "agent",
        agentEngine: "claude-code",
        ...(node.resume ? { agentResume: node.resume } : {}),
      }),
      responseText: null,
      cached: false,
      jjPointer: null,
      jjCwd: repo.dir,
    });
    i += 1;
  }
}

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function openRepoDb(repo) {
  pinSqliteBackend(repo.dir);
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

/** A fake interactive `claude` that records its argv and stays alive or exits. */
function writeFakeInteractiveClaude(binDir) {
  const argvFile = join(binDir, "claude-argv.json");
  writeExecutable(
    binDir,
    "claude",
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      "const argv = process.argv.slice(2);",
      "if (process.env.HIJACK_ARGV_FILE) {",
      "  try { fs.writeFileSync(process.env.HIJACK_ARGV_FILE, JSON.stringify(argv)); } catch {}",
      "}",
      "if (process.env.HIJACK_STAY_ALIVE) { setInterval(() => {}, 3600000); } else { process.exit(0); }",
      "",
    ].join("\n"),
  );
  return argvFile;
}

/**
 * Seed a run whose latest attempt carries a resumable claude-code session, so
 * `steer`/`hijack` resolves a native-CLI candidate.
 *
 * @param {ReturnType<typeof createTempRepo>} repo
 * @param {SmithersDb} adapter
 * @param {{ runId: string, nodeId: string, status?: string }} spec
 */
async function seedSteerableRun(repo, adapter, spec) {
  const now = Date.now();
  await adapter.insertRun({
    runId: spec.runId,
    workflowName: "steer-fixture",
    workflowPath: "workflow.tsx",
    status: spec.status ?? "finished",
    createdAtMs: now - 10_000,
    startedAtMs: now - 9_000,
    finishedAtMs: spec.status === "running" ? null : now - 1_000,
    heartbeatAtMs: spec.status === "running" ? now : null,
    vcsType: "none",
    vcsRevision: null,
  });
  await adapter.insertNode({
    runId: spec.runId,
    nodeId: spec.nodeId,
    iteration: 0,
    state: spec.status === "running" ? "in-progress" : "finished",
    lastAttempt: 1,
    updatedAtMs: now - 2_000,
    outputTable: "",
    label: "Node A",
  });
  await adapter.insertAttempt({
    runId: spec.runId,
    nodeId: spec.nodeId,
    iteration: 0,
    attempt: 1,
    state: spec.status === "running" ? "in-progress" : "finished",
    startedAtMs: now - 7_000,
    finishedAtMs: spec.status === "running" ? null : now - 6_000,
    errorJson: null,
    metaJson: JSON.stringify({ kind: "agent", agentEngine: "claude-code", agentResume: RESUME }),
    responseText: null,
    cached: false,
    jjPointer: null,
    jjCwd: repo.dir,
  });
}

/**
 * @param {string} session
 * @param {string[]} args
 * @returns {any}
 */
function herdrCli(session, args) {
  const out = execFileSync("herdr", args, {
    env: { ...process.env, HERDR_SESSION: session },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
  return JSON.parse(line).result;
}

// ── Run resolution (real seeded DB, no herdr needed) ─────────────────────────

test("listActiveRunsForSteer returns only active runs, newest first, de-duped", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    const now = Date.now();
    const insert = (runId, status, createdOffset) =>
      adapter.insertRun({
        runId,
        workflowName: "wf",
        status,
        createdAtMs: now - createdOffset,
        startedAtMs: now - createdOffset,
        finishedAtMs: status === "finished" ? now : null,
      });
    await insert("done-run", "finished", 5_000);
    await insert("old-active", "running", 4_000);
    await insert("gate-run", "waiting-approval", 3_000);
    await insert("new-active", "running", 1_000);

    const active = await listActiveRunsForSteer(adapter);
    const ids = active.map((r) => r.runId);
    // Finished run excluded; the rest present, newest (smallest offset) first.
    expect(ids).not.toContain("done-run");
    expect(ids).toEqual(["new-active", "gate-run", "old-active"]);
    // No duplicates even though "running" also folds in "continued".
    expect(new Set(ids).size).toBe(ids.length);
  } finally {
    sqlite.close();
  }
}, 30_000);

test("smithers steer errors cleanly for an unknown run id and for no active run", async () => {
  const repo = createTempRepo();
  const { sqlite } = openRepoDb(repo);
  try {
    const unknown = runSmithers(["steer", "no-such-run"], {
      cwd: repo.dir,
      format: "json",
      env: {
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_NO_UPDATE_CHECK: "1",
        HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
      },
    });
    expect(unknown.exitCode).not.toBe(0);
    expect(`${unknown.stdout}${unknown.stderr}`).toContain("RUN_NOT_FOUND");

    const none = runSmithers(["steer"], {
      cwd: repo.dir,
      format: "json",
      env: {
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_NO_UPDATE_CHECK: "1",
        HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
      },
    });
    expect(none.exitCode).not.toBe(0);
    expect(`${none.stdout}${none.stderr}`).toContain("NO_ACTIVE_RUN");
  } finally {
    sqlite.close();
  }
}, 30_000);

test("smithers steer --takeover with no herdr mirror hands off in the current terminal (mirrored:false)", async () => {
  const repo = createTempRepo();
  const binDir = createExecutableDir();
  const argvFile = writeFakeInteractiveClaude(binDir);
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    // A settled run with one node -> no in-flight siblings, so takeover needs no
    // confirmation and hands straight off.
    await seedSteerableRun(repo, adapter, { runId: "steer-no-mirror", nodeId: "node-a" });
    // HERDR_SOCKET_PATH points at nothing, so mirror detection fails
    // deterministically (never touching a real default session) and the
    // hand-off falls back to the byte-identical current-terminal flow.
    const result = runSmithers(["steer", "steer-no-mirror", "--node", "node-a", "--takeover"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 60_000,
      env: prependPath(binDir, {
        HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
        HIJACK_ARGV_FILE: argvFile,
        NO_COLOR: "1",
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_NO_UPDATE_CHECK: "1",
      }),
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.json).toBeDefined();
    expect(result.json.steered).toBe(true);
    expect(result.json.mode).toBe("takeover");
    expect(result.json.mirrored).toBe(false);
    expect(result.json.herdrPane).toBeUndefined();
    // The current-terminal flow launched the resumable CLI with the resume argv.
    expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual(["--resume", RESUME]);
  } finally {
    sqlite.close();
  }
}, 60_000);

// ── Steer mode (real DB, no agent process needed) ────────────────────────────

test("smithers steer RUN_ID --node NODE MESSAGE queues a durable steer (mode:steer)", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedRunningWave(repo, adapter, { runId: "steer-run", nodes: [{ nodeId: "impl" }] });
    const message = "prefer the smaller change and add a test";
    const result = runSmithers(["steer", "steer-run", "--node", "impl", message], {
      cwd: repo.dir,
      format: "json",
      env: {
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_NO_UPDATE_CHECK: "1",
        HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
      },
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.json.steered).toBe(true);
    expect(result.json.mode).toBe("steer");
    expect(result.json.nodeId).toBe("impl");
    expect(result.json.message).toBe(message);
    expect(typeof result.json.steerId).toBe("string");
    // Ack tells the operator how to watch it land.
    expect(`${result.stderr}`).toContain("steer queued");
    expect(`${result.stderr}`).toContain("smithers tail steer-run --node impl");

    // The durable row + the SteerQueued event are both written.
    const steers = await adapter.listSteers("steer-run");
    expect(steers).toHaveLength(1);
    expect(steers[0].status).toBe("queued");
    expect(steers[0].nodeId).toBe("impl");
    expect(steers[0].message).toBe(message);
    expect(steers[0].author).toBeTruthy();
    const queued = await adapter.listQueuedSteers("steer-run", "impl");
    expect(queued).toHaveLength(1);
  } finally {
    sqlite.close();
  }
}, 30_000);

test("nodeExistsInRun is true for a run's real node and false for an unknown id", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedRunningWave(repo, adapter, { runId: "exists-run", nodes: [{ nodeId: "impl" }] });
    expect(await nodeExistsInRun(adapter, "exists-run", "impl")).toBe(true);
    expect(await nodeExistsInRun(adapter, "exists-run", "does-not-exist")).toBe(false);
  } finally {
    sqlite.close();
  }
}, 30_000);

test("smithers steer --node naming an unknown node errors (NODE_NOT_IN_RUN) and queues nothing", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedRunningWave(repo, adapter, { runId: "steer-badnode", nodes: [{ nodeId: "impl" }] });
    const result = runSmithers(["steer", "steer-badnode", "--node", "does-not-exist", "tighten it up"], {
      cwd: repo.dir,
      format: "json",
      env: {
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_NO_UPDATE_CHECK: "1",
        HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
      },
    });
    // A typo'd --node is rejected up front rather than queuing a steer that
    // would silently expire at run end.
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("NODE_NOT_IN_RUN");
    // The real node "impl" is untouched; nothing was queued for the bogus node.
    expect(await adapter.listSteers("steer-badnode")).toHaveLength(0);

    // Sanity: the pane `s` path (a real in-flight node id) still queues, proving
    // the validation only rejects unknown nodes.
    const ok = runSmithers(["steer", "steer-badnode", "--node", "impl", "tighten it up"], {
      cwd: repo.dir,
      format: "json",
      env: {
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_NO_UPDATE_CHECK: "1",
        HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
      },
    });
    expect(ok.exitCode, `${ok.stdout}\n${ok.stderr}`).toBe(0);
    expect(ok.json.nodeId).toBe("impl");
    expect(await adapter.listQueuedSteers("steer-badnode", "impl")).toHaveLength(1);
  } finally {
    sqlite.close();
  }
}, 60_000);

test("smithers steer rejects an existing node once its run is terminal", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedRunningWave(repo, adapter, { runId: "steer-terminal", nodes: [{ nodeId: "impl" }] });
    await adapter.updateRun("steer-terminal", { status: "finished", finishedAtMs: Date.now() });
    const result = runSmithers(["steer", "steer-terminal", "--node", "impl", "too late"], {
      cwd: repo.dir,
      format: "json",
      env: {
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_NO_UPDATE_CHECK: "1",
        HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("RUN_NOT_ACTIVE");
    expect(await adapter.listSteers("steer-terminal")).toHaveLength(0);
  } finally {
    sqlite.close();
  }
}, 30_000);

test("smithers steer RUN_ID MESSAGE (no --node) targets the run's current in-flight agent node", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    // "review" starts after "impl", so it is the newest in-flight agent node.
    await seedRunningWave(repo, adapter, { runId: "steer-default", nodes: [{ nodeId: "impl" }, { nodeId: "review" }] });
    const result = runSmithers(["steer", "steer-default", "tighten the assertion"], {
      cwd: repo.dir,
      format: "json",
      env: {
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_NO_UPDATE_CHECK: "1",
        HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
      },
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.json.mode).toBe("steer");
    expect(result.json.nodeId).toBe("review");
    const queued = await adapter.listQueuedSteers("steer-default", "review");
    expect(queued).toHaveLength(1);
    expect(queued[0].message).toBe("tighten the assertion");
  } finally {
    sqlite.close();
  }
}, 30_000);

test("smithers steer RUN_ID with no message and no --takeover errors on a non-TTY (STEER_MESSAGE_REQUIRED)", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedRunningWave(repo, adapter, { runId: "steer-empty", nodes: [{ nodeId: "impl" }] });
    const result = runSmithers(["steer", "steer-empty"], {
      cwd: repo.dir,
      format: "json",
      env: {
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_NO_UPDATE_CHECK: "1",
        HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
      },
    });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("STEER_MESSAGE_REQUIRED");
    // Nothing was queued.
    expect(await adapter.listSteers("steer-empty")).toHaveLength(0);
  } finally {
    sqlite.close();
  }
}, 30_000);

// ── Takeover sibling warning (parallel wave) ─────────────────────────────────

test("countInFlightAgentSiblings counts OTHER in-flight agent nodes, excluding the target", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedRunningWave(repo, adapter, {
      runId: "wave",
      nodes: [{ nodeId: "target", resume: RESUME }, { nodeId: "sib-1" }, { nodeId: "sib-2" }],
    });
    const siblings = await countInFlightAgentSiblings(adapter, "wave", "target");
    expect(siblings).toEqual(["sib-1", "sib-2"]);
    // The takeover default target (newest agent node) resolves too.
    expect(await resolveSteerTargetNode(adapter, "wave", undefined)).toBe("sib-2");
    expect(formatTakeoverWarning(siblings)).toContain("aborts 2 in-flight siblings");
  } finally {
    sqlite.close();
  }
}, 30_000);

test("smithers steer --takeover in a parallel wave warns with the sibling count and aborts without --yes (non-TTY)", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedRunningWave(repo, adapter, {
      runId: "wave-abort",
      nodes: [{ nodeId: "target", resume: RESUME }, { nodeId: "sib-1" }, { nodeId: "sib-2" }],
    });
    const result = runSmithers(["steer", "wave-abort", "--node", "target", "--takeover"], {
      cwd: repo.dir,
      format: "json",
      env: {
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_NO_UPDATE_CHECK: "1",
        HERDR_SOCKET_PATH: "/nonexistent/herdr.sock",
      },
    });
    // Non-TTY without --yes: the warning is printed and the run is NOT taken over.
    expect(result.exitCode).not.toBe(0);
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).toContain("aborts 2 in-flight siblings");
    expect(combined).toContain("sib-1, sib-2");
    expect(combined).toContain("TAKEOVER_NOT_CONFIRMED");
    // The run was never hijacked: no hijack request was written.
    const run = await adapter.getRun("wave-abort");
    expect(run.status).toBe("running");
    expect(run.hijackRequestedAtMs == null).toBe(true);
  } finally {
    sqlite.close();
  }
}, 30_000);

// ── Mirror auto-detection + full command (real throwaway herdr) ──────────────

describe.skipIf(!isCompatibleHerdrInstalled())("steer against a real herdr mirror", () => {
  /** @type {Awaited<ReturnType<typeof startHerdrServer>>} */
  let server;

  beforeAll(async () => {
    server = await startHerdrServer();
  });

  afterAll(async () => {
    await server?.dispose();
  });

  test("detectHerdrMirrorForRun finds a seeded workspace by run id and rejects the absent one", async () => {
    const runId = "detect-run";
    const label = herdrWorkspaceLabel(workflowIdFromPath("workflow.tsx"), runId);
    herdrCli(server.session, ["workspace", "create", "--label", label, "--no-focus"]);

    const hit = await detectHerdrMirrorForRun({ session: server.session, label, runId });
    expect(hit.mirrored).toBe(true);
    expect(typeof hit.workspaceId === "string" || hit.workspaceId === undefined).toBe(true);

    const missLabel = herdrWorkspaceLabel(workflowIdFromPath("workflow.tsx"), "absent-run");
    const miss = await detectHerdrMirrorForRun({ session: server.session, label: missLabel, runId: "absent-run" });
    expect(miss.mirrored).toBe(false);

    // No server reachable (a never-started session) → soft false.
    const dead = await detectHerdrMirrorForRun({ session: randomSessionName(), label, runId });
    expect(dead.mirrored).toBe(false);
  }, 30_000);

  test("smithers steer RUN_ID --node NODE --takeover auto-detects the mirror and opens a hijack pane (no env ceremony)", async () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    const argvFile = writeFakeInteractiveClaude(binDir);
    const { sqlite, adapter } = openRepoDb(repo);
    const runId = "steer-mirror-run";
    const nodeId = "node-a";
    try {
      await seedSteerableRun(repo, adapter, { runId, nodeId });
      // Pre-create the run's mirror workspace with the deterministic label,
      // exactly as `up --herdr` / `herdr attach` would.
      const label = herdrWorkspaceLabel(workflowIdFromPath("workflow.tsx"), runId);
      herdrCli(server.session, ["workspace", "create", "--label", label, "--no-focus"]);

      // NOTE: no SMITHERS_HERDR, no SMITHERS_HERDR_HIJACK. Only HERDR_SESSION,
      // which is exactly what a herdr pane already carries. steer detects the
      // mirror itself and routes the hand-off into a hijack pane.
      const result = runSmithers(["steer", runId, "--node", nodeId, "--takeover"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 60_000,
        env: prependPath(binDir, {
          HERDR_SESSION: server.session,
          HIJACK_ARGV_FILE: argvFile,
          HIJACK_STAY_ALIVE: "1",
          NO_COLOR: "1",
          SMITHERS_NO_SKILL_REFRESH: "1",
          SMITHERS_NO_UPDATE_CHECK: "1",
        }),
      });

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.json).toBeDefined();
      expect(result.json.steered).toBe(true);
      expect(result.json.mode).toBe("takeover");
      expect(result.json.mirrored).toBe(true);
      const expectedName = `smithers:${runId}:hijack:${nodeId}`;
      expect(result.json.herdrPane).toBeDefined();
      expect(result.json.herdrPane.name).toBe(expectedName);

      // The agent really exists in the seeded workspace.
      const agents = herdrCli(server.session, ["agent", "list"]).agents;
      const agent = agents.find((a) => a && a.name === expectedName);
      expect(agent).toBeDefined();
      expect(agent.pane_id).toBe(result.json.herdrPane.paneId);
    } finally {
      sqlite.close();
    }
  }, 90_000);
});
