import { accessSync, chmodSync, constants as fsConstants, statSync } from "node:fs";

/**
 * Ensure the bundled `jj` binary is executable. The platform packages carry a
 * `postinstall` chmod, but bun (and pnpm v10+) block dependency lifecycle
 * scripts by default unless the package is trusted, so a normal install can
 * leave the binary without its exec bit — spawning it then fails with EACCES.
 * Repair it in-process (best effort) so the first worktree creation works
 * without any install-time cooperation.
 *
 * Internal: intentionally NOT re-exported from the package barrel, so it does
 * not become part of the public `@smithers-orchestrator/vcs` surface.
 *
 * @param {string} binaryPath
 * @returns {void}
 */
export function ensureJjExecutable(binaryPath) {
	try {
		accessSync(binaryPath, fsConstants.X_OK);
		return;
	} catch {
		// Not executable (or unreadable) — try to add the exec bits.
	}
	try {
		const mode = statSync(binaryPath).mode;
		chmodSync(binaryPath, mode | 0o111);
	} catch {
		// Read-only store or insufficient permissions: leave it and let the
		// spawn failure surface a friendly remediation upstream.
	}
}
