/**
 * Recovery affordance for a terminally failed run (#1500 §4): point the
 * operator at the last good checkpoint with the exact resume/replay commands
 * instead of leaving them to rediscover the time-travel CLI under pressure.
 * Pure presentation over the existing snapshot/frame primitives: no new
 * time-travel machinery.
 */

/** @param {string} value */
function shellEscape(value) {
  if (/^[a-zA-Z0-9._/:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Build the recovery commands for a failed run from its durable rows.
 * @param {{ runId: string; workflowPath?: string | null; frameNo?: number | null; checkpointSeq?: number | null }} input
 * @returns {{ resume: string; replay?: string }}
 */
export function buildRunRecoveryCommands(input) {
  const workflowArg = input.workflowPath ? shellEscape(input.workflowPath) : "<workflow>";
  const runIdArg = shellEscape(String(input.runId));
  const resume = `smithers up ${workflowArg} --run-id ${runIdArg} --resume true`;
  const replay =
    input.frameNo != null ? `smithers replay ${workflowArg} --run-id ${runIdArg} --frame ${input.frameNo}` : undefined;
  return { resume, replay };
}

/**
 * Attach the recovery pointer to a run-level error payload (the errorToJson
 * shape): `details.recovery` always, plus a message suffix when a last good
 * checkpoint exists. Consumers (CLI, gateway, run UIs) all read this same
 * payload, so enriching it here fixes every surface at once (#1500 §3/§6).
 *
 * @param {object} adapter SmithersDb adapter
 * @param {string} runId
 * @param {string | null | undefined} workflowPath
 * @param {Record<string, any>} errorInfo errorToJson output, mutated in place
 * @returns {Promise<Record<string, any>>} errorInfo
 */
export async function attachRunFailureRecovery(adapter, runId, workflowPath, errorInfo) {
  let frameNo = null;
  let checkpointSeq = null;
  try {
    const frame = await adapter.getLastFrame(runId);
    const candidate = Number(frame?.frameNo ?? frame?.frame_no);
    if (Number.isSafeInteger(candidate) && candidate >= 0) frameNo = candidate;
  } catch {
    // Recovery info is best-effort; never mask the real failure.
  }
  try {
    if (typeof adapter.listWorkspaceCheckpoints === "function") {
      const checkpoints = await adapter.listWorkspaceCheckpoints(runId);
      const latest = checkpoints.at(-1);
      const candidate = Number(latest?.seq);
      if (Number.isSafeInteger(candidate)) checkpointSeq = candidate;
    }
  } catch {
    // Best-effort, same as above.
  }
  const commands = buildRunRecoveryCommands({ runId, workflowPath, frameNo, checkpointSeq });
  const details =
    errorInfo.details && typeof errorInfo.details === "object" && !Array.isArray(errorInfo.details)
      ? errorInfo.details
      : {};
  details.recovery = {
    runId,
    ...(frameNo != null ? { frameNo } : {}),
    ...(checkpointSeq != null ? { checkpointSeq } : {}),
    resume: commands.resume,
    ...(commands.replay ? { replay: commands.replay } : {}),
  };
  errorInfo.details = details;
  if (typeof errorInfo.message === "string" && !errorInfo.message.includes("Resume with:")) {
    const checkpointRef =
      frameNo != null
        ? ` Last good checkpoint: frame ${frameNo}${checkpointSeq != null ? ` (snapshot ${checkpointSeq})` : ""}.`
        : "";
    errorInfo.message = `${errorInfo.message}${checkpointRef} Resume with: ${commands.resume}${commands.replay ? ` or replay from the checkpoint with: ${commands.replay}` : ""}`;
  }
  return errorInfo;
}
