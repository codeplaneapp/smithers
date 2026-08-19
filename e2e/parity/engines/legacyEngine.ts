import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { runWorkflow } from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { killProcess } from "../../harness/killProcess.ts";
import type { ParityDriveContext, ParityFixture } from "../ParityFixture.ts";
import type { ParityObservation } from "../ParityObservation.ts";
import { observeRun } from "../observation/observeRun.ts";
import type { ParityEngine, ParityExecuteContext } from "./ParityEngine.ts";

/**
 * The legacy engine lane: `packages/engine`'s React-driver loop, reached
 * through the same public `runWorkflow` entry point a user calls.
 *
 * Nothing here is specific to parity beyond bookkeeping. The fixture builds a
 * real workflow on a real on-disk database, the engine runs it, and the
 * observation is read back out of storage afterwards.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_RUNNER = join(HERE, "..", "parityChildRunner.ts");

const DEFAULT_TIMEOUT_MS = 60_000;
const MARKER_POLL_INTERVAL_MS = 25;

/**
 * Run statuses that need no further work. Everything else is a durable park:
 * the run released its owner and waits for an approval, a signal, or a timer.
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "finished",
  "failed",
  "cancelled",
  "canceled",
  "continued",
]);

/**
 * A parked run is resumed at most this many times before the fixture is
 * treated as stuck. Each release (an approval granted, a signal delivered, a
 * timer fired) costs one resume, and no fixture needs more than a handful.
 */
const MAX_RESUMES = 8;

export const legacyEngine: ParityEngine = {
  id: "legacy",
  description: "packages/engine React-driver loop via runWorkflow",
  unavailableReason: () => null,
  execute: (fixture, context) =>
    fixture.execution === "crash-resume"
      ? executeCrashResume(fixture, context)
      : executeInProcess(fixture, context),
};

async function executeInProcess(
  fixture: ParityFixture,
  context: ParityExecuteContext,
): Promise<ParityObservation> {
  const build = fixture.build({
    dbPath: context.dbPath,
    runId: context.runId,
    mode: "initial",
    scratchDir: context.scratchDir,
  });
  ensureSmithersTables(build.db as never);

  // A SECOND connection, standing in for an operator or the gateway acting on
  // a live run. Fixtures drive approvals, signals, and cancels through it.
  const driverSqlite = new Database(context.dbPath);
  const driverAdapter = new SmithersDb(driverSqlite);

  try {
    const runPromise = Effect.runPromise(
      runWorkflow(build.workflow as never, { runId: context.runId, input: build.input }),
    );
    const drivePromise = fixture.drive
      ? fixture.drive({
          runId: context.runId,
          adapter: driverAdapter,
          scratchDir: context.scratchDir,
        })
      : Promise.resolve();
    await withTimeout(
      Promise.all([runPromise, drivePromise]).then(() =>
        resumeUntilTerminal(build.workflow, build.input, context, driverSqlite),
      ),
      fixture.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      `fixture ${fixture.id} on the legacy engine`,
    );
  } finally {
    driverSqlite.close();
    build.close();
  }

  return observeRun({
    dbPath: context.dbPath,
    runId: context.runId,
    fixture: fixture.id,
    ...(fixture.redactOutputColumns ? { redactOutputColumns: fixture.redactOutputColumns } : {}),
    ...(fixture.sideEffects ? { sideEffects: fixture.sideEffects(context.scratchDir) } : {}),
  });
}

/**
 * Carry a parked run through to a terminal verdict.
 *
 * `runWorkflow` returns as soon as a run parks on an approval, a signal, or a
 * timer: the run has released its owner and is waiting to be picked back up.
 * In production that pickup is the supervisor's resume sweep. The parity
 * suite performs the same resume itself so a fixture is always observed at a
 * terminal verdict rather than mid-park, and so the resumes are visible in
 * the attempt trace instead of hidden inside a background daemon.
 */
async function resumeUntilTerminal(
  workflow: unknown,
  input: Record<string, unknown>,
  context: ParityExecuteContext,
  sqlite: Database,
): Promise<void> {
  for (let resume = 0; resume < MAX_RESUMES; resume += 1) {
    const status = readRunStatus(sqlite, context.runId);
    if (status === null || TERMINAL_RUN_STATUSES.has(status)) return;
    await Effect.runPromise(
      runWorkflow(workflow as never, {
        runId: context.runId,
        input,
        resume: true,
        // A resumed run is claimed by a new owner id, so the lease has to be
        // taken over explicitly even though this is the same process.
        force: true,
      }),
    );
  }
  const status = readRunStatus(sqlite, context.runId);
  if (status !== null && !TERMINAL_RUN_STATUSES.has(status)) {
    throw new Error(
      `parity: run ${context.runId} was still ${status} after ${MAX_RESUMES} resumes`,
    );
  }
}

function readRunStatus(sqlite: Database, runId: string): string | null {
  const row = sqlite
    .query<{ status: string }, [string]>(`SELECT status FROM _smithers_runs WHERE run_id = ?`)
    .get(runId);
  return row ? row.status : null;
}

/**
 * Run the fixture in a real child process, SIGKILL that process once the
 * fixture's marker appears, then resume the same run id in a fresh process.
 *
 * The kill is a real signal to a real pid — no simulated crash — because the
 * durability claim being ported from `e2e/faults` is specifically that the
 * run survives the loss of the engine process.
 */
async function executeCrashResume(
  fixture: ParityFixture,
  context: ParityExecuteContext,
): Promise<ParityObservation> {
  if (!fixture.killAfterMarker && !fixture.killWhen) {
    throw new Error(
      `parity: fixture ${fixture.id} is crash-resume but declares neither killAfterMarker nor killWhen`,
    );
  }
  const timeoutMs = fixture.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const initial = spawnChild(fixture.id, context, "initial");

  // A connection outside the child process: it watches for the moment to
  // kill, and afterwards it is how the operator-side decision is made on a
  // run whose engine is gone. The child owns schema bootstrap, so this waits
  // for the tables to exist rather than racing them.
  await withTimeout(
    waitForSchema(context.dbPath, initial, fixture.id, timeoutMs),
    timeoutMs * 2,
    `schema bootstrap for ${fixture.id}`,
  );
  const observerSqlite = new Database(context.dbPath);
  const observerAdapter = new SmithersDb(observerSqlite);
  const driveContext = {
    runId: context.runId,
    adapter: observerAdapter,
    scratchDir: context.scratchDir,
  };

  try {
    const moment = await withTimeout(
      waitForKillMoment(fixture, initial, context, driveContext),
      timeoutMs,
      `kill moment for ${fixture.id}`,
    );
    if (moment === "kill") {
      await killProcess({ pid: initial.child.pid as number });
    }
    forceKill(initial.child);

    // The engine that owned this run is gone. Anything the fixture drives
    // from here — deciding a gate, delivering a signal — happens against a
    // run with no live owner, exactly as it does in production.
    if (fixture.drive) {
      await withTimeout(fixture.drive(driveContext), timeoutMs, `drive of ${fixture.id}`);
    }

    const resumed = spawnChild(fixture.id, context, "resume");
    try {
      const exit = await withTimeout(waitForExit(resumed.child), timeoutMs, `resume of ${fixture.id}`);
      if (exit.code !== 0) {
        throw new Error(
          `parity: resume child for ${fixture.id} exited with code ${exit.code}\n` +
            `stdout:\n${resumed.stdout()}\nstderr:\n${resumed.stderr()}`,
        );
      }
    } finally {
      forceKill(resumed.child);
    }
  } finally {
    observerSqlite.close();
  }

  return observeRun({
    dbPath: context.dbPath,
    runId: context.runId,
    fixture: fixture.id,
    ...(fixture.redactOutputColumns ? { redactOutputColumns: fixture.redactOutputColumns } : {}),
    ...(fixture.sideEffects ? { sideEffects: fixture.sideEffects(context.scratchDir) } : {}),
  });
}

type SpawnedChild = {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: () => { code: number | null; signal: NodeJS.Signals | null } | null;
};

function spawnChild(
  fixtureId: string,
  context: ParityExecuteContext,
  mode: "initial" | "resume",
): SpawnedChild {
  const child = spawn(
    "bun",
    [CHILD_RUNNER, fixtureId, context.dbPath, context.runId, mode, context.scratchDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exited: () => exited,
  };
}

/**
 * What the harness should do once the child has reached the fixture's kill
 * moment.
 *
 * `kill` is the normal case. `already-gone` only happens for a `killWhen`
 * fixture whose kill moment is a durable park: the engine releases the run and
 * the child's own exit path (flush, close, runtime teardown) can outrun the
 * poll that observes the park. Both leave the same durable state behind — a
 * parked run with no live owner — so the resume half of the fixture is
 * unaffected, and the observation is identical either way.
 */
type KillMoment = "kill" | "already-gone";

/** How long the durable park is re-checked for after the child exits first. */
const POST_EXIT_PARK_GRACE_MS = 5_000;

/**
 * Resolve when the child has reached the point the fixture wants to kill it
 * at: a marker file it wrote, or a durable state it parked in.
 *
 * For a marker fixture the child exiting first is always an error — a fault
 * that was never injected would let the fixture pass for the wrong reason. For
 * a `killWhen` fixture the child exiting first is only an error if it exited
 * WITHOUT reaching the declared durable state, so the state is re-checked
 * against the now-final database before the fixture is failed.
 */
async function waitForKillMoment(
  fixture: ParityFixture,
  spawned: SpawnedChild,
  context: ParityExecuteContext,
  driveContext: ParityDriveContext,
): Promise<KillMoment> {
  if (fixture.killWhen) {
    const reached = fixture.killWhen(driveContext).then(() => "reached" as const);
    const exited = childExited(spawned).then(() => "exited" as const);
    const first = await Promise.race([reached, exited]);
    if (first === "reached") return spawned.exited() ? "already-gone" : "kill";
    // The child is gone. Its writes are durable and final, so the kill moment
    // either already holds or never will; a bounded re-check tells them apart.
    await withTimeout(
      reached,
      POST_EXIT_PARK_GRACE_MS,
      `kill moment for ${fixture.id} after its child exited ` +
        `(code ${spawned.exited()?.code}, signal ${spawned.exited()?.signal})\n` +
        `stdout:\n${spawned.stdout()}\nstderr:\n${spawned.stderr()}`,
    );
    return "already-gone";
  }
  const markerPath = join(context.scratchDir, fixture.killAfterMarker as string);
  for (;;) {
    if (existsSync(markerPath)) return "kill";
    const exit = spawned.exited();
    if (exit) {
      throw new Error(
        `parity: ${fixture.id} child exited (code ${exit.code}, signal ${exit.signal}) before its kill marker appeared\n` +
          `stdout:\n${spawned.stdout()}\nstderr:\n${spawned.stderr()}`,
      );
    }
    await sleep(MARKER_POLL_INTERVAL_MS);
  }
}

/**
 * A sqlite error that only means "the child is still bootstrapping".
 *
 * The probe below is a second connection to a file the child is actively
 * creating, journalling, and recovering. Opening it in that window fails with
 * `SQLITE_CANTOPEN` (the file exists but its journal/WAL siblings do not yet)
 * or `SQLITE_BUSY*` / "database is locked" (the child holds the write lock, or
 * the connection has to run journal recovery it cannot get a lock for). None
 * of those mean the schema is absent, so they are polled through rather than
 * thrown; a genuinely broken database keeps failing and surfaces as the
 * caller's bootstrap timeout, with the last transient error attached.
 */
function isSchemaProbeTransient(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code === "SQLITE_CANTOPEN")) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("database is locked") ||
    message.includes("unable to open database file") ||
    message.includes("no such table")
  );
}

/**
 * Wait until the child has bootstrapped the internal tables. The parity
 * observer is a second connection to the same file, and opening it before the
 * child has created `_smithers_nodes` would make every poll fail on a missing
 * table rather than on a run that has not parked yet.
 */
async function waitForSchema(
  dbPath: string,
  spawned: SpawnedChild,
  fixtureId: string,
  timeoutMs: number,
): Promise<void> {
  let lastTransient: unknown = null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(dbPath)) {
      try {
        const probe = new Database(dbPath, { readonly: true });
        try {
          const row = probe
            .query<{ name: string }, []>(
              `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_smithers_nodes'`,
            )
            .get();
          if (row) return;
        } finally {
          probe.close();
        }
      } catch (error) {
        if (!isSchemaProbeTransient(error)) throw error;
        lastTransient = error;
      }
    }
    const exit = spawned.exited();
    if (exit) {
      throw new Error(
        `parity: ${fixtureId} child exited (code ${exit.code}, signal ${exit.signal}) before bootstrapping its schema\n` +
          `stdout:\n${spawned.stdout()}\nstderr:\n${spawned.stderr()}`,
      );
    }
    if (Date.now() >= deadline) {
      if (lastTransient) throw lastTransient;
      throw new Error(
        `parity: ${fixtureId} child never created _smithers_nodes within ${timeoutMs}ms\n` +
          `stdout:\n${spawned.stdout()}\nstderr:\n${spawned.stderr()}`,
      );
    }
    await sleep(MARKER_POLL_INTERVAL_MS);
  }
}

/** Resolves once the child process is gone, whatever its exit reason. */
async function childExited(spawned: SpawnedChild): Promise<void> {
  for (;;) {
    if (spawned.exited()) return;
    await sleep(MARKER_POLL_INTERVAL_MS);
  }
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function forceKill(child: ChildProcess): void {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`parity: ${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
