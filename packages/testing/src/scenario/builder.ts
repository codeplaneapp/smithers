import { freezeScenario, type ScenarioAst, type ScenarioBarrier, type ScenarioExtension, type ScenarioFault, type ScenarioStep, type ScenarioValue } from "./ast.ts";
import { createHash } from "node:crypto";
export type TaskRuntime = Readonly<{ effect: <T>(name: string, operation: () => T | Promise<T>) => Promise<T>; sleep: (ms: number) => Promise<void>; log: (message: string, data?: ScenarioValue) => void; opaque: <T>(name: string, operation: () => T | Promise<T>) => Promise<T> }>;
export type StepRunner = (runtime: TaskRuntime, input: ScenarioValue | undefined) => unknown | Promise<unknown>;
const runners = new WeakMap<object, StepRunner>();
const runnersByBinding = new Map<string, StepRunner>();
const runnerOwners = new Map<string, StepRunner>();
let nextAnonymousRunner = 0;
export const stepRunner = (stepValue: ScenarioStep): StepRunner | undefined => runners.get(stepValue) ?? (stepValue.runnerBinding ? runnersByBinding.get(stepValue.runnerBinding) : undefined);
export const step = (id: string, options: { input?: ScenarioValue; dependsOn?: readonly string[]; capabilities?: readonly string[]; extension?: string; runnerBinding?: string; run?: StepRunner } = {}): ScenarioStep => {
  const runnerBinding = options.run ? (options.runnerBinding ?? `anonymous:${nextAnonymousRunner++}:${createHash("sha256").update(Function.prototype.toString.call(options.run)).digest("hex").slice(0, 16)}`) : options.runnerBinding;
  if (options.run && runnerBinding) {
    const owner = runnerOwners.get(runnerBinding);
    if (owner && owner !== options.run) throw new Error(`RUNNER_BINDING_COLLISION: ${runnerBinding} is already bound to another runner`);
    runnerOwners.set(runnerBinding, options.run);
  }
  const value = freezeScenario({ kind: "step" as const, id, ...(options.input === undefined ? {} : { input: options.input }), dependsOn: [...(options.dependsOn ?? [])], capabilities: [...(options.capabilities ?? [])], ...(options.extension ? { extension: options.extension } : {}), ...(runnerBinding ? { runnerBinding } : {}) });
  if (options.run) { runners.set(value, options.run); if (runnerBinding) runnersByBinding.set(runnerBinding, options.run); }
  return value;
};
export const barrier = (id: string, parties: readonly string[], budget = 100): ScenarioBarrier => freezeScenario({ kind: "barrier", id, parties: [...parties], budget });
export const fault = (id: string, phase: ScenarioFault["phase"], operation: ScenarioFault["operation"], outcome?: ScenarioValue): ScenarioFault => freezeScenario({ kind: "fault", id, phase, operation, ...(outcome === undefined ? {} : { outcome }) });
export const extension = (name: string, value: ScenarioValue): ScenarioExtension => freezeScenario({ kind: "extension", name, value });
export const scenario = (name: string, options: { steps?: readonly ScenarioStep[]; barriers?: readonly ScenarioBarrier[]; faults?: readonly ScenarioFault[]; extensions?: readonly ScenarioExtension[]; seed?: number } = {}): ScenarioAst => freezeScenario({ version: 1, name, ...(options.seed === undefined ? {} : { seed: options.seed }), steps: [...(options.steps ?? [])], barriers: [...(options.barriers ?? [])], faults: [...(options.faults ?? [])], extensions: [...(options.extensions ?? [])] });
