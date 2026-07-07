import { existsSync } from "node:fs";
import { resolve, dirname, parse } from "node:path";
/**
 * Walk up from `startDir` to find the nearest directory containing `.jj` or `.git`.
 * Prefers `.jj` over `.git` so colocated repos (both exist) use jj semantics.
 * Returns the VCS type and root path, or null if neither is found.
 *
 * @param {string} startDir
 * @returns {{ type: "jj"; root: string } | { type: "git"; root: string } | null}
 */
export function findVcsRoot(startDir) {
    let dir = resolve(startDir);
    const { root: fsRoot } = parse(dir);
    // Single loop covers every ancestor INCLUDING the filesystem root; the loop
    // stops at the filesystem root and the terminal `return null` reports "no VCS".
    while (true) {
        if (existsSync(resolve(dir, ".jj")))
            return /** @type {{ type: "jj"; root: string }} */ ({ type: "jj", root: dir });
        if (existsSync(resolve(dir, ".git")))
            return /** @type {{ type: "git"; root: string }} */ ({ type: "git", root: dir });
        if (dir === fsRoot)
            break;
        dir = dirname(dir);
    }
    return null;
}
