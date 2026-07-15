// src/simulate.ts
import { zodSchemaToJsonExample as zodSchemaToJsonExample2 } from "@smithers-orchestrator/components/zod-to-example";
import { WorkflowDriver } from "@smithers-orchestrator/driver";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler";
import { makeWorkflowSession } from "@smithers-orchestrator/scheduler";
import { Effect } from "effect";

// src/fakeAgent.ts
import { closeSync, constants as fsConstants, writeFileSync } from "fs";
import { lstat, mkdir, open, realpath } from "fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "path";
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
function unsafeFilePath(path) {
  return new TypeError(`Fake agent file path must stay inside rootDir: ${path}`);
}
function isErrnoException(error) {
  return error instanceof Error && ("code" in error || "errno" in error);
}
async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return void 0;
    throw error;
  }
}
async function ensureSafeParentDirectories(root, target, name) {
  const parent = dirname(target);
  const parentRelative = relative(root, parent);
  if (!parentRelative) return;
  let current = root;
  for (const component of parentRelative.split(sep)) {
    current = join(current, component);
    let stats = await lstatIfExists(current);
    if (!stats) {
      try {
        await mkdir(current);
      } catch (error) {
        if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      }
      stats = await lstat(current);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw unsafeFilePath(name);
    }
  }
}
async function writeFileWithoutFollowingSymlinks(root, target, name, contents) {
  await ensureSafeParentDirectories(root, target, name);
  await ensureSafeParentDirectories(root, target, name);
  const existingTarget = await lstatIfExists(target);
  if (existingTarget?.isSymbolicLink()) {
    throw unsafeFilePath(name);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow, 438);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ELOOP") {
      throw unsafeFilePath(name);
    }
    throw error;
  }
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}
var posixFsPromise;
async function loadPosixFs() {
  if (posixFsPromise) return posixFsPromise;
  posixFsPromise = import("koffi").then((module) => {
    const koffi = "default" in module ? module.default : module;
    const libc = koffi.load(null);
    return {
      openat: libc.func("int openat(int dirfd, const char *path, int flags, ...)"),
      mkdirat: libc.func("int mkdirat(int dirfd, const char *path, int mode)"),
      errno: koffi.errno,
      errors: koffi.os.errno
    };
  });
  return posixFsPromise;
}
function posixError(operation, path, errno) {
  const error = new Error(`${operation} failed for ${path} (errno ${errno})`);
  error.errno = errno;
  return error;
}
function isUnsafePosixError(posix, errno) {
  return errno === posix.errors.ELOOP || errno === posix.errors.ENOTDIR;
}
function openAt(posix, directory, path, flags, mode) {
  const fd = mode === void 0 ? posix.openat(directory, path, flags) : posix.openat(directory, path, flags, "int", mode);
  if (fd >= 0) return fd;
  throw posixError("openat", path, posix.errno());
}
function directoryOpenFlags() {
  return fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | closeOnExecFlag();
}
function closeOnExecFlag() {
  const constants = fsConstants;
  return constants.O_CLOEXEC ?? 0;
}
function openExistingDirectoryAt(posix, directory, component, name) {
  try {
    return openAt(posix, directory, component, directoryOpenFlags());
  } catch (error) {
    if (isErrnoException(error) && typeof error.errno === "number" && isUnsafePosixError(posix, error.errno)) {
      throw unsafeFilePath(name);
    }
    throw error;
  }
}
function openOrCreateDirectoryAt(posix, directory, component, name) {
  try {
    return openExistingDirectoryAt(posix, directory, component, name);
  } catch (error) {
    if (!isErrnoException(error) || error.errno !== posix.errors.ENOENT) throw error;
  }
  if (posix.mkdirat(directory, component, 511) < 0) {
    const errno = posix.errno();
    if (errno !== posix.errors.EEXIST) throw posixError("mkdirat", component, errno);
  }
  return openExistingDirectoryAt(posix, directory, component, name);
}
function openCanonicalDirectory(posix, path, name) {
  const { root } = parse(path);
  let current = openAt(posix, 0, root, directoryOpenFlags());
  try {
    const remainder = relative(root, path);
    if (!remainder) return current;
    for (const component of remainder.split(sep)) {
      const next = openExistingDirectoryAt(posix, current, component, name);
      closeSync(current);
      current = next;
    }
    return current;
  } catch (error) {
    closeSync(current);
    throw error;
  }
}
async function openRootDirectory(posix, lexicalRoot) {
  const missing = [];
  let existing = lexicalRoot;
  let canonical;
  while (true) {
    try {
      canonical = await realpath(existing);
      break;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  let current = openCanonicalDirectory(posix, canonical, lexicalRoot);
  try {
    for (const component of missing) {
      const next = openOrCreateDirectoryAt(posix, current, component, lexicalRoot);
      closeSync(current);
      current = next;
    }
    return current;
  } catch (error) {
    closeSync(current);
    throw error;
  }
}
function writeFileAt(posix, root, path, name, contents) {
  const components = path.split(sep);
  const filename = components.pop();
  if (!filename) throw unsafeFilePath(name);
  let current = root;
  let ownsCurrent = false;
  try {
    for (const component of components) {
      const next = openOrCreateDirectoryAt(posix, current, component, name);
      if (ownsCurrent) closeSync(current);
      current = next;
      ownsCurrent = true;
    }
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW | closeOnExecFlag();
    let file;
    try {
      file = openAt(posix, current, filename, flags, 438);
    } catch (error) {
      if (isErrnoException(error) && typeof error.errno === "number" && isUnsafePosixError(posix, error.errno)) {
        throw unsafeFilePath(name);
      }
      throw error;
    }
    try {
      writeFileSync(file, contents);
    } finally {
      closeSync(file);
    }
  } finally {
    if (ownsCurrent) closeSync(current);
  }
}
async function writeFiles(rootDir, files) {
  if (!files || Object.keys(files).length === 0) return;
  if (!rootDir) {
    throw new TypeError("Fake agent files require a rootDir");
  }
  const lexicalRoot = resolve(rootDir);
  if (process.platform === "win32") {
    await mkdir(lexicalRoot, { recursive: true });
    const root2 = await realpath(lexicalRoot);
    for (const [name, contents] of Object.entries(files)) {
      assertSafeRelativePath(name);
      const target = resolve(root2, name);
      const rel = relative(root2, target);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new TypeError(`Fake agent file path must stay inside rootDir: ${name}`);
      }
      await writeFileWithoutFollowingSymlinks(root2, target, name, contents);
    }
    return;
  }
  const posix = await loadPosixFs();
  const root = await openRootDirectory(posix, lexicalRoot);
  try {
    for (const [name, contents] of Object.entries(files)) {
      assertSafeRelativePath(name);
      const target = resolve(lexicalRoot, name);
      const rel = relative(lexicalRoot, target);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new TypeError(`Fake agent file path must stay inside rootDir: ${name}`);
      }
      writeFileAt(posix, root, rel, name, contents);
    }
  } finally {
    closeSync(root);
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

// src/simulate.ts
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
function normalizeFunctionMockResult(task, result) {
  if (!task.outputSchema || !isObject(result) || !("output" in result)) {
    return result;
  }
  const parsedOutput = task.outputSchema.safeParse(result.output);
  return parsedOutput.success ? parsedOutput.data : result;
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
    return normalizeFunctionMockResult(task, result);
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
  const smithersRenderer = new SmithersRenderer();
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
        createSession: (sessionOptions) => makeWorkflowSession({
          runId: sessionOptions.runId,
          requireStableFinish: true,
          requireRerenderOnOutputChange: sessionOptions.options?.requireRerenderOnOutputChange !== false
        }),
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
export {
  simulate
};
