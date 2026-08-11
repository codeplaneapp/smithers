import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";
import { lingerUntilClosed } from "../src/tail.js";

const BUN_BINARY = process.execPath;
const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");
// Keep the fake-agent-free read command's stdout clean and deterministic: no
// skill self-heal / update notices (both are best-effort side effects that
// otherwise print to stderr and add latency to every scripted invocation).
const QUIET_ENV = {
  SMITHERS_NO_SKILL_REFRESH: "1",
  SMITHERS_NO_UPDATE_CHECK: "1",
};

const ALPHA_TEXT = "ALPHA_OUTPUT_LINE\n";
const BETA_TEXT = "BETA_OUTPUT_LINE\n";

/**
 * Give Incur a deliberately stale installed command-skill hash. A raw JSONL
 * command must bypass the generated stale-skills CTA instead of appending a
 * non-event object to stdout.
 *
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function staleCommandSkillsEnv(repo) {
  const dataHome = repo.path("xdg-data");
  const skillDir = repo.path("installed-command-skill");
  mkdirSync(resolve(dataHome, "incur"), { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: smithers\ndescription: stale test skill\n---\n");
  writeFileSync(
    resolve(dataHome, "incur/smithers.json"),
    `${JSON.stringify({ hash: "deliberately-stale", skills: ["smithers"], paths: [skillDir] })}\n`,
  );
  return { ...QUIET_ENV, XDG_DATA_HOME: dataHome };
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
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} status
 */
async function insertRun(adapter, runId, status) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "tail-fixture",
    status,
    createdAtMs: now - 2_000,
    startedAtMs: now - 2_000,
    finishedAtMs: status === "finished" ? now : null,
  });
}

/**
 * Seed one event. Each event gets a distinct timestamp so the adapter's
 * (runId, timestampMs, type, payloadJson) dedupe never collapses two rows.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @param {{ ts: number }} clock
 */
async function insertEvent(adapter, runId, type, payload, clock) {
  const timestampMs = (clock.ts += 1);
  await adapter.insertEventWithNextSeq({
    runId,
    timestampMs,
    type,
    payloadJson: JSON.stringify({ type, runId, ...payload, timestampMs }),
  });
}

/**
 * Seed a completed two-node run: alpha then beta, each with a verbatim output
 * chunk and start/finish lifecycle, wrapped in run start/finish events.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function seedCompletedRun(adapter, runId) {
  const clock = { ts: Date.now() - 1_000 };
  await insertRun(adapter, runId, "finished");
  await insertEvent(adapter, runId, "RunStarted", {}, clock);
  await insertEvent(adapter, runId, "NodeStarted", { nodeId: "alpha", iteration: 0, attempt: 1 }, clock);
  await insertEvent(
    adapter,
    runId,
    "NodeOutput",
    { nodeId: "alpha", iteration: 0, attempt: 1, text: ALPHA_TEXT, stream: "stdout" },
    clock,
  );
  await insertEvent(adapter, runId, "NodeFinished", { nodeId: "alpha", iteration: 0, attempt: 1 }, clock);
  await insertEvent(adapter, runId, "NodeStarted", { nodeId: "beta", iteration: 0, attempt: 1 }, clock);
  await insertEvent(
    adapter,
    runId,
    "NodeOutput",
    { nodeId: "beta", iteration: 0, attempt: 1, text: BETA_TEXT, stream: "stdout" },
    clock,
  );
  await insertEvent(adapter, runId, "NodeFinished", { nodeId: "beta", iteration: 0, attempt: 1 }, clock);
  await insertEvent(adapter, runId, "RunFinished", {}, clock);
}

/**
 * Seed a finished run whose single node emits more NodeOutput events than one
 * DB page (1000), so the tail backfill must page through the store. Each chunk
 * carries its index so ordering and completeness are checkable.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} chunks
 */
async function seedBulkRun(adapter, runId, chunks) {
  const clock = { ts: Date.now() - chunks - 10 };
  await insertRun(adapter, runId, "finished");
  await insertEvent(adapter, runId, "RunStarted", {}, clock);
  await insertEvent(adapter, runId, "NodeStarted", { nodeId: "bulk", iteration: 0, attempt: 1 }, clock);
  for (let i = 0; i < chunks; i += 1) {
    await insertEvent(
      adapter,
      runId,
      "NodeOutput",
      { nodeId: "bulk", iteration: 0, attempt: 1, text: `chunk-${i}\n`, stream: "stdout" },
      clock,
    );
  }
  await insertEvent(adapter, runId, "NodeFinished", { nodeId: "bulk", iteration: 0, attempt: 1 }, clock);
  await insertEvent(adapter, runId, "RunFinished", {}, clock);
}

// ---------------------------------------------------------------------------
// Live-process helpers (for the --follow test).
// ---------------------------------------------------------------------------
/**
 * @param {string[]} args
 * @param {{ cwd: string; env?: Record<string, string | undefined> }} options
 */
function spawnSmithersLive(args, options) {
  const child = spawn(BUN_BINARY, ["run", CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      resolveExit({ exitCode: code ?? 1, signal });
    });
  });
  return { child, readStdout: () => stdout, readStderr: () => stderr, exited };
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {Promise<{ exitCode: number; signal: NodeJS.Signals | null }>} exited
 */
async function waitForExit(exited, timeoutMs = 15_000) {
  return await new Promise((resolveExit, rejectExit) => {
    const timeoutId = setTimeout(() => {
      rejectExit(new Error(`Timed out waiting for smithers tail after ${timeoutMs}ms`));
    }, timeoutMs);
    exited.then(
      (value) => {
        clearTimeout(timeoutId);
        resolveExit(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        rejectExit(error);
      },
    );
  });
}

/**
 * @param {() => string} read
 * @param {string} matcher
 */
async function waitForMatch(read, matcher, timeoutMs = 20_000, pollMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (read().includes(matcher)) return;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for tail output containing "${matcher}"`);
}

/** @type {{ child: import("node:child_process").ChildProcess } | undefined} */
let liveProcess;
afterEach(async () => {
  if (liveProcess && liveProcess.child.exitCode === null && !liveProcess.child.killed) {
    liveProcess.child.kill("SIGKILL");
  }
  liveProcess = undefined;
});

test("tail of a completed run prints the event overview and exits without hanging", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedCompletedRun(adapter, "tail-done-run");
    const result = runSmithers(["tail", "tail-done-run"], {
      cwd: repo.dir,
      env: QUIET_ENV,
      timeoutMs: 30_000,
    });
    // Default --follow must not hang on an already-terminal run.
    expect(result.exitCode).toBe(0);
    // Run-level overview: node + run lifecycle lines, and a final status line.
    expect(result.stdout).toContain("alpha");
    expect(result.stdout).toContain("beta");
    expect(result.stdout).toContain("Run finished");
    expect(result.stdout).toContain("Run tail-done-run finished");
    // The overview skips noisy per-chunk output events.
    expect(result.stdout).not.toContain("ALPHA_OUTPUT_LINE");
    expect(result.stdout).not.toContain("BETA_OUTPUT_LINE");
  } finally {
    sqlite.close();
  }
}, 40_000);

test("tail --node prints only that node's verbatim output", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedCompletedRun(adapter, "tail-node-run");
    const result = runSmithers(["tail", "tail-node-run", "--node", "alpha"], {
      cwd: repo.dir,
      env: QUIET_ENV,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    // Verbatim output for the requested node, and its lifecycle marker.
    expect(result.stdout).toContain(ALPHA_TEXT.trimEnd());
    expect(result.stdout).toContain("alpha");
    // The other node's output and markers are filtered out.
    expect(result.stdout).not.toContain(BETA_TEXT.trimEnd());
    expect(result.stdout).not.toContain("beta");
  } finally {
    sqlite.close();
  }
}, 40_000);

test("tail --format jsonl emits parseable JSON lines matching persisted events", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    await seedCompletedRun(adapter, "tail-jsonl-run");
    const result = runSmithers(["tail", "tail-jsonl-run", "--format", "jsonl"], {
      cwd: repo.dir,
      env: staleCommandSkillsEnv(repo),
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    // Every emitted line is a raw event JSON object.
    const events = lines.map((line) => JSON.parse(line));
    for (const event of events) {
      expect(event.runId).toBe("tail-jsonl-run");
      expect(typeof event.seq).toBe("number");
      expect(typeof event.type).toBe("string");
      expect(typeof event.payload).toBe("object");
    }
    const types = events.map((event) => event.type);
    expect(types).toContain("NodeOutput");
    expect(types).toContain("RunFinished");
    // Persisted payload is preserved verbatim (exact NodeOutput text).
    const alphaOutput = events.find((event) => event.type === "NodeOutput" && event.payload.nodeId === "alpha");
    expect(alphaOutput?.payload.text).toBe(ALPHA_TEXT);
    // Sequence numbers are strictly increasing.
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  } finally {
    sqlite.close();
  }
}, 40_000);

test("tail --follow on a live run exits when the run finishes and prints a final status line", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    const clock = { ts: Date.now() - 1_000 };
    await insertRun(adapter, "tail-live-run", "running");
    await insertEvent(adapter, "tail-live-run", "RunStarted", {}, clock);
    await insertEvent(adapter, "tail-live-run", "NodeStarted", { nodeId: "alpha", iteration: 0, attempt: 1 }, clock);
    liveProcess = spawnSmithersLive(["tail", "tail-live-run"], {
      cwd: repo.dir,
      env: QUIET_ENV,
    });
    // Tail is up and streaming the live run before we drive it to completion.
    await waitForMatch(liveProcess.readStdout, "alpha");
    // Drive the run to completion in the background.
    await insertEvent(
      adapter,
      "tail-live-run",
      "NodeOutput",
      { nodeId: "alpha", iteration: 0, attempt: 1, text: "LIVE_OUTPUT\n", stream: "stdout" },
      clock,
    );
    await insertEvent(adapter, "tail-live-run", "NodeFinished", { nodeId: "alpha", iteration: 0, attempt: 1 }, clock);
    await insertEvent(adapter, "tail-live-run", "RunFinished", {}, clock);
    await adapter.updateRun("tail-live-run", {
      status: "finished",
      finishedAtMs: Date.now(),
    });
    const exit = await waitForExit(liveProcess.exited);
    expect(exit.exitCode).toBe(0);
    expect(liveProcess.readStdout()).toContain("Run tail-live-run finished");
  } finally {
    sqlite.close();
  }
}, 40_000);

test("tail --linger keeps the process alive after the run finishes and exits cleanly on SIGINT", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    // The run is already terminal, so a plain tail would drain it and exit at
    // once. --linger must instead hold the process open after the final status
    // line so a herdr pane does not vanish the instant the run finishes.
    await seedCompletedRun(adapter, "tail-linger-run");
    liveProcess = spawnSmithersLive(["tail", "tail-linger-run", "--linger"], {
      cwd: repo.dir,
      env: QUIET_ENV,
    });
    // It drains the finished run, prints the final status line, then lingers.
    await waitForMatch(liveProcess.readStdout, "Run tail-linger-run finished");
    await waitForMatch(liveProcess.readStdout, "Lingering");
    // It must NOT exit on its own: still alive after a grace window that a
    // non-lingering tail would have exited within.
    await sleep(1_500);
    expect(liveProcess.child.exitCode).toBeNull();
    // SIGINT closes the linger and the process exits cleanly (code 0).
    liveProcess.child.kill("SIGINT");
    const exit = await waitForExit(liveProcess.exited);
    expect(exit.exitCode).toBe(0);
  } finally {
    sqlite.close();
  }
}, 40_000);

test("lingerUntilClosed closes on a raw Ctrl-C (0x03) byte from a raw-mode pane stdin", async () => {
  // Regression: inside a real herdr linger pane, stdin is a raw-mode TTY (ISIG
  // off), so Ctrl-C is delivered as the raw ETX byte 0x03 on stdin and fires NO
  // SIGINT. The key handler must treat 0x03 like `q` and tear down; without the
  //  branch in the match, Ctrl-C is dead in a pane. Drive the real function
  // with a fake stdin stream (no TTY needed, so this runs in CI) and assert the
  // returned promise resolves when the raw byte arrives.
  const stdin = new PassThrough();
  /** @type {string[]} */
  const emitted = [];
  const closed = lingerUntilClosed({ stdin, emit: (t) => emitted.push(t) });
  // Give the linger a tick to wire up its data listener, then send the raw ETX.
  await new Promise((r) => setTimeout(r, 10));
  stdin.write(Buffer.from([0x03]));
  // Resolves promptly on the keypress; a hang here (caught by the watchdog) means
  // the 0x03 byte was ignored and Ctrl-C would be dead in a real pane.
  /** @type {ReturnType<typeof setTimeout>} */
  let watchdog;
  const timeout = new Promise((_, reject) => {
    watchdog = setTimeout(() => reject(new Error("linger did not close on raw Ctrl-C (0x03)")), 5_000);
  });
  try {
    await Promise.race([closed, timeout]);
  } finally {
    clearTimeout(watchdog);
  }
  // It advertised the Ctrl-C affordance it just honored.
  expect(emitted.join("")).toContain("Ctrl-C");
}, 20_000);

test("tail pages through a run with more events than one DB page, in order and without gaps", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  const chunks = 1_500; // > the 1000-row page size, so paging must span >1 page
  try {
    await seedBulkRun(adapter, "tail-bulk-run", chunks);
    const result = runSmithers(["tail", "tail-bulk-run", "--format", "jsonl"], {
      cwd: repo.dir,
      env: QUIET_ENV,
      timeoutMs: 60_000,
    });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
    const events = lines.map((line) => JSON.parse(line));
    const outputs = events.filter((event) => event.type === "NodeOutput");
    // Every chunk survived the paging: none dropped, none duplicated.
    expect(outputs.length).toBe(chunks);
    const seqs = events.map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicate seq across pages
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // strictly ordered
    // Boundary chunks (first and last, either side of the page split) are intact.
    expect(outputs[0].payload.text).toBe("chunk-0\n");
    expect(outputs[chunks - 1].payload.text).toBe(`chunk-${chunks - 1}\n`);
  } finally {
    sqlite.close();
  }
}, 90_000);

test("tail --format jsonl keeps one JSON line per event with embedded newlines and unicode", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  // Interior newlines, unicode, a quote and a tab: all must round-trip inside a
  // single JSON line, never splitting the event across output lines.
  const gnarly = 'α β\nγ δ\n😀 "quoted"\ttabbed\n';
  try {
    const clock = { ts: Date.now() - 1_000 };
    await insertRun(adapter, "tail-unicode-run", "finished");
    await insertEvent(adapter, "tail-unicode-run", "RunStarted", {}, clock);
    await insertEvent(adapter, "tail-unicode-run", "NodeStarted", { nodeId: "u", iteration: 0, attempt: 1 }, clock);
    await insertEvent(
      adapter,
      "tail-unicode-run",
      "NodeOutput",
      { nodeId: "u", iteration: 0, attempt: 1, text: gnarly, stream: "stdout" },
      clock,
    );
    await insertEvent(adapter, "tail-unicode-run", "RunFinished", {}, clock);
    const result = runSmithers(["tail", "tail-unicode-run", "--format", "jsonl"], {
      cwd: repo.dir,
      env: QUIET_ENV,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
    // Each line parses on its own — the embedded newlines did not break framing.
    const events = lines.map((line) => JSON.parse(line));
    const output = events.find((event) => event.type === "NodeOutput");
    expect(output?.payload.text).toBe(gnarly);
  } finally {
    sqlite.close();
  }
}, 40_000);

test("tail handles empty result sets: a run with no events and a nonexistent --node", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  try {
    // (a) A finished run with zero events must not hang and must end with the
    // terminal status line rather than crashing on an empty backfill.
    await insertRun(adapter, "tail-empty-run", "finished");
    const empty = runSmithers(["tail", "tail-empty-run"], {
      cwd: repo.dir,
      env: QUIET_ENV,
      timeoutMs: 30_000,
    });
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("Run tail-empty-run finished");

    // (b) Filtering to a node that produced nothing yields only the final
    // status line, cleanly, with no output from other nodes.
    await seedCompletedRun(adapter, "tail-ghost-node-run");
    const ghost = runSmithers(["tail", "tail-ghost-node-run", "--node", "ghost"], {
      cwd: repo.dir,
      env: QUIET_ENV,
      timeoutMs: 30_000,
    });
    expect(ghost.exitCode).toBe(0);
    expect(ghost.stdout).toContain("Run tail-ghost-node-run finished");
    expect(ghost.stdout).not.toContain(ALPHA_TEXT.trimEnd());
    expect(ghost.stdout).not.toContain(BETA_TEXT.trimEnd());
  } finally {
    sqlite.close();
  }
}, 40_000);

test("tail of an unknown run id errors cleanly with a non-zero exit", async () => {
  const repo = createTempRepo();
  const { sqlite } = openRepoDb(repo);
  try {
    const result = runSmithers(["tail", "no-such-run"], {
      cwd: repo.dir,
      env: QUIET_ENV,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Run not found");
  } finally {
    sqlite.close();
  }
}, 40_000);
