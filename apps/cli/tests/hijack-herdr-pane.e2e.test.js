// Spec D4: `smithers hijack` hosts the interactive agent CLI in a herdr pane when
// opted in via SMITHERS_HERDR_HIJACK, instead of spawning it stdio-inherit in the
// operator's current terminal. These are real-backend tests (no mocks): a fake
// interactive agent CLI on PATH + a real, throwaway herdr server. The pane-hosting
// suite is skipped when the `herdr` binary is absent (CI has none) so it stays
// green there; the default-terminal test needs no herdr and always runs, proving
// the launch path is byte-identical when the toggle is unset.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
import { isCompatibleHerdrInstalled, startHerdrServer } from "../../../packages/herdr/tests/herdr-server.js";

const RUN_ID = "hijack-run";
const NODE_ID = "node-a";
const RESUME = "sess-123";

/**
 * A fake interactive `claude` CLI. Records the argv it was launched with (so a
 * test can assert the resume args reached the pane process regardless of
 * process-info timing) and either stays alive as the pane's foreground process
 * (HIJACK_STAY_ALIVE, for the pane test) or exits 0 immediately (for the
 * current-terminal launch test, where the hijack command waits on child exit).
 * Writes nothing to stdout so the CLI's `--format json` output stays parseable.
 *
 * @param {string} binDir
 * @returns {string} the argv-capture file path the fake writes on launch
 */
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
      "if (process.env.HIJACK_STAY_ALIVE) {",
      "  setInterval(() => {}, 3600000);",
      "} else {",
      "  process.exit(0);",
      "}",
      "",
    ].join("\n"),
  );
  return argvFile;
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

/**
 * Seed a finished run whose latest attempt carries a resumable claude-code
 * session, so `hijack` resolves a native-CLI candidate without a live engine.
 *
 * @param {ReturnType<typeof createTempRepo>} repo
 * @param {SmithersDb} adapter
 */
async function seedHijackableRun(repo, adapter) {
  const now = Date.now();
  await adapter.insertRun({
    runId: RUN_ID,
    workflowName: "hijack-fixture",
    workflowPath: "workflow.tsx",
    status: "finished",
    createdAtMs: now - 10_000,
    startedAtMs: now - 9_000,
    finishedAtMs: now - 1_000,
    heartbeatAtMs: null,
    vcsType: "none",
    vcsRevision: null,
  });
  await adapter.insertNode({
    runId: RUN_ID,
    nodeId: NODE_ID,
    iteration: 0,
    state: "finished",
    lastAttempt: 1,
    updatedAtMs: now - 2_000,
    outputTable: "",
    label: "Node A",
  });
  await adapter.insertAttempt({
    runId: RUN_ID,
    nodeId: NODE_ID,
    iteration: 0,
    attempt: 1,
    state: "finished",
    startedAtMs: now - 7_000,
    finishedAtMs: now - 6_000,
    errorJson: null,
    metaJson: JSON.stringify({ kind: "agent", agentEngine: "claude-code", agentResume: RESUME }),
    responseText: null,
    cached: false,
    jjPointer: null,
    jjCwd: repo.dir,
  });
}

/**
 * Run a `herdr` CLI subcommand against a named session and return its parsed
 * `result` (the CLI mirrors the socket API 1:1 and prints one `{id,result}` line).
 *
 * @param {string} session
 * @param {string[]} args
 * @returns {any}
 */
/** @type {string} */
let activeHerdrSocketPath = "";

function herdrCli(session, args) {
  const out = execFileSync("herdr", args, {
    env: {
      ...process.env,
      HERDR_SESSION: session,
      HERDR_SOCKET_PATH: activeHerdrSocketPath || "",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
  return JSON.parse(line).result;
}

/**
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {number} timeoutMs
 * @param {number} intervalMs
 */
async function waitFor(predicate, timeoutMs = 8000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await Bun.sleep(intervalMs);
  }
  return Boolean(await predicate());
}

describe.skipIf(!isCompatibleHerdrInstalled())("hijack into a herdr pane (real herdr)", () => {
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

  test("SMITHERS_HERDR_HIJACK=1 launches the interactive CLI in a herdr pane (name + argv); no auto-resume", async () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    const argvFile = writeFakeInteractiveClaude(binDir);
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await seedHijackableRun(repo, adapter);

      const result = runSmithers(["hijack", RUN_ID], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 60_000,
        env: prependPath(binDir, {
          HERDR_SESSION: server.session,
          HERDR_SOCKET_PATH: server.socketPath,
          HERDR_ENV: "0",
          SMITHERS_HERDR_DOCK: "0",
          SMITHERS_HERDR_HIJACK: "1",
          HIJACK_ARGV_FILE: argvFile,
          HIJACK_STAY_ALIVE: "1",
          NO_COLOR: "1",
        }),
      });

      // The command returns immediately after launching the pane (it does NOT
      // block on the pane's process, which herdr owns) and reports the pane.
      expect(result.exitCode).toBe(0);
      expect(result.json).toBeDefined();
      const pane = result.json.herdrPane;
      expect(pane).toBeDefined();
      const expectedName = `smithers:${RUN_ID}:hijack:${NODE_ID}`;
      expect(pane.name).toBe(expectedName);
      expect(pane.attach).toBe(`herdr agent attach ${expectedName}`);
      expect(typeof pane.paneId).toBe("string");
      // Handback stays manual in pane mode: no auto-resume, resumeCommand offered.
      expect(result.json.resumedBySmithers).toBe(false);
      expect(typeof result.json.resumeCommand === "string" || result.json.resumeCommand === null).toBe(true);

      // Assert the agent exists in herdr with the expected name, via herdr CLI JSON.
      // Match name or agent field (herdr 0.7 sometimes only sets one).
      const agents = herdrCli(server.session, ["agent", "list"]).agents ?? [];
      const agent = agents.find((a) => a && (a.name === expectedName || a.agent === expectedName));
      expect(agent).toBeDefined();
      expect(agent.pane_id).toBe(pane.paneId);
      expect(agent.workspace_id).toBe(pane.workspaceId);

      // Assert the launched argv reached the pane process, via herdr CLI JSON
      // (pane process-info's foreground cmdline carries the resume args).
      let cmdline = "";
      await waitFor(() => {
        const info = herdrCli(server.session, ["pane", "process-info", "--pane", pane.paneId]);
        const procs = info?.process_info?.foreground_processes ?? [];
        cmdline = procs.map((p) => p.cmdline ?? (Array.isArray(p.argv) ? p.argv.join(" ") : "")).join(" | ");
        return cmdline.includes("--resume") && cmdline.includes(RESUME);
      });
      expect(cmdline).toContain("--resume");
      expect(cmdline).toContain(RESUME);

      // Cross-check what the fake CLI itself recorded it was launched with. The
      // pane's shell runs the command, so its first write trails the process
      // becoming visible in process-info by a beat.
      expect(await waitFor(() => existsSync(argvFile))).toBe(true);
      const recordedArgv = JSON.parse(readFileSync(argvFile, "utf8"));
      expect(recordedArgv).toEqual(["--resume", RESUME]);
    } finally {
      sqlite.close();
    }
  }, 90_000);
});

describe("hijack without herdr uses the current terminal (default, unchanged)", () => {
  test("SMITHERS_HERDR_HIJACK unset: launches in-process, no herdr pane, no auto-resume for a finished run", async () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    const argvFile = writeFakeInteractiveClaude(binDir);
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await seedHijackableRun(repo, adapter);

      // No SMITHERS_HERDR_HIJACK, no HERDR_SESSION: the pane branch is never
      // taken, so this exercises the byte-identical launchHijackSession flow.
      // The fake exits 0 immediately (HIJACK_STAY_ALIVE unset).
      const result = runSmithers(["hijack", RUN_ID], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 60_000,
        env: prependPath(binDir, { HIJACK_ARGV_FILE: argvFile, NO_COLOR: "1" }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.json).toBeDefined();
      expect(result.json.herdrPane).toBeUndefined();
      expect(result.json.resumedBySmithers).toBe(false);
      // The current-terminal flow spawned the resumable CLI with the same argv.
      const recordedArgv = JSON.parse(readFileSync(argvFile, "utf8"));
      expect(recordedArgv).toEqual(["--resume", RESUME]);
    } finally {
      sqlite.close();
    }
  }, 60_000);
});
