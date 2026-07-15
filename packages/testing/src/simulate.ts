import { zodSchemaToJsonExample } from "@smithers-orchestrator/components/zod-to-example";
import { WorkflowDriver } from "@smithers-orchestrator/driver";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler";
import { makeWorkflowSession } from "@smithers-orchestrator/scheduler";
import { Effect } from "effect";
import type { WorkflowDefinition } from "@smithers-orchestrator/driver/WorkflowDefinition";
import type { ExtractOptions, TaskDescriptor, WorkflowGraph } from "@smithers-orchestrator/graph";
import type { FakeAgent } from "./fakeAgent.ts";
import { isAuto } from "./fakeAgent.ts";

type ComputeFnOptions = { rootDir?: string; workflowPath?: string | null };
type EngineOutputHelpers = {
  resolveTaskOutputs: (tasks: readonly TaskDescriptor[], workflow: unknown) => void;
};
type TaskComputeFnHelpers = {
  attachSubflowComputeFns: (
    tasks: readonly TaskDescriptor[],
    workflow: unknown,
    opts: ComputeFnOptions,
  ) => void;
  attachSandboxComputeFns: (
    tasks: readonly TaskDescriptor[],
    workflow: unknown,
    opts: ComputeFnOptions,
  ) => void;
};

export type SimulateMockFunction = (args: {
  nodeId: string;
  iteration: number;
  attempt: number;
  prompt?: string;
  rootDir?: string;
  outputSchema?: TaskDescriptor["outputSchema"];
}) => unknown | Promise<unknown>;

export type SimulateOptions = {
  input?: unknown;
  mocks?: Record<string, unknown>;
  rootDir?: string;
  workflowPath?: string | null;
};

export type SimTaskRecord = {
  status: "finished" | "failed" | "pending";
  outputs: unknown[];
  prompts: unknown[];
};

export type Sim<Schema = unknown> = {
  run(): Promise<Sim<Schema>>;
  status: string;
  output: unknown;
  outputs: Record<string, unknown[]>;
  executed: string[];
  task(id: string): SimTaskRecord;
  unusedMocks: string[];
  warnings: string[];
  error?: unknown;
};

type MutableTaskRecord = {
  status: "finished" | "failed" | "pending";
  outputs: unknown[];
  prompts: unknown[];
};

type MockResolution =
  | { matched: true; key: string; value: unknown }
  | { matched: false };

type RenderOptions = ExtractOptions & {
  trigger?: unknown;
};
type SimTaskExecutorContext = {
  runId: string;
  options: {
    rootDir?: string;
    input?: unknown;
  };
  signal?: AbortSignal;
};

function createRunId(): string {
  return `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFakeAgent(value: unknown): value is FakeAgent<unknown> {
  return isObject(value) && typeof value.generate === "function";
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globMatches(pattern: string, value: string): boolean {
  const source = `^${escapeRegExp(pattern).replace(/\*/g, ".*")}$`;
  return new RegExp(source).test(value);
}

function formatAgentTaskIds(agentTaskIds: readonly string[]): string {
  return JSON.stringify([...new Set(agentTaskIds)].sort());
}

function formatIssues(issues: readonly unknown[]): string {
  if (issues.length === 0) return "unknown validation failure";
  return issues
    .map((issue) => {
      if (!isObject(issue)) return JSON.stringify(issue);
      const path = Array.isArray(issue.path) && issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: `
        : "";
      const message = "message" in issue ? String(issue.message) : JSON.stringify(issue);
      return `${path}${message}`;
    })
    .join("; ");
}

function simulatorError(
  message: string,
  code: "AGENT_CONFIG_INVALID" | "INVALID_OUTPUT" | "SIMULATION_ERROR" = "SIMULATION_ERROR",
): Error {
  const error = new Error(message) as Error & {
    code?: string;
    details?: Record<string, unknown>;
  };
  error.name = "SimulationError";
  error.code = code;
  error.details = { failureRetryable: false };
  return error;
}

function schemaExample(task: TaskDescriptor): unknown {
  if (!task.outputSchema) {
    throw simulatorError(
      `simulate(): auto mock for task "${task.nodeId}" requires an outputSchema.`,
      "AGENT_CONFIG_INVALID",
    );
  }
  return JSON.parse(zodSchemaToJsonExample(task.outputSchema));
}

function validateTaskOutput(task: TaskDescriptor, value: unknown): unknown {
  if (!task.outputSchema) return value;
  const parsed = task.outputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw simulatorError(
    `simulate(): task "${task.nodeId}" output failed validation: ${formatIssues(parsed.error.issues)}`,
    "INVALID_OUTPUT",
  );
}

function isAgentTask(task: TaskDescriptor): boolean {
  return task.kind === "agent" ||
    (task.agent != null && task.computeFn == null && task.staticPayload === undefined);
}

function getTaskRecord(
  records: Map<string, MutableTaskRecord>,
  nodeId: string,
): MutableTaskRecord {
  let record = records.get(nodeId);
  if (!record) {
    record = { status: "pending", outputs: [], prompts: [] };
    records.set(nodeId, record);
  }
  return record;
}

function copyTaskRecord(record: MutableTaskRecord | undefined): SimTaskRecord {
  return {
    status: record?.status ?? "pending",
    outputs: [...(record?.outputs ?? [])],
    prompts: [...(record?.prompts ?? [])],
  };
}

function resolveMock(
  mocks: Record<string, unknown>,
  task: TaskDescriptor,
  agentTask: boolean,
): MockResolution {
  if (Object.prototype.hasOwnProperty.call(mocks, task.nodeId)) {
    return { matched: true, key: task.nodeId, value: mocks[task.nodeId] };
  }
  for (const key of Object.keys(mocks)) {
    if (key === "*" || !key.includes("*")) continue;
    if (globMatches(key, task.nodeId)) {
      return { matched: true, key, value: mocks[key] };
    }
  }
  if (agentTask && Object.prototype.hasOwnProperty.call(mocks, "*")) {
    return { matched: true, key: "*", value: mocks["*"] };
  }
  return { matched: false };
}

function updateUnusedMocks(
  handle: Pick<Sim, "unusedMocks">,
  mocks: Record<string, unknown>,
  consumedMocks: ReadonlySet<string>,
): void {
  handle.unusedMocks = Object.keys(mocks).filter((key) => !consumedMocks.has(key));
}

async function materializeMock(
  mock: unknown,
  task: TaskDescriptor,
  context: SimTaskExecutorContext,
  rootDir: string | undefined,
  runId: string,
): Promise<unknown> {
  if (isAuto(mock)) {
    return schemaExample(task);
  }
  if (isFakeAgent(mock)) {
    const result = await mock.generate({
      prompt: task.prompt,
      outputSchema: task.outputSchema,
      rootDir: context.options.rootDir ?? rootDir,
      taskContext: {
        runId,
        nodeId: task.nodeId,
        iteration: task.iteration,
        attempt: 1,
      },
    });
    return result.output;
  }
  if (typeof mock === "function") {
    const result = await (mock as SimulateMockFunction)({
      nodeId: task.nodeId,
      iteration: task.iteration,
      attempt: 1,
      prompt: task.prompt,
      rootDir: context.options.rootDir ?? rootDir,
      outputSchema: task.outputSchema,
    });
    if (isObject(result) && "output" in result) {
      return result.output;
    }
    return result;
  }
  return mock;
}

export function simulate<Schema = unknown>(
  workflow: WorkflowDefinition<Schema>,
  options: SimulateOptions = {},
): Sim<Schema> {
  const runId = createRunId();
  const mocks = options.mocks ?? {};
  const consumedMocks = new Set<string>();
  const taskRecords = new Map<string, MutableTaskRecord>();
  const latestTasks = new Map<string, TaskDescriptor>();
  let latestAgentTaskIds: string[] = [];
  let runPromise: Promise<Sim<Schema>> | undefined;
  let lastExecutionError: unknown;

  const handle: Sim<Schema> = {
    status: "pending",
    output: undefined,
    outputs: {},
    executed: [],
    unusedMocks: Object.keys(mocks),
    warnings: [],
    run() {
      runPromise ??= runSimulation();
      return runPromise;
    },
    task(id: string) {
      if (!taskRecords.has(id) && latestTasks.has(id)) {
        taskRecords.set(id, { status: "pending", outputs: [], prompts: [] });
      }
      return copyTaskRecord(taskRecords.get(id));
    },
  };

  const smithersRenderer = new SmithersRenderer();
  const renderer = {
    async render(element: Parameters<SmithersRenderer["render"]>[0], extractOptions?: RenderOptions): Promise<WorkflowGraph> {
      const graph = await smithersRenderer.render(element, extractOptions);
      const rootDir = extractOptions?.baseRootDir ?? options.rootDir;
      const workflowPath = extractOptions?.workflowPath ?? options.workflowPath ?? null;
      const engineHelpers = (await import(
        "@smithers-orchestrator/engine/engine"
      )) as unknown as EngineOutputHelpers;
      const computeHelpers = (await import(
        "@smithers-orchestrator/engine/task-compute-fns"
      )) as unknown as TaskComputeFnHelpers;
      engineHelpers.resolveTaskOutputs(graph.tasks, workflow);
      computeHelpers.attachSubflowComputeFns(graph.tasks, workflow, {
        rootDir,
        workflowPath,
      });
      computeHelpers.attachSandboxComputeFns(graph.tasks, workflow, {
        rootDir,
        workflowPath,
      });
      latestTasks.clear();
      for (const task of graph.tasks) {
        latestTasks.set(task.nodeId, task);
      }
      latestAgentTaskIds = graph.tasks.filter(isAgentTask).map((task) => task.nodeId);
      return graph;
    },
  };

  const executeTask = async (task: TaskDescriptor, context: SimTaskExecutorContext): Promise<unknown> => {
    const record = getTaskRecord(taskRecords, task.nodeId);
    handle.executed.push(task.nodeId);
    record.prompts.push(task.prompt);
    const agentTask = isAgentTask(task);
    try {
      const mock = resolveMock(mocks, task, agentTask);
      let value: unknown;
      if (mock.matched) {
        consumedMocks.add(mock.key);
        updateUnusedMocks(handle, mocks, consumedMocks);
        value = await materializeMock(mock.value, task, context, options.rootDir, runId);
      } else if (agentTask) {
        throw simulatorError(
          `simulate(): agent task "${task.nodeId}" has no mock. Provide mocks[${JSON.stringify(task.nodeId)}], a glob, "*": auto, or a per-node value. Agent tasks in this run: ${formatAgentTaskIds(latestAgentTaskIds)}`,
          "AGENT_CONFIG_INVALID",
        );
      } else if (task.computeFn) {
        value = await task.computeFn();
      } else {
        value = task.staticPayload ?? null;
      }
      const parsed = validateTaskOutput(task, value);
      const channel = task.outputTableName;
      (handle.outputs[channel] ??= []).push(parsed);
      record.outputs.push(parsed);
      record.status = "finished";
      handle.output = parsed;
      return parsed;
    } catch (error) {
      record.status = "failed";
      lastExecutionError = error;
      throw error;
    }
  };

  async function runSimulation(): Promise<Sim<Schema>> {
    handle.status = "running";
    try {
      const driver = new WorkflowDriver({
        workflow,
        runtime: {
          runPromise: <A>(effect: unknown) =>
            Effect.runPromise(effect as Effect.Effect<A, unknown, never>),
        },
        renderer,
        createSession: (sessionOptions) =>
          makeWorkflowSession({
            runId: sessionOptions.runId,
            requireStableFinish: true,
            requireRerenderOnOutputChange:
              sessionOptions.options?.requireRerenderOnOutputChange !== false,
          }),
        executeTask,
      });
      const result = await driver.run({
        runId,
        input: (options.input ?? {}) as Record<string, unknown>,
        initialOutputs: {},
        rootDir: options.rootDir,
        workflowPath: options.workflowPath ?? undefined,
      });
      handle.status = result.status;
      if (result.output !== undefined) {
        handle.output = result.output;
      }
      if (result.failedChildren && result.failedChildren > 0) {
        handle.warnings.push(
          `simulate(): run finished with ${result.failedChildren} failed child task(s).`,
        );
      }
      if (result.status === "failed") {
        handle.error = lastExecutionError ?? result.error;
        throw handle.error instanceof Error
          ? handle.error
          : simulatorError(String(handle.error ?? "simulate(): run failed"));
      }
      return handle;
    } catch (error) {
      handle.status = "failed";
      handle.error = error;
      throw error;
    } finally {
      updateUnusedMocks(handle, mocks, consumedMocks);
    }
  }

  return handle;
}
