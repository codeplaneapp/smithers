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
declare function isLikelyWorkerNodeId(nodeId: string, extraPattern?: RegExp): boolean;
/**
 * Simple pin matcher: exact id, or trailing glob `prefix*` / `*suffix` / `*mid*`.
 *
 * @param {string} nodeId
 * @param {string[] | undefined} pins
 * @returns {boolean}
 */
declare function isPinnedNodeId(nodeId: string, pins: string[] | undefined): boolean;
/**
 * Normalize auto-open flags with product defaults.
 *
 * @param {HerdrAutoOpenPolicy | undefined} autoOpen
 * @returns {Required<HerdrAutoOpenPolicy>}
 */
declare function resolveAutoOpenPolicy(autoOpen: HerdrAutoOpenPolicy | undefined): Required<HerdrAutoOpenPolicy>;
/**
 * @param {CockpitPolicyOptions | undefined} opts
 * @returns {number}
 */
declare function resolveSoftPinSlots(opts: CockpitPolicyOptions | undefined): number;
/**
 * Gate tab label convention: `gate:<nodeId>` (display may still truncate).
 *
 * @param {string} nodeId
 * @returns {string}
 */
declare function gateTabLabel(nodeId: string): string;
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
declare function shouldAutoOpenDetailTab(ctx: AutoOpenContext, policy?: CockpitPolicyOptions): boolean;
/**
 * Track soft-pin set after a node starts or finishes (in-memory helper for the surface).
 *
 * @param {Set<string>} softPins
 * @param {{ nodeId: string, action: "start" | "end", isWorker?: boolean }} event
 * @param {CockpitPolicyOptions} [policy]
 * @returns {Set<string>} the same set (mutated)
 */
declare function updateSoftPinSet(softPins: Set<string>, event: {
    nodeId: string;
    action: "start" | "end";
    isWorker?: boolean;
}, policy?: CockpitPolicyOptions): Set<string>;
/**
 * Cockpit tab / pane policy for the herdr run mirror.
 *
 * Pure helpers: soft-pin (K=1 non-worker stage), worker heuristics, pin matching,
 * and the auto-open matrix (gates + failures always; workers board-only by default).
 * The run surface consults {@link shouldAutoOpenDetailTab} before creating a
 * detail tab for an ordinary agent node.
 */
/** Default max soft-pinned in-progress non-worker stage tabs. */
declare const DEFAULT_SOFT_PIN_SLOTS: 1;
type HerdrAutoOpenPolicy = {
    stage?: boolean;
    workers?: boolean;
    gates?: boolean;
    failures?: boolean;
};
type CockpitPolicyOptions = {
    autoOpen?: HerdrAutoOpenPolicy;
    softPinSlots?: number;
    pin?: string[];
    workerPattern?: RegExp;
};
/**
 * Decision input for whether an ordinary (non-hijack) node should get a detail tab.
 * `softPinnedNodeIds` = currently soft-pinned node ids that still hold a stage pane.
 */
type AutoOpenContext = {
    nodeId: string;
    reason: "stage" | "gate" | "failure" | "pin" | "open" | "ordinary";
    isWorker?: boolean;
    softPinnedNodeIds?: string[];
};

export { type AutoOpenContext, type CockpitPolicyOptions, DEFAULT_SOFT_PIN_SLOTS, type HerdrAutoOpenPolicy, gateTabLabel, isLikelyWorkerNodeId, isPinnedNodeId, resolveAutoOpenPolicy, resolveSoftPinSlots, shouldAutoOpenDetailTab, updateSoftPinSet };
