import { Effect } from "effect";
/**
 * Cross-version-safe JJ helpers.
 *
 * - Every helper accepts an optional `cwd` so callers can target a repo path.
 * - Spawning errors (e.g. jj not installed) are normalized to `code: 127`
 *   instead of throwing, giving stable error shapes for callers and tests.
 * - Workspace operations try multiple syntaxes to tolerate JJ version drift.
 */
export type RunJjOptions = {
    cwd?: string;
};
export type RunJjResult = {
    code: number;
    stdout: string;
    stderr: string;
};
/**
 * Run a `jj` command and capture output.
 * Minimal helper used by vcs features and safe to call when jj is missing.
 */
export declare function runJj(args: string[], opts?: RunJjOptions): Effect.Effect<{
    code: number;
    stdout: string;
    stderr: string;
} | {
    code: number;
    stdout: string;
    stderr: string;
}, never, import("@effect/platform/CommandExecutor").CommandExecutor>;
/**
 * Returns the current workspace change id (jj `change_id`) or null on failure.
 * Accepts optional `cwd` to run inside a target repository.
 */
export declare function getJjPointer(cwd?: string): Effect.Effect<string | null, never, import("@effect/platform/CommandExecutor").CommandExecutor>;
export type JjRevertResult = {
    success: boolean;
    error?: string;
};
/**
 * Restore the working copy to a previously recorded jujutsu `change_id`.
 * Used by the engine to revert attempts within the correct repo/worktree (via `cwd`).
 */
export declare function revertToJjPointer(pointer: string, cwd?: string): Effect.Effect<{
    success: true;
    error?: undefined;
} | {
    success: false;
    error: string;
}, never, import("@effect/platform/CommandExecutor").CommandExecutor>;
/**
 * Quick repo detection by executing a read-only jj command.
 */
export declare function isJjRepo(cwd?: string): Effect.Effect<boolean, never, import("@effect/platform/CommandExecutor").CommandExecutor>;
export type WorkspaceAddOptions = {
    cwd?: string;
    atRev?: string;
};
export type WorkspaceResult = {
    success: boolean;
    error?: string;
};
/**
 * Create a new JJ workspace at `path` with a friendly `name`.
 * NOTE: Syntax may vary between JJ versions; this helper aims to be permissive.
 */
export declare function workspaceAdd(name: string, path: string, opts?: WorkspaceAddOptions): Effect.Effect<{
    success: true;
    error?: undefined;
} | {
    success: false;
    error: string;
}, never, import("@effect/platform/CommandExecutor").CommandExecutor>;
export type WorkspaceInfo = {
    name: string;
    path: string | null;
    selected: boolean;
};
/**
 * List existing workspaces using a JJ template for structured output.
 * Falls back to parsing human output if `-T` is unavailable.
 */
export declare function workspaceList(cwd?: string): Effect.Effect<WorkspaceInfo[], never, import("@effect/platform/CommandExecutor").CommandExecutor>;
/**
 * Close the given workspace by name.
 */
export declare function workspaceClose(name: string, opts?: {
    cwd?: string;
}): Effect.Effect<{
    success: true;
    error?: undefined;
} | {
    success: false;
    error: string;
}, never, import("@effect/platform/CommandExecutor").CommandExecutor>;
