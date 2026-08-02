/// <reference path="../types/bun-test-shim.d.ts" />
export { AutoMock, FakeAgent, FakeAgentCall, FakeAgentFiles, FakeAgentOptions, FakeAgentResult, FakeAgentScript, SafeSchema, auto, fakeAgent, isAuto } from './fakeAgent.js';
export { RenderWorkflowOptions, RenderedWorkflow, renderWorkflow } from './renderWorkflow.js';
export { renderPromptToText as renderPrompt } from '@smthrs/components/components/Task';
export { RunTaskOptions, runTask } from './runTask.js';
export { Sim, SimTaskRecord, SimulateMockFunction, SimulateOptions, simulate } from './simulate.js';
export { CoverableWorkflow, WorkflowCoverageApproval, WorkflowCoverageApprovalResolver, WorkflowCoverageApprovalValue, WorkflowCoverageDecision, WorkflowCoverageError, WorkflowCoverageEventContext, WorkflowCoverageEventResolver, WorkflowCoverageFailure, WorkflowCoverageOptions, WorkflowCoveragePass, WorkflowCoverageResult, WorkflowCoverageTaskContext, WorkflowCoverageValidation, coverWorkflow, expectFullCoverage } from './coverWorkflow.js';
export { simMatchers, toHaveExecuted, toHaveExecutedInOrder, toHaveFinished } from './matchers.js';
import { ChildProcess } from 'node:child_process';
import '@smthrs/driver/SmithersCtx';
import '@smthrs/react-reconciler';
import '@smthrs/driver/WorkflowDefinition';
import '@smthrs/graph';
import '@smthrs/scheduler';

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

type CompileDiagnostic = Readonly<{
    readonly code: string;
    readonly message: string;
    readonly node: string;
}>;
type CompileResult = Readonly<{
    readonly ok: true;
    readonly requiredCapabilities: readonly Capability[];
} | {
    readonly ok: false;
    readonly diagnostics: readonly CompileDiagnostic[];
    readonly requiredCapabilities: readonly Capability[];
}>;
declare const compileScenario: (ast: ScenarioAst, registeredExtensions?: ReadonlySet<string>) => CompileResult;

declare class CanonicalizeError extends Error {
    readonly details?: unknown | undefined;
    readonly code = "CANONICALIZE_UNSUPPORTED";
    constructor(message: string, details?: unknown | undefined);
}
declare const canonicalize: (value: ScenarioValue | object) => string;

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

declare const replayIdentity: (input: {
    ast: ScenarioAst;
    seed: number;
    controlLog?: readonly ControlMessage[];
}) => string;

type TraceEvent = Readonly<{
    readonly seq: number;
    readonly at: number;
    readonly type: "schedule" | "barrier" | "fault" | "task" | "effect" | "opaque-effect" | "capability" | "wait" | "ambiguity" | "adapter" | "durability";
    readonly id?: string;
    readonly data?: ScenarioValue;
}>;

type Timer = Readonly<{
    readonly id: number;
    readonly at: number;
    readonly callback: () => void;
}>;
declare class VirtualClock {
    private current;
    private nextId;
    private timers;
    now(): number;
    sleep(ms: number, callback: () => void): number;
    cancel(id: number): void;
    advance(ms: number): void;
    advanceToNextTimer(): boolean;
    runUntilIdle(limit?: number): void;
    pending(): readonly Timer[];
    clear(): void;
    private flush;
}

declare class SeededScheduler {
    private state;
    private readonly decisions;
    constructor(seed: number);
    choose<T>(ready: readonly T[], forcedIndex?: number): T;
    snapshot(): readonly number[];
    private next;
}

declare class ControlBus {
    private readonly pending;
    private readonly observed;
    constructor(input?: readonly ControlMessage[]);
    /** Append the command at the point it happened. Supplied commands are never
     * searched for or reordered: a generated decision is part of the log even
     * when a later supplied rendezvous is still pending. */
    append(message: ControlMessage): number;
    /** Only rendezvoused controls are observations. Pending input is exposed
     * separately so replay cannot mistake unconsumed commands for evidence. */
    log(): readonly ControlMessage[];
    find<T extends ControlMessage["type"]>(type: T): Extract<ControlMessage, {
        readonly type: T;
    }>[];
    /** Consume a command at its actual rendezvous and retain it in the replay log. */
    take<T extends ControlMessage["type"]>(type: T): Extract<ControlMessage, {
        readonly type: T;
    }> | undefined;
    /** Advance-clock is consumed only at a virtual-clock rendezvous. */
    takeAdvanceClock(): Extract<ControlMessage, {
        readonly type: "advance-clock";
    }> | undefined;
    /** Consume only the next command. Runtime commands are ordered. */
    takeNext<T extends ControlMessage["type"]>(type: T): Extract<ControlMessage, {
        readonly type: T;
    }> | undefined;
    /**
     * A rendezvous control is ordered, but applicability is part of the
     * rendezvous.  In particular, a pin for a step that is not ready must stay
     * pending until that step becomes ready; consuming it and generating a
     * replacement changes replay identity and can execute the wrong schedule.
     */
    takeApplicablePin(choices: readonly string[]): Extract<ControlMessage, {
        readonly type: "pin-interleaving";
    }> | undefined;
    peek(): ControlMessage | undefined;
    takeResolve(effect: string): Extract<ControlMessage, {
        readonly type: "resolve-effect";
    }> | undefined;
    takeTimerFire(timer: string): Extract<ControlMessage, {
        readonly type: "timer-fire";
    }> | undefined;
    consumed(): number;
    pendingControls(): readonly ControlMessage[];
}

declare class TraceCollector {
    private readonly clock;
    private readonly events;
    constructor(clock: {
        now(): number;
    });
    emit(event: Omit<TraceEvent, "seq" | "at">): TraceEvent;
    snapshot(): readonly TraceEvent[];
}

type WaitBudget = Readonly<{
    readonly steps: number;
    readonly ms?: number;
}>;
declare class BoundedWaitError extends Error {
    readonly budget: WaitBudget;
    readonly code = "WAIT_BUDGET_EXHAUSTED";
    constructor(budget: WaitBudget);
}
declare const boundedWait: <T>(budget: WaitBudget, operation: (remaining: Readonly<{
    readonly steps: number;
}>) => T | Promise<T>) => Promise<T>;

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

declare const e2eDescriptor: (config?: HarnessConfig) => Harness;

declare class SimulationError extends Error {
    readonly code: string;
    readonly details?: unknown | undefined;
    readonly fidelity = "simulation";
    constructor(message: string, code: string, details?: unknown | undefined);
}
type SimulationNativeErrorSpec = Readonly<{
    readonly className: string;
    readonly message: string;
    readonly name?: string;
    readonly code?: string;
    readonly summary?: string;
    readonly details?: unknown;
    readonly docsUrl?: string;
    readonly cause?: unknown;
    /** Extra native own-fields (for example SQLite `errno`). */
    readonly extra?: Readonly<Record<string, unknown>>;
}>;
declare const simulationNativeError: (spec: SimulationNativeErrorSpec) => Error;
/**
 * Simulation double for the production `SmithersError` boundary shape:
 * `message = summary + " See " + docsUrl` with own name/code/summary/docsUrl/
 * details/cause fields, mirroring packages/errors SmithersError.
 */
declare const simulationSmithersError: (code: string, summary: string, options?: Readonly<{
    readonly details?: unknown;
    readonly cause?: unknown;
    readonly docsUrl?: string;
    readonly name?: string;
}>) => Error;
declare const serializeSimulationDurableError: (value: unknown) => unknown;
declare const serializeBoundaryError: (value: unknown) => unknown;

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
declare const runScenario: (ast: ScenarioAst, options?: RunScenarioOptions) => Promise<ScenarioResult>;

declare const dryRun: (ast: ScenarioAst, options?: RunScenarioOptions) => {
    canonicalAst: string;
    replayIdentity: string;
    admissions: readonly Readonly<{
        readonly kind: "supported" | "capability-failure" | "capability-skip";
        readonly harness: string;
        readonly capability: Capability;
        readonly hint?: string;
    }>[];
    diagnostics: readonly Readonly<{
        readonly code: string;
        readonly message: string;
        readonly node: string;
    }>[];
    requiredCapabilities: readonly Capability[];
    replayBundle: Readonly<{
        readonly version: 1;
        readonly ast: ScenarioAst;
        readonly seed: number;
        readonly controlLog: readonly ControlMessage[];
        readonly trace: readonly TraceEvent[];
        readonly ambiguity: readonly unknown[];
        readonly determinism: Readonly<{
            readonly deterministic: boolean;
            readonly residues: readonly string[];
        }>;
        readonly harness: string;
        readonly harnessIdentity: string;
        readonly runnerBindings: Readonly<Record<string, string>>;
        readonly replayIdentity: string;
    }>;
    plannedSteps: string[];
    executesAgents: boolean;
    run: () => Promise<Readonly<{
        readonly status: ScenarioStatus;
        readonly outputs: Readonly<Record<string, unknown>>;
        readonly trace: readonly TraceEvent[];
        readonly replayIdentity: string;
        readonly controlLog: readonly ControlMessage[];
        readonly capabilityReport: readonly unknown[];
        readonly ambiguity: readonly AmbiguityResult[];
        readonly determinismReport: DeterminismReport;
        readonly error?: HarnessError;
    }>>;
};

type JournalState = "none" | "effect-applied" | "journaled" | "acked";
type LeaseState = "unclaimed" | "owned" | "lost";
type WakeupState = "none" | "registered" | "delivered" | "lost";
declare class JournalModel {
    private readonly states;
    private readonly leases;
    private readonly owners;
    private readonly wakeups;
    state(id: string): JournalState;
    effectApplied(id: string): void;
    journal(id: string): boolean;
    ack(id: string): void;
    claimLease(id: string, owner: string): boolean;
    assertLease(id: string, owner: string): void;
    loseLease(id: string): void;
    leaseState(id: string): LeaseState;
    registerWakeup(id: string): void;
    deliverWakeup(id: string): void;
    loseWakeup(id: string): void;
    wakeupState(id: string): WakeupState;
    snapshot(): Readonly<Record<string, unknown>>;
}

type DurabilityPhase = "before-task" | "during-task" | "after-task" | "after-effect-before-journal" | "after-journal-before-ack" | "after-ack";
type DurabilityOperation = "task" | "effect" | "attempt-write" | "event-append" | "completion-cas" | "heartbeat" | "lease" | "resume" | "cancellation";
type DurabilityCutPoint = Readonly<{
    readonly phase: DurabilityPhase;
    readonly operation: DurabilityOperation;
}>;
declare const cutPoint: (phase: DurabilityPhase, operation: DurabilityOperation) => DurabilityCutPoint;

type EffectOutcome = Readonly<{
    readonly kind: "succeed" | "fail" | "duplicate" | "hang";
    readonly value?: unknown;
}>;
type EffectRequest = Readonly<{
    readonly id: string;
    readonly name: string;
    readonly input?: unknown;
}>;
declare class EffectLedger {
    private readonly requests;
    private readonly outcomes;
    private readonly journal;
    request(request: EffectRequest): void;
    resolve(id: string, outcome: EffectOutcome): void;
    get(id: string): EffectOutcome | undefined;
    recordJournal(id: string): void;
    journalCount(id: string): number;
    snapshot(): Readonly<{
        readonly requests: readonly EffectRequest[];
        readonly outcomes: Readonly<Record<string, EffectOutcome>>;
        readonly journal: Readonly<Record<string, number>>;
    }>;
}
declare const mediatedEffect: <T>(ledger: EffectLedger, request: EffectRequest, execute: () => T | Promise<T>) => Promise<T>;

declare const opaqueEffect: (description?: string) => Readonly<{
    readonly kind: "opaque-effect";
    readonly description: string;
}>;
declare const isOpaqueEffect: (value: unknown) => value is {
    readonly kind: "opaque-effect";
    readonly description: string;
};

type BoundaryShape = Readonly<{
    readonly name: string;
    readonly className: string;
    readonly tag?: string;
    readonly code?: string;
    readonly message?: string;
    readonly summary?: string;
    readonly hasCause: boolean;
    readonly cause?: BoundaryShape;
    readonly details?: unknown;
    readonly detailsKeys: readonly string[];
    readonly docsUrl?: string;
    readonly serialized?: unknown;
}>;
declare const boundaryShape: (error: unknown, serialized?: unknown) => BoundaryShape;
declare const compareBoundaryShape: (expected: BoundaryShape, actual: BoundaryShape) => readonly string[];

type ProbeReport = Readonly<{
    readonly name: string;
    readonly passed: boolean;
    readonly expected: BoundaryShape;
    readonly actual: BoundaryShape;
    readonly differences: readonly string[];
}>;
declare const contractProbe: (name: string, production: () => unknown | Promise<unknown>, simulated: () => unknown | Promise<unknown>, options?: Readonly<{
    readonly serializeProduction?: (value: unknown) => unknown;
    readonly serializeSimulation?: (value: unknown) => unknown;
}>) => Promise<ProbeReport>;

type CleanupResource = Readonly<{
    readonly kind: string;
    readonly id: string;
}>;
declare class CleanupScope {
    private readonly entries;
    private readonly live;
    private liveSequence;
    private closed;
    add(resource: CleanupResource, dispose: () => void | Promise<void>): () => void;
    register(kind: string, id: string, dispose: () => void | Promise<void>): () => void;
    pending(): readonly CleanupResource[];
    track(resource: CleanupResource, operation: Promise<unknown>): () => void;
    liveResources(): readonly CleanupResource[];
    close(budget?: number, timeoutMs?: number): Promise<void>;
}

declare const assertNoLeaks: (scope: CleanupScope, extra?: readonly {
    readonly kind: string;
    readonly id: string;
}[]) => void;

declare class ExactlyOnceUnsupportedError extends Error {
    readonly code = "EXACTLY_ONCE_UNSUPPORTED";
    constructor();
}
type ResultLike = Readonly<{
    readonly trace: readonly {
        readonly type: string;
        readonly data?: unknown;
    }[];
    readonly ambiguity: readonly {
        readonly outcome: string;
    }[];
}>;
type Assertion = Readonly<{
    readonly name: string;
    readonly guarantee: string;
    readonly assert: (result: ResultLike) => void;
}>;
declare const expectEffect: (name: string) => {
    name: string;
    exactlyOnce: () => never;
    atLeastOnce: (result?: ResultLike) => Assertion;
    atMostOnceJournaled: (result?: ResultLike) => Assertion;
    idempotencyKey: (key: string, result?: ResultLike) => Assertion & Readonly<{
        readonly key: string;
    }>;
    journalCas: (result?: ResultLike) => Assertion;
};
declare const expectTrace: (predicate: (event: ResultLike["trace"][number]) => boolean, message?: string) => ((result: ResultLike) => void);
declare const expectAmbiguity: (outcome: string) => ((result: ResultLike) => void);

type ReplayBundle = Readonly<{
    readonly version: 1;
    readonly ast: ScenarioAst;
    readonly seed: number;
    readonly controlLog: readonly ControlMessage[];
    readonly trace: readonly TraceEvent[];
    readonly ambiguity: readonly unknown[];
    readonly determinism: Readonly<{
        readonly deterministic: boolean;
        readonly residues: readonly string[];
    }>;
    readonly harness: string;
    readonly harnessIdentity: string;
    readonly runnerBindings: Readonly<Record<string, string>>;
    readonly replayIdentity: string;
}>;
declare const makeReplayBundle: (input: {
    ast: ScenarioAst;
    seed: number;
    controlLog: readonly ControlMessage[];
    trace?: readonly TraceEvent[];
    ambiguity?: readonly unknown[];
    determinism?: Readonly<{
        readonly deterministic: boolean;
        readonly residues: readonly string[];
    }>;
    harness?: string;
    harnessIdentity?: string;
}) => ReplayBundle;
declare const serializeReplayBundle: (bundle: ReplayBundle) => string;
declare const loadReplayBundle: (serialized: string) => ReplayBundle;
declare const replayBundle: (bundle: ReplayBundle, options?: Omit<RunScenarioOptions, "seed" | "controlLog">) => Promise<ScenarioResult>;

type Divergence = Readonly<{
    readonly index: number;
    readonly sequence: number;
    readonly controlIndex?: number;
    readonly field?: string;
    readonly left?: TraceEvent;
    readonly right?: TraceEvent;
    readonly message: string;
}>;
declare const firstDivergence: (left: readonly TraceEvent[], right: readonly TraceEvent[]) => Divergence | null;

type ShrinkOptions = Readonly<Pick<RunScenarioOptions, "harness" | "stepRunners"> & {
    readonly maxCandidates?: number;
    readonly seed?: number;
}>;
declare const shrink: (ast: ScenarioAst, controls: readonly ControlMessage[], failure: (ast: ScenarioAst, controls: readonly ControlMessage[], result?: ScenarioResult) => boolean | Promise<boolean>, options?: ShrinkOptions) => Promise<{
    ast: Readonly<{
        readonly version: 1;
        readonly name: string;
        readonly seed?: number;
        readonly steps: readonly ScenarioStep[];
        readonly barriers: readonly ScenarioBarrier[];
        readonly faults: readonly ScenarioFault[];
        readonly extensions: readonly ScenarioExtension[];
    }>;
    controls: ControlMessage[];
    candidatesTried: number;
}>;

type PlainDbMethod = (...args: readonly never[]) => unknown | PromiseLike<unknown>;
type DbMethod<Args extends readonly unknown[]> = (...args: Args) => unknown | PromiseLike<unknown>;
type AttemptCompletionArgs = [
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
    runtimeOwnerId: string | null,
    finishedAtMs: number
];
type ResumeArgs = [
    params: {
        runId: string;
        expectedStatus?: string;
        expectedRuntimeOwnerId: string | null;
        expectedHeartbeatAtMs: number | null;
        staleBeforeMs: number;
        claimOwnerId: string;
        claimHeartbeatAtMs: number;
        requireStale?: boolean;
    }
];
type RealDbResource = Readonly<{
    readonly db: unknown;
    readonly path?: string;
    readonly productionIdentity?: "SmithersDb";
    readonly close: () => void | Promise<void>;
    readonly insertRun: PlainDbMethod;
    readonly heartbeatRun: DbMethod<[runId: string, runtimeOwnerId: string, heartbeatAtMs: number]>;
    readonly listRuns: PlainDbMethod;
    readonly claimAttemptCompletion?: DbMethod<AttemptCompletionArgs>;
    readonly claimRunForResume?: DbMethod<ResumeArgs>;
    readonly completeRun?: DbMethod<[runId: string, runtimeOwnerId: string, finishedAtMs: number]>;
    readonly requestRunCancel?: DbMethod<[runId: string, cancelRequestedAtMs: number]>;
    readonly claimRunCancellation?: DbMethod<[runId: string, cancelledAtMs: number, errorJson?: string | null]>;
    readonly heartbeatAttempt?: PlainDbMethod;
    readonly operations?: Readonly<Record<string, PlainDbMethod>>;
}>;
type RealDbAdapterOptions = Readonly<{
    readonly open: () => RealDbResource | Promise<RealDbResource>;
    readonly identity?: string;
    readonly serializeError?: HarnessAdapter["serializeError"];
    readonly extensionExecutors?: HarnessAdapter["extensionExecutors"];
}>;
declare const realDbAdapter: (options: RealDbAdapterOptions) => HarnessAdapter;

type Awaitable<T> = T | PromiseLike<T>;
type ClaimAttemptCompletionInput = Readonly<{
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    runtimeOwnerId: string | null;
    finishedAtMs: number;
}>;
type ClaimRunForResumeInput = Readonly<{
    runId: string;
    expectedStatus?: string;
    expectedRuntimeOwnerId: string | null;
    expectedHeartbeatAtMs: number | null;
    staleBeforeMs: number;
    claimOwnerId: string;
    claimHeartbeatAtMs: number;
    requireStale?: boolean;
}>;
type HeartbeatRunInput = Readonly<{
    runId: string;
    runtimeOwnerId: string;
    heartbeatAtMs: number;
}>;
type RealDbOperationMap = Readonly<{
    claimAttemptCompletion: (input: ClaimAttemptCompletionInput) => Awaitable<boolean>;
    claimRunForResume: (input: ClaimRunForResumeInput) => Awaitable<boolean>;
    heartbeatRun: (input: HeartbeatRunInput) => Awaitable<void>;
    completeRun: (input: Readonly<{
        runId: string;
        runtimeOwnerId: string;
        finishedAtMs: number;
    }>) => Awaitable<unknown>;
    requestRunCancel: (input: Readonly<{
        runId: string;
        cancelRequestedAtMs: number;
    }>) => Awaitable<unknown>;
    claimRunCancellation: (input: Readonly<{
        runId: string;
        cancelledAtMs: number;
        errorJson?: string | null;
    }>) => Awaitable<unknown>;
}>;
/**
 * Bind the framework's durability vocabulary to SmithersDb's production CAS
 * methods.  These bindings are deliberately boring: a real-db proof must
 * call the methods on the admitted SmithersDb instance, never a journal echo.
 */
declare const realDbCutPoints: (db: RealDbResource) => RealDbOperationMap;

/** A resource created by the repository's engineChildRunner protocol. */
type RealProcessResource = Readonly<{
    readonly pid: number;
    readonly child: ChildProcess;
    /** The child must echo the adapter-owned nonce; a truthy caller boolean is
     * deliberately not accepted as process identity evidence. */
    readonly handshake: (nonce: string) => string | Promise<string>;
    readonly kill: (signal?: string) => void | Promise<void>;
    readonly close: () => void | Promise<void>;
    /** Production-owned fresh-process continuation used by the restart cut point. */
    readonly resume?: (nonce: string) => RealProcessResource | Promise<RealProcessResource>;
    readonly healthy?: () => boolean | Promise<boolean>;
    /** Production-owned result observed from stdout/durable completion. */
    readonly resultStatus?: () => string | undefined | Promise<string | undefined>;
    /** Reads durable/effect evidence owned by the production fixture. */
    readonly observeDurableState?: () => RealProcessDurableState | Promise<RealProcessDurableState>;
}>;
type RealProcessDurableState = Readonly<{
    readonly effectApplied: boolean;
    readonly journalWritten: boolean;
    readonly outputPersisted: boolean;
}>;
type RealProcessObservation = Readonly<{
    readonly terminatedBy: "SIGKILL";
    readonly preKillEffectApplied: boolean;
    readonly journalWritten: boolean;
    readonly outputPersisted: boolean;
    readonly resumed: boolean;
    readonly resumedStatus?: string;
    readonly resumedEffectApplied?: boolean;
    readonly resumedJournalWritten?: boolean;
    readonly resumedOutputPersisted?: boolean;
}>;
type RealProcessAdapterOptions = Readonly<{
    /** Launch input for the ACTUAL production runWorkflow child. Invoked only by
     * runStep("runWorkflow") — never during admission — so a scenario that
     * schedules no runWorkflow step provably executes no target workflow. */
    readonly spawn: (nonce: string) => RealProcessResource | Promise<RealProcessResource>;
    /** Launch input for the admission identity/liveness probe: a child of the
     * same repository-owned runner that completes the `probe:<nonce>` handshake
     * and exits 0 WITHOUT executing the target workflow. */
    readonly probe: (nonce: string) => RealProcessResource | Promise<RealProcessResource>;
    /** Absolute path to the repository-owned engineChildRunner. Required proof of identity. */
    readonly runnerPath: string;
    readonly identity?: string;
    readonly serializeError?: HarnessAdapter["serializeError"];
    readonly extensionExecutors?: HarnessAdapter["extensionExecutors"];
}>;
declare const realProcessAdapter: (options: RealProcessAdapterOptions) => HarnessAdapter;

export { type AdapterFaultContext, type AmbiguityOutcome, type AmbiguityResult, type BoundaryShape, BoundedWaitError, CanonicalizeError, type Capability, type CapabilityDecision, type ClaimAttemptCompletionInput, type ClaimRunForResumeInput, CleanupScope, type CompileDiagnostic, type CompileResult, ControlBus, type ControlMessage, type DurabilityCutPoint, type DurabilityOperation, type DurabilityPhase, type E2eRealProcessHarnessConfig, EffectLedger, type EffectOutcome, type EffectRequest, ExactlyOnceUnsupportedError, type Harness, type HarnessAdapter, type HarnessConfig, type HarnessError, type HarnessKind, type HeartbeatRunInput, type IntegrationRealDbHarnessConfig, JournalModel, type ProbeReport, type RealDbAdapterOptions, type RealDbOperationMap, type RealDbResource, type RealProcessAdapterOptions, type RealProcessObservation, type RealProcessResource, type ReplayBundle, type RunScenarioOptions, type ScenarioAst, type ScenarioBarrier, type ScenarioExtension, type ScenarioFault, type ScenarioResult, type ScenarioStep, type ScenarioValue, SeededScheduler, SimulationError, type SimulationNativeErrorSpec, type StepRunner, type TaskRuntime, TraceCollector, type TraceEvent, type UnitSimHarnessConfig, VirtualClock, ambiguity, assertNoLeaks, barrier, boundaryShape, boundedWait, canonicalize, compareBoundaryShape, compileScenario, contractProbe, cutPoint, dryRun, e2eDescriptor, e2eHarness, expectAmbiguity, expectEffect, expectTrace, extension, fault, firstDivergence, integrationHarness, isOpaqueEffect, loadReplayBundle, makeHarness, makeReplayBundle, mediatedEffect, opaqueEffect, realDbAdapter, realDbCutPoints, realProcessAdapter, replayBundle, replayIdentity, requiredCapabilities, runScenario, scenario, serializeBoundaryError, serializeReplayBundle, serializeSimulationDurableError, shrink, simulationNativeError, simulationSmithersError, step, unitSimHarness };
