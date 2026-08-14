/**
 * Cockpit tab / pane policy for the herdr run mirror.
 *
 * Pure helpers: soft-pin (K=1 non-worker stage), worker heuristics, pin matching,
 * and the auto-open matrix (gates + failures always; workers board-only by default).
 * The run surface consults {@link shouldAutoOpenDetailTab} before creating a
 * detail tab for an ordinary agent node.
 */

/** Default max soft-pinned in-progress non-worker stage tabs. */
export const DEFAULT_SOFT_PIN_SLOTS = 1;

/**
 * @typedef {{
 *   stage?: boolean;
 *   workers?: boolean;
 *   gates?: boolean;
 *   failures?: boolean;
 * }} HerdrAutoOpenPolicy
 */

/**
 * @typedef {{
 *   autoOpen?: HerdrAutoOpenPolicy;
 *   softPinSlots?: number;
 *   pin?: string[];
 *   workerPattern?: RegExp;
 * }} CockpitPolicyOptions
 */

/**
 * Whether a node id looks like a fan-out worker leaf (board-only by default).
 * Matches common smithers swarm patterns: worker-N, fix-N, shard-*, item-*, etc.
 *
 * @param {string} nodeId
 * @param {RegExp} [extraPattern]
 * @returns {boolean}
 */
export function isLikelyWorkerNodeId(nodeId, extraPattern) {
  if (typeof nodeId !== "string" || nodeId === "") {
    return false;
  }
  if (extraPattern) {
    const previousIndex = extraPattern.lastIndex;
    extraPattern.lastIndex = 0;
    const matches = extraPattern.test(nodeId);
    extraPattern.lastIndex = previousIndex;
    if (matches) return true;
  }
  // worker-07, fix-3, shard-12, item_1, leaf-0
  if (/(?:^|[/:._-])(?:worker|fix|shard|leaf|item)[-_]?\d+$/i.test(nodeId)) {
    return true;
  }
  // path-style swarm leaves: swarm/worker-03
  if (/\/(?:worker|fix|shard)[-_]?\d+$/i.test(nodeId)) {
    return true;
  }
  // Bare worker-/fix- prefixes only when they look numbered (avoid fix-auth).
  if (/^(?:worker|fix|shard|leaf)[-_]?\d+$/i.test(nodeId)) {
    return true;
  }
  return false;
}

/**
 * Simple pin matcher: exact id, or trailing glob `prefix*` / `*suffix` / `*mid*`.
 *
 * @param {string} nodeId
 * @param {string[] | undefined} pins
 * @returns {boolean}
 */
export function isPinnedNodeId(nodeId, pins) {
  if (!Array.isArray(pins) || pins.length === 0 || typeof nodeId !== "string") {
    return false;
  }
  for (const raw of pins) {
    if (typeof raw !== "string" || raw === "") {
      continue;
    }
    if (raw === nodeId) {
      return true;
    }
    if (raw.includes("*")) {
      const escaped = raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      try {
        if (new RegExp(`^${escaped}$`).test(nodeId)) {
          return true;
        }
      } catch {
        // ignore bad patterns
      }
    }
  }
  return false;
}

/**
 * Normalize auto-open flags with product defaults.
 *
 * @param {HerdrAutoOpenPolicy | undefined} autoOpen
 * @returns {Required<HerdrAutoOpenPolicy>}
 */
export function resolveAutoOpenPolicy(autoOpen) {
  return {
    stage: autoOpen?.stage !== false,
    workers: autoOpen?.workers === true,
    gates: autoOpen?.gates !== false,
    failures: autoOpen?.failures !== false,
  };
}

/**
 * @param {CockpitPolicyOptions | undefined} opts
 * @returns {number}
 */
export function resolveSoftPinSlots(opts) {
  const n = opts?.softPinSlots;
  if (typeof n === "number" && Number.isFinite(n) && n >= 0) {
    return Math.floor(n);
  }
  return DEFAULT_SOFT_PIN_SLOTS;
}

/**
 * Gate tab label convention: `gate:<nodeId>` (display may still truncate).
 *
 * @param {string} nodeId
 * @returns {string}
 */
export function gateTabLabel(nodeId) {
  return `gate:${nodeId}`;
}

/**
 * Decision input for whether an ordinary (non-hijack) node should get a detail tab.
 * `softPinnedNodeIds` = currently soft-pinned node ids that still hold a stage pane.
 *
 * @typedef {{
 *   nodeId: string;
 *   reason: "stage" | "gate" | "failure" | "pin" | "open" | "ordinary";
 *   isWorker?: boolean;
 *   softPinnedNodeIds?: string[];
 * }} AutoOpenContext
 */

/**
 * Whether the surface should open (or keep opening) a detail tab for this node.
 * Attention reasons (gate/failure/pin/open) always win. Ordinary stage soft-pin
 * respects K slots and skips workers unless `autoOpen.workers`.
 *
 * @param {AutoOpenContext} ctx
 * @param {CockpitPolicyOptions} [policy]
 * @returns {boolean}
 */
export function shouldAutoOpenDetailTab(ctx, policy = {}) {
  const auto = resolveAutoOpenPolicy(policy.autoOpen);
  const nodeId = ctx.nodeId;
  const isWorker =
    typeof ctx.isWorker === "boolean" ? ctx.isWorker : isLikelyWorkerNodeId(nodeId, policy.workerPattern);

  if (ctx.reason === "open" || ctx.reason === "pin") {
    return true;
  }
  if (isPinnedNodeId(nodeId, policy.pin)) {
    return true;
  }
  if (ctx.reason === "gate") {
    return auto.gates;
  }
  if (ctx.reason === "failure") {
    return auto.failures;
  }

  // Ordinary / stage path
  if (isWorker) {
    return auto.workers === true;
  }
  if (!auto.stage) {
    return false;
  }
  const slots = resolveSoftPinSlots(policy);
  if (slots <= 0) {
    return false;
  }
  const pinned = Array.isArray(ctx.softPinnedNodeIds) ? ctx.softPinnedNodeIds : [];
  // Already soft-pinned this node → keep opening (idempotent ensurePane)
  if (pinned.includes(nodeId)) {
    return true;
  }
  // Room for another stage tab?
  return pinned.length < slots;
}

/**
 * Track soft-pin set after a node starts or finishes (in-memory helper for the surface).
 *
 * @param {Set<string>} softPins
 * @param {{ nodeId: string, action: "start" | "end", isWorker?: boolean }} event
 * @param {CockpitPolicyOptions} [policy]
 * @returns {Set<string>} the same set (mutated)
 */
export function updateSoftPinSet(softPins, event, policy = {}) {
  const auto = resolveAutoOpenPolicy(policy.autoOpen);
  const isWorker =
    typeof event.isWorker === "boolean" ? event.isWorker : isLikelyWorkerNodeId(event.nodeId, policy.workerPattern);
  if (event.action === "end") {
    softPins.delete(event.nodeId);
    return softPins;
  }
  // start
  // Declarative pins always open but do NOT consume soft-pin stage slots.
  if (isPinnedNodeId(event.nodeId, policy.pin)) {
    return softPins;
  }
  if (isWorker) {
    return softPins;
  }
  if (!auto.stage) {
    return softPins;
  }
  const slots = resolveSoftPinSlots(policy);
  if (softPins.has(event.nodeId)) {
    return softPins;
  }
  if (softPins.size < slots) {
    softPins.add(event.nodeId);
  }
  return softPins;
}
