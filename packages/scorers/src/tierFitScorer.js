import { llmJudge } from "./llmJudge.js";
/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./types.js").Scorer} Scorer */

/**
 * @param {unknown} candidate
 * @returns {candidate is { tier: string }}
 */
function hasTier(candidate) {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (/** @type {{ tier?: unknown }} */ (candidate).tier) === "string"
  );
}

/**
 * Creates the delegation-chain tier-fit scorer, an LLM judge that evaluates
 * whether a node's intelligence tier (fable/opus/sonnet/haiku) matched its
 * work. Over-tiering wastes cost on routine work; under-tiering risks quality
 * on hard work.
 *
 * The node descriptor (`{ tier, brief, stats? }`) is read from the scored
 * `input` (preferred) or `context`; the node's produced output is the scored
 * `output`. `stats` may carry cost/context figures (e.g. `costUsd`, token
 * counts) and is passed to the judge verbatim when present.
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
export function tierFitScorer(judge) {
  return llmJudge({
    id: "tier-fit",
    name: "Tier Fit",
    description:
      "Judges whether a delegation node's intelligence tier matched its work (over-tiered wastes cost, under-tiered risks quality)",
    judge,
    instructions: `You evaluate tier fit in a delegation-chain workflow, where strong models recursively decompose work for weaker models. Tiers from strongest/most expensive to weakest/cheapest: fable, opus, sonnet, haiku.

Key Principles:
1. Judge whether the assigned tier matched the difficulty of the brief and the quality of the output
2. Over-tiered: the output is short or routine and a cheaper tier would clearly have sufficed — wasted cost
3. Under-tiered: the brief demanded more judgment or breadth than the tier delivered — quality risk
4. A perfect fit scores 1.0; penalize proportionally to how far off the tier was and how much it cost or risked
5. Use cost/context stats when provided; do not invent numbers`,
    promptTemplate: ({ input, output, context }) => {
      const node = hasTier(input) ? input : hasTier(context) ? context : undefined;
      const tier = node ? node.tier : "unknown";
      const brief = node && "brief" in node ? node.brief : undefined;
      const stats = node && "stats" in node ? node.stats : undefined;
      return `Evaluate whether this delegation node's intelligence tier was the right choice.

Tier: ${JSON.stringify(tier)}

Brief: ${brief === undefined ? "No brief provided" : JSON.stringify(brief)}

Cost/context stats: ${stats === undefined ? "No stats provided" : JSON.stringify(stats)}

Output: ${JSON.stringify(output)}

Respond with a JSON object: { "score": <number 0-1>, "reason": "<brief explanation>" }

Where 1.0 means the tier fit the work perfectly and 0.0 means it was badly over- or under-tiered.`;
    },
  });
}
