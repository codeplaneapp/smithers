import { existsSync } from "node:fs";

/**
 * Resolve the `git` executable Smithers should spawn.
 *
 * Order of preference:
 *   1. `SMITHERS_GIT_PATH` — an explicit override pointing at a real file.
 *   2. The bare `"git"`, left for the OS to resolve against `PATH`.
 *
 * Git is never bundled (only jj is); this mirrors {@link resolveJjBinary} so the
 * override and the tooling preflight share one source of truth for where git is.
 *
 * @returns {import("./ResolvedBinary.js").ResolvedBinary}
 */
export function resolveGitBinary() {
	const override = process.env.SMITHERS_GIT_PATH;
	if (override && existsSync(override)) return { path: override, source: "env" };
	return { path: "git", source: "path" };
}
