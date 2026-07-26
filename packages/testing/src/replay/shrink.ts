import { compileScenario } from "../scenario/compile.ts";
import type { ScenarioAst } from "../scenario/ast.ts";
import type { ControlMessage } from "../control/ControlMessage.ts";
import { runScenario, type ScenarioResult, type RunScenarioOptions } from "../runScenario.ts";
const controlsValid = (ast: ScenarioAst, controls: readonly ControlMessage[]): boolean => {
  const steps = new Set(ast.steps.map((step) => step.id));
  const faults = new Set(ast.faults.map((fault) => fault.id));
  const barriers = new Set(ast.barriers.map((barrier) => barrier.id));
  return controls.every(
    (control) =>
      (control.type !== "pin-interleaving" || steps.has(control.choice)) &&
      (control.type !== "task-restart" || steps.has(control.step)) &&
      (control.type !== "inject-fault" || faults.has(control.fault)) &&
      (control.type !== "release-barrier" || barriers.has(control.barrier)) &&
      (control.type !== "resolve-effect" || steps.has(control.effect.split(":", 1)[0])),
  );
};
const removeStep = (ast: ScenarioAst, id: string): ScenarioAst => {
  // Only remove a leaf that is not a barrier party. Rewriting dependencies or
  // barriers produces a different scenario while pretending it is a shrink.
  const referenced = new Set(ast.steps.flatMap((step) => step.dependsOn));
  if (referenced.has(id) || ast.barriers.some((barrier) => barrier.parties.includes(id))) return ast;
  // A shrink must not erase the only provider of a declared capability.  The
  // failure predicate is otherwise able to "preserve" a failure by changing
  // it into an admission failure.
  const removed = ast.steps.find((step) => step.id === id);
  if (
    removed?.capabilities.some((capability) =>
      ast.steps.filter((step) => step.id !== id).every((step) => !step.capabilities.includes(capability)),
    )
  )
    return ast;
  return { ...ast, steps: ast.steps.filter((step) => step.id !== id) };
};
type ShrinkOptions = Readonly<
  Pick<RunScenarioOptions, "harness" | "stepRunners"> & { readonly maxCandidates?: number; readonly seed?: number }
>;
export const shrink = async (
  ast: ScenarioAst,
  controls: readonly ControlMessage[],
  failure: (
    ast: ScenarioAst,
    controls: readonly ControlMessage[],
    result?: ScenarioResult,
  ) => boolean | Promise<boolean>,
  options: ShrinkOptions = {},
) => {
  const max = Math.max(0, options.maxCandidates ?? 100);
  let tried = 0;
  let current = ast;
  let currentControls = [...controls];
  let changed = true;
  while (changed && tried < max) {
    changed = false;
    for (const step of [...current.steps]) {
      if (tried >= max || current.steps.length <= 1) break;
      const candidate = removeStep(current, step.id);
      if (candidate === current) continue;
      const candidateControls = currentControls.filter(
        (control) =>
          (control.type !== "pin-interleaving" || control.choice !== step.id) &&
          (control.type !== "task-restart" || control.step !== step.id) &&
          (control.type !== "resolve-effect" || control.effect.split(":", 1)[0] !== step.id),
      );
      if (!compileScenario(candidate).ok || !controlsValid(candidate, candidateControls)) continue;
      tried++;
      const result = await runScenario(candidate, {
        ...options,
        controlLog: candidateControls,
        seed: options.seed ?? candidate.seed,
      });
      if (await failure(candidate, candidateControls, result)) {
        current = candidate;
        currentControls = candidateControls;
        changed = true;
        break;
      }
    }
  }
  for (let i = 0; i < currentControls.length && tried < max; i++) {
    const candidateControls = currentControls.filter((_, index) => index !== i);
    if (candidateControls.length === currentControls.length || !controlsValid(current, candidateControls)) continue;
    tried++;
    const result = await runScenario(current, {
      ...options,
      controlLog: candidateControls,
      seed: options.seed ?? current.seed,
    });
    if (await failure(current, candidateControls, result)) {
      currentControls = candidateControls;
      i = -1;
    }
  }
  return { ast: current, controls: currentControls, candidatesTried: tried };
};
