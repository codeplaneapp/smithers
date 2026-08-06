// Leak-proof scratch directories for tests.
//
// Every `mkdtemp` in a suite that forgets to remove its directory leaves a
// permanent `$TMPDIR/smithers-*` entry behind. That is not hypothetical: the
// repo's suites grew ~30k of them (~35GB) and filled the volume twice, which
// then failed unrelated runs with ENOSPC.
//
// `makeTempDir` removes the "remember to clean up" step. It registers every
// directory it creates in a module-level registry, and a `process.on("exit")`
// sweep drains that registry — so no directory outlives the process that made
// it, whether the suite passed, failed, or threw on the way out. Call sites
// that want the space back sooner still can:
//
//   * `using dir = makeTempDir(...)` — released at the end of the block.
//   * `dir.cleanup()` — explicit, idempotent.
//   * `afterEach(cleanupTempDirs)` — drains per test. Worth adding in suites
//     whose directories are large (the PGlite migrate workspaces are ~40MB
//     each); everything else can ride the exit sweep.
//
// Deliberately *not* used here: a module-scope `afterEach`, which would only
// cover the first file to import this module (`bun test <dir>` runs every file
// in one process, with one module registry), and `onTestFinished`, which times
// the enclosing test out when called from inside an AsyncLocalStorage context
// such as `withTaskRuntime` (bun 1.4 canary).
//
// Only paths this module created are ever removed. Live state such as the
// running gateway's `$TMPDIR/smithers-gateway` is never in the registry and is
// never touched.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TempDir = {
  /** Absolute path of the created directory. */
  readonly path: string;
  /** Remove the directory and forget it. Idempotent. */
  readonly cleanup: () => void;
  readonly [Symbol.dispose]: () => void;
};

/** Paths created by this module and not yet removed. */
const tracked = new Set<string>();

// A just-closed SQLite/PGlite directory can still be held briefly on Windows,
// where the unlink races EBUSY. Retry rather than leak the directory.
const removeOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const;

const remove = (path: string): void => {
  tracked.delete(path);
  try {
    rmSync(path, removeOptions);
  } catch {
    // A directory that cannot be removed must not fail the test that used it.
  }
};

/** Remove every tracked directory. Safe to call repeatedly. */
export const cleanupTempDirs = (): void => {
  for (const path of [...tracked]) remove(path);
};

/** Paths currently tracked — the regression guard reads this. */
export const trackedTempDirs = (): readonly string[] => [...tracked];

// Resolved once. The import is dynamic so importing this helper from a plain
// script (a repro, a codemod) does not fail on the unavailable `bun:test`.
const afterAll = await import("bun:test").then(
  (mod) => mod.afterAll as ((fn: () => void) => void) | undefined,
  () => undefined,
);

// `afterAll` called from inside a running test still attaches to the file's
// own suite, which is what makes the drain self-scoping: each test file that
// creates a directory gets its own end-of-file drain, with no per-file opt-in
// to forget. Re-arming whenever the registry goes from empty to non-empty
// keeps that to roughly one hook per file rather than one per directory.
let sweepInstalled = false;
const armDrain = (): void => {
  if (!sweepInstalled) {
    sweepInstalled = true;
    // Covers plain `node`/`bun run` consumers. `bun test` does not emit
    // "exit", which is why the afterAll below carries the test runner.
    process.on("exit", cleanupTempDirs);
  }
  if (afterAll && tracked.size === 0) afterAll(cleanupTempDirs);
};

/**
 * Create a tracked scratch directory under `$TMPDIR`.
 *
 * @param prefix mkdtemp prefix, conventionally `smithers-<suite>-`.
 */
export const makeTempDir = (prefix = "smithers-"): TempDir => {
  armDrain();
  const path = mkdtempSync(join(tmpdir(), prefix));
  tracked.add(path);
  const cleanup = () => remove(path);
  return { path, cleanup, [Symbol.dispose]: cleanup };
};

/** `makeTempDir(...).path` — for call sites that only ever needed the string. */
export const makeTempDirPath = (prefix?: string): string => makeTempDir(prefix).path;
