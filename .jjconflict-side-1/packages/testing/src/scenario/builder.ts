import { freezeScenario, type ScenarioAst, type ScenarioBarrier, type ScenarioExtension, type ScenarioFault, type ScenarioStep, type ScenarioValue } from "./ast.ts";
import { provablyStatelessSource } from "./statelessSource.ts";
export type TaskRuntime = Readonly<{ effect: <T>(name: string, operation: () => T | Promise<T>, options?: Readonly<{ idempotencyKey?: string }>) => Promise<T>; sleep: (ms: number) => Promise<void>; log: (message: string, data?: ScenarioValue) => void; opaque: <T>(name: string, operation: () => T | Promise<T>) => Promise<T> }>;
export type StepRunner = (runtime: TaskRuntime, input: ScenarioValue | undefined) => unknown | Promise<unknown>;
// The source-reflection primitive is a MUTABLE intrinsic:
// `Function.prototype.toString` can be replaced with a forgery that reports
// the same stateless-looking source for two different closures (Sol's round-7
// counterexample). The reference is captured ONCE at module initialization so
// a post-import mutation cannot substitute forged source, and it is used ONLY
// as a rejection diagnostic below — never to mint an executable identity, so
// even a PRE-import forgery of the reflection primitive can at most change
// which rejection code a caller sees.
const intrinsicFunctionToString = Function.prototype.toString;
const runnerSource = (runner: StepRunner): string => intrinsicFunctionToString.call(runner);
// Anonymous executable identities are RETIRED. The previous design recompiled
// provably-stateless source through the global `Function` constructor so the
// digest and the executable were the same bytes — but the constructor is
// itself mutable realm state. Sol's round-8 counterexample replaced
// `globalThis.Function` BEFORE the package imported (real `Function.prototype`
// preserved), so the captured "intrinsic" WAS the forgery: two fresh
// processes minted equal anonymous bindings and replay identities while the
// forged compiler bound divergent behavior to them. No unforgeable
// replacement exists in ordinary JavaScript: every route to a
// function-construction or evaluation primitive — `globalThis.Function`,
// `Function.prototype.constructor`, `(function () {}).constructor`, `eval`,
// generator/async constructor chains — resolves through writable realm state
// a pre-import adversary controls. An executable identity therefore must be
// caller-supplied: every `run` callback requires an explicit stable
// runnerBinding, which is canonical AST data and part of the replay identity,
// and the caller owns keeping that binding pointed at one behavior. The
// statelessness scan below survives purely as a diagnostic so authors still
// learn WHY a callback could never have carried a content-addressed identity.
const runners = new WeakMap<object, StepRunner>();
const runnersByBinding = new Map<string, StepRunner>();
// A binding is canonical AST data ONLY when it is a non-empty string. Sol's
// round-9 counterexample supplied `runnerBinding: ""`: it counted as explicit
// (bypassing RUNNER_BINDING_REQUIRED), truthiness spreads then dropped it from
// the canonical AST, yet the executable stayed registered — an anonymous
// executable identity in all but name, with equal replay identities around
// process-divergent behavior. Validity is a RUNTIME predicate (TypeScript
// types are caller-erasable), and it gates registration, lookup, and
// admission alike so an invalid binding can never name or reach an
// executable. Whitespace-only strings fail too: a binding that canonicalizes
// to visible identity must carry at least one visible character.
export const validRunnerBinding = (binding: unknown): binding is string => typeof binding === "string" && binding.trim().length > 0;
export const stepRunner = (stepValue: ScenarioStep): StepRunner | undefined => runners.get(stepValue) ?? (validRunnerBinding(stepValue.runnerBinding) ? runnersByBinding.get(stepValue.runnerBinding) : undefined);
export const step = (id: string, options: { input?: ScenarioValue; dependsOn?: readonly string[]; capabilities?: readonly string[]; extension?: string; runnerBinding?: string; run?: StepRunner } = {}): ScenarioStep => {
  const explicitBinding = options.runnerBinding !== undefined;
  if (explicitBinding && !validRunnerBinding(options.runnerBinding)) {
    throw Object.assign(new Error(`RUNNER_BINDING_INVALID: runnerBinding must be a non-empty stable string (step ${id}); an empty, whitespace-only, or non-string binding cannot name one behavior across processes and would strand its executable outside the canonical AST`), { code: "RUNNER_BINDING_INVALID", details: { step: id, runnerBinding: options.runnerBinding } });
  }
  // The `anonymous:` namespace is RETIRED framework-issued identity. No new
  // binding may ever claim it: a caller-forged `anonymous:` binding would
  // revive the content-addressed namespace while naming an arbitrary
  // executable, recreating the collision the retirement closed.
  if (explicitBinding && options.runnerBinding!.startsWith("anonymous:")) {
    throw Object.assign(new Error(`RUNNER_BINDING_CONFLICT: the anonymous: namespace is retired framework-issued identity; provide a caller-owned runnerBinding`), { code: "RUNNER_BINDING_CONFLICT", details: { runnerBinding: options.runnerBinding, explicitBinding } });
  }
  if (options.run && !explicitBinding) {
    // Source is read once through the captured reflection intrinsic, for
    // diagnostics only. Unprovable statelessness keeps its historical
    // rejection; the provable subset is rejected too, because binding an
    // executable identity to source requires a compilation primitive and no
    // unforgeable one exists (see the retirement note above).
    const source = runnerSource(options.run);
    if (!provablyStatelessSource(source)) {
      throw Object.assign(new Error("RUNNER_BINDING_AMBIGUOUS: callback statelessness is not provable from source; provide an explicit stable runnerBinding"), { code: "RUNNER_BINDING_AMBIGUOUS" });
    }
    throw Object.assign(new Error(`RUNNER_BINDING_REQUIRED: anonymous executable identities are retired — every run callback requires an explicit caller-supplied stable runnerBinding (step ${id}); the caller owns keeping the binding pointed at one behavior across processes`), { code: "RUNNER_BINDING_REQUIRED", details: { step: id } });
  }
  // Past the validity gate, an explicit binding IS a valid non-empty string.
  // Presence checks below are on `undefined`, never truthiness: a truthiness
  // check is exactly what let the empty binding split "explicit enough to
  // skip rejection" from "canonical enough to enter the AST".
  const runnerBinding = options.runnerBinding;
  if (options.run && runnerBinding !== undefined) {
    const prior = runnersByBinding.get(runnerBinding);
    // An explicit binding names exactly one executable per process.
    if (prior && prior !== options.run) {
      throw Object.assign(new Error(`RUNNER_BINDING_CONFLICT: ${runnerBinding} names multiple executables; provide an explicit stable runnerBinding`), { code: "RUNNER_BINDING_CONFLICT", details: { runnerBinding, explicitBinding } });
    }
  }
  const value = freezeScenario({ kind: "step" as const, id, ...(options.input === undefined ? {} : { input: options.input }), dependsOn: [...(options.dependsOn ?? [])], capabilities: [...(options.capabilities ?? [])], ...(options.extension ? { extension: options.extension } : {}), ...(runnerBinding === undefined ? {} : { runnerBinding }) });
  const executable = options.run;
  if (executable) { runners.set(value, executable); if (runnerBinding !== undefined && !runnersByBinding.has(runnerBinding)) runnersByBinding.set(runnerBinding, executable); }
  return value;
};
export const barrier = (id: string, parties: readonly string[], budget = 100): ScenarioBarrier => freezeScenario({ kind: "barrier", id, parties: [...parties], budget });
export const fault = (id: string, phase: ScenarioFault["phase"], operation: ScenarioFault["operation"], outcome?: ScenarioValue): ScenarioFault => freezeScenario({ kind: "fault", id, phase, operation, ...(outcome === undefined ? {} : { outcome }) });
export const extension = (name: string, value: ScenarioValue): ScenarioExtension => freezeScenario({ kind: "extension", name, value });
export const scenario = (name: string, options: { steps?: readonly ScenarioStep[]; barriers?: readonly ScenarioBarrier[]; faults?: readonly ScenarioFault[]; extensions?: readonly ScenarioExtension[]; seed?: number } = {}): ScenarioAst => freezeScenario({ version: 1, name, ...(options.seed === undefined ? {} : { seed: options.seed }), steps: [...(options.steps ?? [])], barriers: [...(options.barriers ?? [])], faults: [...(options.faults ?? [])], extensions: [...(options.extensions ?? [])] });
