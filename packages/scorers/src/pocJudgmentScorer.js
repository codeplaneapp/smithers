import { createScorer } from "./createScorer.js";
import { extractDelegationEvents, resolvePlanningNodes } from "./delegationEvents.js";
/** @typedef {import("./DelegationEvent.js").DelegationEvent} DelegationEvent */
/** @typedef {import("./PocJudgmentOptions.js").PocJudgmentClassification} PocJudgmentClassification */
/** @typedef {import("./PocJudgmentOptions.js").PocJudgmentOptions} PocJudgmentOptions */
/** @typedef {import("./types.js").Scorer} Scorer */

/** @type {Record<PocJudgmentClassification, number>} */
const DEFAULT_VALUES = {
  correctPositiveChanged: 1,
  correctPositiveConfirmed: 0.9,
  correctNegative: 0.75,
  falsePositive: 0.4,
  falseNegative: 0,
};

/** @type {Record<PocJudgmentClassification, number>} */
const DEFAULT_WEIGHTS = {
  correctPositiveChanged: 1,
  correctPositiveConfirmed: 1,
  correctNegative: 1,
  falsePositive: 1,
  falseNegative: 3,
};

/**
 * Classifies one planning node's probe judgment from the event log.
 *
 * @param {string} nodeId
 * @param {DelegationEvent[]} events
 * @returns {{ classification: PocJudgmentClassification; reason: string; flagged: boolean; findings: number }}
 */
function classifyNode(nodeId, events) {
  let flagged = false;
  let firstFindingIndex = -1;
  let findings = 0;
  let badOutcome = false;
  let changed = false;
  let reaffirmed = false;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    switch (event.t) {
      case "RISK_FLAGGED":
        if (event.node === nodeId) flagged = true;
        break;
      case "PROBE_SPAWNED":
        if (event.parent === nodeId) flagged = true;
        break;
      case "FINDING_REPORTED":
        if (event.toParent === nodeId) {
          findings++;
          if (firstFindingIndex === -1) firstFindingIndex = i;
        }
        break;
      case "REPLAN_REQUESTED":
        if (event.from === nodeId && firstFindingIndex !== -1 && i > firstFindingIndex) {
          changed = true;
        }
        break;
      case "NODE_INVALIDATED":
      case "REDELEGATED":
      case "GATE_FAILED":
        if (event.node === nodeId) {
          badOutcome = true;
          if (event.t === "NODE_INVALIDATED" && firstFindingIndex !== -1 && i > firstFindingIndex) {
            // The node replanned itself in response to its probe's
            // finding — the probe changed the plan.
            changed = true;
          }
        }
        break;
      case "NODE_REAFFIRMED":
        if (event.node === nodeId && firstFindingIndex !== -1 && i > firstFindingIndex) {
          reaffirmed = true;
        }
        break;
      default:
        break;
    }
  }
  if (!flagged) {
    return badOutcome
      ? {
          classification: "falseNegative",
          reason: "flagged nothing, but the node was later invalidated, redelegated, or failed a gate",
          flagged,
          findings,
        }
      : {
          classification: "correctNegative",
          reason: "flagged nothing, and nothing in its domain broke",
          flagged,
          findings,
        };
  }
  if (findings > 0) {
    if (changed) {
      return {
        classification: "correctPositiveChanged",
        reason: "flagged a risk and the probe finding changed the plan",
        flagged,
        findings,
      };
    }
    if (reaffirmed) {
      return {
        classification: "correctPositiveConfirmed",
        reason: "flagged a risk; the probe finding was folded in and the plan reaffirmed",
        flagged,
        findings,
      };
    }
    return {
      classification: "falsePositive",
      reason: "flagged a risk, but the probe finding had no downstream effect",
      flagged,
      findings,
    };
  }
  if (badOutcome) {
    return {
      classification: "correctPositiveConfirmed",
      reason: "flagged a risk that materialized in execution",
      flagged,
      findings,
    };
  }
  return {
    classification: "falsePositive",
    reason: "flagged a risk, but the probe found nothing and nothing broke",
    flagged,
    findings,
  };
}

/**
 * Creates the delegation-chain POC-judgment scorer.
 *
 * For each planning node (goal/chunk) in a delegation event log, classifies
 * its risk judgment into one of five outcomes (see
 * `PocJudgmentClassification`) and returns the weighted mean of the
 * per-classification values. Findings that CHANGED the plan reward hardest;
 * unflagged risks that later broke the node (false negatives) are punished
 * hardest via both a zero value and the highest weight.
 *
 * The event log is read from the scored `output` (preferred) or `context`,
 * as either a bare `DelegationEvent[]` or a `{ events, nodes? }` payload.
 * With no events or no planning nodes the scorer no-ops (score 1,
 * `meta.skipped`).
 *
 * @param {PocJudgmentOptions} [opts]
 * @returns {Scorer}
 */
export function pocJudgmentScorer(opts) {
  const values = { ...DEFAULT_VALUES, ...opts?.values };
  const weights = { ...DEFAULT_WEIGHTS, ...opts?.weights };
  return createScorer({
    id: "poc-judgment",
    name: "POC Judgment",
    description:
      "Scores each planning node's risk-flagging and probe judgment (correct positives/negatives vs false positives/negatives)",
    score: async ({ output, context }) => {
      const payload = extractDelegationEvents({ output, context });
      if (!payload) {
        return {
          score: 1,
          reason: "No delegation events available; skipping",
          meta: { skipped: true },
        };
      }
      const planningNodes = resolvePlanningNodes(payload);
      if (planningNodes.length === 0) {
        return {
          score: 1,
          reason: "No planning nodes found in delegation events; skipping",
          meta: { skipped: true },
        };
      }
      /** @type {Record<string, { classification: PocJudgmentClassification; value: number; weight: number; flagged: boolean; findings: number; reason: string }>} */
      const nodes = {};
      /** @type {Record<PocJudgmentClassification, number>} */
      const counts = {
        correctPositiveChanged: 0,
        correctPositiveConfirmed: 0,
        correctNegative: 0,
        falsePositive: 0,
        falseNegative: 0,
      };
      let total = 0;
      let weightSum = 0;
      for (const nodeId of planningNodes) {
        const { classification, reason, flagged, findings } = classifyNode(nodeId, payload.events);
        const value = values[classification];
        const weight = weights[classification];
        counts[classification]++;
        total += value * weight;
        weightSum += weight;
        nodes[nodeId] = {
          classification,
          value,
          weight,
          flagged,
          findings,
          reason,
        };
      }
      if (weightSum === 0) {
        return {
          score: 1,
          reason: "All classifications zero-weighted; skipping",
          meta: { skipped: true, nodes, counts },
        };
      }
      const score = Math.max(0, Math.min(1, total / weightSum));
      const summary = Object.entries(counts)
        .filter(([, count]) => count > 0)
        .map(([classification, count]) => `${count} ${classification}`)
        .join(", ");
      return {
        score,
        reason: `${planningNodes.length} planning node(s): ${summary}`,
        meta: { nodes, counts },
      };
    },
  });
}
