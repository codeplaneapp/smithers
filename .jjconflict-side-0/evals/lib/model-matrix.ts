// Resolve a case's `input.model` string to a real agent, with clear errors so a
// typo in a case fails loudly instead of silently running the wrong model.
import type { AgentLike } from "smithers-orchestrator";
import { MODEL_TIER, type ModelName, models } from "../agents.js";

const KNOWN = Object.keys(models) as ModelName[];

function isModelName(name: string): name is ModelName {
  return (KNOWN as string[]).includes(name);
}

/** The agent that plays the candidate-under-test for a case. */
export function resolveCandidate(name: string): AgentLike {
  if (!isModelName(name)) {
    throw new Error(
      `Unknown candidate model "${name}". Known models: ${KNOWN.join(", ")}.`,
    );
  }
  return models[name];
}

/** The agent that plays the judge (llmJudge scorer + judge-verify). Defaults to
 * opus; falls back to sonnet only if the requested judge is unknown. */
export function resolveJudge(name: string | null | undefined): AgentLike {
  const judge = name ?? "opus";
  if (isModelName(judge)) return models[judge];
  return models.opus;
}

/** Guardrail used by the suite + tests: weak-tier candidates must not be used
 * for `build-complex`, and sota models shouldn't be wasted on trivial evals. */
export function tierOf(name: string): "weak" | "sota" | "unknown" {
  return isModelName(name) ? MODEL_TIER[name] : "unknown";
}
