/**
 * Translation between Smithers' `runtime_owner_id` string and the flows
 * `OwnerId` fencing token (`@flows/journal`'s `OwnerId`: host, pid, nonce).
 *
 * Smithers writes `pid:<pid>@<host>:<sessionId>`
 * (`packages/db/src/runtime-owner.js`), which carries exactly the three fields
 * flows fences on. The two legacy forms — `pid:<pid>:<session>` and a bare pid —
 * have no host identity, so they map onto a reserved host id and keep the
 * historical single-host behaviour.
 */
import { formatRuntimeOwnerId, parseRuntimeOwnerIdentity } from "../runtime-owner.js";

/** Host id used for owner ids that were written before hosts were recorded. */
export const LEGACY_OWNER_HOST_ID = "smithers-legacy-local";
/** Nonce used for owner ids that carry no session segment. */
export const LEGACY_OWNER_NONCE = "legacy";

/** @typedef {{ hostId: string; pid: number; nonce: string }} FlowsOwnerId */

/**
 * @param {string} runtimeOwnerId
 * @returns {string}
 */
function ownerSession(runtimeOwnerId) {
  const scoped = runtimeOwnerId.trim().match(/^pid:\d+@[^:]+:(.+)$/u);
  if (scoped) return scoped[1];
  const legacy = runtimeOwnerId.trim().match(/^pid:\d+:(.+)$/u);
  if (legacy) return legacy[1];
  return LEGACY_OWNER_NONCE;
}

/**
 * Build the flows fencing token for a Smithers runtime owner id.
 *
 * @param {string | null | undefined} runtimeOwnerId
 * @returns {FlowsOwnerId | null} `null` when the id names no usable identity.
 */
export function toFlowsOwnerId(runtimeOwnerId) {
  if (typeof runtimeOwnerId !== "string") return null;
  const identity = parseRuntimeOwnerIdentity(runtimeOwnerId, LEGACY_OWNER_HOST_ID);
  if (!identity) return null;
  return {
    hostId: identity.hostname ?? LEGACY_OWNER_HOST_ID,
    pid: identity.pid,
    nonce: ownerSession(runtimeOwnerId),
  };
}

/**
 * Rebuild the Smithers runtime owner id a flows token came from.
 *
 * @param {FlowsOwnerId | null | undefined} owner
 * @returns {string | null}
 */
export function toRuntimeOwnerId(owner) {
  if (!owner) return null;
  if (owner.hostId === LEGACY_OWNER_HOST_ID) {
    return owner.nonce === LEGACY_OWNER_NONCE ? `pid:${owner.pid}` : `pid:${owner.pid}:${owner.nonce}`;
  }
  return formatRuntimeOwnerId(owner.pid, owner.hostId, owner.nonce);
}

/**
 * @param {FlowsOwnerId | null | undefined} left
 * @param {FlowsOwnerId | null | undefined} right
 * @returns {boolean}
 */
export function sameFlowsOwner(left, right) {
  if (!left || !right) return left === right || (!left && !right);
  return left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce;
}
