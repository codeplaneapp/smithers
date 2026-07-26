import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { Effect } from "effect";
import { runJj } from "@smithers-orchestrator/vcs";
import { listSmithersWorktrees } from "./listSmithersWorktrees.js";
import { getPlatformLayer } from "./platform-layer.js";
import { runGit } from "./runGit.js";

/** @typedef {import("./listSmithersWorktrees.js").SmithersWorktree} SmithersWorktree */
/** @typedef {{ path: string; runId: string; bytes: number }} ReapedWorktree */
/** @typedef {{ path: string; runId: string; reason: string }} SkippedWorktree */
/** @typedef {{ removed: ReapedWorktree[]; skipped: SkippedWorktree[]; bytesFreed: number; dryRun: boolean }} ReapWorktreesResult */

/**
 * A run in any of these states will never schedule another task, so nothing can
 * reach into its worktrees again. Everything else — running, paused, and every
 * `waiting-*` state — is live work and is never reaped.
 */
export const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled", "canceled"]);

/**
 * @param {string} path
 * @returns {Promise<number>}
 */
function directorySizeBytes(path) {
    return new Promise((res) => {
        const child = spawn("du", ["-sk", path], { stdio: ["ignore", "pipe", "ignore"] });
        let stdout = "";
        child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
        child.on("error", () => res(0));
        child.on("close", () => {
            const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
            res(Number.isFinite(kb) ? kb * 1024 : 0);
        });
    });
}

/**
 * @param {readonly string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number; stdout: string }>}
 */
async function jj(args, cwd) {
    const res = await Effect.runPromise(runJj([...args], { cwd }).pipe(Effect.provide(getPlatformLayer())));
    return { code: res.code, stdout: res.stdout };
}

/**
 * Are these commits already on the base branch in everything but identity? A
 * lane lands by squash or cherry-pick, which rewrites the commit, so ancestry
 * keeps answering "exists nowhere else" for work that is wholly upstream. Patch
 * ids see through the rewrite: `git cherry` prefixes a commit with `-` when the
 * upstream ref already carries an equivalent patch and `+` when it does not. A
 * commit git will not rule on (a merge, an unreadable ref) counts as unsaved.
 *
 * @param {string} gitDir
 * @param {readonly string[]} upstreamRefs
 * @param {readonly string[]} commits
 * @returns {Promise<boolean>}
 */
async function patchesAreUpstream(gitDir, upstreamRefs, commits) {
    for (const commit of commits) {
        let landed = false;
        for (const ref of upstreamRefs) {
            const res = await runGit(gitDir, ["cherry", ref, commit]);
            if (res.code !== 0)
                continue;
            const line = res.stdout.split("\n").find((entry) => entry.trim().endsWith(commit));
            if (line?.trimStart().startsWith("-")) {
                landed = true;
                break;
            }
        }
        if (!landed)
            return false;
    }
    return true;
}

/**
 * Does this jj workspace hold work that exists nowhere else? One revset answers
 * both halves of the question: `::@` includes the auto-snapshotted working copy,
 * so uncommitted edits make `@` non-empty, and anything already merged into the
 * base branch drops out of `~::base`. Empty commits carry no work and are
 * ignored. Whatever survives is only a *candidate*: a squash-landed lane keeps
 * its own commit ids, so the candidates are re-checked by patch id before the
 * workspace is called unsaved. A revset that will not evaluate (no such base)
 * reports "unsaved" — the reaper must never guess in the direction of deletion.
 *
 * @param {string} worktreePath
 * @param {string | undefined} baseBranch
 * @param {string} rootDir
 * @returns {Promise<boolean>}
 */
async function jjWorkspaceHasUnsavedWork(worktreePath, baseBranch, rootDir) {
    const base = baseBranch ?? "main";
    const revsets = [
        `::@ & ~::(${base} | ${base}@origin) & ~empty()`,
        `::@ & ~::${base} & ~empty()`,
        "::@ & ~::trunk() & ~empty()",
    ];
    for (const revset of revsets) {
        const res = await jj(["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"'], worktreePath);
        if (res.code !== 0)
            continue;
        const commits = res.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
        if (commits.length === 0)
            return false;
        return !(await patchesAreUpstream(rootDir, [`origin/${base}`, base], commits));
    }
    return true;
}

/**
 * Does this git worktree hold work that exists nowhere else? Uncommitted or
 * untracked files count, and so do commits that no remote branch and not even
 * the primary checkout's HEAD contains.
 *
 * @param {string} worktreePath
 * @param {string} rootDir
 * @returns {Promise<boolean>}
 */
async function gitWorktreeHasUnsavedWork(worktreePath, rootDir) {
    const status = await runGit(worktreePath, ["status", "--porcelain"]);
    if (status.code !== 0)
        return true;
    if (status.stdout.trim() !== "")
        return true;
    const head = await runGit(worktreePath, ["rev-parse", "HEAD"]);
    if (head.code !== 0)
        return true;
    const commit = head.stdout.trim();
    const onRemote = await runGit(worktreePath, ["branch", "-r", "--contains", commit]);
    if (onRemote.code === 0 && onRemote.stdout.trim() !== "")
        return false;
    const rootHead = await runGit(rootDir, ["rev-parse", "HEAD"]);
    if (rootHead.code !== 0)
        return true;
    const merged = await runGit(rootDir, ["merge-base", "--is-ancestor", commit, rootHead.stdout.trim()]);
    return merged.code !== 0;
}

/**
 * @param {SmithersWorktree} worktree
 * @param {string} rootDir
 * @returns {Promise<boolean>}
 */
function hasUnsavedWork(worktree, rootDir) {
    return worktree.owner.vcsType === "jj"
        ? jjWorkspaceHasUnsavedWork(worktree.path, worktree.owner.baseBranch, rootDir)
        : gitWorktreeHasUnsavedWork(worktree.path, rootDir);
}

/**
 * @param {SmithersWorktree} worktree
 * @param {string} rootDir
 * @returns {Promise<void>}
 */
async function removeWorktree(worktree, rootDir) {
    if (worktree.owner.vcsType === "jj") {
        await jj(["workspace", "forget", worktree.owner.workspaceName ?? basename(worktree.path)], rootDir);
    }
    rmSync(worktree.path, { recursive: true, force: true });
}

/**
 * Reclaim the worktrees of runs that are over. A `<Worktree>` lane is a full
 * checkout; a 64-lane run leaves 64 of them behind, and nothing ever removed
 * them, so repositories accumulated hundreds of registrations and tens of GB.
 *
 * Reaping is refused unless every one of these holds, and `force` relaxes only
 * the last one:
 *   - the worktree carries a Smithers ownership record (we created it);
 *   - its owning run is in a terminal state;
 *   - it holds no uncommitted, untracked, or unpushed work.
 *
 * @param {{
 *   rootDir: string,
 *   getRunStatus: (runId: string) => Promise<string | null | undefined>,
 *   runId?: string,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   olderThanMs?: number,
 *   nowMs?: number,
 * }} options
 * @returns {Promise<ReapWorktreesResult>}
 */
export async function reapWorktrees(options) {
    const { rootDir, getRunStatus, runId, force = false, dryRun = false, olderThanMs, nowMs = Date.now() } = options;
    const root = resolve(rootDir);
    const worktrees = await listSmithersWorktrees(root);
    /** @type {ReapedWorktree[]} */
    const removed = [];
    /** @type {SkippedWorktree[]} */
    const skipped = [];
    /** @type {Map<string, string | null>} */
    const statuses = new Map();
    let bytesFreed = 0;

    for (const worktree of worktrees) {
        const owner = worktree.owner;
        if (runId && owner.runId !== runId)
            continue;
        const entry = { path: worktree.path, runId: owner.runId };
        if (worktree.path === root || root.startsWith(`${worktree.path}${sep}`)) {
            skipped.push({ ...entry, reason: "is-root" });
            continue;
        }
        if (worktree.locked) {
            skipped.push({ ...entry, reason: "locked" });
            continue;
        }
        if (!statuses.has(owner.runId)) {
            statuses.set(owner.runId, (await getRunStatus(owner.runId)) ?? null);
        }
        const status = statuses.get(owner.runId);
        if (!status) {
            skipped.push({ ...entry, reason: "unknown-run" });
            continue;
        }
        if (!TERMINAL_RUN_STATUSES.has(status)) {
            skipped.push({ ...entry, reason: `run-${status}` });
            continue;
        }
        if (olderThanMs !== undefined && nowMs - owner.updatedAtMs < olderThanMs) {
            skipped.push({ ...entry, reason: "too-recent" });
            continue;
        }
        if (worktree.exists && !force && (await hasUnsavedWork(worktree, root))) {
            skipped.push({ ...entry, reason: "unsaved-work" });
            continue;
        }
        const bytes = worktree.exists ? await directorySizeBytes(worktree.path) : 0;
        if (!dryRun && worktree.exists) {
            await removeWorktree(worktree, root);
        }
        bytesFreed += bytes;
        removed.push({ ...entry, bytes });
    }

    if (!dryRun && removed.length > 0) {
        await runGit(root, ["worktree", "prune"]);
    }
    return { removed, skipped, bytesFreed, dryRun };
}
