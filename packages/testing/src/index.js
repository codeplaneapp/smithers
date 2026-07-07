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
export {
  auto,
  fakeAgent,
  isAuto,
  renderPromptToText as renderPrompt,
  renderWorkflow,
  runTask
};
