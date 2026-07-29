import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDefinition } from "@smithers-orchestrator/driver/WorkflowDefinition";
import type { TaskDescriptor, WorkflowGraph, XmlNode } from "@smithers-orchestrator/graph";
import type {
  ApprovalResolution,
  EngineDecision,
  RunResult,
  WaitReason,
  WorkflowSessionService,
} from "@smithers-orchestrator/scheduler";
import { Effect } from "effect";
import { auto } from "./fakeAgent.ts";
import { schemaMock } from "./schemaMock.ts";
import { __simulateWithControls } from "./simulate.ts";

export type CoverableWorkflow<Schema = unknown> =
  | WorkflowDefinition<Schema>
  | {
      readonly default: WorkflowDefinition<Schema>;
    };

export type WorkflowCoverageApproval = {
  readonly approved: boolean;
  readonly note?: string;
  readonly decidedBy?: string;
  readonly optionKey?: string;
  readonly output?: unknown;
};

export type WorkflowCoverageApprovalValue = boolean | "approve" | "deny" | WorkflowCoverageApproval;

export type WorkflowCoverageApprovalResolver = (
  context: WorkflowCoverageTaskContext,
) => WorkflowCoverageApprovalValue | Promise<WorkflowCoverageApprovalValue>;

export type WorkflowCoverageEventResolver = (context: WorkflowCoverageEventContext) => unknown | Promise<unknown>;

export type WorkflowCoverageTaskContext = {
  readonly nodeId: string;
  readonly label?: string;
  readonly iteration: number;
  readonly input: unknown;
  readonly passIndex: number;
};

export type WorkflowCoverageEventContext = WorkflowCoverageTaskContext & {
  readonly eventName: string;
  readonly correlationId?: string;
};

export type WorkflowCoverageOptions = {
  readonly input?: unknown;
  readonly inputs?: readonly unknown[];
  readonly mocks?: Readonly<Record<string, unknown>>;
  readonly approvals?:
    | WorkflowCoverageApprovalValue
    | WorkflowCoverageApprovalResolver
    | Readonly<Record<string, WorkflowCoverageApprovalValue | WorkflowCoverageApprovalResolver>>;
  readonly signals?: Readonly<Record<string, unknown | WorkflowCoverageEventResolver>>;
  readonly events?: Readonly<Record<string, unknown | WorkflowCoverageEventResolver>>;
  readonly maxLoopIterations?: number;
  readonly expectedNodes?: readonly string[];
  readonly allowUnreached?: readonly string[];
  readonly executeCompute?: boolean;
  readonly executeSideEffects?: boolean;
  readonly rootDir?: string;
  readonly workflowPath?: string | null;
  readonly assert?: boolean;
};

export type WorkflowCoverageValidation = {
  readonly passIndex: number;
  readonly nodeId: string;
  readonly iteration: number;
  readonly valid: boolean;
  readonly message?: string;
};

export type WorkflowCoverageDecision = {
  readonly passIndex: number;
  readonly nodeId: string;
  readonly iteration: number;
  readonly approved: boolean;
  readonly note?: string;
  readonly decidedBy?: string;
};

export type WorkflowCoverageFailure = {
  readonly passIndex: number;
  readonly nodeId?: string;
  readonly code?: string;
  readonly message: string;
  readonly cause: unknown;
};

export type WorkflowCoveragePass = {
  readonly passIndex: number;
  readonly input: unknown;
  readonly status: string;
  readonly executed: string[];
  readonly outputs: Record<string, unknown[]>;
  readonly taskOutputs: Record<string, unknown[]>;
  readonly finalOutput: unknown;
  readonly definedNodes: string[];
  readonly unexecuted: string[];
  readonly validations: WorkflowCoverageValidation[];
  readonly approvals: WorkflowCoverageDecision[];
  readonly errors: WorkflowCoverageFailure[];
  readonly unusedMocks: string[];
  readonly warnings: string[];
};

export type WorkflowCoverageResult = {
  readonly status: "finished" | "failed";
  readonly passes: WorkflowCoveragePass[];
  readonly executed: string[];
  readonly outputs: Record<string, unknown[]>;
  readonly taskOutputs: Record<string, unknown[]>;
  readonly finalOutputs: unknown[];
  readonly definedNodes: string[];
  readonly coveredNodes: string[];
  readonly unexecuted: string[];
  readonly unreached: string[];
  readonly validations: WorkflowCoverageValidation[];
  readonly approvals: WorkflowCoverageDecision[];
  readonly errors: WorkflowCoverageFailure[];
  readonly allowUnreached: string[];
};

export class WorkflowCoverageError extends Error {
  readonly result: WorkflowCoverageResult;

  constructor(message: string, result: WorkflowCoverageResult) {
    super(message);
    this.name = "WorkflowCoverageError";
    this.result = result;
  }
}

type MutablePassState = {
  defined: Set<string>;
  descriptors: Map<string, TaskDescriptor>;
  executionOrder: string[];
  suppressTaskStart: Set<string>;
  externalTaskOutputs: Record<string, unknown[]>;
  externalTableOutputs: Record<string, unknown[]>;
  validations: WorkflowCoverageValidation[];
  approvals: WorkflowCoverageDecision[];
  taskFailures: WorkflowCoverageFailure[];
  approvalOutputs: Map<string, unknown>;
  timerDeadlines: Map<string, number>;
  latestGraph?: WorkflowGraph;
  nowMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function workflowFromModule<Schema>(candidate: CoverableWorkflow<Schema>): WorkflowDefinition<Schema> {
  const workflow = isRecord(candidate) && "default" in candidate ? candidate.default : candidate;
  if (!workflow || typeof workflow !== "object" || typeof workflow.build !== "function") {
    throw new TypeError("coverWorkflow(): expected a workflow definition or a module with a default workflow export");
  }
  return workflow;
}

function schemaExample(task: TaskDescriptor): unknown {
  if (!task.outputSchema) return null;
  return schemaMock(task.outputSchema);
}

function stateKey(task: Pick<TaskDescriptor, "nodeId" | "iteration">): string {
  return `${task.nodeId}::${task.iteration}`;
}

function cloneWithLoopCap(node: XmlNode | null, maxLoopIterations: number): XmlNode | null {
  if (!node || node.kind === "text") return node;
  const children = node.children.map((child) => cloneWithLoopCap(child, maxLoopIterations) as XmlNode);
  if (node.tag !== "smithers:ralph") return { ...node, children };
  const { continueAsNewEvery: _continueAsNewEvery, ...props } = node.props;
  // A cap only ever LOWERS the bound. A loop the workflow declared as
  // maxIterations={2} must still run at most twice under coverage, or the
  // harness reports iteration counts the real run can never produce.
  const declared = Number(props.maxIterations);
  const bound = Number.isInteger(declared) && declared > 0 ? Math.min(declared, maxLoopIterations) : maxLoopIterations;
  return {
    ...node,
    props: {
      ...props,
      maxIterations: String(bound),
      onMaxReached: "return-last",
    },
    children,
  };
}

function capLoops(graph: WorkflowGraph, maxLoopIterations: number): WorkflowGraph {
  return {
    ...graph,
    xml: cloneWithLoopCap(graph.xml, maxLoopIterations),
  };
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function isAllowed(nodeId: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => globMatches(entry, nodeId));
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function failure(passIndex: number, cause: unknown, nodeId?: string): WorkflowCoverageFailure {
  return {
    passIndex,
    ...(nodeId ? { nodeId } : {}),
    ...(errorCode(cause) ? { code: errorCode(cause) } : {}),
    message: errorMessage(cause),
    cause,
  };
}

function invalidOutputError(task: TaskDescriptor, message: string): Error {
  return Object.assign(new Error(`coverWorkflow(): task "${task.nodeId}" output failed validation: ${message}`), {
    name: "SimulationError",
    code: "INVALID_OUTPUT",
    details: { failureRetryable: false },
  });
}

function validateExternalOutput(
  task: TaskDescriptor,
  value: unknown,
  passIndex: number,
  validations: WorkflowCoverageValidation[],
): unknown {
  if (!task.outputSchema) return value;
  const parsed = task.outputSchema.safeParse(value);
  if (parsed.success) {
    validations.push({
      passIndex,
      nodeId: task.nodeId,
      iteration: task.iteration,
      valid: true,
    });
    return parsed.data;
  }
  const message = parsed.error.issues.map((issue) => issue.message).join("; ");
  validations.push({
    passIndex,
    nodeId: task.nodeId,
    iteration: task.iteration,
    valid: false,
    message,
  });
  throw invalidOutputError(task, message);
}

function normalizeApproval(value: WorkflowCoverageApprovalValue): WorkflowCoverageApproval {
  if (value === true || value === "approve") return { approved: true };
  if (value === false || value === "deny") return { approved: false };
  return value;
}

function looksLikeApprovalValue(value: unknown): value is WorkflowCoverageApproval {
  return isRecord(value) && typeof value.approved === "boolean";
}

function taskContext(task: TaskDescriptor, input: unknown, passIndex: number): WorkflowCoverageTaskContext {
  return {
    nodeId: task.nodeId,
    ...(task.label ? { label: task.label } : {}),
    iteration: task.iteration,
    input,
    passIndex,
  };
}

function lookupByTask<T>(values: Readonly<Record<string, T>>, task: TaskDescriptor, extraKey?: string): T | undefined {
  if (Object.prototype.hasOwnProperty.call(values, task.nodeId)) return values[task.nodeId];
  if (task.label && Object.prototype.hasOwnProperty.call(values, task.label)) return values[task.label];
  if (extraKey && Object.prototype.hasOwnProperty.call(values, extraKey)) return values[extraKey];
  return values["*"];
}

async function approvalFor(
  options: WorkflowCoverageOptions,
  task: TaskDescriptor,
  input: unknown,
  passIndex: number,
): Promise<WorkflowCoverageApproval> {
  const configured = options.approvals;
  let value: WorkflowCoverageApprovalValue | WorkflowCoverageApprovalResolver | undefined;
  if (
    configured === undefined ||
    typeof configured === "boolean" ||
    typeof configured === "string" ||
    typeof configured === "function" ||
    looksLikeApprovalValue(configured)
  ) {
    value = configured;
  } else {
    value = lookupByTask(configured, task);
  }
  const resolved = typeof value === "function" ? await value(taskContext(task, input, passIndex)) : value;
  return normalizeApproval(resolved ?? true);
}

function approvalTaskOutput(task: TaskDescriptor, decision: WorkflowCoverageApproval): unknown {
  if (decision.output !== undefined) return decision.output;
  const generated = schemaExample(task);
  if (!isRecord(generated)) return generated;
  const output = { ...generated };
  if ("approved" in output) output.approved = decision.approved;
  if (decision.note !== undefined && "note" in output) output.note = decision.note;
  if (decision.decidedBy !== undefined) {
    if ("decidedBy" in output) output.decidedBy = decision.decidedBy;
    if ("reviewer" in output) output.reviewer = decision.decidedBy;
  }
  if (task.approvalMode === "select" && "selected" in output) {
    output.selected = decision.optionKey ?? task.approvalOptions?.[0]?.key ?? "";
  }
  if (task.approvalMode === "rank" && "ranked" in output) {
    output.ranked = task.approvalOptions?.map((option) => option.key) ?? [];
  }
  return output;
}

async function eventPayloadFor(
  options: WorkflowCoverageOptions,
  task: TaskDescriptor,
  eventName: string,
  input: unknown,
  passIndex: number,
): Promise<unknown> {
  const eventValue = options.events ? lookupByTask(options.events, task, eventName) : undefined;
  const signalValue = options.signals ? lookupByTask(options.signals, task, eventName) : undefined;
  const configured = eventValue ?? signalValue;
  if (typeof configured !== "function") return configured === undefined ? schemaExample(task) : configured;
  const correlationId = typeof task.meta?.__correlationId === "string" ? task.meta.__correlationId : undefined;
  return configured({
    ...taskContext(task, input, passIndex),
    eventName,
    ...(correlationId ? { correlationId } : {}),
  });
}

function isIsolatedSideEffect(task: TaskDescriptor): boolean {
  return Boolean(task.sideEffect || task.meta?.__sandbox || task.meta?.__subflow);
}

async function runEffect<A>(effect: unknown): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, unknown, never>);
}

async function decideAgain(session: WorkflowSessionService): Promise<EngineDecision> {
  const graph = await runEffect<WorkflowGraph | null>(session.getCurrentGraph());
  if (!graph) throw new Error("coverWorkflow(): workflow session has no current graph");
  return runEffect<EngineDecision>(session.submitGraph(graph));
}

function waitingTask(
  state: MutablePassState,
  states: ReadonlyMap<string, string>,
  expectedState: string,
  predicate?: (task: TaskDescriptor) => boolean,
): TaskDescriptor | undefined {
  return [...state.descriptors.values()]
    .reverse()
    .find((task) => states.get(stateKey(task)) === expectedState && (!predicate || predicate(task)));
}

function timerDeadline(state: MutablePassState, task: TaskDescriptor): number | undefined {
  const key = stateKey(task);
  const existing = state.timerDeadlines.get(key);
  if (existing !== undefined) return existing;

  const until = task.meta?.__timerUntil;
  let deadline: number | undefined;
  if (typeof until === "string" && until.length > 0) {
    const parsed = Date.parse(until);
    if (Number.isFinite(parsed)) deadline = Math.floor(parsed);
  } else {
    const duration = task.meta?.__timerDuration;
    if (typeof duration === "string") {
      const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(duration.trim().toLowerCase());
      const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
      const multiplier = match ? multipliers[(match[2] ?? "ms") as keyof typeof multipliers] : undefined;
      const amount = match ? Number(match[1]) : Number.NaN;
      if (multiplier !== undefined && Number.isFinite(amount)) {
        deadline = state.nowMs + Math.floor(amount * multiplier);
      }
    }
  }
  if (deadline !== undefined) state.timerDeadlines.set(key, deadline);
  return deadline;
}

function appendOutput(record: Record<string, unknown[]>, key: string, value: unknown): void {
  (record[key] ??= []).push(value);
}

function mergeOutputs(target: Record<string, unknown[]>, source: Record<string, unknown[]>): void {
  for (const [key, values] of Object.entries(source)) {
    (target[key] ??= []).push(...values);
  }
}

async function runCoveragePass<Schema>(
  workflow: WorkflowDefinition<Schema>,
  options: WorkflowCoverageOptions,
  input: unknown,
  passIndex: number,
  rootDir: string,
  maxLoopIterations: number,
): Promise<WorkflowCoveragePass> {
  const state: MutablePassState = {
    defined: new Set(),
    descriptors: new Map(),
    executionOrder: [],
    suppressTaskStart: new Set(),
    externalTaskOutputs: {},
    externalTableOutputs: {},
    validations: [],
    approvals: [],
    taskFailures: [],
    approvalOutputs: new Map(),
    timerDeadlines: new Map(),
    nowMs: Date.now(),
  };
  const callerMocks = options.mocks ?? {};
  const injectedCatchAll = !Object.prototype.hasOwnProperty.call(callerMocks, "*");
  const mocks = { "*": auto, ...callerMocks };
  const sim = __simulateWithControls(
    workflow,
    {
      input,
      mocks,
      rootDir,
      workflowPath: options.workflowPath,
    },
    {
      nowMs: () => state.nowMs,
      transformGraph: (graph) => capLoops(graph, maxLoopIterations),
      onGraph: (graph) => {
        state.latestGraph = graph;
        for (const task of graph.tasks) {
          state.defined.add(task.nodeId);
          state.descriptors.set(stateKey(task), task);
        }
      },
      onTaskStarted: (task) => {
        const key = stateKey(task);
        if (state.suppressTaskStart.delete(key)) return;
        state.executionOrder.push(task.nodeId);
      },
      onTaskValidated: (task) => {
        if (!task.outputSchema) return;
        state.validations.push({
          passIndex,
          nodeId: task.nodeId,
          iteration: task.iteration,
          valid: true,
        });
      },
      onTaskError: (task, error) => {
        state.taskFailures.push(failure(passIndex, error, task.nodeId));
        if (task.outputSchema && (errorCode(error) === "INVALID_OUTPUT" || /validation/i.test(errorMessage(error)))) {
          state.validations.push({
            passIndex,
            nodeId: task.nodeId,
            iteration: task.iteration,
            valid: false,
            message: errorMessage(error),
          });
        }
      },
      executeUnmocked: async (task) => {
        if (task.kind === "human") {
          return {
            handled: true,
            value: state.approvalOutputs.get(stateKey(task)) ?? schemaExample(task),
          };
        }
        if (task.needsApproval && (task.meta?.requestTitle || task.approvalMode !== "gate")) {
          return {
            handled: true,
            value: state.approvalOutputs.get(stateKey(task)) ?? schemaExample(task),
          };
        }
        if (isIsolatedSideEffect(task)) {
          return options.executeSideEffects ? { handled: false } : { handled: true, value: schemaExample(task) };
        }
        if (!options.executeCompute && task.computeFn) {
          return { handled: true, value: schemaExample(task) };
        }
        return { handled: false };
      },
      resolveWait: async (reason: WaitReason, session: WorkflowSessionService): Promise<EngineDecision | RunResult> => {
        if (reason._tag === "Approval") {
          const states = await runEffect<Map<string, string>>(session.getTaskStates());
          const task =
            waitingTask(state, states, "waiting-approval", (candidate) => candidate.nodeId === reason.nodeId) ??
            [...state.descriptors.values()].reverse().find((candidate) => candidate.nodeId === reason.nodeId);
          if (!task) throw new Error(`coverWorkflow(): approval task "${reason.nodeId}" was not rendered`);
          const decision = await approvalFor(options, task, input, passIndex);
          const output = approvalTaskOutput(task, decision);
          state.approvalOutputs.set(stateKey(task), output);
          state.approvals.push({
            passIndex,
            nodeId: task.nodeId,
            iteration: task.iteration,
            approved: decision.approved,
            ...(decision.note ? { note: decision.note } : {}),
            ...(decision.decidedBy ? { decidedBy: decision.decidedBy } : {}),
          });
          state.executionOrder.push(task.nodeId);
          state.suppressTaskStart.add(stateKey(task));
          return runEffect(
            session.approvalResolved(task.nodeId, {
              approved: decision.approved,
              ...(decision.note !== undefined ? { note: decision.note } : {}),
              ...(decision.decidedBy !== undefined ? { decidedBy: decision.decidedBy } : {}),
              ...(decision.optionKey !== undefined ? { optionKey: decision.optionKey } : {}),
              ...(decision.output !== undefined ? { payload: decision.output } : {}),
            } satisfies ApprovalResolution),
          );
        }
        if (reason._tag === "Event") {
          const states = await runEffect<Map<string, string>>(session.getTaskStates());
          const task = waitingTask(
            state,
            states,
            "waiting-event",
            (candidate) => candidate.meta?.__eventName === reason.eventName,
          );
          if (!task) throw new Error(`coverWorkflow(): waiting event "${reason.eventName}" has no rendered task`);
          const rawPayload = await eventPayloadFor(options, task, reason.eventName, input, passIndex);
          const payload = validateExternalOutput(task, rawPayload, passIndex, state.validations);
          state.executionOrder.push(task.nodeId);
          appendOutput(state.externalTaskOutputs, task.nodeId, payload);
          if (task.outputTableName) appendOutput(state.externalTableOutputs, task.outputTableName, payload);
          const correlationId = typeof task.meta?.__correlationId === "string" ? task.meta.__correlationId : null;
          return runEffect(session.eventReceived(reason.eventName, payload, correlationId));
        }
        if (reason._tag === "Timer") {
          const states = await runEffect<Map<string, string>>(session.getTaskStates());
          const waiting = [...state.descriptors.values()]
            .reverse()
            .filter((candidate) => states.get(stateKey(candidate)) === "waiting-timer");
          const deadlines = waiting.map((candidate) => ({ candidate, deadline: timerDeadline(state, candidate) }));
          const task =
            deadlines.find(({ deadline }) => deadline === reason.resumeAtMs)?.candidate ??
            deadlines
              .filter((entry): entry is { candidate: TaskDescriptor; deadline: number } => entry.deadline !== undefined)
              .sort((left, right) => left.deadline - right.deadline)[0]?.candidate ??
            (waiting.length === 1 ? waiting[0] : undefined);
          if (!task) throw new Error("coverWorkflow(): waiting timer has no rendered task");
          state.nowMs = Math.max(state.nowMs, reason.resumeAtMs);
          state.executionOrder.push(task.nodeId);
          appendOutput(state.externalTaskOutputs, task.nodeId, { firedAtMs: state.nowMs });
          return runEffect(session.timerFired(task.nodeId, state.nowMs));
        }
        if (reason._tag === "RetryBackoff") {
          state.nowMs += Math.max(0, reason.waitMs);
          return decideAgain(session);
        }
        if (reason._tag === "HotReload" && state.latestGraph) {
          return runEffect(session.hotReloaded(state.latestGraph));
        }
        if (reason._tag === "OrphanRecovery") {
          return runEffect(session.recoverOrphanedTasks());
        }
        return {
          runId: "coverage",
          status: reason._tag === "Quota" ? "waiting-quota" : "waiting-event",
          error: new Error(`coverWorkflow(): cannot auto-resolve ${reason._tag} wait`),
        };
      },
    },
  );

  let runError: unknown;
  try {
    await sim.run();
  } catch (error) {
    runError = error;
  }
  const taskOutputs: Record<string, unknown[]> = {};
  for (const nodeId of new Set(sim.executed)) {
    taskOutputs[nodeId] = sim.task(nodeId).outputs;
  }
  mergeOutputs(taskOutputs, state.externalTaskOutputs);
  const outputs: Record<string, unknown[]> = {};
  mergeOutputs(outputs, sim.outputs);
  mergeOutputs(outputs, state.externalTableOutputs);
  const finalTaskFailures = state.taskFailures.filter(
    (item) => item.nodeId !== undefined && sim.task(item.nodeId).status === "failed",
  );
  const errors =
    finalTaskFailures.length > 0 ? finalTaskFailures : runError !== undefined ? [failure(passIndex, runError)] : [];
  const executedSet = new Set(state.executionOrder);
  const definedNodes = [...state.defined];
  return {
    passIndex,
    input,
    status: sim.status,
    executed: state.executionOrder,
    outputs,
    taskOutputs,
    finalOutput: sim.output,
    definedNodes,
    unexecuted: definedNodes.filter((nodeId) => !executedSet.has(nodeId)),
    validations: state.validations,
    approvals: state.approvals,
    errors,
    // `unusedMocks` reports the CALLER's dead mocks. coverWorkflow injects its
    // own "*": auto catch-all, and a fully mocked run never consumes it, so
    // reporting it would make the list permanently non-empty and useless.
    unusedMocks: injectedCatchAll ? sim.unusedMocks.filter((key) => key !== "*") : sim.unusedMocks,
    warnings: sim.warnings,
  };
}

function normalizeInputs(options: WorkflowCoverageOptions): readonly unknown[] {
  if (options.input !== undefined && options.inputs !== undefined) {
    throw new TypeError("coverWorkflow(): use either input or inputs, not both");
  }
  if (options.inputs !== undefined) {
    if (options.inputs.length === 0) throw new TypeError("coverWorkflow(): inputs must contain at least one value");
    return options.inputs;
  }
  return [options.input ?? {}];
}

function normalizeLoopCap(value: number | undefined): number {
  const cap = value ?? 3;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new TypeError("coverWorkflow(): maxLoopIterations must be a positive integer");
  }
  return cap;
}

export async function coverWorkflow<Schema = unknown>(
  workflowModule: CoverableWorkflow<Schema>,
  options: WorkflowCoverageOptions = {},
): Promise<WorkflowCoverageResult> {
  const workflow = workflowFromModule(workflowModule);
  const inputs = normalizeInputs(options);
  const maxLoopIterations = normalizeLoopCap(options.maxLoopIterations);
  const temporaryRoot = options.rootDir ? undefined : await mkdtemp(join(tmpdir(), "smithers-coverage-"));
  const rootDir = options.rootDir ?? temporaryRoot!;
  const passes: WorkflowCoveragePass[] = [];
  try {
    for (let passIndex = 0; passIndex < inputs.length; passIndex += 1) {
      passes.push(await runCoveragePass(workflow, options, inputs[passIndex], passIndex, rootDir, maxLoopIterations));
    }
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }

  const outputs: Record<string, unknown[]> = {};
  const taskOutputs: Record<string, unknown[]> = {};
  for (const pass of passes) {
    mergeOutputs(outputs, pass.outputs);
    mergeOutputs(taskOutputs, pass.taskOutputs);
  }
  const executed = passes.flatMap((pass) => pass.executed);
  const definedNodes = [...new Set(passes.flatMap((pass) => pass.definedNodes))];
  const coveredNodes = [...new Set(executed)];
  const coveredSet = new Set(coveredNodes);
  const definedSet = new Set(definedNodes);
  const allowUnreached = [...(options.allowUnreached ?? [])];
  const expectedNodes = [...new Set([...(options.expectedNodes ?? []), ...allowUnreached])];
  const result: WorkflowCoverageResult = {
    status: passes.every((pass) => pass.status === "finished") ? "finished" : "failed",
    passes,
    executed,
    outputs,
    taskOutputs,
    finalOutputs: passes.map((pass) => pass.finalOutput),
    definedNodes,
    coveredNodes,
    unexecuted: definedNodes.filter((nodeId) => !coveredSet.has(nodeId)),
    unreached: expectedNodes.filter((nodeId) => !definedSet.has(nodeId)),
    validations: passes.flatMap((pass) => pass.validations),
    approvals: passes.flatMap((pass) => pass.approvals),
    errors: passes.flatMap((pass) => pass.errors),
    allowUnreached,
  };
  if (options.assert !== false) expectFullCoverage(result);
  return result;
}

export function expectFullCoverage(result: WorkflowCoverageResult): WorkflowCoverageResult {
  const failures: string[] = [];
  const unfinished = result.passes.filter((pass) => pass.status !== "finished");
  if (unfinished.length > 0) {
    failures.push(
      `unfinished passes: ${unfinished.map((pass) => `${pass.passIndex} (${JSON.stringify(pass.status)})`).join(", ")}`,
    );
  }
  const unexpectedUnexecuted = result.unexecuted.filter((nodeId) => !isAllowed(nodeId, result.allowUnreached));
  if (unexpectedUnexecuted.length > 0) {
    failures.push(`unexecuted nodes: ${JSON.stringify(unexpectedUnexecuted)}`);
  }
  const unexpectedUnreached = result.unreached.filter((nodeId) => !isAllowed(nodeId, result.allowUnreached));
  if (unexpectedUnreached.length > 0) {
    failures.push(`unreached expected nodes: ${JSON.stringify(unexpectedUnreached)}`);
  }
  const invalid = result.validations.filter((validation) => !validation.valid);
  if (invalid.length > 0) {
    failures.push(
      `invalid structured outputs: ${invalid.map((item) => `${item.nodeId} (${item.message ?? "invalid"})`).join(", ")}`,
    );
  }
  if (result.errors.length > 0) {
    failures.push(
      `errors: ${result.errors.map((item) => `${item.nodeId ? `${item.nodeId}: ` : ""}${item.message}`).join("; ")}`,
    );
  }
  if (failures.length > 0) {
    throw new WorkflowCoverageError(`Workflow coverage failed:\n- ${failures.join("\n- ")}`, result);
  }
  return result;
}
