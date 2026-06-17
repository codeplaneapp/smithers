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

import * as Command from "@effect/platform/Command";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { Duration, Effect, Fiber, Metric, Stream } from "effect";
import { vcsDuration } from "@smithers-orchestrator/observability/metrics";
import { resolveJjBinary } from "./resolveJjBinary.js";

const JJ_POINTER_TIMEOUT_MS = 1_500;
const WORKSPACE_SNAPSHOT_TIMEOUT_MS = 1_500;
/**
 * @param {Stream.Stream<Uint8Array, unknown, never>} stream
 * @returns {Effect.Effect<string, unknown, never>}
 */
function collectUtf8(stream) {
    const decoder = new TextDecoder("utf-8");
    return Stream.runFold(stream, "", (acc, chunk) => acc + decoder.decode(chunk, { stream: true })).pipe(Effect.map((acc) => acc + decoder.decode()));
}
/**
 * Run a `jj` command and capture output.
 * Minimal helper used by vcs features and safe to call when jj is missing.
 *
 * @param {string[]} args
 * @param {RunJjOptions} [opts]
 * @returns {Effect.Effect<RunJjResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
export function runJj(args, opts = {}) {
    let command = Command.make(resolveJjBinary().path, ...args);
    if (opts.cwd) {
        command = Command.workingDirectory(command, opts.cwd);
    }
    return Effect.scoped(Effect.gen(function* () {
        const start = performance.now();
        yield* Effect.logDebug(`jj ${args.join(" ")}`);
        const process = yield* Command.start(command);
        const stdoutFiber = yield* Effect.fork(collectUtf8(process.stdout));
        const stderrFiber = yield* Effect.fork(collectUtf8(process.stderr));
        const exitCode = yield* process.exitCode;
        const stdout = yield* Fiber.join(stdoutFiber);
        const stderr = yield* Fiber.join(stderrFiber);
        yield* Metric.update(vcsDuration, performance.now() - start);
        return {
            code: Number(exitCode),
            stdout,
            stderr,
        };
    })).pipe(Effect.annotateLogs({
        vcs: "jj",
        cwd: opts.cwd ?? "",
        args: args.join(" "),
    }), Effect.withLogSpan("vcs:jj"), Effect.catchAll((error) => Effect.succeed({
        code: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
    })));
}
/**
 * @param {RunJjResult} res
 * @returns {string}
 */
function jjError(res) {
    return res.stderr.trim() || `jj exited with code ${res.code}`;
}
/**
 * Returns the current workspace change id (jj `change_id`) or null on failure.
 * Accepts optional `cwd` to run inside a target repository.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<string | null, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
export function getJjPointer(cwd) {
    return runJj(["log", "-r", "@", "--no-graph", "--template", "change_id"], { cwd }).pipe(Effect.timeoutTo({
        duration: Duration.millis(JJ_POINTER_TIMEOUT_MS),
        onSuccess: (res) => res,
        onTimeout: () => ({
            code: 124,
            stdout: "",
            stderr: `jj pointer timed out after ${JJ_POINTER_TIMEOUT_MS}ms`,
        }),
    }), Effect.map((res) => {
        if (res.code !== 0)
            return null;
        const out = res.stdout.trim();
        return out ? out : null;
    }), Effect.annotateLogs({ cwd: cwd ?? "" }), Effect.withLogSpan("vcs:jj-pointer"));
}
/**
 * Wrap a snapshot jj call with a bounded timeout so a slow or hung jj cannot
 * block the agent. On timeout it returns a sentinel non-zero result, which the
 * caller treats as a durability gap rather than a value.
 *
 * @param {Effect.Effect<RunJjResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>} effect
 * @param {string} label
 * @returns {Effect.Effect<RunJjResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
function withSnapshotTimeout(effect, label) {
    return effect.pipe(Effect.timeoutTo({
        duration: Duration.millis(WORKSPACE_SNAPSHOT_TIMEOUT_MS),
        onSuccess: (res) => res,
        onTimeout: () => ({
            code: 124,
            stdout: "",
            stderr: `${label} timed out after ${WORKSPACE_SNAPSHOT_TIMEOUT_MS}ms`,
        }),
    }));
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
 * @returns {Effect.Effect<WorkspaceSnapshot | null, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
export function captureWorkspaceSnapshot(cwd) {
    return Effect.gen(function* () {
        const logRes = yield* withSnapshotTimeout(runJj(["log", "-r", "@", "--no-graph", "-T", 'commit_id ++ "\\n" ++ change_id'], { cwd }), "jj snapshot log");
        if (logRes.code !== 0)
            return null;
        const [commitId, changeId] = logRes.stdout.split("\n").map((part) => part.trim());
        if (!commitId)
            return null;
        const opRes = yield* withSnapshotTimeout(runJj(["--ignore-working-copy", "operation", "log", "--no-graph", "--limit", "1", "-T", "self.id()"], { cwd }), "jj snapshot op");
        if (opRes.code !== 0)
            return null;
        const operationId = opRes.stdout.trim();
        if (!operationId)
            return null;
        return { commitId, changeId: changeId ?? "", operationId };
    }).pipe(Effect.annotateLogs({ cwd: cwd ?? "" }), Effect.withLogSpan("vcs:jj-snapshot"));
}
/**
 * Restore the working copy to a previously recorded jujutsu `change_id`.
 * Used by the engine to revert attempts within the correct repo/worktree (via `cwd`).
 *
 * @param {string} pointer
 * @param {string} [cwd]
 * @returns {Effect.Effect<JjRevertResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
export function revertToJjPointer(pointer, cwd) {
    return runJj(["restore", "--from", pointer], { cwd }).pipe(Effect.map((res) => res.code === 0
        ? { success: true }
        : { success: false, error: jjError(res) }), Effect.annotateLogs({ cwd: cwd ?? "", pointer }), Effect.withLogSpan("vcs:jj-revert"));
}
/**
 * Quick repo detection by executing a read-only jj command.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<boolean, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
export function isJjRepo(cwd) {
    return runJj(["log", "-r", "@", "-n", "1", "--no-graph"], {
        cwd,
    }).pipe(Effect.map((res) => res.code === 0), Effect.annotateLogs({ cwd: cwd ?? "" }), Effect.withLogSpan("vcs:jj-is-repo"));
}
/**
 * Create a new JJ workspace at `path` with a friendly `name`.
 * NOTE: Syntax may vary between JJ versions; this helper aims to be permissive.
 *
 * @param {string} name
 * @param {string} path
 * @param {WorkspaceAddOptions} [opts]
 * @returns {Effect.Effect<WorkspaceResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
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
        try {
            if (fs.existsSync(path)) {
                fs.rmSync(path, { recursive: true, force: true });
            }
            const parentDir = nodePath.dirname(path);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }
        }
        catch (error) {
            // Best-effort cleanup: do not abort workspace creation if it fails,
            // but log a warning so cleanup failures are diagnosable rather than silent.
            yield* Effect.logWarning(`jj workspace pre-create cleanup failed at ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        let lastErr = "";
        for (const args of attempts) {
            const res = yield* runJj(args, { cwd: opts.cwd });
            if (res.code === 0) {
                return { success: true };
            }
            lastErr = jjError(res);
        }
        const hint = ` (partial state may exist at ${path}; consider removing it before retrying)`;
        return { success: false, error: lastErr + hint };
    }).pipe(Effect.annotateLogs({
        cwd: opts.cwd ?? "",
        workspaceName: name,
        workspacePath: path,
        workspaceAtRev: opts.atRev ?? "",
    }), Effect.withLogSpan("vcs:jj-workspace-add"));
}
/**
 * List existing workspaces using a JJ template for structured output.
 * Falls back to parsing human output if `-T` is unavailable.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<WorkspaceInfo[], never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
export function workspaceList(cwd) {
    return Effect.gen(function* () {
        let res = yield* runJj(["workspace", "list", "-T", 'name ++ "\\n"'], {
            cwd,
        });
        if (res.code === 0) {
            const lines = res.stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
            return lines.map((name) => ({ name, path: /** @type {string | null} */ (null), selected: false }));
        }
        res = yield* runJj(["workspace", "list"], { cwd });
        if (res.code !== 0)
            return [];
        /** @type {WorkspaceInfo[]} */
        const rows = [];
        for (const raw of res.stdout.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line)
                continue;
            const selected = line.startsWith("*");
            const rawName = selected ? line.replace(/^\*\s*/, "").trim() : line;
            const name = rawName.split(/\s+/)[0] ?? "";
            if (!name)
                continue;
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
 * @returns {Effect.Effect<WorkspaceResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
export function workspaceClose(name, opts = {}) {
    return runJj(["workspace", "forget", name], { cwd: opts.cwd }).pipe(Effect.map((res) => res.code === 0
        ? { success: true }
        : { success: false, error: jjError(res) }), Effect.annotateLogs({ cwd: opts.cwd ?? "", workspaceName: name }), Effect.withLogSpan("vcs:jj-workspace-close"));
}
