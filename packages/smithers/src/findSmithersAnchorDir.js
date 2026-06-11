import { resolve, dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";

/**
 * Walk upward from `from` and return the nearest directory that contains a
 * `.smithers/` subdirectory, or `undefined` if none is found before the
 * filesystem root.
 *
 * Directories at or above $HOME are excluded: a `~/.smithers` global pack
 * must not be treated as a project anchor, so the DB would incorrectly land
 * in the user's home directory.
 *
 * @param {string} from
 * @returns {string | undefined}
 */
export function findSmithersAnchorDir(from) {
    let dir = resolve(from);
    const fsRoot = resolve("/");
    const home = process.env.HOME ? resolve(process.env.HOME) : undefined;
    while (true) {
        // Stop at or above HOME — anchors must be proper project directories
        // strictly below the user's home directory.
        // Use startsWith rather than length comparison so that symlinks and
        // unusual mount points (e.g. /home2) don't produce false positives.
        if (home && (dir === home || !dir.startsWith(home + "/"))) {
            return undefined;
        }
        // Guard: never scan the filesystem root itself.
        if (dir === fsRoot) {
            return undefined;
        }
        const candidate = join(dir, ".smithers");
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return dir;
        }
        dir = dirname(dir);
    }
}
