// @smithers-type-exports-begin
/** @typedef {import("./JjRevertResult.js").JjRevertResult} JjRevertResult */
/** @typedef {import("./RunJjOptions.js").RunJjOptions} RunJjOptions */
/** @typedef {import("./RunJjResult.js").RunJjResult} RunJjResult */
/** @typedef {import("./WorkspaceAddOptions.js").WorkspaceAddOptions} WorkspaceAddOptions */
/** @typedef {import("./WorkspaceInfo.js").WorkspaceInfo} WorkspaceInfo */
/** @typedef {import("./WorkspaceResult.js").WorkspaceResult} WorkspaceResult */
/**
 * @typedef {object} WorkspaceSnapshot
 * @property {string} commitId Working-copy commit id for this snapshot.
 * @property {string} changeId Stable JJ change id for the working copy.
 * @property {string} operationId JJ operation id for the snapshot.
 */
// @smithers-type-exports-end

import * as Command from "effect/unstable/process/ChildProcess";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { Duration, Effect, Fiber, Metric, Stream } from "effect";
import { vcsDuration } from "@smithers-orchestrator/observability/metrics";
import { resolveJjBinary } from "./resolveJjBinary.js";

// Bounds every jj probe/snapshot call (getJjPointer, isJjRepo, captureWorkspaceSnapshot):
// a hung jj must degrade to a failed probe, never stall the agent path — see withJjTimeout.
const JJ_PROBE_TIMEOUT_MS = 1_500;
// Effect's process finalizer sends SIGTERM and otherwise waits indefinitely.
// Bound teardown too, so a jj process that ignores SIGTERM cannot turn a
// 1.5-second probe timeout into an unbounded caller stall.
const JJ_FORCE_KILL_AFTER_MS = 500;
/**
 * @param {Stream.Stream<Uint8Array, unknown, never>} stream
 * @returns {Effect.Effect<string, unknown, never>}
 */
function collectUtf8(stream) {
  const decoder = new TextDecoder("utf-8");
  return Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + decoder.decode(chunk, { stream: true }),
  ).pipe(Effect.map((acc) => acc + decoder.decode()));
}
/**
 * Run a `jj` command and capture output.
 * Minimal helper used by vcs features and safe to call when jj is missing.
 *
 * @param {string[]} args
 * @param {RunJjOptions} [opts]
 * @returns {Effect.Effect<RunJjResult, never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
export function runJj(args, opts = {}) {
  let command = Command.make(resolveJjBinary().path, args, {
    forceKillAfter: Duration.millis(JJ_FORCE_KILL_AFTER_MS),
  });
  if (opts.cwd) {
    command = Command.setCwd(command, opts.cwd);
  }
  return Effect.scoped(
    Effect.suspend(() => {
      const start = performance.now();
      return Effect.gen(function* () {
        yield* Effect.logDebug(`jj ${args.join(" ")}`);
        const process = yield* command;
        const stdoutFiber = yield* Effect.forkChild(collectUtf8(process.stdout));
        const stderrFiber = yield* Effect.forkChild(collectUtf8(process.stderr));
        const exitCode = yield* process.exitCode;
        const stdout = yield* Fiber.join(stdoutFiber);
        const stderr = yield* Fiber.join(stderrFiber);
        return {
          code: Number(exitCode),
          stdout,
          stderr,
        };
      }).pipe(Effect.ensuring(Effect.suspend(() => Metric.update(vcsDuration, performance.now() - start))));
    }),
  ).pipe(
    Effect.annotateLogs({
      vcs: "jj",
      cwd: opts.cwd ?? "",
      args: args.join(" "),
    }),
    Effect.withLogSpan("vcs:jj"),
    Effect.catch((error) =>
      Effect.succeed({
        code: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
}
/**
 * @param {RunJjResult} res
 * @returns {string}
 */
function jjError(res) {
  return res.stderr.trim() || `jj exited with code ${res.code}`;
}
/**
 * Returns an immutable pointer to the current working-copy state (jj
 * `commit_id`, forcing one snapshot) or null on failure. Accepts optional
 * `cwd` to run inside a target repository.
 *
 * This MUST be the commit id, never the change id: the engine keeps `@` on
 * one change across task attempts, so a recorded change_id aliases to the
 * change's CURRENT commit at restore time and `jj restore --from <change_id>`
 * silently no-ops ("Nothing changed.") while reporting success. commit_id
 * pins the exact snapshot, which is also what makes it usable as a
 * state-discriminating cache-key component.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<string | null, never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
export function getJjPointer(cwd) {
  return withJjTimeout(runJj(["log", "-r", "@", "--no-graph", "--template", "commit_id"], { cwd }), "jj pointer").pipe(
    Effect.map((res) => {
      if (res.code !== 0) return null;
      const out = res.stdout.trim();
      return out ? out : null;
    }),
    Effect.annotateLogs({ cwd: cwd ?? "" }),
    Effect.withLogSpan("vcs:jj-pointer"),
  );
}
/**
 * Wrap a jj probe/snapshot call with a bounded timeout so a slow or hung jj
 * cannot block the agent. On timeout it returns a sentinel non-zero result,
 * which the caller treats as a failed probe (durability gap / not a repo)
 * rather than a value, and logs a warning so the silent downgrade is
 * diagnosable.
 *
 * @param {Effect.Effect<RunJjResult, never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>} effect
 * @param {string} label
 * @returns {Effect.Effect<RunJjResult, never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
function withJjTimeout(effect, label) {
  return effect.pipe(
    Effect.map((res) => ({ res, timedOut: false })),
    Effect.timeoutOrElse({
      duration: Duration.millis(JJ_PROBE_TIMEOUT_MS),
      orElse: () =>
        Effect.succeed({
          res: {
            code: 124,
            stdout: "",
            stderr: `${label} timed out after ${JJ_PROBE_TIMEOUT_MS}ms`,
          },
          timedOut: true,
        }),
    }),
    Effect.tap(({ timedOut }) =>
      timedOut
        ? Effect.logWarning(`${label} timed out after ${JJ_PROBE_TIMEOUT_MS}ms; treating as failed probe`)
        : Effect.void,
    ),
    Effect.map(({ res }) => res),
  );
}
/**
 * Parse the snapshot values returned by the two jj commands in
 * {@link captureWorkspaceSnapshot}.
 *
 * @param {string} logStdout stdout from `jj log -r @ ...`
 * @param {string} opStdout stdout from `jj operation log ...`
 * @returns {WorkspaceSnapshot | null}
 */
export function parseWorkspaceSnapshot(logStdout, opStdout) {
  const [commitId, changeId] = logStdout.split("\n").map((part) => part.trim());
  if (!commitId) return null;
  const operationId = opStdout
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!operationId) return null;
  return { commitId, changeId: changeId ?? "", operationId };
}
/**
 * Capture the current working-copy state as a restorable handle.
 *
 * Step 1 (`jj log -r @`) forces exactly one working-copy snapshot and returns the
 * resulting `commit_id` and `change_id`. Step 2 reads the latest operation id
 * WITHOUT taking a second snapshot (`--ignore-working-copy`), so both ids describe
 * the same snapshot from step 1. Returns null on any failure or timeout (a
 * durability gap the caller records); it never throws into the agent path.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<WorkspaceSnapshot | null, never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
export function captureWorkspaceSnapshot(cwd) {
  return Effect.gen(function* () {
    const logRes = yield* withJjTimeout(
      runJj(["log", "-r", "@", "--no-graph", "-T", 'commit_id ++ "\\n" ++ change_id'], { cwd }),
      "jj snapshot log",
    );
    if (logRes.code !== 0) return yield* snapshotGap("log", logRes.code, jjError(logRes));
    const opRes = yield* withJjTimeout(
      runJj(["--ignore-working-copy", "operation", "log", "--no-graph", "--limit", "1", "-T", "self.id()"], { cwd }),
      "jj snapshot op",
    );
    if (opRes.code !== 0) return yield* snapshotGap("operation-log", opRes.code, jjError(opRes));
    const snapshot = parseWorkspaceSnapshot(logRes.stdout, opRes.stdout);
    if (!snapshot) return yield* snapshotGap("parse", 0, "jj returned no commit id or operation id to parse");
    return snapshot;
  }).pipe(Effect.annotateLogs({ cwd: cwd ?? "" }), Effect.withLogSpan("vcs:jj-snapshot"));
}
/**
 * Record why a workspace snapshot could not be captured, then yield null.
 * Callers treat null as a durability gap; without this the reason (a jj error,
 * a timeout, or unparsable output) was lost and the gap was unattributable.
 *
 * @param {string} step which snapshot step failed
 * @param {number} code jj exit code for the failing step (0 when the failure is a parse gap)
 * @param {string} reason human-readable cause
 * @returns {Effect.Effect<null, never, never>}
 */
function snapshotGap(step, code, reason) {
  return Effect.logWarning(`jj workspace snapshot unavailable (durability gap): ${reason}`).pipe(
    Effect.annotateLogs({ snapshotStep: step, jjExit: String(code), reason }),
    Effect.as(null),
  );
}
/**
 * jj change ids render in the reverse-hex alphabet (k-z only), commit ids in
 * plain hex, so a stored pointer's kind is recoverable after the fact.
 *
 * @param {string} pointer
 * @returns {boolean}
 */
function isJjChangeIdPointer(pointer) {
  // `change_id` templates emit the full 32-character reverse-hex identifier.
  // Legacy database rows stored that full template value; arbitrary short
  // revision strings still go to jj for its normal validation.
  return /^[k-z]{32}$/.test(pointer);
}
/**
 * Restore the working copy to a previously recorded jj pointer (a `commit_id`
 * from {@link getJjPointer} or {@link captureWorkspaceSnapshot}). Used by the
 * engine to revert attempts within the correct repo/worktree (via `cwd`).
 *
 * Legacy rows recorded before the commit_id fix hold change_ids. jj still
 * accepts them, but `--from <change_id>` resolves to that change's CURRENT
 * commit, so when `@` never left the change the restore is a silent
 * filesystem no-op. That aliasing cannot be repaired from the pointer alone
 * (the historical commit is unrecoverable without the evolog position), so it
 * must fail closed instead of invoking a command known to alias to the current
 * filesystem state.
 *
 * @param {string} pointer
 * @param {string} [cwd]
 * @returns {Effect.Effect<JjRevertResult, never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
export function revertToJjPointer(pointer, cwd) {
  if (isJjChangeIdPointer(pointer)) {
    const error =
      "Cannot restore legacy jj change_id pointer: it resolves to the change's current commit, not the recorded historical filesystem state.";
    return Effect.logWarning(error).pipe(
      Effect.as({ success: false, error }),
      Effect.annotateLogs({ cwd: cwd ?? "", pointer }),
      Effect.withLogSpan("vcs:jj-revert"),
    );
  }
  return runJj(["restore", "--from", pointer], { cwd }).pipe(
    Effect.map((res) => (res.code === 0 ? { success: true } : { success: false, error: jjError(res) })),
    Effect.annotateLogs({ cwd: cwd ?? "", pointer }),
    Effect.withLogSpan("vcs:jj-revert"),
  );
}
/**
 * Quick repo detection by executing a read-only jj command.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<boolean, never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
export function isJjRepo(cwd) {
  return withJjTimeout(
    runJj(["log", "-r", "@", "-n", "1", "--no-graph"], {
      cwd,
    }),
    "jj repo check",
  ).pipe(
    Effect.map((res) => res.code === 0),
    Effect.annotateLogs({ cwd: cwd ?? "" }),
    Effect.withLogSpan("vcs:jj-is-repo"),
  );
}
/**
 * Create a new JJ workspace at `path` with a friendly `name`.
 * NOTE: Syntax may vary between JJ versions; this helper aims to be permissive.
 *
 * @param {string} name
 * @param {string} path
 * @param {WorkspaceAddOptions} [opts]
 * @returns {Effect.Effect<WorkspaceResult, never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
/** Transient shared-lock failures worth retrying (holders live for ms–s). */
const LOCK_CONTENTION_PATTERN =
  /could not be obtained|Could not acquire lock|index\.lock|packed-refs\.lock|lock file already exists/i;
const LOCK_CONTENTION_RETRIES = 8;

export function workspaceAdd(name, path, opts = {}) {
  const attempts = [];
  const revTail = opts.atRev ? ["-r", opts.atRev] : [];
  attempts.push(["workspace", "add", path, "--name", name, ...revTail]);
  if (opts.atRev) {
    attempts.push(["workspace", "add", "-r", opts.atRev, path, "--name", name]);
  }
  attempts.push(["workspace", "add", name, path, ...revTail]);
  attempts.push(["workspace", "add", "--wc-path", path, name, ...revTail]);
  return Effect.gen(function* () {
    // Pre-check: forget stale workspace + ensure parent dir exists
    const listRes = yield* runJj(["workspace", "list"], { cwd: opts.cwd });
    if (listRes.code === 0 && listRes.stdout.includes(`${name}:`)) {
      yield* runJj(["workspace", "forget", name], { cwd: opts.cwd });
    }
    let backupRoot;
    let backupPath;
    try {
      const parentDir = nodePath.dirname(path);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      if (fs.existsSync(path)) {
        // Keep prior contents until jj confirms that workspace creation succeeded.
        backupRoot = fs.mkdtempSync(nodePath.join(parentDir, `.${nodePath.basename(path)}.smithers-backup-`));
        backupPath = nodePath.join(backupRoot, "workspace");
        fs.renameSync(path, backupPath);
      }
    } catch (error) {
      if (backupRoot && (!backupPath || !fs.existsSync(backupPath))) {
        try {
          fs.rmSync(backupRoot, { recursive: true, force: true });
        } catch {}
      }
      return {
        success: false,
        error: `jj workspace could not preserve the existing target at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const errors = [];
    // Shared .git lock contention (index.lock, packed-refs.lock) is always
    // transient: some other git/jj process holds it for milliseconds to
    // seconds. jj itself gives up after ONE acquisition attempt, so retry
    // the same invocation with jittered backoff before falling down the
    // syntax ladder (issue #935: 38 of 50 parallel lanes lost this race).
    for (const args of attempts) {
      let res = yield* runJj(args, { cwd: opts.cwd });
      for (
        let retry = 0;
        res.code !== 0 && LOCK_CONTENTION_PATTERN.test(jjError(res)) && retry < LOCK_CONTENTION_RETRIES;
        retry += 1
      ) {
        yield* Effect.sleep(`${150 + Math.floor(Math.random() * 600)} millis`);
        res = yield* runJj(args, { cwd: opts.cwd });
      }
      if (res.code === 0) {
        if (backupRoot) {
          try {
            fs.rmSync(backupRoot, { recursive: true, force: true });
          } catch (error) {
            yield* Effect.logWarning(
              `jj workspace backup cleanup failed at ${backupRoot}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return { success: true };
      }
      errors.push(`\`jj ${args.join(" ")}\`: ${jjError(res)}`);
    }
    let restoreError = "";
    if (backupPath && backupRoot) {
      try {
        fs.rmSync(path, { recursive: true, force: true });
        fs.renameSync(backupPath, path);
        fs.rmSync(backupRoot, { recursive: true, force: true });
      } catch (error) {
        restoreError = `; failed to restore the existing target from ${backupPath}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    // Report every attempt: the first uses the current jj syntax, so its error
    // is the real cause; later ones are legacy-syntax fallbacks whose noise
    // (e.g. "unexpected argument '--wc-path'") used to mask it.
    const joined = errors.join("; ");
    // A spawn EACCES means the resolved jj binary is not executable — most
    // often the bundled binary installed without its exec bit (bun/pnpm
    // skip lifecycle scripts) or a macOS quarantine flag. Point at the
    // concrete fixes rather than leaving the raw "permission denied".
    const jjBinary = resolveJjBinary();
    const permissionDenied = /EACCES|permission denied|PermissionDenied/i.test(joined);
    const hint = permissionDenied
      ? ` (cannot execute the jj binary at ${jjBinary.path}. Fix with \`chmod +x ${jjBinary.path}\`` +
        (process.platform === "darwin"
          ? `, clear macOS quarantine with \`xattr -d com.apple.quarantine ${jjBinary.path}\`,`
          : ",") +
        ` or point SMITHERS_JJ_PATH at a working jj)`
      : backupPath && !restoreError
        ? ` (previous contents at ${path} were restored)`
        : ` (partial state may exist at ${path}; consider removing it before retrying)`;
    return { success: false, error: joined + hint + restoreError };
  }).pipe(
    Effect.annotateLogs({
      cwd: opts.cwd ?? "",
      workspaceName: name,
      workspacePath: path,
      workspaceAtRev: opts.atRev ?? "",
    }),
    Effect.withLogSpan("vcs:jj-workspace-add"),
  );
}
/**
 * List existing workspaces using a JJ template for structured output.
 * Falls back to parsing human output if `-T` is unavailable.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<WorkspaceInfo[], never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
export function workspaceList(cwd) {
  return Effect.gen(function* () {
    let res = yield* runJj(
      ["workspace", "list", "-T", 'name ++ "\\t" ++ if(target.current_working_copy(), "true", "false") ++ "\\n"'],
      {
        cwd,
      },
    );
    if (res.code === 0) {
      const lines = res.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return lines.map((line) => {
        const [name = "", selected = "false"] = line.split("\t");
        return { name, path: /** @type {string | null} */ (null), selected: selected === "true" };
      });
    }
    res = yield* runJj(["workspace", "list"], { cwd });
    if (res.code !== 0) return [];
    /** @type {WorkspaceInfo[]} */
    const rows = [];
    for (const raw of res.stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const selected = line.startsWith("*");
      const rawName = selected ? line.replace(/^\*\s*/, "").trim() : line;
      const name = rawName.split(/\s+/)[0] ?? "";
      if (!name) continue;
      rows.push({ name, path: null, selected });
    }
    return rows;
  }).pipe(Effect.annotateLogs({ cwd: cwd ?? "" }), Effect.withLogSpan("vcs:jj-workspace-list"));
}
/**
 * Close the given workspace by name.
 *
 * @param {string} name
 * @param {{ cwd?: string }} [opts]
 * @returns {Effect.Effect<WorkspaceResult, never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
export function workspaceClose(name, opts = {}) {
  return runJj(["workspace", "forget", name], { cwd: opts.cwd }).pipe(
    Effect.map((res) => (res.code === 0 ? { success: true } : { success: false, error: jjError(res) })),
    Effect.annotateLogs({ cwd: opts.cwd ?? "", workspaceName: name }),
    Effect.withLogSpan("vcs:jj-workspace-close"),
  );
}
