import { canonicalize } from "../scenario/canonicalize.ts";
import { replayIdentity } from "../scenario/replayIdentity.ts";
import type { ScenarioAst } from "../scenario/ast.ts";
import type { ControlMessage } from "../control/ControlMessage.ts";
import type { TraceEvent } from "../trace/TraceEvent.ts";
import type { RunScenarioOptions, ScenarioResult } from "../runScenario.ts";
import { stepRunner } from "../scenario/builder.ts";
export type ReplayBundle = Readonly<{
  readonly version: 1;
  readonly ast: ScenarioAst;
  readonly seed: number;
  readonly controlLog: readonly ControlMessage[];
  readonly trace: readonly TraceEvent[];
  readonly ambiguity: readonly unknown[];
  readonly determinism: Readonly<{ readonly deterministic: boolean; readonly residues: readonly string[] }>;
  readonly harness: string;
  readonly harnessIdentity: string;
  readonly runnerBindings: Readonly<Record<string, string>>;
  readonly replayIdentity: string;
}>;
export const makeReplayBundle = (input: {
  ast: ScenarioAst;
  seed: number;
  controlLog: readonly ControlMessage[];
  trace?: readonly TraceEvent[];
  ambiguity?: readonly unknown[];
  determinism?: Readonly<{ readonly deterministic: boolean; readonly residues: readonly string[] }>;
  harness?: string;
  harnessIdentity?: string;
}): ReplayBundle =>
  Object.freeze({
    version: 1,
    ast: JSON.parse(canonicalize(input.ast)) as ScenarioAst,
    seed: input.seed,
    controlLog: JSON.parse(JSON.stringify(input.controlLog)) as readonly ControlMessage[],
    trace: JSON.parse(JSON.stringify(input.trace ?? [])) as readonly TraceEvent[],
    ambiguity: JSON.parse(JSON.stringify(input.ambiguity ?? [])) as readonly unknown[],
    determinism: input.determinism ?? { deterministic: true, residues: [] },
    harness: input.harness ?? "unit-sim",
    harnessIdentity: input.harnessIdentity ?? input.harness ?? "unit-sim",
    runnerBindings: Object.fromEntries(
      input.ast.steps.filter((step) => step.runnerBinding).map((step) => [step.id, step.runnerBinding!]),
    ),
    replayIdentity: replayIdentity(input),
  });
export const serializeReplayBundle = (bundle: ReplayBundle): string => JSON.stringify(bundle);
export const loadReplayBundle = (serialized: string): ReplayBundle => {
  const value = JSON.parse(serialized) as ReplayBundle;
  if (value.version !== 1 || !value.ast || !Array.isArray(value.controlLog) || typeof value.seed !== "number")
    throw new Error("INVALID_REPLAY_BUNDLE");
  const bundle = makeReplayBundle(value);
  if (bundle.replayIdentity !== value.replayIdentity) throw new Error("REPLAY_IDENTITY_MISMATCH");
  return Object.freeze({ ...bundle, runnerBindings: value.runnerBindings ?? {} });
};
export const replayBundle = async (
  bundle: ReplayBundle,
  options: Omit<RunScenarioOptions, "seed" | "controlLog"> = {},
): Promise<ScenarioResult> => {
  const { runScenario } = await import("../runScenario.ts");
  if (bundle.replayIdentity !== replayIdentity({ ast: bundle.ast, seed: bundle.seed, controlLog: bundle.controlLog }))
    throw new Error("REPLAY_IDENTITY_MISMATCH");
  const selectedHarness = options.harness?.name ?? "unit-sim";
  const selectedIdentity =
    options.harness?.adapter?.verifiedProductionIdentity ?? options.harness?.adapter?.identity ?? selectedHarness;
  if (selectedHarness !== bundle.harness || selectedIdentity !== bundle.harnessIdentity)
    throw new Error(
      `REPLAY_HARNESS_MISMATCH: bundle=${bundle.harness}/${bundle.harnessIdentity} selected=${selectedHarness}/${selectedIdentity}`,
    );
  const runners = options.stepRunners ?? {};
  const unbound = Object.keys(runners).filter((id) =>
    bundle.ast.steps.some((step) => step.id === id && !step.runnerBinding),
  );
  if (unbound.length) throw new Error(`RUNNER_BINDING_REQUIRED: ${unbound.join(", ")}`);
  // A binding is an executable identity, not a one-step lease. Multiple AST
  // steps may intentionally invoke the same imported runner; reject only when
  // the caller explicitly supplies incompatible per-step executors.
  const bindings = new Map<string, (typeof runners)[string]>();
  for (const step of bundle.ast.steps) {
    if (!step.runnerBinding || !runners[step.id]) continue;
    const prior = bindings.get(step.runnerBinding);
    if (prior && prior !== runners[step.id]) throw new Error(`REPLAY_RUNNER_BINDING_CONFLICT: ${step.runnerBinding}`);
    bindings.set(step.runnerBinding, runners[step.id]);
  }
  const missing = bundle.ast.steps
    .filter((step) => step.runnerBinding && !runners[step.id] && !stepRunner(step))
    .map((step) => step.id);
  if (missing.length) throw new Error(`REPLAY_RUNNER_MISSING: ${missing.join(", ")}`);
  return runScenario(bundle.ast, {
    ...options,
    ...(Object.keys(runners).length ? { stepRunners: runners } : {}),
    seed: bundle.seed,
    controlLog: bundle.controlLog,
  });
};
