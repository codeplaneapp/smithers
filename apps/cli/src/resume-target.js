/**
 * Builtin-resume config: how a run whose workflow was built in-process (no
 * `.tsx` on disk, e.g. `smithers oneshot`) records the argv that reconstructs
 * it, so `supervise` can auto-resume a detached run that lost its engine.
 *
 * NOTE: reconstructed after the fact — the original module was referenced by
 * apps/cli/src/index.js but never committed (its producing worktree is gone),
 * which left `bun apps/cli/src/index.js` unable to boot at all. Keep this the
 * single source of truth for the config key and shape; the resume consumer
 * should import from here when it lands.
 */

export const BUILTIN_RESUME_CONFIG_KEY = "builtinResume";

/**
 * @param {{ command: string; args: string[]; cwd: string }} input
 * @returns {{ command: string; args: string[]; cwd: string }}
 */
export function buildBuiltinResumeConfig({ command, args, cwd }) {
  return { command, args: [...args], cwd };
}
