import { admitCapabilities, requiredCapabilities, type Capability, type CapabilityDecision } from "./capabilities.ts";
import type { ScenarioFault } from "../scenario/ast.ts";
export type HarnessKind = "unit-sim" | "integration-real-db" | "e2e-real-process";
export type UnitSimHarnessConfig = Readonly<{
  readonly kind?: "unit-sim";
  readonly name?: string;
  readonly policy?: "fail" | "skip";
  readonly capabilities?: readonly Capability[];
}>;
export type IntegrationRealDbHarnessConfig = Readonly<{
  readonly kind?: "integration-real-db";
  readonly name?: string;
  readonly policy?: "fail" | "skip";
  readonly capabilities?: readonly Capability[];
  readonly adapter: HarnessAdapter;
  readonly dbPath?: string;
  readonly retryProfile?: Readonly<Record<string, unknown>>;
}>;
export type E2eRealProcessHarnessConfig = Readonly<{
  readonly kind?: "e2e-real-process";
  readonly name?: string;
  readonly policy?: "fail" | "skip";
  readonly capabilities?: readonly Capability[];
  readonly adapter: HarnessAdapter;
  readonly workflowEntry?: string;
  readonly dbPath?: string;
  readonly killSignal?: string;
  readonly resumeOwner?: string;
}>;
/** Transition context handed to an adapter's injectFault at the exact operation/phase boundary. */
export type AdapterFaultContext = Readonly<{
  readonly operation?: string;
  readonly phase?: string;
  readonly stepId?: string;
  readonly input?: unknown;
  readonly invoked?: boolean;
  readonly result?: unknown;
}>;
export type HarnessAdapter = Readonly<{
  readonly identity: string;
  readonly verifiedProductionIdentity?: string;
  readonly admissionProbe: () => void | Promise<void>;
  readonly cleanup?: () => void | Promise<void>;
  readonly runStep?: (...args: readonly unknown[]) => unknown | Promise<unknown>;
  readonly injectFault?: (fault: ScenarioFault, context?: AdapterFaultContext) => unknown | Promise<unknown>;
  readonly supportedCutPoints?: ReadonlySet<string>;
  readonly serializeError?: (error: unknown) => unknown;
  readonly extensions?: ReadonlySet<string>;
  readonly extensionExecutors?: Readonly<Record<string, (...args: readonly unknown[]) => unknown | Promise<unknown>>>;
}>;
const trustedAdapters = new WeakMap<object, HarnessKind>();
export const registerTrustedAdapter = (adapter: HarnessAdapter, kind: HarnessKind): HarnessAdapter => {
  trustedAdapters.set(adapter, kind);
  return adapter;
};
export const trustedAdapterKind = (adapter: HarnessAdapter): HarnessKind | undefined => trustedAdapters.get(adapter);
export type HarnessConfig = Readonly<{
  readonly name?: string;
  readonly policy?: "fail" | "skip";
  readonly capabilities?: readonly Capability[];
  readonly adapter?: HarnessAdapter;
}>;
type AdapterlessCompatibilityConfig = Readonly<{
  readonly name?: string;
  readonly policy?: "fail" | "skip";
  readonly capabilities?: readonly Capability[];
}>;
export type Harness<Config extends HarnessConfig = HarnessConfig> = Readonly<{
  readonly name: string;
  readonly kind: HarnessKind;
  readonly capabilities: ReadonlySet<Capability>;
  readonly config: Config;
  readonly adapter?: HarnessAdapter;
  readonly admit: (requested: readonly Capability[]) => readonly CapabilityDecision[];
  readonly admitScenario: (
    ast: Parameters<typeof requiredCapabilities>[0],
    requested?: readonly Capability[],
  ) => readonly CapabilityDecision[];
}>;
export function makeHarness(kind: "unit-sim", config?: UnitSimHarnessConfig): Harness<UnitSimHarnessConfig>;
export function makeHarness(
  kind: "integration-real-db",
  config: IntegrationRealDbHarnessConfig,
): Harness<IntegrationRealDbHarnessConfig>;
export function makeHarness(
  kind: "integration-real-db",
  config?: AdapterlessCompatibilityConfig,
): Harness<AdapterlessCompatibilityConfig>;
export function makeHarness(
  kind: "e2e-real-process",
  config: E2eRealProcessHarnessConfig,
): Harness<E2eRealProcessHarnessConfig>;
export function makeHarness(
  kind: "e2e-real-process",
  config?: AdapterlessCompatibilityConfig,
): Harness<AdapterlessCompatibilityConfig>;
/** @deprecated Dynamic-kind compatibility overload; literal kinds retain strict config checking. */
export function makeHarness(kind: HarnessKind, config?: HarnessConfig): Harness<HarnessConfig>;
export function makeHarness(kind: HarnessKind, config: HarnessConfig = {}): Harness<HarnessConfig> {
  const defaults: Record<HarnessKind, readonly Capability[]> = {
    "unit-sim": [
      "virtual-time",
      "seeded-interleaving",
      "explicit-interleaving",
      "barriers",
      "mediated-effects",
      "durability-faults",
    ],
    "integration-real-db": [
      "virtual-time",
      "seeded-interleaving",
      "explicit-interleaving",
      "barriers",
      "mediated-effects",
      "real-db",
      "native-error-parity",
      "durability-faults",
    ],
    "e2e-real-process": ["real-process", "native-error-parity", "durability-faults"],
  };
  const requestedCapabilities = (config.capabilities ?? defaults[kind]).filter(
    (capability) => !(capability === "native-error-parity" && typeof config.adapter?.serializeError !== "function"),
  );
  const forbiddenForUnit = new Set<Capability>(["real-db", "real-process", "native-error-parity"]);
  const capabilities = new Set(
    kind === "unit-sim"
      ? requestedCapabilities.filter((capability) => !forbiddenForUnit.has(capability))
      : requestedCapabilities,
  );
  const name = config.name ?? kind;
  const admit = (requested: readonly Capability[]): readonly CapabilityDecision[] => {
    const decisions = admitCapabilities({ name, capabilities }, requested, config.policy ?? "fail");
    const forbidden = requested.filter((capability) => forbiddenForUnit.has(capability));
    if (kind === "unit-sim" && forbidden.length)
      return [
        ...decisions,
        ...forbidden.map((capability) => ({
          kind: config.policy === "skip" ? ("capability-skip" as const) : ("capability-failure" as const),
          harness: name,
          capability,
          hint: "unit-sim cannot claim a real production capability",
        })),
      ];
    const crossKind = requestedCapabilities.some(
      (capability) =>
        (kind === "integration-real-db" && capability === "real-process") ||
        (kind === "e2e-real-process" &&
          (capability === "real-db" ||
            ["virtual-time", "seeded-interleaving", "explicit-interleaving", "barriers"].includes(capability))),
    );
    if (
      kind !== "unit-sim" &&
      (crossKind ||
        !config.adapter ||
        trustedAdapterKind(config.adapter) !== kind ||
        typeof config.adapter.admissionProbe !== "function" ||
        typeof config.adapter.runStep !== "function" ||
        !config.adapter.verifiedProductionIdentity)
    ) {
      const capability: Capability = kind === "e2e-real-process" ? "real-process" : "real-db";
      return [
        ...decisions,
        {
          kind: config.policy === "skip" ? "capability-skip" : "capability-failure",
          harness: name,
          capability,
          hint: "declaration is not proof: a verified production adapter with admissionProbe, runStep, and identity is required",
        },
      ];
    }
    return decisions;
  };
  return {
    name,
    kind,
    capabilities,
    config,
    adapter: config.adapter,
    admit,
    admitScenario: (ast, requested = []) => admit([...requiredCapabilities(ast), ...requested]),
  };
}
export const unitSimHarness = (config: UnitSimHarnessConfig = {}): Harness<UnitSimHarnessConfig> =>
  makeHarness("unit-sim", config);
export function integrationHarness(config: IntegrationRealDbHarnessConfig): Harness<IntegrationRealDbHarnessConfig>;
/** @deprecated Adapterless construction is compatibility-only and cannot prove real-db. */
export function integrationHarness(config?: AdapterlessCompatibilityConfig): Harness<AdapterlessCompatibilityConfig>;
export function integrationHarness(
  config: IntegrationRealDbHarnessConfig | AdapterlessCompatibilityConfig = {},
): Harness<IntegrationRealDbHarnessConfig | AdapterlessCompatibilityConfig> {
  return makeHarness("integration-real-db", config);
}
export function e2eHarness(config: E2eRealProcessHarnessConfig): Harness<E2eRealProcessHarnessConfig>;
/** @deprecated Adapterless construction is compatibility-only and cannot prove real-process. */
export function e2eHarness(config?: AdapterlessCompatibilityConfig): Harness<AdapterlessCompatibilityConfig>;
export function e2eHarness(
  config: E2eRealProcessHarnessConfig | AdapterlessCompatibilityConfig = {},
): Harness<E2eRealProcessHarnessConfig | AdapterlessCompatibilityConfig> {
  return makeHarness("e2e-real-process", config);
}
