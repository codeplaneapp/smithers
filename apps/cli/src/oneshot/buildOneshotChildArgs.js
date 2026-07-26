/**
 * @param {{
 *   cliPath: string;
 *   goal: string;
 *   goalFile?: string;
 *   cwd: string;
 *   review: "on" | "off";
 *   model?: string;
 *   agent?: string;
 *   open: boolean;
 *   startedByHarness?: string;
 *   startedBySession?: string;
 *   startedByPrompt?: string;
 * }} options
 */
export function buildOneshotChildArgs(options) {
  const args = [options.cliPath, "oneshot"];
  if (options.goalFile) args.push("--goal-file", options.goalFile);
  else args.push(options.goal);
  args.push("--cwd", options.cwd, "--detach", "false", "--open", String(options.open), "--review", options.review);
  if (options.model) args.push("--model", options.model);
  if (options.agent) args.push("--agent", options.agent);
  if (options.startedByHarness) args.push("--started-by-harness", options.startedByHarness);
  if (options.startedBySession) args.push("--started-by-session", options.startedBySession);
  if (options.startedByPrompt !== undefined) args.push("--started-by-prompt", options.startedByPrompt);
  return args;
}
