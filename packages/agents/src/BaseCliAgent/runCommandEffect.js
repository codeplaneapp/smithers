import { Effect } from "effect";
import { spawnCaptureEffect } from "@smthrs/driver/child-process";
import { sanitizeCliArgs } from "./sanitizeCliArgs.js";
/**
 * @typedef {{ cwd: string; env: Record<string, string>; input?: string; timeoutMs?: number; idleTimeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number; truncateKeep?: "head" | "tail"; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; onProcess?: (event: { phase: "started" | "exited"; pid: number | undefined }) => void; }} RunCommandOptions
 */
/** @typedef {import("./RunCommandResult.ts").RunCommandResult} RunCommandResult */
/** @typedef {import("@smthrs/errors/SmithersError").SmithersError} SmithersError */

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
    // Spawn agent CLIs as their own process-group leader (POSIX) so cleanup
    // can kill the whole group — subagents, MCP servers, tool children —
    // instead of just the wrapper pid, and so an orphan reaper can address
    // the group by pgid after an engine death (#1464 AWF-3, #1332).
    detached: process.platform !== "win32",
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
