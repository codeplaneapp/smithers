import * as effect_unstable_process_ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner';
import { Effect } from 'effect';
import { accessSync, existsSync } from 'node:fs';

/**
 * Walk up from `startDir` to find the nearest directory containing `.jj` or `.git`.
 * Prefers `.jj` over `.git` so colocated repos (both exist) use jj semantics.
 * Returns the VCS type and root path, or null if neither is found.
 *
 * @param {string} startDir
 * @returns {{ type: "jj"; root: string } | { type: "git"; root: string } | null}
 */
declare function findVcsRoot(startDir: string): {
    type: "jj";
    root: string;
} | {
    type: "git";
    root: string;
} | null;

type WorkspaceResult$1 = {
    success: boolean;
    error?: string;
};

type WorkspaceInfo$1 = {
    name: string;
    path: string | null;
    selected: boolean;
};

type WorkspaceAddOptions$1 = {
    cwd?: string;
    atRev?: string;
};

type RunJjResult$1 = {
    code: number;
    stdout: string;
    stderr: string;
};

type RunJjOptions$1 = {
    cwd?: string;
};

type JjRevertResult$1 = {
    success: boolean;
    error?: string;
};

/**
 * Run a `jj` command and capture output.
 * Minimal helper used by vcs features and safe to call when jj is missing.
 *
 * @param {string[]} args
 * @param {RunJjOptions} [opts]
 * @returns {Effect.Effect<RunJjResult, never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
declare function runJj(args: string[], opts?: RunJjOptions): Effect.Effect<RunJjResult, never, effect_unstable_process_ChildProcessSpawner.ChildProcessSpawner>;
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
declare function getJjPointer(cwd?: string): Effect.Effect<string | null, never, effect_unstable_process_ChildProcessSpawner.ChildProcessSpawner>;
/**
 * Parse the snapshot values returned by the two jj commands in
 * {@link captureWorkspaceSnapshot}.
 *
 * @param {string} logStdout stdout from `jj log -r @ ...`
 * @param {string} opStdout stdout from `jj operation log ...`
 * @returns {WorkspaceSnapshot | null}
 */
declare function parseWorkspaceSnapshot(logStdout: string, opStdout: string): WorkspaceSnapshot | null;
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
declare function captureWorkspaceSnapshot(cwd?: string): Effect.Effect<WorkspaceSnapshot | null, never, effect_unstable_process_ChildProcessSpawner.ChildProcessSpawner>;
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
declare function revertToJjPointer(pointer: string, cwd?: string): Effect.Effect<JjRevertResult, never, effect_unstable_process_ChildProcessSpawner.ChildProcessSpawner>;
/**
 * Quick repo detection by executing a read-only jj command.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<boolean, never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
declare function isJjRepo(cwd?: string): Effect.Effect<boolean, never, effect_unstable_process_ChildProcessSpawner.ChildProcessSpawner>;
declare function workspaceAdd(name: any, path: any, opts?: {}): Effect.Effect<{
    success: boolean;
    error: string;
} | {
    success: boolean;
    error?: undefined;
}, never, effect_unstable_process_ChildProcessSpawner.ChildProcessSpawner>;
/**
 * List existing workspaces using a JJ template for structured output.
 * Falls back to parsing human output if `-T` is unavailable.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<WorkspaceInfo[], never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
declare function workspaceList(cwd?: string): Effect.Effect<WorkspaceInfo[], never, effect_unstable_process_ChildProcessSpawner.ChildProcessSpawner>;
/**
 * Close the given workspace by name.
 *
 * @param {string} name
 * @param {{ cwd?: string }} [opts]
 * @returns {Effect.Effect<WorkspaceResult, never, import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner>}
 */
declare function workspaceClose(name: string, opts?: {
    cwd?: string;
}): Effect.Effect<WorkspaceResult, never, effect_unstable_process_ChildProcessSpawner.ChildProcessSpawner>;
type JjRevertResult = JjRevertResult$1;
type RunJjOptions = RunJjOptions$1;
type RunJjResult = RunJjResult$1;
type WorkspaceAddOptions = WorkspaceAddOptions$1;
type WorkspaceInfo = WorkspaceInfo$1;
type WorkspaceResult = WorkspaceResult$1;
type WorkspaceSnapshot = {
    /**
     * Working-copy commit id for this snapshot.
     */
    commitId: string;
    /**
     * Stable JJ change id for the working copy.
     */
    changeId: string;
    /**
     * JJ operation id for the snapshot.
     */
    operationId: string;
};

/**
 * A resolved VCS executable plus where Smithers found it.
 *
 * - `env`: an explicit override (e.g. `SMITHERS_JJ_PATH`)
 * - `bundled`: a binary shipped inside a `@smithers-orchestrator/jj-<platform>` package
 * - `path`: the bare command name, left for the OS to resolve against `PATH`
 */
type ResolvedBinary = {
    path: string;
    source: "env" | "bundled" | "path";
};

/**
 * Resolve the `git` executable Smithers should spawn.
 *
 * Order of preference:
 *   1. `SMITHERS_GIT_PATH` — an explicit override pointing at a real file.
 *   2. The bare `"git"`, left for the OS to resolve against `PATH`.
 *
 * Git is never bundled (only jj is); this mirrors {@link resolveJjBinary} so the
 * override and the tooling preflight share one source of truth for where git is.
 *
 * @returns {import("./ResolvedBinary.js").ResolvedBinary}
 */
declare function resolveGitBinary(): ResolvedBinary;

/**
 * Whether the operating system can execute a bundled `jj` candidate.
 *
 * POSIX requires the executable bit; Windows selects the vendored `.exe` and
 * does not use POSIX mode bits, so existence/readability is sufficient there.
 * This is deliberately a probe, not a chmod: an unusable automatic bundle must
 * not shadow a working `jj` on PATH.
 *
 * Internal: intentionally NOT re-exported from the package barrel.
 *
 * @param {string} binaryPath
 * @param {{ platform?: NodeJS.Platform, accessFile?: typeof accessSync }} [options]
 * @returns {boolean}
 */
declare function isJjExecutable(binaryPath: string, { platform, accessFile }?: {
    platform?: NodeJS.Platform;
    accessFile?: typeof accessSync;
}): boolean;

/**
 * Locate the bundled `jj` binary for the current host, or null when no platform
 * package is installed and executable (unsupported target, `--no-optional`
 * install, not yet published, or stripped POSIX execute bits). Resolution goes
 * through the package's `package.json` so it works regardless of hoisting
 * layout.
 *
 * @returns {string | null}
 */
declare function resolveBundledJjPath({ platform, arch, resolvePackage, fileExists, fileExecutable, }?: {
    platform?: NodeJS.Platform | undefined;
    arch?: NodeJS.Architecture | undefined;
    resolvePackage?: NodeJS.RequireResolve | undefined;
    fileExists?: typeof existsSync | undefined;
    fileExecutable?: typeof isJjExecutable | undefined;
}): string | null;
/**
 * Resolve the `jj` executable Smithers should spawn.
 *
 * Order of preference:
 *   1. `SMITHERS_JJ_PATH` — an explicit override pointing at a real file. An
 *      existing override remains authoritative so a bad explicit path is
 *      reported instead of silently running a different binary.
 *   2. An executable binary bundled via
 *      `@smithers-orchestrator/jj-<platform>` (`.exe` existence on Windows).
 *   3. The bare `"jj"`, left for the OS to resolve against `PATH`.
 *
 * Always returns a spawnable command. When jj is genuinely absent the bare
 * `"jj"` simply fails to spawn, which `runJj` already normalizes to exit code
 * 127, so callers keep their soft-failure behavior.
 *
 * @returns {import("./ResolvedBinary.js").ResolvedBinary}
 */
declare function resolveJjBinary(): ResolvedBinary;

/**
 * Whether `<bin> --version` exits 0. Best-effort: a missing binary, a non-zero
 * exit, or a spawn error all read as "not usable".
 *
 * @param {import("./ResolvedBinary.js").ResolvedBinary} bin
 * @returns {boolean}
 */
declare function runsVersion(bin: ResolvedBinary): boolean;
/**
 * Probe whether a usable `jj` and/or `git` exists for the current host, using
 * the override → bundled → PATH resolution for jj and override → PATH for git.
 *
 * Synchronous and best-effort: used by `smithers doctor` and run preflights to
 * tell the user — before a run fails deep in worktree creation — that no VCS
 * tooling is installed, and which knob (bundled package, PATH install, or
 * `SMITHERS_JJ_PATH`) would fix it.
 *
 * @returns {VcsToolingStatus}
 */
declare function vcsToolingStatus(): VcsToolingStatus;
/**
 * Whether a usable `jj` and/or `git` exists for the current host. Each field is
 * the resolved binary when `<bin> --version` runs, or null when it does not.
 */
type VcsToolingStatus = {
    /**
     * a usable jj (override, bundled, or PATH), else null
     */
    jj: ResolvedBinary | null;
    /**
     * a usable git (override or PATH), else null
     */
    git: ResolvedBinary | null;
    /**
     * true when at least one of jj or git is usable
     */
    ok: boolean;
};

export { type JjRevertResult, type RunJjOptions, type RunJjResult, type VcsToolingStatus, type WorkspaceAddOptions, type WorkspaceInfo, type WorkspaceResult, type WorkspaceSnapshot, captureWorkspaceSnapshot, findVcsRoot, getJjPointer, isJjRepo, parseWorkspaceSnapshot, resolveBundledJjPath, resolveGitBinary, resolveJjBinary, revertToJjPointer, runJj, runsVersion, vcsToolingStatus, workspaceAdd, workspaceClose, workspaceList };
