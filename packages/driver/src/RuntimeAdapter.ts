import type { TaskExecutor } from "./TaskExecutor.ts";
import type { OutputSnapshot } from "./OutputSnapshot.ts";
import type { SignalRowInput } from "./SignalRows.ts";

/**
 * Wall-clock and monotonic timing, abstracted so the portable driver never
 * touches `Date`/`performance`/`setTimeout` directly — a runtime supplies the
 * concrete primitives (real globals in Node and in a browser; fakes in tests).
 */
export type RuntimeClock = {
  /** Wall-clock time in epoch milliseconds (`Date.now()` in Node/browser). */
  now(): number;
  /** Monotonic time in milliseconds (`performance.now()` in Node/browser). */
  monotonicNow(): number;
  /** Abortable delay; rejects with an `AbortError`-named error if `signal` fires first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

/** Minimal durable run record a `RuntimeStorage` persists across the run lifecycle. */
export type StoredRunState = {
  runId: string;
  status: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

/**
 * Persistence seam for the portable driver. A Node engine typically has its
 * own durable database and can treat this as a no-op; a browser (or any host
 * without a bespoke DB) backs it with real storage (e.g. an in-memory `Map`,
 * `IndexedDB`, etc.) so a run's per-task outputs and terminal state survive
 * across the whole lifecycle, not just a save-at-the-end wrapper.
 */
export type RuntimeStorage = {
  loadRun(runId: string): Promise<StoredRunState | undefined>;
  saveRun(runId: string, run: StoredRunState): Promise<void>;
  loadOutputs(runId: string): Promise<OutputSnapshot | undefined>;
  saveOutputs(runId: string, outputs: OutputSnapshot): Promise<void>;
};

/** Filesystem capability namespace. Every environment exposes this object; unsupported ops throw `RuntimeCapabilityError`. */
export type RuntimeFilesystem = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
};

export type RuntimeSubprocessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** Subprocess capability namespace. Unsupported in any environment without real process spawning (e.g. a browser). */
export type RuntimeSubprocess = {
  spawn(command: string, args?: readonly string[], opts?: Record<string, unknown>): Promise<RuntimeSubprocessResult>;
};

/** Worktree path-resolution capability, mirroring `@smthrs/graph`'s `resolveWorktreePath` contract. */
export type RuntimeWorktree = {
  resolve(path: string, opts?: { baseRootDir?: string; workflowPath?: string | null }): string;
};

export type RuntimeSandboxResult = {
  output: unknown;
};

/** Sandbox-execution capability namespace. Unsupported outside a Node/container host. */
export type RuntimeSandbox = {
  run(config: Record<string, unknown>): Promise<RuntimeSandboxResult>;
};

/**
 * Durable signal read capability. When present, `WorkflowDriver.renderAndSubmit`
 * calls `load` fresh on every render so `ctx.signalRows` always reflects the
 * latest delivered `_smithers_signals` rows for the run (no separate
 * invalidation step needed — every frame re-reads). Optional: environments
 * without a durable signal store (e.g. the browser runtime, or a driver used
 * purely for tests) fall back to whatever `RunOptions.signals` seeded once at
 * `run()` start.
 */
export type RuntimeSignals = {
  load(runId: string): Promise<SignalRowInput[]>;
};

/**
 * The full runtime contract the portable Smithers workflow core (driver +
 * scheduler + graph + renderer) depends on instead of reaching for
 * environment globals directly. A concrete adapter (Node, browser, ...) must
 * be a complete, immediately-usable implementation of this type on its own —
 * every field always present and callable, with unsupported operations
 * failing closed via `RuntimeCapabilityError` rather than being `undefined`.
 */
export type RuntimeAdapter = {
  /** Identifies the runtime for diagnostics and `RuntimeCapabilityError` messages (e.g. "node", "browser"). */
  readonly name: string;
  readonly clock: RuntimeClock;
  readonly storage: RuntimeStorage;
  /** Generates a new unique identifier (`crypto.randomUUID()` in Node/browser). */
  uuid(): string;
  /** Executes a single task descriptor to completion (or throws/rejects on failure). */
  executeTask: TaskExecutor;
  readonly filesystem: RuntimeFilesystem;
  readonly subprocess: RuntimeSubprocess;
  readonly worktree: RuntimeWorktree;
  readonly sandbox: RuntimeSandbox;
  /** Optional: see {@link RuntimeSignals}. Absent in adapters with no durable signal store. */
  readonly signals?: RuntimeSignals;
};
