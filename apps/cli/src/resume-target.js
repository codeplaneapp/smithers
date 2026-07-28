// @smithers-type-exports-begin
/** @typedef {import("./ResumeTarget.ts").ResumeTarget} ResumeTarget */
/** @typedef {import("./ResumeTarget.ts").BuiltinResumeDescriptor} BuiltinResumeDescriptor */
// @smithers-type-exports-end

import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Resolving "how do I restart this run?".
 *
 * Every recovery tool (`supervise`, `hijack`, the give-up diagnostics) used to
 * answer that question with one field: `run.workflow_path`. That silently
 * excluded every run started by a BUILT-IN workflow — `smithers oneshot` builds
 * its workflow in-process from the selected agent chain and records no path —
 * so the supervisor skipped those runs forever with "workflow file not found at
 * (missing path)", which made the recovery tool useless for the launch mode
 * most likely to be detached and orphaned.
 *
 * A built-in run instead records the argv that recreates it under
 * `config.builtinResume`, and this module turns either shape into one
 * {@link ResumeTarget} the resume path can spawn. Keep this the single source
 * of truth for the config key, shape, and argv reconstruction used by
 * supervise and the oneshot monitor controls.
 */

/** Key under a run's `config_json` holding a {@link BuiltinResumeDescriptor}. */
export const BUILTIN_RESUME_CONFIG_KEY = "builtinResume";

/**
 * Build the descriptor a built-in workflow persists so it can be resumed later.
 *
 * @param {{ command: string; args: readonly string[]; cwd: string }} params
 * @returns {BuiltinResumeDescriptor}
 */
export function buildBuiltinResumeConfig(params) {
  return {
    command: params.command,
    args: [...params.args],
    cwd: isAbsolute(params.cwd) ? params.cwd : resolve(params.cwd),
  };
}

/**
 * Read a built-in resume descriptor out of a run's persisted config.
 * Tolerant by design: a malformed or absent config means "not resumable as a
 * built-in", never a throw on the supervisor's poll loop.
 *
 * @param {unknown} configJson
 * @returns {BuiltinResumeDescriptor | null}
 */
export function parseBuiltinResume(configJson) {
  if (!configJson) return null;
  let parsed;
  if (typeof configJson === "string") {
    try {
      parsed = JSON.parse(configJson);
    } catch {
      return null;
    }
  } else if (typeof configJson === "object") {
    parsed = configJson;
  } else {
    return null;
  }
  const descriptor = /** @type {any} */ (parsed)?.[BUILTIN_RESUME_CONFIG_KEY];
  if (!descriptor || typeof descriptor !== "object") return null;
  const { command, args, cwd } = descriptor;
  if (typeof command !== "string" || command.length === 0) return null;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return null;
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  return { command, args, cwd };
}

/**
 * Absolute form of a recorded workflow path, or null when none was recorded.
 *
 * @param {string | null | undefined} workflowPath
 * @param {string} [from]
 * @returns {string | null}
 */
export function resolveWorkflowPath(workflowPath, from = process.cwd()) {
  if (!workflowPath) return null;
  return isAbsolute(workflowPath) ? workflowPath : resolve(from, workflowPath);
}

/**
 * Resolve how to relaunch a run. A workflow file on disk always wins: it is the
 * authored source of truth, and a built-in descriptor is only ever the fallback
 * for runs that have no file.
 *
 * @param {{ runId?: string; workflowPath?: string | null; configJson?: unknown }} run
 * @param {{ workflowExists: (workflowPath: string) => boolean; cwd?: string }} deps
 * @returns {ResumeTarget | null}
 */
export function resolveResumeTarget(run, deps) {
  const from = deps.cwd ?? process.cwd();
  const workflowPath = resolveWorkflowPath(run.workflowPath, from);
  if (workflowPath && deps.workflowExists(workflowPath)) {
    return { kind: "workflow-file", workflowPath, cwd: dirname(workflowPath) };
  }
  const builtin = parseBuiltinResume(run.configJson);
  if (builtin) {
    return { kind: "builtin", command: builtin.command, args: builtin.args, cwd: builtin.cwd };
  }
  return null;
}

/**
 * Human-readable identity of a resume target, for logs and give-up diagnostics.
 *
 * @param {ResumeTarget} target
 * @returns {string}
 */
export function describeResumeTarget(target) {
  return target.kind === "workflow-file" ? target.workflowPath : `built-in \`smithers ${target.command}\``;
}

const REPLACED_OPTIONS = new Set(["--run-id", "--resume", "--force", "--detach", "--open"]);

/**
 * Remove options whose values are supplied by the relaunch. The recorded
 * oneshot argv always stores explicit boolean values, but accepting bare
 * boolean flags keeps this safe for older run rows.
 *
 * @param {readonly string[]} args
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
 * @param {{ command: string; args: readonly string[]; cwd: string }} config
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
