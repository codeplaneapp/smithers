/**
 * The workflow router: scores a known workflow catalog (the live
 * `useGatewayWorkflows` registry, passed in as `knownWorkflows`) against a
 * {@link ContextContract} and returns the best-matching workflows. It derives a
 * fixed set of boolean "needs" features from the contract text (goal + acceptance
 * criteria + open questions, joined and lowercased) plus a few structural signals
 * (open questions present, a report spec set), then maps those features to
 * workflow ids with simple additive keyword scoring.
 *
 * Pure TS (no React, no clock, no randomness, no module-level catalog import):
 * the same `(contract, knownWorkflows)` always yields the same recommendations,
 * in the same order. Only ids present in the passed `knownWorkflows` are ever
 * emitted — unknown ids are filtered out so a stale mapping can never surface a
 * workflow the live registry does not have. Ties break by the catalog order of
 * `knownWorkflows`, so a stable `listWorkflows` order yields stable output.
 */

import type { StoreWorkflow } from "../../store/workflows";
import type { ContextContract } from "./contextContract";

/** One scored workflow recommendation: a store workflow id, its score, and why. */
export type WorkflowRecommendation = {
  workflow: string;
  score: number;
  reason: string;
};

/**
 * The deterministic feature vector derived from a contract. Each flag is a
 * coarse "the work needs this" signal used to weight workflow candidates.
 */
type ContractFeatures = {
  needsResearch: boolean;
  needsImplementation: boolean;
  needsInterview: boolean;
  needsReview: boolean;
  needsDebugging: boolean;
  needsTestCoverage: boolean;
  needsLoop: boolean;
  needsTickets: boolean;
  needsReport: boolean;
  needsWorkflowCreation: boolean;
};

/** Whether any keyword in the set appears as a substring of the haystack. */
function hasAny(haystack: string, keywords: string[]): boolean {
  return keywords.some((keyword) => haystack.includes(keyword));
}

/**
 * Build the searchable text for a contract: its goal, every acceptance
 * criterion, and every open question, joined with spaces and lowercased. This
 * is the only text the feature heuristics read, keeping detection deterministic.
 */
function contractText(contract: ContextContract): string {
  const parts: string[] = [contract.goal];
  for (const criterion of contract.acceptanceCriteria) {
    parts.push(criterion.criterion);
  }
  for (const question of contract.openQuestions) {
    parts.push(question);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Derive the boolean feature vector from a contract. Text-driven flags match a
 * fixed lowercase keyword set against {@link contractText}; the structural flags
 * (`needsInterview`, `needsReport`) read the contract shape directly.
 */
export function deriveFeatures(contract: ContextContract): ContractFeatures {
  const text = contractText(contract);
  return {
    needsResearch: hasAny(text, [
      "research",
      "investigate",
      "explore",
      "understand",
      "gather context",
      "find out",
      "look into",
    ]),
    needsImplementation: hasAny(text, [
      "implement",
      "build",
      "add",
      "create",
      "write code",
      "develop",
      "feature",
      "fix",
      "change",
      "refactor",
    ]),
    needsInterview: contract.openQuestions.length > 0,
    needsReview: hasAny(text, [
      "review",
      "audit",
      "critique",
      "feedback",
      "code review",
      "inspect",
    ]),
    needsDebugging: hasAny(text, [
      "debug",
      "bug",
      "broken",
      "crash",
      "error",
      "failing",
      "reproduce",
      "stack trace",
    ]),
    needsTestCoverage: hasAny(text, [
      "test",
      "coverage",
      "unit test",
      "test coverage",
      "missing tests",
    ]),
    needsLoop: hasAny(text, [
      "continuously",
      "loop",
      "keep working",
      "maintenance",
      "ongoing",
      "iterate until",
      "repeatedly",
    ]),
    needsTickets: hasAny(text, [
      "ticket",
      "tickets",
      "break down",
      "break into",
      "split into",
      "backlog",
      "kanban",
    ]),
    needsReport: contract.reportSpec !== null && contract.reportSpec.trim() !== "",
    needsWorkflowCreation: hasAny(text, [
      "workflow",
      "create a workflow",
      "new workflow",
      "scaffold",
      "skill",
      "orchestrate",
    ]),
  };
}

/** A single scoring contribution toward a workflow id, with a human-readable why. */
type Contribution = {
  workflow: string;
  score: number;
  reason: string;
};

/**
 * Map the feature vector to weighted contributions toward default-pack workflow
 * ids. Every entry references an id from the default Smithers workflow pack; the
 * additive weights are tuned so combined needs (e.g. research + implementation)
 * promote the broader workflow over the narrow ones. Contributions whose id is
 * not in the passed `knownWorkflows` are filtered in {@link recommendWorkflows},
 * and contributions for the same id are summed there.
 */
function buildContributions(features: ContractFeatures): Contribution[] {
  const contributions: Contribution[] = [];

  // Research + implementation together → the combined research/plan/implement flow.
  if (features.needsResearch && features.needsImplementation) {
    contributions.push({
      workflow: "research-plan-implement",
      score: 5,
      reason: "Goal needs both upfront research and implementation.",
    });
  }

  if (features.needsResearch) {
    contributions.push({
      workflow: "research",
      score: 3,
      reason: "Goal calls for gathering context before building.",
    });
  }

  if (features.needsImplementation) {
    contributions.push({
      workflow: "implement",
      score: 3,
      reason: "Goal describes a concrete change to implement.",
    });
    contributions.push({
      workflow: "plan",
      score: 1,
      reason: "Implementation work benefits from an upfront plan.",
    });
  }

  if (features.needsInterview) {
    contributions.push({
      workflow: "grill-me",
      score: 4,
      reason: "Open questions remain — interview to make them actionable.",
    });
  }

  if (features.needsReview) {
    contributions.push({
      workflow: "review",
      score: 3,
      reason: "Goal or criteria ask for a review of changes.",
    });
  }

  if (features.needsDebugging) {
    contributions.push({
      workflow: "debug",
      score: 4,
      reason: "Goal describes a bug to reproduce, fix, and validate.",
    });
  }

  if (features.needsTestCoverage) {
    contributions.push({
      workflow: "improve-test-coverage",
      score: 3,
      reason: "Goal targets adding or improving test coverage.",
    });
  }

  if (features.needsLoop) {
    contributions.push({
      workflow: "ralph",
      score: 4,
      reason: "Open-ended, continuous work suits a maintenance loop.",
    });
  }

  if (features.needsTickets) {
    contributions.push({
      workflow: "tickets-create",
      score: 3,
      reason: "Larger request should be broken into multiple tickets.",
    });
    contributions.push({
      workflow: "ticket-create",
      score: 2,
      reason: "A focused request can become a single structured ticket.",
    });
    contributions.push({
      workflow: "kanban",
      score: 1,
      reason: "Tickets can be implemented on worktree branches via Kanban.",
    });
  }

  if (features.needsReport) {
    contributions.push({
      workflow: "report-slideshow",
      score: 3,
      reason: "A report spec is set — generate a slideshow report.",
    });
  }

  if (features.needsWorkflowCreation) {
    contributions.push({
      workflow: "create-workflow",
      score: 3,
      reason: "Goal is about authoring a new Smithers workflow.",
    });
    contributions.push({
      workflow: "extract-skill",
      score: 1,
      reason: "Reusable patterns can be harvested into a skill or workflow.",
    });
  }

  return contributions;
}

/**
 * Score the passed `knownWorkflows` catalog against a contract and return the top
 * matches (up to five) sorted by descending score. Deterministic and pure:
 * features come from {@link deriveFeatures}, contributions from
 * {@link buildContributions}, and ties break by the order of `knownWorkflows` so
 * the output is stable for a stable catalog order. Only ids present in
 * `knownWorkflows` are emitted — a contribution toward a workflow the live
 * registry does not expose is dropped.
 *
 * @param contract The context contract to route.
 * @param knownWorkflows The live workflow catalog (e.g. from
 *   `mapToStoreWorkflows(useGatewayWorkflows().data)`); only its ids and order
 *   are read.
 */
export function recommendWorkflows(
  contract: ContextContract,
  knownWorkflows: readonly StoreWorkflow[],
): WorkflowRecommendation[] {
  const features = deriveFeatures(contract);
  const contributions = buildContributions(features);

  // The valid id set + catalog order index, both derived from the passed
  // catalog. KNOWN_WORKFLOW_IDS gates which contributions can surface; orderIndex
  // is the deterministic tie-breaker.
  const knownWorkflowIds = new Set<string>();
  const orderIndex = new Map<string, number>();
  knownWorkflows.forEach((workflow, index) => {
    knownWorkflowIds.add(workflow.id);
    orderIndex.set(workflow.id, index);
  });

  // Sum scores per workflow id, keeping the highest-weight reason as the why.
  const byId = new Map<string, { score: number; reason: string; reasonScore: number }>();
  for (const contribution of contributions) {
    if (!knownWorkflowIds.has(contribution.workflow)) continue;
    const existing = byId.get(contribution.workflow);
    if (existing === undefined) {
      byId.set(contribution.workflow, {
        score: contribution.score,
        reason: contribution.reason,
        reasonScore: contribution.score,
      });
    } else {
      existing.score += contribution.score;
      if (contribution.score > existing.reasonScore) {
        existing.reason = contribution.reason;
        existing.reasonScore = contribution.score;
      }
    }
  }

  const recommendations: WorkflowRecommendation[] = [];
  for (const [workflow, entry] of byId) {
    recommendations.push({ workflow, score: entry.score, reason: entry.reason });
  }

  recommendations.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aIndex = orderIndex.get(a.workflow) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = orderIndex.get(b.workflow) ?? Number.MAX_SAFE_INTEGER;
    return aIndex - bIndex;
  });

  return recommendations.slice(0, 5);
}
