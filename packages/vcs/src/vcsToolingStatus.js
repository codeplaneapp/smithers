import { spawnSync } from "node:child_process";
import { resolveJjBinary } from "./resolveJjBinary.js";
import { resolveGitBinary } from "./resolveGitBinary.js";

/**
 * Whether a usable `jj` and/or `git` exists for the current host. Each field is
 * the resolved binary when `<bin> --version` runs, or null when it does not.
 *
 * @typedef {object} VcsToolingStatus
 * @property {import("./ResolvedBinary.js").ResolvedBinary | null} jj a usable jj (override, bundled, or PATH), else null
 * @property {import("./ResolvedBinary.js").ResolvedBinary | null} git a usable git (override or PATH), else null
 * @property {boolean} ok true when at least one of jj or git is usable
 */

const VERSION_PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether `<bin> --version` exits 0. Best-effort: a missing binary, a non-zero
 * exit, or a spawn error all read as "not usable".
 *
 * @param {import("./ResolvedBinary.js").ResolvedBinary} bin
 * @returns {boolean}
 */
export function runsVersion(bin) {
	try {
		const res = spawnSync(bin.path, ["--version"], {
			stdio: "ignore",
			timeout: VERSION_PROBE_TIMEOUT_MS,
		});
		return res.status === 0;
	} catch {
		return false;
	}
}

/**
 * Probe whether a usable `jj` and/or `git` exists for the current host, using
 * the override → bundled → PATH resolution for jj and override → PATH for git.
 *
 * Synchronous and best-effort: used by `smithers doctor` and run preflights to
 * tell the user — before a run fails deep in worktree creation — that no VCS
 * tooling is installed, and which knob (bundled package, PATH install, or
 * `SMITHERS_JJ_PATH`) would fix it.
 *
 * @returns {VcsToolingStatus}
 */
export function vcsToolingStatus() {
	const jjBin = resolveJjBinary();
	const gitBin = resolveGitBinary();
	const jj = runsVersion(jjBin) ? jjBin : null;
	const git = runsVersion(gitBin) ? gitBin : null;
	return { jj, git, ok: Boolean(jj || git) };
}
