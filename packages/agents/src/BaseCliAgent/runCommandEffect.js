import { Effect } from "effect";
import { spawnCaptureEffect } from "@smithers-orchestrator/driver/child-process";
import { sanitizeCliArgs } from "./sanitizeCliArgs.js";
/**
 * @typedef {{ cwd: string; env: Record<string, string>; input?: string; timeoutMs?: number; idleTimeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number; truncateKeep?: "head" | "tail"; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; onProcess?: (event: { phase: "started" | "exited"; pid: number | undefined }) => void; }} RunCommandOptions
 */
/** @typedef {import("./RunCommandResult.ts").RunCommandResult} RunCommandResult */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {RunCommandOptions} options
 * @returns {Effect.Effect<RunCommandResult, SmithersError>}
 */
export function runCommandEffect(command, args, options) {
  const {
    cwd,
    env,
    input,
    timeoutMs,
    idleTimeoutMs,
    signal,
    maxOutputBytes,
    truncateKeep,
    onStdout,
    onStderr,
    onProcess,
  } = options;
  return spawnCaptureEffect(command, args, {
    cwd,
    env,
    input,
    signal,
    timeoutMs,
    idleTimeoutMs,
    maxOutputBytes,
    truncateKeep,
    onStdout,
    onStderr,
    onProcess,
  }).pipe(
    Effect.annotateLogs({
      agentCommand: command,
      agentArgs: sanitizeCliArgs(args).join(" "),
      cwd,
    }),
    Effect.withLogSpan(`agent:${command}`),
  );
}
