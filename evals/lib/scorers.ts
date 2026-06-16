// Scorers attached to the candidate <Task>. They never block the run; they grade
// non-binary quality so trends improve even before a red case flips green.
//
// Re-exports the built-ins too, so suites import everything from one place.
import type { AgentLike } from "smithers-orchestrator";
import {
  createScorer,
  faithfulnessScorer,
  llmJudge,
  relevancyScorer,
  schemaAdherenceScorer,
} from "smithers-orchestrator/scorers";
import type { CandidateReport } from "./report-schema.js";

export { faithfulnessScorer, relevancyScorer, schemaAdherenceScorer };

function asReport(output: unknown): Partial<CandidateReport> {
  return (output ?? {}) as Partial<CandidateReport>;
}

/** Did the weak model one-shot it cleanly? 1.0 = first-try, no friction, no
 * blockers. Graded, not binary, so "completed but fumbled" is distinguishable. */
export const oneShotScorer = createScorer({
  id: "one-shot",
  name: "One-Shot",
  description: "Whether the candidate produced a correct answer first-try with no dead-ends.",
  score: async ({ output }) => {
    const r = asReport(output);
    const friction = r.friction?.length ?? 0;
    const blockers = r.blockers?.length ?? 0;
    if (blockers > 0) return { score: 0.1, reason: `blocked (${blockers})` };
    if (r.oneShot && friction === 0) return { score: 1, reason: "clean one-shot" };
    if (r.oneShot) return { score: 0.8, reason: `one-shot with ${friction} friction note(s)` };
    return { score: 0.4, reason: `not one-shot, ${friction} friction note(s)` };
  },
});

const FRICTION_WEIGHT: Record<string, number> = {
  "missing-docs": 1,
  "wrong-docs": 1,
  "ambiguous-docs": 0.7,
  "api-confusing": 0.6,
  "had-to-guess": 0.5,
  "tool-error": 0.4,
  other: 0.3,
};

/** Inverse friction severity: 1.0 = frictionless, lower as friction (weighted by
 * how doc-fixable each kind is) accumulates. */
export const frictionScorer = createScorer({
  id: "friction",
  name: "Friction (inverse)",
  description: "1.0 = frictionless; decreases with weighted friction severity.",
  score: async ({ output }) => {
    const r = asReport(output);
    const items = r.friction ?? [];
    if (items.length === 0) return { score: 1, reason: "no friction" };
    const severity = items.reduce((sum, f) => sum + (FRICTION_WEIGHT[f.kind] ?? 0.3), 0);
    const score = Math.max(0, 1 - Math.min(1, severity / 3));
    return { score, reason: `${items.length} friction note(s), weighted severity ${severity.toFixed(2)}` };
  },
});

/** llmJudge: how high-quality is a candidate's custom workflow UI bundle? Grades
 * design/UX/code on a 0-1 scale (the build verifier only checks it compiles +
 * uses the right API). Attached only to UI-authoring cases.
 *
 * Wrapped so a transient judge failure (rate/session limit) still records a row
 * — otherwise a thrown judge call drops the score silently and the AI-quality
 * signal vanishes from the scorecard. */
export const uiQualityScorer = (judge: AgentLike) => {
  const base = llmJudge({
    id: "ui-quality",
    name: "UI Quality",
    description: "Quality of a Smithers custom workflow UI bundle (gateway-react).",
    judge,
    instructions:
      "You rate a Smithers custom workflow UI bundle (React + smithers-orchestrator/gateway-react). " +
      "Score 0-1 on: correct use of createGatewayReactRoot + the gateway hooks " +
      "(useGatewayRun/RunEvents/NodeOutput/Approvals/Actions/Runs); handling of loading, empty, and error states; " +
      "scoping to the ?runId in location.search; clean component structure and naming; sensible layout/UX and basic accessibility; " +
      "and absence of obvious bugs or invented APIs. " +
      'Respond ONLY with JSON: {"score": <0-1>, "reason": "<short>"}.',
    promptTemplate: (input) => {
      const r = asReport(input.output);
      return `Rate this Smithers workflow UI bundle 0-1:\n\n${(r.artifact ?? "(none)").slice(0, 6000)}\n\nReturn JSON {"score","reason"}.`;
    },
  });
  return createScorer({
    id: "ui-quality",
    name: "UI Quality",
    description: base.description,
    score: async (input) => {
      try {
        return await base.score(input);
      } catch (e) {
        return { score: 0, reason: `ui-quality judge unavailable: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`, meta: { judgeError: true } };
      }
    },
  });
};

/** llmJudge: does the reported friction reflect a REAL, fixable docs/API gap (so
 * the scorecard can prioritize)? Sample this — it spends a model. */
export const docsGapScorer = (judge: AgentLike) =>
  llmJudge({
    id: "docs-gap",
    name: "Docs Gap Likelihood",
    description: "Likelihood the reported friction is a genuine, fixable Smithers docs/API gap.",
    judge,
    instructions:
      "You triage friction an AI agent reported while using Smithers from its docs. " +
      "Decide whether it points to a genuine, fixable documentation or API gap (1.0) versus the agent's own mistake or no real gap (0.0). " +
      'Respond ONLY with JSON: {"score": <0-1>, "reason": "<short>"}.',
    promptTemplate: (input) => {
      const r = asReport(input.output);
      return [
        "Candidate summary:",
        r.summary ?? "(none)",
        "",
        "Reported friction:",
        JSON.stringify(r.friction ?? [], null, 2),
        "",
        "Blockers:",
        JSON.stringify(r.blockers ?? []),
        "",
        'Return JSON {"score","reason"}. 1.0 = clearly a real fixable docs/API gap; 0.0 = no gap / agent error.',
      ].join("\n");
    },
  });
