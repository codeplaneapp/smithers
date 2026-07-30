/**
 * @param {{
 *   cliPath: string;
 *   goal: string;
 *   goalFile?: string;
 *   cwd: string;
 *   review: "on" | "off";
 *   model?: string;
 *   agent?: string;
 *   preflight?: "auto" | "warn" | "off";
 *   runId?: string;
 *   resume?: boolean;
 *   force?: boolean;
 *   resumeClaimOwner?: string;
 *   resumeClaimHeartbeat?: number;
 *   resumeRestoreOwner?: string;
 *   resumeRestoreHeartbeat?: number;
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
  if (options.preflight) args.push("--preflight", options.preflight);
  if (options.runId) args.push("--run-id", options.runId);
  if (options.resume) args.push("--resume", "true");
  if (options.force) args.push("--force", "true");
  if (options.resumeClaimOwner) args.push("--resume-claim-owner", options.resumeClaimOwner);
  if (options.resumeClaimHeartbeat) args.push("--resume-claim-heartbeat", String(options.resumeClaimHeartbeat));
  if (options.resumeRestoreOwner) args.push("--resume-restore-owner", options.resumeRestoreOwner);
  if (options.resumeRestoreHeartbeat) args.push("--resume-restore-heartbeat", String(options.resumeRestoreHeartbeat));
  if (options.startedByHarness) args.push("--started-by-harness", options.startedByHarness);
  if (options.startedBySession) args.push("--started-by-session", options.startedBySession);
  if (options.startedByPrompt !== undefined) args.push("--started-by-prompt", options.startedByPrompt);
  return args;
}
