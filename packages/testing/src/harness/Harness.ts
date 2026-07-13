import { admitCapabilities, requiredCapabilities, type Capability, type CapabilityDecision } from "./capabilities.ts";
import type { ScenarioFault } from "../scenario/ast.ts";
export type HarnessKind = "unit-sim" | "integration-real-db" | "e2e-real-process";
export type HarnessAdapter = Readonly<{ readonly identity: string; readonly verifiedProductionIdentity?: string; readonly admissionProbe: () => void | Promise<void>; readonly cleanup?: () => void | Promise<void>; readonly runStep?: (...args: readonly unknown[]) => unknown | Promise<unknown>; readonly injectFault?: (fault: ScenarioFault) => void | Promise<void>; readonly supportedCutPoints?: ReadonlySet<string>; readonly serializeError?: (error: unknown) => unknown; readonly extensions?: ReadonlySet<string>; readonly extensionExecutors?: Readonly<Record<string, (...args: readonly unknown[]) => unknown | Promise<unknown>>> }>;
const trustedAdapters = new WeakMap<object, HarnessKind>();
export const registerTrustedAdapter = (adapter: HarnessAdapter, kind: HarnessKind): HarnessAdapter => { trustedAdapters.set(adapter, kind); return adapter; };
export const trustedAdapterKind = (adapter: HarnessAdapter): HarnessKind | undefined => trustedAdapters.get(adapter);
export type HarnessConfig = Readonly<{ readonly name?: string; readonly policy?: "fail" | "skip"; readonly capabilities?: readonly Capability[]; readonly adapter?: HarnessAdapter }>;
export type Harness = Readonly<{ readonly name: string; readonly kind: HarnessKind; readonly capabilities: ReadonlySet<Capability>; readonly config: HarnessConfig; readonly adapter?: HarnessAdapter; readonly admit: (requested: readonly Capability[]) => readonly CapabilityDecision[]; readonly admitScenario: (ast: Parameters<typeof requiredCapabilities>[0], requested?: readonly Capability[]) => readonly CapabilityDecision[] }>;
export const makeHarness = (kind: HarnessKind, config: HarnessConfig = {}): Harness => {
  const defaults: Record<HarnessKind, readonly Capability[]> = { "unit-sim": ["virtual-time", "seeded-interleaving", "explicit-interleaving", "barriers", "mediated-effects", "durability-faults"], "integration-real-db": ["virtual-time", "seeded-interleaving", "explicit-interleaving", "barriers", "mediated-effects", "real-db", "native-error-parity", "durability-faults"], "e2e-real-process": ["real-process", "native-error-parity", "durability-faults"] };
  const requestedCapabilities = config.capabilities ?? defaults[kind];
  const forbiddenForUnit = new Set<Capability>(["real-db", "real-process", "native-error-parity"]);
  const capabilities = new Set(kind === "unit-sim" ? requestedCapabilities.filter((capability) => !forbiddenForUnit.has(capability)) : requestedCapabilities);
  const name = config.name ?? kind;
  const admit = (requested: readonly Capability[]): readonly CapabilityDecision[] => {
    const decisions = admitCapabilities({ name, capabilities }, requested, config.policy ?? "fail");
    const forbidden = requested.filter((capability) => forbiddenForUnit.has(capability));
    if (kind === "unit-sim" && forbidden.length) return [...decisions, ...forbidden.map((capability) => ({ kind: config.policy === "skip" ? "capability-skip" as const : "capability-failure" as const, harness: name, capability, hint: "unit-sim cannot claim a real production capability" }))];
    const crossKind = requestedCapabilities.some((capability) => (kind === "integration-real-db" && capability === "real-process") || (kind === "e2e-real-process" && capability === "real-db"));
    if (kind !== "unit-sim" && (crossKind || !config.adapter || trustedAdapterKind(config.adapter) !== kind || typeof config.adapter.admissionProbe !== "function" || typeof config.adapter.runStep !== "function" || !config.adapter.verifiedProductionIdentity)) {
      const capability: Capability = kind === "e2e-real-process" ? "real-process" : "real-db";
      return [...decisions, { kind: config.policy === "skip" ? "capability-skip" : "capability-failure", harness: name, capability, hint: "declaration is not proof: a verified production adapter with admissionProbe, runStep, and identity is required" }];
    }
    return decisions;
  };
  return { name, kind, capabilities, config, adapter: config.adapter, admit, admitScenario: (ast, requested = []) => admit([...requiredCapabilities(ast), ...requested]) };
};
export const unitSimHarness = (config: HarnessConfig = {}): Harness => makeHarness("unit-sim", config);
export const integrationHarness = (config: HarnessConfig = {}): Harness => makeHarness("integration-real-db", config);
export const e2eHarness = (config: HarnessConfig = {}): Harness => makeHarness("e2e-real-process", config);
