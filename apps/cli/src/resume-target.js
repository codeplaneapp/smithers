/**
 * Builtin-resume config: how a run whose workflow was built in-process (no
 * `.tsx` on disk, e.g. `smithers oneshot`) records the argv that reconstructs
 * it, so `supervise` can auto-resume a detached run that lost its engine.
 *
 * Keep this the single source of truth for the config key, shape, and argv
 * reconstruction used by supervise and the oneshot monitor controls.
 */

export const BUILTIN_RESUME_CONFIG_KEY = "builtinResume";

/**
 * @param {{ command: string; args: string[]; cwd: string }} input
 * @returns {{ command: string; args: string[]; cwd: string }}
 */
export function buildBuiltinResumeConfig({ command, args, cwd }) {
  return { command, args: [...args], cwd };
}

const REPLACED_OPTIONS = new Set(["--run-id", "--resume", "--force", "--detach", "--open"]);

/**
 * Remove options whose values are supplied by the relaunch. The recorded
 * oneshot argv always stores explicit boolean values, but accepting bare
 * boolean flags keeps this safe for older run rows.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function withoutRelaunchOptions(args) {
  const next = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [flag] = arg.split("=", 1);
    if (!REPLACED_OPTIONS.has(flag)) {
      next.push(arg);
      continue;
    }
    if (!arg.includes("=") && typeof args[index + 1] === "string" && !args[index + 1].startsWith("-")) {
      index += 1;
    }
  }
  return next;
}

/**
 * Reconstruct argv for either a fresh restart or a durable resume of an
 * in-process workflow. The caller supplies the CLI executable/entrypoint.
 *
 * @param {{ command: string; args: string[]; cwd: string }} config
 * @param {{ runId: string; resume: boolean }} options
 * @returns {{ args: string[]; cwd: string }}
 */
export function buildBuiltinRelaunch(config, options) {
  if (
    !config ||
    config.command !== "oneshot" ||
    !Array.isArray(config.args) ||
    typeof config.cwd !== "string" ||
    !config.cwd
  ) {
    throw new Error("Run does not contain a valid builtin oneshot resume target");
  }
  return {
    cwd: config.cwd,
    args: [
      config.command,
      ...withoutRelaunchOptions(config.args),
      "--run-id",
      options.runId,
      "--detach",
      "false",
      "--open",
      "false",
      ...(options.resume ? ["--resume", "true", "--force", "true"] : []),
    ],
  };
}
