/**
 * Resume pointers recorded on an attempt row (#1610).
 *
 * An agent attempt records where its conversation lives — the CLI session id
 * (`agentResume`), the captured transcript (`agentConversation`), the last
 * heartbeat payload carrying both (`lastHeartbeat`), and the sibling markers
 * describing what the attempt itself resumed from. Those pointers are only
 * meaningful while the conversation they name still exists. Once an attempt
 * ends failed or cancelled the conversation is usually gone, so the next
 * attempt of that node resumes a dead id and dies immediately with
 * `AGENT_SESSION_LOST`, burning a retry without doing any work.
 *
 * Discarding a resume pointer costs conversation context, never work: the
 * agent's real state lives in its worktree, not in the conversation. Do not
 * "restore" a pointer here as an optimization.
 */

/**
 * Attempt states that end an attempt without success. `in-progress` and the
 * `waiting-*` states are deliberately absent: those attempts are still live and
 * their pointers are the ones a legitimate resume uses.
 * @type {ReadonlyArray<string>}
 */
export const NON_SUCCESS_TERMINAL_ATTEMPT_STATES = Object.freeze(["failed", "cancelled", "canceled"]);

/**
 * Meta keys that name a conversation rather than describe the attempt's work.
 * @type {ReadonlyArray<string>}
 */
export const ATTEMPT_RESUME_POINTER_META_KEYS = Object.freeze([
  "agentResume",
  "agentConversation",
  "lastHeartbeat",
  "resumedFromConversation",
  "resumedFromSession",
]);

const TERMINAL_STATE_SET = new Set(NON_SUCCESS_TERMINAL_ATTEMPT_STATES);

/**
 * @param {unknown} state
 * @returns {boolean}
 */
export function isNonSuccessTerminalAttemptState(state) {
  return typeof state === "string" && TERMINAL_STATE_SET.has(state);
}

/**
 * Whether the resume pointers an attempt recorded may still be handed to a
 * later attempt. Unknown/missing states stay usable: only a recorded
 * non-success terminal transition is evidence the conversation is gone.
 * @param {{ state?: unknown } | null | undefined} attempt
 * @returns {boolean}
 */
export function attemptResumePointersUsable(attempt) {
  return !isNonSuccessTerminalAttemptState(attempt?.state);
}

/**
 * Strip resume pointers from a serialized attempt meta blob. Returns the
 * rewritten JSON, or `null` when there was nothing to strip — callers use that
 * to skip a pointless write. Unparseable meta is left untouched: it is not this
 * function's job to discard a row it cannot read.
 *
 * An attempt carrying a `hijackHandoff` keeps every pointer. That attempt was
 * cancelled *by* the hand-off: a human is sitting in the session it names, and
 * both the resumed run and `smithers hijack` need the pointer to rejoin it.
 *
 * @param {unknown} metaJson
 * @returns {string | null}
 */
export function clearAttemptResumePointers(metaJson) {
  if (typeof metaJson !== "string" || metaJson.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(metaJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.hijackHandoff && typeof parsed.hijackHandoff === "object") return null;
  let changed = false;
  for (const key of ATTEMPT_RESUME_POINTER_META_KEYS) {
    if (!Object.hasOwn(parsed, key)) continue;
    if (parsed[key] === null || parsed[key] === false) continue;
    delete parsed[key];
    changed = true;
  }
  return changed ? JSON.stringify(parsed) : null;
}
