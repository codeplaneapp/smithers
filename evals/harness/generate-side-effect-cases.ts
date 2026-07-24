import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WEAK_MODELS } from "../agents.js";
import { repoRoot } from "../lib/paths.js";
import { scenarios } from "../suites/authoring-side-effects/scenarios.js";
import { sideEffectHandwrittenCases } from "../suites/authoring-side-effects/sideEffectHandwrittenCases.js";

function caseLine(input: {
  id: string;
  scenarioId: string;
  effectClass: string;
  variant: string;
  task: string;
  model: string;
  requireIdempotencyKey: boolean;
  requireRevert: boolean;
  handwritten: boolean;
}): string {
  return JSON.stringify({
    id: input.id,
    input: {
      taskId: input.scenarioId,
      area: "side-effect-authoring",
      feature: input.effectClass,
      model: input.model,
      task: input.task,
      verify: {
        kind: "side-effect-marking",
        must: [],
        mustNot: [],
        answer: null,
        rubric: null,
        sql: null,
        expect: null,
        db: null,
        required: [],
        requireIdempotencyKey: input.requireIdempotencyKey,
        requireRevert: input.requireRevert,
        repoRoot: "/repo",
      },
      judgeModel: "opus",
    },
    expected: { status: "finished", outputContains: { verdict: [{ passed: true }] } },
    metadata: {
      area: "side-effect-authoring",
      feature: input.effectClass,
      tier: "weak",
      source: input.handwritten ? "handwritten" : "scenario-matrix",
      kind: "authoring",
      verify: "deterministic",
      scenarioId: input.scenarioId,
      variant: input.variant,
      handwritten: input.handwritten,
    },
  });
}

/** Regenerate the checked-in authoring-side-effects cases without model calls. */
export function generateSideEffectCases(): { generated: number; handwritten: number; total: number } {
  if (scenarios.length < 100) throw new Error(`expected at least 100 scenarios, found ${scenarios.length}`);
  const generated = scenarios.flatMap((scenario) =>
    WEAK_MODELS.map((model) =>
      caseLine({
        id: `${scenario.id}-${scenario.variant}--${model}`,
        scenarioId: `${scenario.id}-${scenario.variant}`,
        effectClass: scenario.effectClass,
        variant: scenario.variant,
        task: scenario.task,
        model,
        requireIdempotencyKey: scenario.requireIdempotencyKey,
        requireRevert: scenario.requireRevert,
        handwritten: false,
      }),
    ),
  );
  if (generated.length < 300) throw new Error(`expected at least 300 generated cases, found ${generated.length}`);
  if (sideEffectHandwrittenCases.length < 38 || sideEffectHandwrittenCases.length > 42) {
    throw new Error(`expected about 40 handwritten cases, found ${sideEffectHandwrittenCases.length}`);
  }
  const handwritten = sideEffectHandwrittenCases.map((candidate, index) => {
    const model = WEAK_MODELS[index % WEAK_MODELS.length];
    return caseLine({
      id: `${candidate.id}--${model}`,
      scenarioId: candidate.id,
      effectClass: "handwritten-adversarial",
      variant: "handwritten",
      task: candidate.task,
      model,
      requireIdempotencyKey: candidate.requireIdempotencyKey ?? false,
      requireRevert: candidate.requireRevert ?? false,
      handwritten: true,
    });
  });
  const directory = join(repoRoot(), "evals", "suites", "authoring-side-effects");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "cases.jsonl"), `${[...generated, ...handwritten].join("\n")}\n`, "utf8");
  return { generated: generated.length, handwritten: handwritten.length, total: generated.length + handwritten.length };
}

if (import.meta.main) {
  console.log(JSON.stringify(generateSideEffectCases()));
}
