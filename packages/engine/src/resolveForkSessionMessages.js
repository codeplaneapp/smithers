import { SmithersError } from "@smthrs/errors/SmithersError";

/** @typedef {import("@smthrs/db/adapter/AttemptRow").AttemptRow} AttemptRow */

/**
 * Strip the loop-scope suffix (`@@ralph=0,...`) from a node id to recover the
 * logical task id authored in JSX.
 * @param {string} nodeId
 * @returns {string}
 */
function logicalNodeId(nodeId) {
  const atIdx = nodeId.indexOf("@@");
  return atIdx === -1 ? nodeId : nodeId.slice(0, atIdx);
}

/**
 * Parse the persisted agent conversation out of an attempt's meta JSON.
 * @param {string | null | undefined} metaJson
 * @returns {unknown[] | null}
 */
function conversationFromMeta(metaJson) {
  if (typeof metaJson !== "string" || metaJson.length === 0) {
    return null;
  }
  let meta;
  try {
    meta = JSON.parse(metaJson);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object") {
    return null;
  }
  const conversation = /** @type {{ agentConversation?: unknown }} */ (meta).agentConversation;
  if (!Array.isArray(conversation) || conversation.length === 0) {
    return null;
  }
  const usable = conversation.every((entry) => entry && typeof entry === "object");
  return usable ? conversation : null;
}

/**
 * Parse the compact agent-checkpoint reference persisted in attempt metadata.
 * The checkpoint payload itself deliberately lives outside meta_json so large
 * provider snapshots do not inflate attempt rows.
 *
 * @param {string | null | undefined} metaJson
 * @returns {{ contentHash: string; sequence: number; codec: string; version: number } | null}
 */
function checkpointRefFromMeta(metaJson) {
  if (typeof metaJson !== "string" || metaJson.length === 0) return null;
  let meta;
  try {
    meta = JSON.parse(metaJson);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const ref = /** @type {{ agentCheckpoint?: unknown }} */ (meta).agentCheckpoint;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  const candidate = /** @type {Record<string, unknown>} */ (ref);
  if (
    typeof candidate.contentHash !== "string" ||
    candidate.contentHash.length === 0 ||
    !Number.isSafeInteger(candidate.sequence) ||
    candidate.sequence < 0 ||
    typeof candidate.codec !== "string" ||
    candidate.codec.length === 0 ||
    !Number.isSafeInteger(candidate.version) ||
    candidate.version < 1
  ) {
    return null;
  }
  return {
    contentHash: candidate.contentHash,
    sequence: /** @type {number} */ (candidate.sequence),
    codec: candidate.codec,
    version: /** @type {number} */ (candidate.version),
  };
}

/**
 * Sort key for picking the most recently completed attempt. Prefer
 * finishedAtMs, fall back to startedAtMs, then attempt number.
 * @param {AttemptRow} attempt
 * @returns {number}
 */
function completionOrder(attempt) {
  if (typeof attempt.finishedAtMs === "number") return attempt.finishedAtMs;
  if (typeof attempt.startedAtMs === "number") return attempt.startedAtMs;
  return attempt.attempt ?? 0;
}

/**
 * Resolve the agent session snapshot to seed a forked task from. Scans every
 * attempt of the run for finished executions of the fork source (matched by
 * logical id, so a source inside a loop resolves to its latest completed
 * iteration) and returns a deep copy of the most recent usable conversation.
 *
 * The copy guarantees the source session is never mutated by the fork.
 *
 * @param {readonly AttemptRow[]} attempts All attempts for the run.
 * @param {string} forkSource Logical id of the fork source task.
 * @param {string} nodeId Logical/scoped id of the forking task (for errors).
 * @returns {unknown[]} A fresh copy of the source conversation messages.
 */
export function resolveForkSessionMessages(attempts, forkSource, nodeId) {
  const state = resolveForkAgentState(attempts, forkSource, nodeId);
  if (state.messages) return state.messages;
  throw new SmithersError(
    "TASK_FORK_SESSION_UNAVAILABLE",
    `Task "${nodeId}" forks "${forkSource}", which completed without a usable conversation snapshot.`,
    { nodeId, forkSource },
  );
}

/**
 * Resolve all durable agent continuation state available for a task fork. A
 * native checkpoint and a replayable conversation are collected independently
 * from the newest finished source attempts. The engine can then prefer a
 * compatible native checkpoint and fall back to messages for older agents.
 *
 * @param {readonly AttemptRow[]} attempts
 * @param {string} forkSource
 * @param {string} nodeId
 * @returns {{ checkpointRef: { contentHash: string; sequence: number; codec: string; version: number } | null; messages: unknown[] | null; sourceAttempt: AttemptRow }}
 */
export function resolveForkAgentState(attempts, forkSource, nodeId) {
  const finished = attempts.filter(
    (attempt) => logicalNodeId(attempt.nodeId) === forkSource && attempt.state === "finished",
  );
  if (finished.length === 0) {
    throw new SmithersError(
      "TASK_FORK_SOURCE_NOT_COMPLETE",
      `Task "${nodeId}" forks "${forkSource}", which has not completed.`,
      { nodeId, forkSource },
    );
  }
  const ordered = [...finished].sort((a, b) => completionOrder(b) - completionOrder(a));
  for (const attempt of ordered) {
    const checkpointRef = checkpointRefFromMeta(attempt.metaJson);
    const conversation = conversationFromMeta(attempt.metaJson);
    const messages = conversation ? /** @type {unknown[]} */ (JSON.parse(JSON.stringify(conversation))) : null;
    // A conversation may only substitute for a checkpoint from this exact
    // completed attempt. Mixing a newer native snapshot with an older retry or
    // loop iteration silently forks stale state.
    if (checkpointRef || messages) return { checkpointRef, messages, sourceAttempt: attempt };
  }
  throw new SmithersError(
    "TASK_FORK_SESSION_UNAVAILABLE",
    `Task "${nodeId}" forks "${forkSource}", which completed without a usable agent session snapshot.`,
    { nodeId, forkSource },
  );
}
