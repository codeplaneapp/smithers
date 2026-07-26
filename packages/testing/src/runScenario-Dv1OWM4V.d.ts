/// <reference path="../types/bun-test-shim.d.ts" />
import { RunWorkflowScenarioOptions, WorkflowScenarioResult } from './runWorkflowScenario.js';

type ScenarioValue = null | boolean | number | string | readonly ScenarioValue[] | {
    readonly [key: string]: ScenarioValue;
};
type ScenarioStep = Readonly<{
    readonly kind: "step";
    readonly id: string;
    readonly input?: ScenarioValue;
    readonly dependsOn: readonly string[];
    readonly capabilities: readonly string[];
    readonly extension?: string;
    readonly runnerBinding?: string;
}>;
type ScenarioBarrier = Readonly<{
    readonly kind: "barrier";
    readonly id: string;
    readonly parties: readonly string[];
    readonly budget: number;
}>;
type ScenarioFault = Readonly<{
    readonly kind: "fault";
    readonly id: string;
    readonly phase: "before-task" | "during-task" | "after-task" | "after-effect-before-journal" | "after-journal-before-ack" | "after-ack";
    readonly operation: "task" | "effect" | "attempt-write" | "event-append" | "completion-cas" | "heartbeat" | "lease" | "resume" | "cancellation";
    readonly outcome?: ScenarioValue;
}>;
type ScenarioExtension = Readonly<{
    readonly kind: "extension";
    readonly name: string;
    readonly value: ScenarioValue;
}>;
type ScenarioAst = Readonly<{
    readonly version: 1;
    readonly name: string;
    readonly seed?: number;
    readonly steps: readonly ScenarioStep[];
    readonly barriers: readonly ScenarioBarrier[];
    readonly faults: readonly ScenarioFault[];
    readonly extensions: readonly ScenarioExtension[];
}>;

type TaskRuntime = Readonly<{
    effect: <T>(name: string, operation: () => T | Promise<T>, options?: Readonly<{
        idempotencyKey?: string;
    }>) => Promise<T>;
    sleep: (ms: number) => Promise<void>;
    log: (message: string, data?: ScenarioValue) => void;
    opaque: <T>(name: string, operation: () => T | Promise<T>) => Promise<T>;
}>;
type StepRunner = (runtime: TaskRuntime, input: ScenarioValue | undefined) => unknown | Promise<unknown>;
declare const step: (id: string, options?: {
    input?: ScenarioValue;
    dependsOn?: readonly string[];
    capabilities?: readonly string[];
    extension?: string;
    runnerBinding?: string;
    run?: StepRunner;
}) => ScenarioStep;
declare const barrier: (id: string, parties: readonly string[], budget?: number) => ScenarioBarrier;
declare const fault: (id: string, phase: ScenarioFault["phase"], operation: ScenarioFault["operation"], outcome?: ScenarioValue) => ScenarioFault;
declare const extension: (name: string, value: ScenarioValue) => ScenarioExtension;
declare const scenario: (name: string, options?: {
    steps?: readonly ScenarioStep[];
    barriers?: readonly ScenarioBarrier[];
    faults?: readonly ScenarioFault[];
    extensions?: readonly ScenarioExtension[];
    seed?: number;
}) => ScenarioAst;

type Capability = "virtual-time" | "seeded-interleaving" | "explicit-interleaving" | "barriers" | "mediated-effects" | "real-db" | "real-process" | "native-error-parity" | "durability-faults";
type CapabilityDecision = Readonly<{
    readonly kind: "supported" | "capability-failure" | "capability-skip";
    readonly harness: string;
    readonly capability: Capability;
    readonly hint?: string;
}>;
declare const requiredCapabilities: (ast: {
    readonly steps: readonly {
        readonly capabilities: readonly string[];
    }[];
    readonly barriers: readonly unknown[];
    readonly faults: readonly unknown[];
    readonly extensions: readonly {
        readonly name: string;
    }[];
}) => readonly Capability[];

type ControlMessage = Readonly<{
    readonly type: "advance-clock";
    readonly ms: number;
} | {
    readonly type: "timer-fire";
    readonly timer: string;
} | {
    readonly type: "release-barrier";
    readonly barrier: string;
} | {
    readonly type: "pin-interleaving";
    readonly choice: string;
} | {
    readonly type: "inject-fault";
    readonly fault: string;
    readonly payload?: ScenarioValue;
} | {
    readonly type: "resolve-effect";
    readonly effect: string;
    readonly outcome: "succeed" | "fail" | "hang" | "duplicate";
    readonly value?: ScenarioValue;
} | {
    readonly type: "cancel";
    readonly reason?: string;
} | {
    readonly type: "task-restart";
    readonly step: string;
}>;

type TraceEvent = Readonly<{
    readonly seq: number;
    readonly at: number;
    readonly type: "schedule" | "barrier" | "fault" | "task" | "effect" | "opaque-effect" | "capability" | "wait" | "ambiguity" | "adapter" | "durability";
    readonly id?: string;
    readonly data?: ScenarioValue;
}>;

type HarnessError = Readonly<{
    readonly name: string;
    readonly code: string;
    readonly message: string;
    readonly fidelity?: "simulation" | "native";
    readonly tag?: string;
    readonly summary?: string;
    readonly docsUrl?: string;
    readonly serialized?: unknown;
    readonly details?: unknown;
    readonly cause?: unknown;
}>;

type HarnessKind = "unit-sim" | "integration-real-db" | "e2e-real-process";
type UnitSimHarnessConfig = Readonly<{
    readonly kind?: "unit-sim";
    readonly name?: string;
    readonly policy?: "fail" | "skip";
    readonly capabilities?: readonly Capability[];
}>;
type IntegrationRealDbHarnessConfig = Readonly<{
    readonly kind?: "integration-real-db";
    readonly name?: string;
    readonly policy?: "fail" | "skip";
    readonly capabilities?: readonly Capability[];
    readonly adapter: HarnessAdapter;
    readonly dbPath?: string;
    readonly retryProfile?: Readonly<Record<string, unknown>>;
}>;
type E2eRealProcessHarnessConfig = Readonly<{
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
type AdapterFaultContext = Readonly<{
    readonly operation?: string;
    readonly phase?: string;
    readonly stepId?: string;
    readonly input?: unknown;
    readonly invoked?: boolean;
    readonly result?: unknown;
}>;
type HarnessAdapter = Readonly<{
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
type HarnessConfig = Readonly<{
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
type Harness<Config extends HarnessConfig = HarnessConfig> = Readonly<{
    readonly name: string;
    readonly kind: HarnessKind;
    readonly capabilities: ReadonlySet<Capability>;
    readonly config: Config;
    readonly adapter?: HarnessAdapter;
    readonly admit: (requested: readonly Capability[]) => readonly CapabilityDecision[];
    readonly admitScenario: (ast: Parameters<typeof requiredCapabilities>[0], requested?: readonly Capability[]) => readonly CapabilityDecision[];
}>;
declare function makeHarness(kind: "unit-sim", config?: UnitSimHarnessConfig): Harness<UnitSimHarnessConfig>;
declare function makeHarness(kind: "integration-real-db", config: IntegrationRealDbHarnessConfig): Harness<IntegrationRealDbHarnessConfig>;
declare function makeHarness(kind: "integration-real-db", config?: AdapterlessCompatibilityConfig): Harness<AdapterlessCompatibilityConfig>;
declare function makeHarness(kind: "e2e-real-process", config: E2eRealProcessHarnessConfig): Harness<E2eRealProcessHarnessConfig>;
declare function makeHarness(kind: "e2e-real-process", config?: AdapterlessCompatibilityConfig): Harness<AdapterlessCompatibilityConfig>;
/** @deprecated Dynamic-kind compatibility overload; literal kinds retain strict config checking. */
declare function makeHarness(kind: HarnessKind, config?: HarnessConfig): Harness<HarnessConfig>;
declare const unitSimHarness: (config?: UnitSimHarnessConfig) => Harness<UnitSimHarnessConfig>;
declare function integrationHarness(config: IntegrationRealDbHarnessConfig): Harness<IntegrationRealDbHarnessConfig>;
/** @deprecated Adapterless construction is compatibility-only and cannot prove real-db. */
declare function integrationHarness(config?: AdapterlessCompatibilityConfig): Harness<AdapterlessCompatibilityConfig>;
declare function e2eHarness(config: E2eRealProcessHarnessConfig): Harness<E2eRealProcessHarnessConfig>;
/** @deprecated Adapterless construction is compatibility-only and cannot prove real-process. */
declare function e2eHarness(config?: AdapterlessCompatibilityConfig): Harness<AdapterlessCompatibilityConfig>;

type AmbiguityOutcome = "duplicate-delivery" | "effect-applied-journal-missing" | "journal-applied-ack-missing" | "lease-lost" | "cancellation-race" | "restart-in-task" | "lost-wakeup";
type AmbiguityResult = Readonly<{
    readonly outcome: AmbiguityOutcome;
    readonly guaranteed: "journal-cas-only" | "at-least-once";
    readonly details: Readonly<Record<string, unknown>>;
}>;
declare const ambiguity: (outcome: AmbiguityOutcome, details?: Record<string, unknown>) => AmbiguityResult;

type DeterminismReport = Readonly<{
    readonly deterministic: boolean;
    readonly residues: readonly string[];
}>;
type ScenarioStatus = "finished" | "failed" | "capability-failure" | "capability-skip";
type ScenarioResult = Readonly<{
    readonly status: ScenarioStatus;
    readonly outputs: Readonly<Record<string, unknown>>;
    readonly trace: readonly TraceEvent[];
    readonly replayIdentity: string;
    readonly controlLog: readonly ControlMessage[];
    readonly capabilityReport: readonly unknown[];
    readonly ambiguity: readonly AmbiguityResult[];
    readonly determinismReport: DeterminismReport;
    readonly error?: HarnessError;
}>;
type RunScenarioOptions = Readonly<{
    readonly harness?: Harness;
    readonly seed?: number;
    readonly controlLog?: readonly ControlMessage[];
    readonly capabilities?: readonly Parameters<Harness["admit"]>[0][number][];
    readonly stepRunners?: Readonly<Record<string, (runtime: TaskRuntime, input: ScenarioValue | undefined) => unknown | Promise<unknown>>>;
    readonly cleanupBudget?: number;
    readonly waitBudget?: number;
}>;
/** Durability-kernel scenario runner (ScenarioAst). */
declare const runKernelScenario: (ast: ScenarioAst, options?: RunScenarioOptions) => Promise<ScenarioResult>;
/**
 * Dual entry:
 * - `runScenario(ast, options)` → durability kernel (ScenarioAst)
 * - `runScenario({ workflow, … })` → real engine workflow runner
 */
declare function runScenario(ast: ScenarioAst, options?: RunScenarioOptions): Promise<ScenarioResult>;
declare function runScenario(options: RunWorkflowScenarioOptions): Promise<WorkflowScenarioResult>;

export { type AmbiguityResult as A, runScenario as B, type Capability as C, type DeterminismReport as D, type E2eRealProcessHarnessConfig as E, scenario as F, step as G, type HarnessConfig as H, type IntegrationRealDbHarnessConfig as I, unitSimHarness as J, type RunScenarioOptions as R, type ScenarioAst as S, type TraceEvent as T, type UnitSimHarnessConfig as U, type ScenarioValue as a, type ControlMessage as b, type Harness as c, type ScenarioStatus as d, type HarnessError as e, type ScenarioResult as f, type ScenarioStep as g, type ScenarioBarrier as h, type ScenarioFault as i, type ScenarioExtension as j, type HarnessAdapter as k, type AdapterFaultContext as l, type AmbiguityOutcome as m, type CapabilityDecision as n, type HarnessKind as o, type StepRunner as p, type TaskRuntime as q, ambiguity as r, barrier as s, e2eHarness as t, extension as u, fault as v, integrationHarness as w, makeHarness as x, requiredCapabilities as y, runKernelScenario as z };
