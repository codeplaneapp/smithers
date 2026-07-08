// src/fakeAgent.ts
import { mkdir, writeFile } from "fs/promises";
import { dirname, isAbsolute, relative, resolve } from "path";
import { zodSchemaToJsonExample } from "@smithers-orchestrator/components/zod-to-example";
var autoMarker = /* @__PURE__ */ Symbol.for("smithers.testing.auto");
var auto = Object.freeze({
  [autoMarker]: true
});
function isAuto(value) {
  return Boolean(value && typeof value === "object" && value[autoMarker] === true);
}
function schemaExample(schema) {
  const raw = zodSchemaToJsonExample(schema);
  const parsed = JSON.parse(raw);
  return assertSchema(schema, parsed);
}
function formatIssues(issues) {
  if (issues.length === 0) return "unknown validation failure";
  return issues.map((issue) => {
    if (issue && typeof issue === "object" && "message" in issue) {
      return String(issue.message);
    }
    return JSON.stringify(issue);
  }).join("; ");
}
function assertSchema(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new TypeError(`Fake agent output failed validation: ${formatIssues(result.error.issues)}`);
}
function hasResponseKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "output" in value || "text" in value || "files" in value;
}
function normalizeResult(schema, result) {
  if (isAuto(result)) {
    return { output: schemaExample(schema) };
  }
  if (hasResponseKeys(result) && "output" in result) {
    const parsedOutput = schema.safeParse(result.output);
    if (parsedOutput.success) {
      const response = { output: parsedOutput.data };
      if (typeof result.text === "string") response.text = result.text;
      if (result.files) response.files = result.files;
      return response;
    }
  }
  const asOutput = schema.safeParse(result);
  if (asOutput.success) {
    return { output: asOutput.data };
  }
  if (hasResponseKeys(result)) {
    const response = {};
    if ("output" in result) response.output = assertSchema(schema, result.output);
    if (typeof result.text === "string") response.text = result.text;
    if (result.files) response.files = result.files;
    return response;
  }
  return { output: assertSchema(schema, result) };
}
function assertSafeRelativePath(path) {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
    throw new TypeError(`Fake agent file path must stay inside rootDir: ${path}`);
  }
}
async function writeFiles(rootDir, files) {
  if (!files || Object.keys(files).length === 0) return;
  if (!rootDir) {
    throw new TypeError("Fake agent files require a rootDir");
  }
  const root = resolve(rootDir);
  for (const [name, contents] of Object.entries(files)) {
    assertSafeRelativePath(name);
    const target = resolve(root, name);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new TypeError(`Fake agent file path must stay inside rootDir: ${name}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}
function buildFakeAgent(schema, script, options = {}) {
  const calls = [];
  const agent = {
    id: options.id ?? "fake-agent",
    model: options.model ?? "fake-agent",
    tools: {},
    supportsNativeStructuredOutput: options.supportsNativeStructuredOutput ?? true,
    calls,
    async generate(args = {}) {
      const call = {
        args,
        prompt: args.prompt,
        rootDir: typeof args.rootDir === "string" ? args.rootDir : void 0,
        taskContext: args.taskContext
      };
      calls.push(call);
      const raw = typeof script === "function" ? await script(args) : script;
      const response = normalizeResult(schema, raw);
      await writeFiles(call.rootDir, response.files);
      const generated = {};
      if ("output" in response) generated.output = response.output;
      if (response.text !== void 0) generated.text = response.text;
      return generated;
    },
    lastPrompt() {
      return calls.at(-1)?.prompt;
    },
    reset() {
      calls.length = 0;
    }
  };
  return agent;
}
function buildSequenceAgent(schema, entries, options = {}) {
  let index = 0;
  return buildFakeAgent(
    schema,
    () => {
      if (index >= entries.length) {
        throw new Error(`Fake agent sequence exhausted after ${entries.length} call(s)`);
      }
      return entries[index++];
    },
    options
  );
}
var fakeAgent = Object.assign(buildFakeAgent, {
  sequence: buildSequenceAgent
});

// src/renderWorkflow.ts
import { SmithersCtx } from "@smithers-orchestrator/driver/SmithersCtx";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler";
import { canonicalizeXml } from "@smithers-orchestrator/graph/utils/xml";
function buildRuntimeConfig(options) {
  return {
    ...options.runtimeConfig,
    ...options.baseRootDir !== void 0 ? { baseRootDir: options.baseRootDir } : {},
    ...options.workflowPath !== void 0 ? { workflowPath: options.workflowPath } : {}
  };
}
function buildExtractOptions(options) {
  return {
    defaultIteration: options.iteration ?? 0,
    ralphIterations: options.iterations,
    baseRootDir: options.baseRootDir ?? options.runtimeConfig?.baseRootDir,
    workflowPath: options.workflowPath ?? options.runtimeConfig?.workflowPath ?? null
  };
}
async function renderWorkflow(workflow, options = {}) {
  const ctx = new SmithersCtx({
    runId: options.runId ?? "test-run",
    iteration: options.iteration ?? 0,
    iterations: options.iterations,
    input: options.input ?? {},
    auth: options.auth ?? null,
    outputs: options.outputs ?? {},
    zodToKeyName: workflow.zodToKeyName,
    runtimeConfig: buildRuntimeConfig(options)
  });
  const renderer = options.renderer ?? new SmithersRenderer();
  const graph = await renderer.render(
    workflow.build(ctx),
    buildExtractOptions(options)
  );
  const baseRootDir = options.baseRootDir ?? options.runtimeConfig?.baseRootDir;
  const workflowPath = options.workflowPath ?? options.runtimeConfig?.workflowPath ?? null;
  const engineHelpers = await import("@smithers-orchestrator/engine/engine");
  const computeHelpers = await import("@smithers-orchestrator/engine/task-compute-fns");
  engineHelpers.resolveTaskOutputs(graph.tasks, workflow);
  computeHelpers.attachSubflowComputeFns(graph.tasks, workflow, {
    rootDir: baseRootDir,
    workflowPath
  });
  computeHelpers.attachSandboxComputeFns(graph.tasks, workflow, {
    rootDir: baseRootDir,
    workflowPath
  });
  return {
    ...graph,
    runId: ctx.runId,
    frameNo: options.frameNo ?? 0,
    graph,
    ctx,
    toXml() {
      return canonicalizeXml(graph.xml);
    }
  };
}

// src/renderPrompt.ts
import { renderPromptToText } from "@smithers-orchestrator/components/components/Task";

// src/runTask.ts
async function runTask(task, options = {}) {
  if (task.kind === "static" || task.staticPayload !== void 0) {
    return validateOutput(task, task.staticPayload);
  }
  if (task.kind === "compute" || task.computeFn) {
    if (!task.computeFn) {
      throw new TypeError(`Task ${task.nodeId} is marked compute but has no compute function`);
    }
    return validateOutput(task, await task.computeFn());
  }
  const agent = Array.isArray(task.agent) ? task.agent[Math.min((options.attempt ?? 1) - 1, task.agent.length - 1)] : task.agent;
  if (!agent?.generate) {
    throw new TypeError(`Task ${task.nodeId} has no runnable agent, compute function, or static payload`);
  }
  const result = await agent.generate({
    prompt: task.prompt,
    outputSchema: task.outputSchema,
    rootDir: options.rootDir,
    taskContext: {
      runId: options.runId,
      nodeId: task.nodeId,
      iteration: task.iteration,
      attempt: options.attempt ?? 1
    }
  });
  if (result && typeof result === "object" && "output" in result) {
    return validateOutput(task, result.output);
  }
  if (task.outputSchema) return validateOutput(task, result);
  return result;
}
function validateOutput(task, value) {
  if (!task.outputSchema) return value;
  const parsed = task.outputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const message = parsed.error.issues.map((issue) => issue.message).join("; ");
  throw new TypeError(`Task ${task.nodeId} output failed validation: ${message}`);
}

// src/simulate.ts
import { zodSchemaToJsonExample as zodSchemaToJsonExample2 } from "@smithers-orchestrator/components/zod-to-example";
import { WorkflowDriver } from "@smithers-orchestrator/driver";
import { SmithersRenderer as SmithersRenderer2 } from "@smithers-orchestrator/react-reconciler";
import { makeWorkflowSession } from "@smithers-orchestrator/scheduler";
import { Effect } from "effect";
function createRunId() {
  return `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isFakeAgent(value) {
  return isObject(value) && typeof value.generate === "function";
}
function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
function globMatches(pattern, value) {
  const source = `^${escapeRegExp(pattern).replace(/\*/g, ".*")}$`;
  return new RegExp(source).test(value);
}
function formatAgentTaskIds(agentTaskIds) {
  return JSON.stringify([...new Set(agentTaskIds)].sort());
}
function formatIssues2(issues) {
  if (issues.length === 0) return "unknown validation failure";
  return issues.map((issue) => {
    if (!isObject(issue)) return JSON.stringify(issue);
    const path = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
    const message = "message" in issue ? String(issue.message) : JSON.stringify(issue);
    return `${path}${message}`;
  }).join("; ");
}
function simulatorError(message, code = "SIMULATION_ERROR") {
  const error = new Error(message);
  error.name = "SimulationError";
  error.code = code;
  error.details = { failureRetryable: false };
  return error;
}
function schemaExample2(task) {
  if (!task.outputSchema) {
    throw simulatorError(
      `simulate(): auto mock for task "${task.nodeId}" requires an outputSchema.`,
      "AGENT_CONFIG_INVALID"
    );
  }
  return JSON.parse(zodSchemaToJsonExample2(task.outputSchema));
}
function validateTaskOutput(task, value) {
  if (!task.outputSchema) return value;
  const parsed = task.outputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw simulatorError(
    `simulate(): task "${task.nodeId}" output failed validation: ${formatIssues2(parsed.error.issues)}`,
    "INVALID_OUTPUT"
  );
}
function isAgentTask(task) {
  return task.kind === "agent" || task.agent != null && task.computeFn == null && task.staticPayload === void 0;
}
function getTaskRecord(records, nodeId) {
  let record = records.get(nodeId);
  if (!record) {
    record = { status: "pending", outputs: [], prompts: [] };
    records.set(nodeId, record);
  }
  return record;
}
function copyTaskRecord(record) {
  return {
    status: record?.status ?? "pending",
    outputs: [...record?.outputs ?? []],
    prompts: [...record?.prompts ?? []]
  };
}
function resolveMock(mocks, task, agentTask) {
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
function updateUnusedMocks(handle, mocks, consumedMocks) {
  handle.unusedMocks = Object.keys(mocks).filter((key) => !consumedMocks.has(key));
}
async function materializeMock(mock, task, context, rootDir, runId) {
  if (isAuto(mock)) {
    return schemaExample2(task);
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
        attempt: 1
      }
    });
    return result.output;
  }
  if (typeof mock === "function") {
    const result = await mock({
      nodeId: task.nodeId,
      iteration: task.iteration,
      attempt: 1,
      prompt: task.prompt,
      rootDir: context.options.rootDir ?? rootDir,
      outputSchema: task.outputSchema
    });
    if (isObject(result) && "output" in result) {
      return result.output;
    }
    return result;
  }
  return mock;
}
function simulate(workflow, options = {}) {
  const runId = createRunId();
  const mocks = options.mocks ?? {};
  const consumedMocks = /* @__PURE__ */ new Set();
  const taskRecords = /* @__PURE__ */ new Map();
  const latestTasks = /* @__PURE__ */ new Map();
  let latestAgentTaskIds = [];
  let runPromise;
  let lastExecutionError;
  const handle = {
    status: "pending",
    output: void 0,
    outputs: {},
    executed: [],
    unusedMocks: Object.keys(mocks),
    warnings: [],
    run() {
      runPromise ??= runSimulation();
      return runPromise;
    },
    task(id) {
      if (!taskRecords.has(id) && latestTasks.has(id)) {
        taskRecords.set(id, { status: "pending", outputs: [], prompts: [] });
      }
      return copyTaskRecord(taskRecords.get(id));
    }
  };
  const smithersRenderer = new SmithersRenderer2();
  const renderer = {
    async render(element, extractOptions) {
      const graph = await smithersRenderer.render(element, extractOptions);
      const rootDir = extractOptions?.baseRootDir ?? options.rootDir;
      const workflowPath = extractOptions?.workflowPath ?? options.workflowPath ?? null;
      const engineHelpers = await import("@smithers-orchestrator/engine/engine");
      const computeHelpers = await import("@smithers-orchestrator/engine/task-compute-fns");
      engineHelpers.resolveTaskOutputs(graph.tasks, workflow);
      computeHelpers.attachSubflowComputeFns(graph.tasks, workflow, {
        rootDir,
        workflowPath
      });
      computeHelpers.attachSandboxComputeFns(graph.tasks, workflow, {
        rootDir,
        workflowPath
      });
      latestTasks.clear();
      for (const task of graph.tasks) {
        latestTasks.set(task.nodeId, task);
      }
      latestAgentTaskIds = graph.tasks.filter(isAgentTask).map((task) => task.nodeId);
      return graph;
    }
  };
  const executeTask = async (task, context) => {
    const record = getTaskRecord(taskRecords, task.nodeId);
    handle.executed.push(task.nodeId);
    record.prompts.push(task.prompt);
    const agentTask = isAgentTask(task);
    try {
      const mock = resolveMock(mocks, task, agentTask);
      let value;
      if (mock.matched) {
        consumedMocks.add(mock.key);
        updateUnusedMocks(handle, mocks, consumedMocks);
        value = await materializeMock(mock.value, task, context, options.rootDir, runId);
      } else if (agentTask) {
        throw simulatorError(
          `simulate(): agent task "${task.nodeId}" has no mock. Provide mocks[${JSON.stringify(task.nodeId)}], a glob, "*": auto, or a per-node value. Agent tasks in this run: ${formatAgentTaskIds(latestAgentTaskIds)}`,
          "AGENT_CONFIG_INVALID"
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
  async function runSimulation() {
    handle.status = "running";
    try {
      const driver = new WorkflowDriver({
        workflow,
        runtime: {
          runPromise: (effect) => Effect.runPromise(effect)
        },
        renderer,
        createSession: (sessionOptions) => makeWorkflowSession({ runId: sessionOptions.runId }),
        executeTask
      });
      const result = await driver.run({
        runId,
        input: options.input ?? {},
        initialOutputs: {},
        rootDir: options.rootDir,
        workflowPath: options.workflowPath ?? void 0
      });
      handle.status = result.status;
      if (result.output !== void 0) {
        handle.output = result.output;
      }
      if (result.failedChildren && result.failedChildren > 0) {
        handle.warnings.push(
          `simulate(): run finished with ${result.failedChildren} failed child task(s).`
        );
      }
      if (result.status === "failed") {
        handle.error = lastExecutionError ?? result.error;
        throw handle.error instanceof Error ? handle.error : simulatorError(String(handle.error ?? "simulate(): run failed"));
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

// src/matchers.ts
function executedOf(received) {
  return Array.isArray(received.executed) ? received.executed : [];
}
function formatValue(value) {
  return JSON.stringify(value);
}
function hasSubsequence(actual, expected) {
  let expectedIndex = 0;
  for (const id of actual) {
    if (id === expected[expectedIndex]) {
      expectedIndex += 1;
    }
    if (expectedIndex === expected.length) {
      return true;
    }
  }
  return expectedIndex === expected.length;
}
function toHaveExecuted(received, ids) {
  const executed = executedOf(received);
  const missing = ids.filter((id) => !executed.includes(id));
  const pass = missing.length === 0;
  return {
    pass,
    message: () => pass ? `Expected simulation not to have executed ${formatValue(ids)}, but actual executed nodes were ${formatValue(executed)}.` : `Expected simulation to have executed ${formatValue(ids)}, but missing ids were ${formatValue(missing)}. Actual executed nodes were ${formatValue(executed)}.`
  };
}
function toHaveExecutedInOrder(received, ids) {
  const executed = executedOf(received);
  const pass = hasSubsequence(executed, ids);
  return {
    pass,
    message: () => pass ? `Expected simulation not to have executed in order ${formatValue(ids)}, but actual executed order was ${formatValue(executed)}.` : `Expected simulation to have executed in order ${formatValue(ids)}, but actual executed order was ${formatValue(executed)}.`
  };
}
function toHaveFinished(received) {
  const pass = received.status === "finished";
  return {
    pass,
    message: () => pass ? 'Expected simulation not to have finished, but status was "finished".' : `Expected simulation to have finished, but status was ${formatValue(received.status)}.`
  };
}
var simMatchers = { toHaveExecuted, toHaveExecutedInOrder, toHaveFinished };
export {
  auto,
  fakeAgent,
  isAuto,
  renderPromptToText as renderPrompt,
  renderWorkflow,
  runTask,
  simMatchers,
  simulate,
  toHaveExecuted,
  toHaveExecutedInOrder,
  toHaveFinished
};
