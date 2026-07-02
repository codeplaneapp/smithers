import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";

const WORKFLOW_PATH_COMMANDS = new Set([
    "up",
    "graph",
    "fork",
    "replay",
    "revert",
    "timetravel",
]);
const WORKFLOW_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts", ".mdx"]);

/**
 * @param {string} value
 */
export function isOptionLike(value) {
    return value.startsWith("-");
}

/**
 * @param {string} value
 */
export function looksLikeWorkflowPath(value) {
    if (isOptionLike(value))
        return false;
    return WORKFLOW_EXTENSIONS.has(parse(value).ext);
}

/**
 * @param {string[]} args
 */
export function getExplicitWorkflowPath(args) {
    if (args.length === 0)
        return null;
    if (looksLikeWorkflowPath(args[0]))
        return args[0];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (!WORKFLOW_PATH_COMMANDS.has(arg))
            continue;
        for (let nextIndex = index + 1; nextIndex < args.length; nextIndex++) {
            const candidate = args[nextIndex];
            if (looksLikeWorkflowPath(candidate))
                return candidate;
        }
        return null;
    }
    for (const arg of args) {
        if (looksLikeWorkflowPath(arg))
            return arg;
    }
    return null;
}

/**
 * Resolve the local `smithers-orchestrator` package's bin JS file under
 * `<directory>/node_modules/`. Going through `package.json` (instead of the
 * `.bin/smithers` shell shim npm/pnpm generate) is the whole point: the shim
 * is `#!/bin/sh` and re-execing it with `process.execPath` (bun) makes bun
 * parse shell as JavaScript, which crashes with `Expected ")" but found
 * "$(echo "`.
 *
 * @param {string} directory
 */
export function resolveLocalSmithersBinJs(directory) {
    const pkgJsonPath = resolve(directory, "node_modules/smithers-orchestrator/package.json");
    if (!existsSync(pkgJsonPath))
        return null;
    let pkg;
    try {
        pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch {
        return null;
    }
    const binEntry = typeof pkg?.bin === "string" ? pkg.bin : pkg?.bin?.smithers;
    if (typeof binEntry !== "string" || binEntry.length === 0)
        return null;
    const binPath = resolve(dirname(pkgJsonPath), binEntry);
    return existsSync(binPath) ? binPath : null;
}

/**
 * @param {string} cwd
 * @param {string} workflowPath
 */
export function findNearestWorkflowLocalCli(cwd, workflowPath) {
    let current = dirname(resolve(cwd, workflowPath));
    while (true) {
        const localBin = resolveLocalSmithersBinJs(current);
        if (localBin)
            return localBin;
        const parent = dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
}

/**
 * @param {string} parent
 * @param {string} child
 */
function isStrictlyInside(parent, child) {
    const rel = relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Walk upward from `cwd` and return the nearest project-local smithers bin,
 * the way tsx/bunx resolve the nearest node_modules. At each level the
 * workflow pack's install (`.smithers/node_modules`) wins over the project's
 * own `node_modules` dependency. The starting directory is always checked
 * (so `~/.smithers` installs keep working when cwd IS the home directory);
 * ancestors are consulted only while strictly inside $HOME, matching
 * findSmithersAnchorDir's project-root boundary. Without $HOME the walk
 * continues to the filesystem root.
 *
 * @param {string} cwd
 * @param {string | undefined} home
 */
export function findNearestLocalSmithersCli(cwd, home) {
    const resolvedHome = home ? resolve(home) : undefined;
    let current = resolve(cwd);
    let isStart = true;
    while (true) {
        if (!isStart && resolvedHome && !isStrictlyInside(resolvedHome, current))
            return null;
        const packBin = resolveLocalSmithersBinJs(resolve(current, ".smithers"));
        if (packBin)
            return packBin;
        const projectBin = resolveLocalSmithersBinJs(current);
        if (projectBin)
            return projectBin;
        const parent = dirname(current);
        if (parent === current)
            return null;
        current = parent;
        isStart = false;
    }
}
