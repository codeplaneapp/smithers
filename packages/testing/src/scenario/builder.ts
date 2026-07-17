import { freezeScenario, type ScenarioAst, type ScenarioBarrier, type ScenarioExtension, type ScenarioFault, type ScenarioStep, type ScenarioValue } from "./ast.ts";
import { createHash } from "node:crypto";
export type TaskRuntime = Readonly<{ effect: <T>(name: string, operation: () => T | Promise<T>, options?: Readonly<{ idempotencyKey?: string }>) => Promise<T>; sleep: (ms: number) => Promise<void>; log: (message: string, data?: ScenarioValue) => void; opaque: <T>(name: string, operation: () => T | Promise<T>) => Promise<T> }>;
export type StepRunner = (runtime: TaskRuntime, input: ScenarioValue | undefined) => unknown | Promise<unknown>;
const stableRunnerDigest = (runner: StepRunner): string => {
  return createHash("sha256").update(Function.prototype.toString.call(runner)).digest("hex");
};
// JavaScript does not expose a closure environment. We can still reject the
// important ambiguous case (a source-identical callback returning a captured
// value) while retaining compatibility for literal/stateless callbacks. Any
// callback whose executable identity cannot be established should use an
// explicit runnerBinding.
const hasCapturedResult = (runner: StepRunner): boolean => {
  const source = Function.prototype.toString.call(runner);
  // A closure can capture a value as part of an expression, not only as a
  // bare return.  The source digest cannot distinguish make(1) from make(2),
  // so reject the common expression/object forms as well.
  const arrowBody = source.slice(source.indexOf("=>") + 2);
  // Nested factories are the other important shape that cannot be recovered
  // from Function#toString: the runner itself may be `() => [captured]` even
  // though the factory which created it is no longer visible.  Inspect the
  // final arrow body, rather than the parameters of an outer factory.
  const finalBody = arrowBody.includes("=>") ? arrowBody.slice(arrowBody.lastIndexOf("=>") + 2) : arrowBody;
  if (/\[\s*[A-Za-z_$][\w$]*\s*\]/.test(finalBody) || /\{\s*[A-Za-z_$][\w$]*\s*\}/.test(finalBody)) return true;
  if (/\b[A-Za-z_$][\w$]*\s*[+\-*\/%]|\b[A-Za-z_$][\w$]*\s*\?/.test(arrowBody) && !/\b(runtime|input|undefined|null|true|false)\b/.test(arrowBody)) return true;
  // Object-shorthand captures (for example `make(x) => () => ({x})`) are the
  // closure shape that Function#toString cannot distinguish across processes.
  // Treat them as ambiguous even though the returned value is not a bare
  // identifier.
  const objectCapture = source.match(/=>\s*\(?\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*\)?\s*$/s);
  if (objectCapture) {
    const params: string[] = source.slice(0, source.indexOf("=>")).match(/[A-Za-z_$][\w$]*/g) ?? [];
    if (!params.includes(objectCapture[1]!)) return true;
  }
  // Calls are another common closure shape: `make(x) => () =>
  // ({value:String(x)})`.  Function#toString preserves the source but not
  // the environment.  Reject free value identifiers in the returned
  // expression; property names and standard globals are not captures.
  const expression = source.slice(source.indexOf("=>") + 2);
  const valueExpression = /\breturn\b([\s\S]*)/.exec(expression)?.[1]
    ?? (!expression.trim().startsWith("{") ? expression : "");
  const callbackParams: string[] = source.slice(0, source.indexOf("=>")).match(/[A-Za-z_$][\w$]*/g) ?? [];
  // These names are only safe when they are used as their standard intrinsic
  // operations.  A caller can shadow any of them (for example
  // `const make = (Math) => () => Math.value`), so do not treat the root name
  // as proof of a process-independent executable identity.
  const globals = new Set(["String", "Number", "Boolean", "BigInt", "Object", "Array", "Promise", "Error", "undefined", "null", "true", "false", "NaN", "Infinity", "return"]);
  const valueCode = valueExpression.replace(/(['"])(?:\\.|(?!\1).)*\1/g, "");
  const freeValue = [...valueCode.matchAll(/\b[A-Za-z_$][\w$]*\b/g)].some((match) => {
    const name = match[0]!; const before = valueCode.slice(0, match.index ?? 0); const next = valueCode[(match.index ?? 0) + name.length];
    // `box.value` is just as closure-dependent as `box`; excluding an
    // identifier because it is followed by a dot made source-identical
    // object captures look replay-safe even though their outputs differ.
    const previousNonSpace = before.trimEnd().at(-1);
    return !globals.has(name) && !callbackParams.includes(name) && previousNonSpace !== "." && next !== ":";
  });
  if (freeValue) return true;
  const match = source.match(/=>\s*([A-Za-z_$][\w$]*)\s*$/s)
    ?? source.match(/\breturn\s+([A-Za-z_$][\w$]*)\s*;?\s*}\s*$/s);
  if (!match) return false;
  const params: string[] = source.slice(0, source.indexOf("=>")).match(/[A-Za-z_$][\w$]*/g) ?? [];
  if (params.includes(match[1]!)) return false;
  return !new Set(["undefined", "null", "true", "false", "NaN", "Infinity"]).has(match[1]!);
};
const runners = new WeakMap<object, StepRunner>();
const runnersByBinding = new Map<string, StepRunner>();
export const stepRunner = (stepValue: ScenarioStep): StepRunner | undefined => runners.get(stepValue) ?? (stepValue.runnerBinding ? runnersByBinding.get(stepValue.runnerBinding) : undefined);
export const step = (id: string, options: { input?: ScenarioValue; dependsOn?: readonly string[]; capabilities?: readonly string[]; extension?: string; runnerBinding?: string; run?: StepRunner } = {}): ScenarioStep => {
  // Anonymous bindings are content-addressed, never numbered.  A process-global
  // counter makes the canonical AST depend on construction history and makes a
  // fresh-process replay impossible.  Callers that need two distinct runners
  // with identical source must provide an explicit runnerBinding.
  const explicitBinding = options.runnerBinding !== undefined;
  if (options.run && !explicitBinding && hasCapturedResult(options.run)) {
    throw Object.assign(new Error("RUNNER_BINDING_AMBIGUOUS: captured callback requires an explicit stable runnerBinding"), { code: "RUNNER_BINDING_AMBIGUOUS" });
  }
  const runnerBinding = options.run ? (options.runnerBinding ?? `anonymous:${stableRunnerDigest(options.run)}`) : options.runnerBinding;
  if (options.run && runnerBinding) {
    const prior = runnersByBinding.get(runnerBinding);
    // A source digest is not an executable identity: two closures can have
    // byte-identical source while capturing different state.  Reusing that
    // anonymous digest would make replay claim equivalence it cannot prove.
    if (prior && prior !== options.run && (explicitBinding || hasCapturedResult(options.run))) {
      const code = explicitBinding ? "RUNNER_BINDING_CONFLICT" : "RUNNER_BINDING_AMBIGUOUS";
      throw Object.assign(new Error(`${code}: ${runnerBinding} names multiple executables; provide an explicit stable runnerBinding`), { code, details: { runnerBinding, explicitBinding } });
    }
  }
  const value = freezeScenario({ kind: "step" as const, id, ...(options.input === undefined ? {} : { input: options.input }), dependsOn: [...(options.dependsOn ?? [])], capabilities: [...(options.capabilities ?? [])], ...(options.extension ? { extension: options.extension } : {}), ...(runnerBinding ? { runnerBinding } : {}) });
  if (options.run) { runners.set(value, options.run); if (runnerBinding && !runnersByBinding.has(runnerBinding)) runnersByBinding.set(runnerBinding, options.run); }
  return value;
};
export const barrier = (id: string, parties: readonly string[], budget = 100): ScenarioBarrier => freezeScenario({ kind: "barrier", id, parties: [...parties], budget });
export const fault = (id: string, phase: ScenarioFault["phase"], operation: ScenarioFault["operation"], outcome?: ScenarioValue): ScenarioFault => freezeScenario({ kind: "fault", id, phase, operation, ...(outcome === undefined ? {} : { outcome }) });
export const extension = (name: string, value: ScenarioValue): ScenarioExtension => freezeScenario({ kind: "extension", name, value });
export const scenario = (name: string, options: { steps?: readonly ScenarioStep[]; barriers?: readonly ScenarioBarrier[]; faults?: readonly ScenarioFault[]; extensions?: readonly ScenarioExtension[]; seed?: number } = {}): ScenarioAst => freezeScenario({ version: 1, name, ...(options.seed === undefined ? {} : { seed: options.seed }), steps: [...(options.steps ?? [])], barriers: [...(options.barriers ?? [])], faults: [...(options.faults ?? [])], extensions: [...(options.extensions ?? [])] });
