import { scorePatch } from "./scorePatch.js";

/**
 * Per-instance integrity gate. Before (or alongside) trusting an agent's score,
 * we prove the scoring environment is real and discriminating for THIS instance:
 *
 *   - the gold patch MUST resolve   → tests genuinely pass when the fix is present
 *   - the empty patch MUST NOT resolve → the required tests genuinely fail without it
 *
 * If either invariant breaks, the instance's agent result is untrustworthy
 * (flaky tests, broken image, mis-parsed logs) and must be discarded — never
 * counted as a pass. This is what stops the numbers from being fudged: a green
 * agent score is only credible when gold=true and empty=false on the same harness.
 *
 * @param {import("./loadInstances.js").SwebpInstance} instance
 * @param {object} [opts]
 * @param {boolean} [opts.blockNetwork]
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{
 *   valid: boolean,
 *   goldResolved: boolean,
 *   emptyResolved: boolean,
 *   gold: Awaited<ReturnType<typeof scorePatch>>,
 *   empty: Awaited<ReturnType<typeof scorePatch>>,
 * }>}
 */
export async function validateHarness(instance, opts = {}) {
  const log = opts.log ?? (() => {});
  log(`[integrity] ${instance.instanceId}: scoring gold patch…`);
  const gold = await scorePatch(instance, instance.goldPatch, {
    prefix: "gold",
    blockNetwork: opts.blockNetwork,
    timeoutMs: opts.timeoutMs,
  });
  log(`[integrity] ${instance.instanceId}: gold resolved=${gold.resolved} (missing: ${gold.missing.join(", ") || "none"})`);

  log(`[integrity] ${instance.instanceId}: scoring empty patch…`);
  const empty = await scorePatch(instance, "", {
    prefix: "empty",
    blockNetwork: opts.blockNetwork,
    timeoutMs: opts.timeoutMs,
  });
  log(`[integrity] ${instance.instanceId}: empty resolved=${empty.resolved}`);

  const valid = gold.resolved === true && empty.resolved === false;
  return { valid, goldResolved: gold.resolved, emptyResolved: empty.resolved, gold, empty };
}
