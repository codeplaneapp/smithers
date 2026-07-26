import { createScorer } from "./createScorer.js";
import { extractDelegationEvents } from "./delegationEvents.js";
/** @typedef {import("./PlanSolidityOptions.js").PlanSolidityOptions} PlanSolidityOptions */
/** @typedef {import("./types.js").Scorer} Scorer */

/** The churn event types the scorer penalizes after execution starts. */
const CHURN_TYPES = /** @type {const} */ (["NODE_INVALIDATED", "REDELEGATED", "GATE_FAILED", "REPLAN_REQUESTED"]);

/** @type {Record<(typeof CHURN_TYPES)[number], number>} */
const DEFAULT_PENALTIES = {
  NODE_INVALIDATED: 0.1,
  REDELEGATED: 0.08,
  GATE_FAILED: 0.05,
  REPLAN_REQUESTED: 0.04,
};

/**
 * @returns {Record<(typeof CHURN_TYPES)[number], number>}
 */
function zeroCounts() {
  return {
    NODE_INVALIDATED: 0,
    REDELEGATED: 0,
    GATE_FAILED: 0,
    REPLAN_REQUESTED: 0,
  };
}

/**
 * Creates the delegation-chain plan-solidity scorer.
 *
 * Measures how solid the plan was once execution began. Churn during the
 * planning phase (before the first `EXEC_STARTED` event) is free — plan-phase
 * invalidations are the process working. Every churn event after execution
 * starts (`NODE_INVALIDATED`, `REDELEGATED`, `GATE_FAILED`,
 * `REPLAN_REQUESTED`) subtracts a configurable penalty from 1.0; the score is
 * clamped to [0, 1]. With the defaults, one post-exec invalidation plus one
 * redelegation scores 0.82 (the delegation-chain simulation's Frame 10).
 *
 * The event log is read from the scored `output` (preferred) or `context`.
 * With no events the scorer no-ops (score 1, `meta.skipped`); if execution
 * never started, all churn was plan-phase and the score is 1.
 *
 * @param {PlanSolidityOptions} [opts]
 * @returns {Scorer}
 */
export function planSolidityScorer(opts) {
  const penalties = { ...DEFAULT_PENALTIES, ...opts?.penalties };
  return createScorer({
    id: "plan-solidity",
    name: "Plan Solidity",
    description:
      "Penalizes replan churn (invalidations, redelegations, gate failures) after execution started; plan-phase churn is free",
    score: async ({ output, context }) => {
      const payload = extractDelegationEvents({ output, context });
      if (!payload) {
        return {
          score: 1,
          reason: "No delegation events available; skipping",
          meta: { skipped: true },
        };
      }
      const execStartedIndex = payload.events.findIndex((event) => event.t === "EXEC_STARTED");
      const planPhase = zeroCounts();
      const postExec = zeroCounts();
      for (let i = 0; i < payload.events.length; i++) {
        const t = payload.events[i].t;
        if (!CHURN_TYPES.includes(/** @type {(typeof CHURN_TYPES)[number]} */ (t))) {
          continue;
        }
        const type = /** @type {(typeof CHURN_TYPES)[number]} */ (t);
        if (execStartedIndex !== -1 && i > execStartedIndex) {
          postExec[type]++;
        } else {
          planPhase[type]++;
        }
      }
      if (execStartedIndex === -1) {
        return {
          score: 1,
          reason: "Execution never started; all churn was plan-phase",
          meta: { planPhase, postExec, execStartedIndex: null },
        };
      }
      let penalty = 0;
      for (const type of CHURN_TYPES) {
        penalty += postExec[type] * penalties[type];
      }
      const score = Math.max(0, Math.min(1, 1 - penalty));
      const postExecTotal = CHURN_TYPES.reduce((sum, type) => sum + postExec[type], 0);
      const planPhaseTotal = CHURN_TYPES.reduce((sum, type) => sum + planPhase[type], 0);
      return {
        score,
        reason: `${postExecTotal} post-exec churn event(s) (penalty ${penalty.toFixed(2)}); ${planPhaseTotal} plan-phase churn event(s) were free`,
        meta: { planPhase, postExec, execStartedIndex },
      };
    },
  });
}
