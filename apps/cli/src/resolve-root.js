import { resolve } from "node:path";
import { findSmithersAnchorDir } from "smithers-orchestrator/findSmithersAnchorDir";

/**
 * Resolve the effective tool sandbox root for a local workflow launch.
 *
 * Every launch form — `smithers up <path>`, `smithers workflow run <name>`,
 * `smithers graph`, `smithers eval`, and detached/supervised resume — funnels
 * through here so the task root can never drift by launch form (issue #283).
 *
 * Resolution mirrors how `createSmithers()` locates `smithers.db`
 * (`findSmithersAnchorDir(process.cwd()) ?? cwd`, see #240/#248), so a run's
 * root directory and its database always live in the same place:
 *
 *   1. An explicit `--root`, resolved against the operator CWD.
 *   2. The project anchor: the nearest directory containing a `.smithers/`
 *      package, walking up from the operator CWD. Keeps `up`, `workflow run`,
 *      and `graph` on the same root, and makes a global `~/.smithers` workflow
 *      run against the repo it was launched from rather than the pack itself.
 *   3. The operator CWD, when no `.smithers/` anchor exists.
 *
 * @param {string | undefined | null} rootOption - the raw `--root` option value
 * @param {string} [cwd] - operator working directory (defaults to process.cwd())
 * @returns {string} absolute root directory
 */
export function resolveLaunchRootDir(rootOption, cwd = process.cwd()) {
    if (rootOption) {
        return resolve(cwd, rootOption);
    }
    const anchorDir = findSmithersAnchorDir(cwd);
    return anchorDir ?? resolve(cwd);
}

/**
 * Recover the absolute root directory persisted on a run's config JSON.
 *
 * The engine stores the effective (already absolute) `rootDir` in each run's
 * `configJson`. Reading it back lets a resume re-use the exact root the run was
 * originally launched with, instead of re-deriving it from the resume launch
 * context — which can differ (detached resume spawns from the workflow
 * directory, supervised resume from the supervisor's CWD). Returns `undefined`
 * when no usable root is recorded.
 *
 * @param {string | null | undefined} configJson
 * @returns {string | undefined}
 */
export function parsePersistedRootDir(configJson) {
    if (!configJson) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(configJson);
        const rootDir = parsed?.rootDir;
        return typeof rootDir === "string" && rootDir.length > 0
            ? rootDir
            : undefined;
    }
    catch {
        return undefined;
    }
}
