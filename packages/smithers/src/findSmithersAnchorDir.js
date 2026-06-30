import { resolve, dirname, join, relative, isAbsolute } from "node:path";
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
    const home = process.env.HOME ? resolve(process.env.HOME) : undefined;
    while (true) {
        // Stop at or above HOME — anchors must be proper project directories
        // strictly below the user's home directory.
        if (home) {
            const relToHome = relative(home, dir);
            const isInsideHome = relToHome !== "" && !relToHome.startsWith("..") && !isAbsolute(relToHome);
            if (!isInsideHome) {
                return undefined;
            }
        }
        const candidate = join(dir, ".smithers");
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return dir;
        }
        const parent = dirname(dir);
        // Stop at the root of whatever drive/volume `from` is on. On Windows CI
        // tmpdir() may live on a different drive than process.cwd(), so comparing
        // against resolve("/") can miss the real root and loop forever.
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}
