import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Read the backend marker from the nearest .smithers anchor above `cwd`.
 * Returns the backend string (e.g. "pglite") or undefined if there is no marker
 * or it cannot be parsed. Used by executeUpCommand to redirect workflow.db to
 * the correct store after a `smithers migrate` has moved runs to pglite.
 * @param {string} cwd
 * @returns {string | undefined}
 */
export function readBackendMarkerForCwd(cwd) {
    let dir = resolve(cwd);
    const fsRoot = resolve("/");
    const home = process.env.HOME ? resolve(process.env.HOME) : undefined;
    while (true) {
        // Check this directory before deciding whether to stop. This ensures
        // workspaces in /tmp (outside $HOME) and workspaces AT $HOME both find
        // their .smithers markers on the first iteration.
        const backendMarkerPath = `${dir}/.smithers/backend.json`;
        const migratedMarkerPath = `${dir}/.smithers/migrated.json`;
        for (const markerPath of [backendMarkerPath, migratedMarkerPath]) {
            if (!existsSync(markerPath)) continue;
            try {
                const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
                const backend = parsed?.backend ?? parsed?.target?.backend;
                return typeof backend === "string" && backend.length > 0 ? backend.toLowerCase() : undefined;
            }
            catch {
                return undefined;
            }
        }
        if (dir === fsRoot) return undefined;
        // Don't traverse above HOME — stop after checking HOME itself so we
        // never pick up a backend.json belonging to a different workspace that
        // is an ancestor of the user's home directory.
        if (home && dir === home) return undefined;
        const next = dirname(dir);
        if (next === dir) return undefined;
        dir = next;
    }
}
