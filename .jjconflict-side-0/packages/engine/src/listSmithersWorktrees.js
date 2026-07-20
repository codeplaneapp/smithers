import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runGit } from "./runGit.js";
import { readWorktreeOwnerFile, WORKTREE_OWNER_FILE } from "./worktreeOwnerFile.js";

/** @typedef {import("./WorktreeOwner.ts").WorktreeOwner} WorktreeOwner */
/** @typedef {{ path: string; adminDir: string; owner: WorktreeOwner; exists: boolean; locked: boolean }} SmithersWorktree */

/**
 * @param {string} rootDir
 * @returns {Promise<string | null>}
 */
async function resolveGitCommonDir(rootDir) {
    const res = await runGit(rootDir, ["rev-parse", "--git-common-dir"]);
    if (res.code !== 0)
        return null;
    const raw = res.stdout.trim();
    if (!raw)
        return null;
    return resolve(rootDir, raw);
}

/**
 * @param {string} adminDir
 * @returns {string | null}
 */
function readWorktreeCheckoutPath(adminDir) {
    try {
        const gitdir = readFileSync(join(adminDir, "gitdir"), "utf8").trim();
        return gitdir ? dirname(resolve(gitdir)) : null;
    }
    catch {
        return null;
    }
}

/**
 * Every worktree of `rootDir` that Smithers created for a `<Worktree>` node,
 * read straight out of git's own admin area. Worktrees without an ownership
 * record — anything a human added by hand — are not listed and so are never
 * reap candidates. Entries whose checkout is already gone are still listed
 * (`exists: false`) so `git worktree prune` can clear their stale registration.
 *
 * @param {string} rootDir
 * @returns {Promise<SmithersWorktree[]>}
 */
export async function listSmithersWorktrees(rootDir) {
    const commonDir = await resolveGitCommonDir(rootDir);
    if (!commonDir)
        return [];
    const worktreesDir = join(commonDir, "worktrees");
    if (!existsSync(worktreesDir))
        return [];
    /** @type {SmithersWorktree[]} */
    const entries = [];
    for (const name of readdirSync(worktreesDir)) {
        const adminDir = join(worktreesDir, name);
        const owner = readWorktreeOwnerFile(join(adminDir, WORKTREE_OWNER_FILE));
        if (!owner)
            continue;
        const path = readWorktreeCheckoutPath(adminDir);
        if (!path)
            continue;
        entries.push({
            path,
            adminDir,
            owner,
            exists: existsSync(path),
            locked: existsSync(join(adminDir, "locked")),
        });
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
}
