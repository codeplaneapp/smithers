import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { runGit } from "./runGit.js";

/** @typedef {import("./WorktreeOwner.ts").WorktreeOwner} WorktreeOwner */

export const WORKTREE_OWNER_FILE = "smithers-owner.json";

/**
 * Resolve the git admin directory backing `worktreePath`, but only when it is a
 * LINKED worktree (`<git-common-dir>/worktrees/<name>`). The primary checkout
 * resolves to `<repo>/.git`, and must never be marked owned — an ownership
 * record there would make the user's own repository a reap candidate.
 *
 * @param {string} worktreePath
 * @returns {Promise<string | null>}
 */
async function resolveLinkedWorktreeAdminDir(worktreePath) {
    const res = await runGit(worktreePath, ["rev-parse", "--absolute-git-dir"]);
    if (res.code !== 0)
        return null;
    const adminDir = res.stdout.trim();
    if (!adminDir)
        return null;
    const resolved = resolve(adminDir);
    if (basename(dirname(resolved)) !== "worktrees")
        return null;
    return resolved;
}

/**
 * Record (or refresh) which run owns `worktreePath`. Best effort: a worktree
 * that cannot be marked is simply never reaped.
 *
 * @param {string} worktreePath
 * @param {Omit<WorktreeOwner, "createdAtMs" | "updatedAtMs">} owner
 * @param {number} [nowMs]
 * @returns {Promise<boolean>}
 */
export async function writeWorktreeOwner(worktreePath, owner, nowMs = Date.now()) {
    try {
        const adminDir = await resolveLinkedWorktreeAdminDir(worktreePath);
        if (!adminDir)
            return false;
        const ownerPath = join(adminDir, WORKTREE_OWNER_FILE);
        const previous = readWorktreeOwnerFile(ownerPath);
        /** @type {WorktreeOwner} */
        const next = {
            ...owner,
            createdAtMs: previous?.createdAtMs ?? nowMs,
            updatedAtMs: nowMs,
        };
        writeFileSync(ownerPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        return true;
    }
    catch {
        return false;
    }
}

/**
 * @param {string} ownerPath
 * @returns {WorktreeOwner | null}
 */
export function readWorktreeOwnerFile(ownerPath) {
    if (!existsSync(ownerPath))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(ownerPath, "utf8"));
        if (!parsed || typeof parsed.runId !== "string" || !parsed.runId)
            return null;
        return /** @type {WorktreeOwner} */ (parsed);
    }
    catch {
        return null;
    }
}
