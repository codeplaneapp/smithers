import { Effect } from 'effect';
import * as _effect_platform_CommandExecutor from '@effect/platform/CommandExecutor';
import { existsSync } from 'node:fs';

/**
 * Walk up from `startDir` to find the nearest directory containing `.jj` or `.git`.
 * Prefers `.jj` over `.git` so colocated repos (both exist) use jj semantics.
 * Returns the VCS type and root path, or null if neither is found.
 *
 * @param {string} startDir
 * @returns {Effect.Effect<{ type: "jj"; root: string } | { type: "git"; root: string } | null, never, never>}
 */
declare function findVcsRoot(startDir: string): Effect.Effect<{
    type: "jj";
    root: string;
} | {
    type: "git";
    root: string;
} | null, never, never>;

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
 * @returns {Effect.Effect<RunJjResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function runJj(args: string[], opts?: RunJjOptions): Effect.Effect<RunJjResult, never, _effect_platform_CommandExecutor.CommandExecutor>;
/**
 * Returns the current workspace change id (jj `change_id`) or null on failure.
 * Accepts optional `cwd` to run inside a target repository.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<string | null, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function getJjPointer(cwd?: string): Effect.Effect<string | null, never, _effect_platform_CommandExecutor.CommandExecutor>;
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
 * @returns {Effect.Effect<WorkspaceSnapshot | null, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function captureWorkspaceSnapshot(cwd?: string): Effect.Effect<WorkspaceSnapshot | null, never, _effect_platform_CommandExecutor.CommandExecutor>;
/**
 * Restore the working copy to a previously recorded jujutsu `change_id`.
 * Used by the engine to revert attempts within the correct repo/worktree (via `cwd`).
 *
 * @param {string} pointer
 * @param {string} [cwd]
 * @returns {Effect.Effect<JjRevertResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function revertToJjPointer(pointer: string, cwd?: string): Effect.Effect<JjRevertResult, never, _effect_platform_CommandExecutor.CommandExecutor>;
/**
 * Quick repo detection by executing a read-only jj command.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<boolean, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function isJjRepo(cwd?: string): Effect.Effect<boolean, never, _effect_platform_CommandExecutor.CommandExecutor>;
/**
 * Create a new JJ workspace at `path` with a friendly `name`.
 * NOTE: Syntax may vary between JJ versions; this helper aims to be permissive.
 *
 * @param {string} name
 * @param {string} path
 * @param {WorkspaceAddOptions} [opts]
 * @returns {Effect.Effect<WorkspaceResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function workspaceAdd(name: string, path: string, opts?: WorkspaceAddOptions): Effect.Effect<WorkspaceResult, never, _effect_platform_CommandExecutor.CommandExecutor>;
/**
 * List existing workspaces using a JJ template for structured output.
 * Falls back to parsing human output if `-T` is unavailable.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<WorkspaceInfo[], never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function workspaceList(cwd?: string): Effect.Effect<WorkspaceInfo[], never, _effect_platform_CommandExecutor.CommandExecutor>;
/**
 * Close the given workspace by name.
 *
 * @param {string} name
 * @param {{ cwd?: string }} [opts]
 * @returns {Effect.Effect<WorkspaceResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function workspaceClose(name: string, opts?: {
    cwd?: string;
}): Effect.Effect<WorkspaceResult, never, _effect_platform_CommandExecutor.CommandExecutor>;
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
 * Locate the bundled `jj` binary for the current host, or null when no platform
 * package is installed (unsupported target, `--no-optional` install, or not yet
 * published). Resolution goes through the package's `package.json` so it works
 * regardless of hoisting layout.
 *
 * @returns {string | null}
 */
declare function resolveBundledJjPath({ platform, arch, resolvePackage, fileExists, }?: {
    platform?: NodeJS.Platform | undefined;
    arch?: NodeJS.Architecture | undefined;
    resolvePackage?: NodeJS.RequireResolve | undefined;
    fileExists?: typeof existsSync | undefined;
}): string | null;
/**
 * Resolve the `jj` executable Smithers should spawn.
 *
 * Order of preference:
 *   1. `SMITHERS_JJ_PATH` — an explicit override pointing at a real file.
 *   2. A binary bundled via `@smithers-orchestrator/jj-<platform>`.
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
