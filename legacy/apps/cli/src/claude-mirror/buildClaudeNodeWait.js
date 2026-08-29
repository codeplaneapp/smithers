import { deriveClaudeWorkflowPhasesFromFrame } from "@smthrs/graph";
import { SmithersError } from "@smthrs/errors";
import { aggregateNodeDetailEffect } from "../node-detail.js";
import { runPromise } from "../smithersRuntime.js";
import { claudeMirrorContract } from "./claudeMirrorContract.js";
import { extractClaudeMirrorOutputText } from "./extractClaudeMirrorOutputText.js";
import { isTerminalClaudeMirrorNodeState } from "./isTerminalClaudeMirrorNodeState.js";
import { isTerminalClaudeMirrorRunStatus } from "./isTerminalClaudeMirrorRunStatus.js";
import { truncateClaudeMirrorText } from "./truncateClaudeMirrorText.js";

/**
 * Block until one node reaches a terminal state, then report it. This is the
 * whole life of a /workflows watcher row: the watcher agent runs this one
 * command (re-running on `timedOut: true`) and returns the text.
 *
 * A node can vanish: a later frame prunes it before it ever ran. That reports
 * `{ state: "skipped", vanished: true }` once the node is absent from both
 * the node table and the latest frame while the run is still alive, or once
 * the run itself is terminal.
 *
 * @param {any} adapter
 * @param {{ runId: string; nodeId: string; iteration?: number; timeoutMs?: number; intervalMs?: number; maxOutputChars?: number }} params
 */
export async function buildClaudeNodeWait(adapter, params) {
  const { runId, nodeId } = params;
  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs ?? 480000));
  const intervalMs = Math.max(100, Math.floor(params.intervalMs ?? 1000));
  const maxOutputChars = Math.max(0, Math.floor(params.maxOutputChars ?? 2000));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const run = await adapter.getRun(runId);
    if (!run) {
      throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`, { runId });
    }
    const rows = await Promise.resolve(adapter.listNodeIterationsEffect(runId, nodeId)).catch(() => []);
    const row = pickIteration(rows, params.iteration);
    if (row && isTerminalClaudeMirrorNodeState(row.state)) {
      const detail = await runPromise(
        aggregateNodeDetailEffect(adapter, {
          runId,
          nodeId,
          ...(params.iteration !== undefined ? { iteration: params.iteration } : {}),
        }),
      ).catch(() => undefined);
      return {
        contract: claudeMirrorContract,
        runId,
        nodeId,
        state: row.state,
        iteration: row.iteration ?? 0,
        timedOut: false,
        vanished: false,
        output: truncateClaudeMirrorText(detail ? extractClaudeMirrorOutputText(detail) : "", maxOutputChars),
      };
    }
    if (!row) {
      const inFrame = await nodeInLatestFrame(adapter, runId, nodeId);
      if (!inFrame) {
        // Pruned: gone from both the node table and the latest frame.
        return vanishedResult(runId, nodeId);
      }
      if (isTerminalClaudeMirrorRunStatus(run.status)) {
        return vanishedResult(runId, nodeId);
      }
    } else if (row.state === "pending" && isTerminalClaudeMirrorRunStatus(run.status)) {
      // The run ended without this node ever starting.
      return vanishedResult(runId, nodeId);
    }
    if (Date.now() >= deadline) {
      return {
        contract: claudeMirrorContract,
        runId,
        nodeId,
        state: row?.state ?? "unknown",
        iteration: row?.iteration ?? 0,
        timedOut: true,
        vanished: false,
        output: "",
      };
    }
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
}

/**
 * @param {any[]} rows
 * @param {number | undefined} iteration
 */
function pickIteration(rows, iteration) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return undefined;
  }
  if (iteration !== undefined) {
    return rows.find((row) => (row.iteration ?? 0) === iteration);
  }
  return rows.reduce((latest, row) => ((row.iteration ?? 0) > (latest.iteration ?? 0) ? row : latest));
}

/**
 * @param {any} adapter
 * @param {string} runId
 * @param {string} nodeId
 */
async function nodeInLatestFrame(adapter, runId, nodeId) {
  const frame = await Promise.resolve(adapter.getLastFrame(runId)).catch(() => undefined);
  if (!frame) {
    return false;
  }
  const plan = deriveClaudeWorkflowPhasesFromFrame({
    xmlJson: frame.xmlJson ?? null,
    taskIndexJson: frame.taskIndexJson ?? null,
  });
  const logical = String(nodeId).split("@@")[0];
  return plan.nodes.some((node) => node.nodeId === nodeId || String(node.nodeId).split("@@")[0] === logical);
}

/**
 * @param {string} runId
 * @param {string} nodeId
 */
function vanishedResult(runId, nodeId) {
  return {
    contract: claudeMirrorContract,
    runId,
    nodeId,
    state: "skipped",
    iteration: 0,
    timedOut: false,
    vanished: true,
    output: "",
  };
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
