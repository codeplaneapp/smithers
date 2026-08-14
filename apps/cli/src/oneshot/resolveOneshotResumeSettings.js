import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseBuiltinResume } from "../resume-target.js";

/**
 * @param {readonly string[]} args
 * @param {string} name
 * @returns {string | undefined}
 */
function optionValue(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

/**
 * Recover the inputs that originally constructed an in-process oneshot graph.
 * The built-in resume descriptor stores the full goal (or a durable goal-file
 * path), unlike the human-readable config summary which is intentionally
 * truncated.
 *
 * @param {unknown} configJson
 * @param {{ readText?: (path: string) => string }} [deps]
 * @returns {{ goal: string; goalFile?: string; review?: "on" | "off"; model?: string; agent?: string } | null}
 */
export function resolveOneshotResumeSettings(configJson, deps = {}) {
  const descriptor = parseBuiltinResume(configJson);
  if (!descriptor || descriptor.command !== "oneshot") {
    let config;
    try {
      config = typeof configJson === "string" ? JSON.parse(configJson) : configJson;
    } catch {
      return null;
    }
    const summary = config && typeof config === "object" ? config.oneshot : undefined;
    const goal = summary && typeof summary === "object" ? summary.goal : undefined;
    if (typeof goal !== "string" || !goal.trim() || goal.endsWith("…")) return null;
    return {
      goal,
      ...(typeof summary.review === "boolean" ? { review: summary.review ? "on" : "off" } : {}),
    };
  }

  const readText = deps.readText ?? ((path) => readFileSync(path, "utf8"));
  const goalFile = optionValue(descriptor.args, "--goal-file");
  const goalPath = goalFile ? (isAbsolute(goalFile) ? goalFile : resolve(descriptor.cwd, goalFile)) : undefined;
  let goal;
  if (goalPath) {
    goal = readText(goalPath);
  } else if (descriptor.args[0]) {
    goal = descriptor.args[0];
  }
  if (!goal?.trim()) return null;

  const review = optionValue(descriptor.args, "--review");
  const model = optionValue(descriptor.args, "--model");
  const agent = optionValue(descriptor.args, "--agent");
  return {
    goal,
    ...(goalPath ? { goalFile: goalPath } : {}),
    ...(review === "on" || review === "off" ? { review } : {}),
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
  };
}
