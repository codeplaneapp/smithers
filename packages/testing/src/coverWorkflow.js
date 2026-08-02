// src/coverWorkflow.ts
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join as join2 } from "path";
import { Effect as Effect2 } from "effect";

// src/fakeAgent.ts
import { closeSync, constants as fsConstants, writeFileSync } from "fs";
import { lstat, mkdir, open, realpath } from "fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "path";

// src/schemaMock.ts
import { toJSONSchema } from "zod";
import { zodSchemaToJsonExample } from "@smthrs/components/zod-to-example";
function stringForFormat(format) {
  switch (format) {
    case "email":
      return "test@example.com";
    case "uri":
    case "url":
      return "https://example.com";
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    case "date-time":
      return "2020-01-01T00:00:00.000Z";
    case "date":
      return "2020-01-01";
    case "time":
      return "00:00:00Z";
    case "ipv4":
      return "127.0.0.1";
    case "ipv6":
      return "::1";
    case "hostname":
      return "example.com";
    default:
      return "string";
  }
}
function nextRepresentable(value, direction) {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return direction === 1 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  let bits = view.getBigUint64(0);
  bits += (value >= 0 ? direction : -direction) === 1 ? 1n : -1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}
function greatestCommonDivisor(left, right) {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left < 0n ? -left : left;
}
function integerStepFromMultiple(multiple) {
  const [mantissa, exponentText] = multiple.toString().toLowerCase().split("e");
  const exponent = Number(exponentText ?? 0);
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = `${whole}${fraction}`.replace(/^\+/, "");
  let numerator = BigInt(digits);
  let denominator = 1n;
  const scale = fraction.length - exponent;
  if (scale > 0) denominator = 10n ** BigInt(scale);
  else if (scale < 0) numerator *= 10n ** BigInt(-scale);
  const divisor = greatestCommonDivisor(numerator, denominator);
  return Number((numerator < 0n ? -numerator : numerator) / divisor);
}
function numberFromSchema(schema, integer) {
  let lower = schema.minimum ?? Number.NEGATIVE_INFINITY;
  let upper = schema.maximum ?? Number.POSITIVE_INFINITY;
  if (schema.exclusiveMinimum !== void 0) {
    lower = Math.max(
      lower,
      integer ? Math.floor(schema.exclusiveMinimum) + 1 : nextRepresentable(schema.exclusiveMinimum, 1)
    );
  }
  if (schema.exclusiveMaximum !== void 0) {
    upper = Math.min(
      upper,
      integer ? Math.ceil(schema.exclusiveMaximum) - 1 : nextRepresentable(schema.exclusiveMaximum, -1)
    );
  }
  if (integer) {
    lower = Math.ceil(lower);
    upper = Math.floor(upper);
  }
  const multiple = schema.multipleOf && schema.multipleOf > 0 ? Math.abs(schema.multipleOf) : integer ? 1 : null;
  if (multiple !== null) {
    if (integer) {
      const step = integerStepFromMultiple(multiple);
      if (!Number.isFinite(step) || step <= 0) {
        throw new TypeError("JSON Schema multipleOf cannot produce a representable integer");
      }
      const firstMultiplier2 = Number.isFinite(lower) ? Math.ceil(lower / step) : 0;
      const lastMultiplier2 = Number.isFinite(upper) ? Math.floor(upper / step) : Infinity;
      const multiplier2 = firstMultiplier2 <= 0 && lastMultiplier2 >= 0 ? 0 : firstMultiplier2;
      const value2 = multiplier2 * step;
      if (firstMultiplier2 > lastMultiplier2 || value2 < lower || value2 > upper || !Number.isInteger(value2)) {
        throw new TypeError("JSON Schema numeric constraints have no representable integer multiple");
      }
      return value2;
    }
    let firstMultiplier = Number.isFinite(lower) ? Math.ceil(lower / multiple) : 0;
    let lastMultiplier = Number.isFinite(upper) ? Math.floor(upper / multiple) : Infinity;
    if (Number.isFinite(lower) && (firstMultiplier - 1) * multiple >= lower) firstMultiplier -= 1;
    if (Number.isFinite(upper) && (lastMultiplier + 1) * multiple <= upper) lastMultiplier += 1;
    let multiplier = firstMultiplier <= 0 && lastMultiplier >= 0 ? 0 : firstMultiplier;
    let value = multiplier * multiple;
    if (firstMultiplier > lastMultiplier || value < lower || value > upper) {
      throw new TypeError("JSON Schema numeric constraints have no representable multiple");
    }
    return value;
  }
  if (lower > upper) throw new TypeError("JSON Schema numeric constraints describe an empty interval");
  if (lower <= 0 && upper >= 0) return 0;
  if (Number.isFinite(lower) && Number.isFinite(upper)) {
    const midpoint = lower + (upper - lower) / 2;
    return midpoint >= lower && midpoint <= upper ? midpoint : lower;
  }
  return Number.isFinite(lower) ? lower : Number.isFinite(upper) ? upper : 0;
}
function characterFromClass(source) {
  const negated = source.startsWith("^");
  const body = negated ? source.slice(1) : source;
  const candidates = ["a", "A", "0", "_", "-", " "];
  let expression;
  try {
    expression = new RegExp(`^[${source}]$`);
  } catch {
    return "a";
  }
  return candidates.find((candidate) => expression.test(candidate)) ?? (negated ? "a" : body[0] ?? "a");
}
function stringForPattern(pattern) {
  const source = pattern.replace(/^\^/, "").replace(/\$$/, "");
  const pieces = [];
  for (let index = 0; index < source.length; ) {
    let token = "";
    const char = source[index];
    if (char === "\\") {
      const escaped = source[index + 1];
      token = escaped === "d" ? "0" : escaped === "w" ? "a" : escaped === "s" ? " " : escaped ?? "";
      index += 2;
    } else if (char === "[") {
      const end = source.indexOf("]", index + 1);
      if (end < 0) return null;
      token = characterFromClass(source.slice(index + 1, end));
      index = end + 1;
    } else if (char === ".") {
      token = "a";
      index += 1;
    } else if ("()|".includes(char)) {
      index += 1;
      continue;
    } else {
      token = char;
      index += 1;
    }
    let count = 1;
    if (source[index] === "*") {
      count = 0;
      index += 1;
    } else if (source[index] === "?") {
      count = 0;
      index += 1;
    } else if (source[index] === "+") {
      index += 1;
    } else if (source[index] === "{") {
      const end = source.indexOf("}", index + 1);
      const minimum = end < 0 ? NaN : Number(source.slice(index + 1, end).split(",")[0]);
      if (!Number.isFinite(minimum)) return null;
      count = minimum;
      index = end + 1;
    }
    pieces.push(token.repeat(count));
  }
  const value = pieces.join("");
  try {
    return new RegExp(pattern).test(value) ? value : null;
  } catch {
    return null;
  }
}
function jsonSchemaExample(schema, depth = 0) {
  if (depth > 12) return null;
  if ("const" in schema) return schema.const;
  if ("default" in schema) return schema.default;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.enum?.length) return schema.enum[0];
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives?.length) return jsonSchemaExample(alternatives[0], depth + 1);
  if (schema.allOf?.length) {
    const values = schema.allOf.map((entry) => jsonSchemaExample(entry, depth + 1));
    if (values.every((value) => value && typeof value === "object" && !Array.isArray(value))) {
      return Object.assign({}, ...values);
    }
    return values[0];
  }
  const type = Array.isArray(schema.type) ? schema.type.find((candidate) => candidate !== "null") ?? schema.type[0] : schema.type;
  switch (type) {
    case "null":
      return null;
    case "boolean":
      return false;
    case "integer":
      return numberFromSchema(schema, true);
    case "number":
      return numberFromSchema(schema, false);
    case "array": {
      if (schema.prefixItems?.length) {
        return schema.prefixItems.map((item) => jsonSchemaExample(item, depth + 1));
      }
      const length = schema.maxItems === 0 ? 0 : Math.max(1, schema.minItems ?? 0);
      return Array.from({ length }, () => jsonSchemaExample(schema.items ?? {}, depth + 1));
    }
    case "object": {
      const output = {};
      for (const key of schema.required ?? []) {
        output[key] = jsonSchemaExample(schema.properties?.[key] ?? {}, depth + 1);
      }
      return output;
    }
    case "string":
    default: {
      let value = (schema.pattern ? stringForPattern(schema.pattern) : null) ?? stringForFormat(schema.format);
      const minimum = schema.minLength ?? 0;
      if (value.length < minimum) value += "a".repeat(minimum - value.length);
      if (schema.maxLength !== void 0 && value.length > schema.maxLength) {
        value = value.slice(0, schema.maxLength);
      }
      return value;
    }
  }
}
function formatIssues(issues) {
  return issues.map(
    (issue) => issue && typeof issue === "object" && "message" in issue ? String(issue.message) : JSON.stringify(issue)
  ).join("; ");
}
function schemaMock(schema) {
  try {
    const first = JSON.parse(zodSchemaToJsonExample(schema));
    const firstResult = schema.safeParse(first);
    if (firstResult.success) return firstResult.data;
  } catch {
  }
  const jsonSchema = toJSONSchema(schema);
  const candidate = jsonSchemaExample(jsonSchema);
  const result = schema.safeParse(candidate);
  if (result.success) return result.data;
  throw new TypeError(`Could not generate a valid schema-aware mock: ${formatIssues(result.error.issues)}`);
}

// src/fakeAgent.ts
var autoMarker = /* @__PURE__ */ Symbol.for("smithers.testing.auto");
var auto = Object.freeze({
  [autoMarker]: true
});
function isAuto(value) {
  return Boolean(
    value && typeof value === "object" && value[autoMarker] === true
  );
}
function schemaExample(schema) {
  return schemaMock(schema);
}
function formatIssues2(issues) {
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
  throw new TypeError(`Fake agent output failed validation: ${formatIssues2(result.error.issues)}`);
}
function hasResponseKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "output" in value || "text" in value || "files" in value;
}
function normalizeResult(schema, result) {
  if (isAuto(result)) {
    return { output: schemaExample(schema) };
  }
  if (hasResponseKeys(result) && !("output" in result)) {
    const response = {};
    if (typeof result.text === "string") response.text = result.text;
    if (result.files) response.files = result.files;
    return response;
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
import { WorkflowDriver } from "@smthrs/driver";
import { SmithersRenderer } from "@smthrs/react-reconciler";
import { makeWorkflowSession } from "@smthrs/scheduler";
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
function formatIssues3(issues) {
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
  return schemaMock(task.outputSchema);
}
function validateTaskOutput(task, value) {
  if (!task.outputSchema) return value;
  const parsed = task.outputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw simulatorError(
    `simulate(): task "${task.nodeId}" output failed validation: ${formatIssues3(parsed.error.issues)}`,
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
  if (task.label && Object.prototype.hasOwnProperty.call(mocks, task.label)) {
    return { matched: true, key: task.label, value: mocks[task.label] };
  }
  for (const key of Object.keys(mocks)) {
    if (key === "*" || !key.includes("*")) continue;
    if (globMatches(key, task.nodeId) || task.label !== void 0 && globMatches(key, task.label)) {
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
function __simulateWithControls(workflow, options = {}, controls) {
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
      const engineHelpers = await import("@smthrs/engine/engine");
      const computeHelpers = await import("@smthrs/engine/task-compute-fns");
      engineHelpers.resolveTaskOutputs(graph.tasks, workflow);
      computeHelpers.attachSubflowComputeFns(graph.tasks, workflow, {
        rootDir,
        workflowPath
      });
      computeHelpers.attachSandboxComputeFns(graph.tasks, workflow, {
        rootDir,
        workflowPath
      });
      const controlledGraph = controls?.transformGraph?.(graph) ?? graph;
      latestTasks.clear();
      for (const task of controlledGraph.tasks) {
        latestTasks.set(task.nodeId, task);
      }
      latestAgentTaskIds = controlledGraph.tasks.filter(isAgentTask).map((task) => task.nodeId);
      controls?.onGraph?.(controlledGraph);
      return controlledGraph;
    }
  };
  const executeTask = async (task, context) => {
    const record = getTaskRecord(taskRecords, task.nodeId);
    handle.executed.push(task.nodeId);
    controls?.onTaskStarted?.(task);
    record.prompts.push(task.prompt);
    const agentTask = isAgentTask(task);
    try {
      const mock = resolveMock(mocks, task, agentTask);
      let value;
      if (mock.matched) {
        consumedMocks.add(mock.key);
        updateUnusedMocks(handle, mocks, consumedMocks);
        value = await materializeMock(mock.value, task, context, options.rootDir, runId);
      } else if (controls?.executeUnmocked) {
        const controlled = await controls.executeUnmocked(task, context);
        if (controlled.handled) {
          value = controlled.value;
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
      controls?.onTaskValidated?.(task, parsed);
      const channel = task.outputTableName;
      (handle.outputs[channel] ??= []).push(parsed);
      record.outputs.push(parsed);
      record.status = "finished";
      handle.output = parsed;
      return parsed;
    } catch (error) {
      record.status = "failed";
      lastExecutionError = error;
      controls?.onTaskError?.(task, error);
      throw error;
    }
  };
  async function runSimulation() {
    handle.status = "running";
    try {
      let session;
      const driver = new WorkflowDriver({
        workflow,
        runtime: {
          runPromise: (effect) => Effect.runPromise(effect)
        },
        renderer,
        createSession: (sessionOptions) => {
          session = makeWorkflowSession({
            runId: sessionOptions.runId,
            ...controls?.nowMs ? { nowMs: controls.nowMs } : {},
            requireStableFinish: true,
            requireRerenderOnOutputChange: sessionOptions.options?.requireRerenderOnOutputChange !== false
          });
          return session;
        },
        executeTask,
        ...controls?.resolveWait ? {
          onWait: (reason) => {
            if (!session) throw new Error("simulate(): workflow session was not initialized");
            return controls.resolveWait(reason, session);
          }
        } : {},
        ...controls?.continueAsNew ? {
          continueAsNew: (transition) => controls.continueAsNew(transition)
        } : {}
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
        handle.warnings.push(`simulate(): run finished with ${result.failedChildren} failed child task(s).`);
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

// src/coverWorkflow.ts
var WorkflowCoverageError = class extends Error {
  result;
  constructor(message, result) {
    super(message);
    this.name = "WorkflowCoverageError";
    this.result = result;
  }
};
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function workflowFromModule(candidate) {
  const workflow = isRecord(candidate) && "default" in candidate ? candidate.default : candidate;
  if (!workflow || typeof workflow !== "object" || typeof workflow.build !== "function") {
    throw new TypeError("coverWorkflow(): expected a workflow definition or a module with a default workflow export");
  }
  return workflow;
}
function schemaExample3(task) {
  if (!task.outputSchema) return null;
  return schemaMock(task.outputSchema);
}
function stateKey(task) {
  return `${task.nodeId}::${task.iteration}`;
}
function cloneWithLoopCap(node, maxLoopIterations) {
  if (!node || node.kind === "text") return node;
  const children = node.children.map((child) => cloneWithLoopCap(child, maxLoopIterations));
  if (node.tag !== "smithers:ralph") return { ...node, children };
  const { continueAsNewEvery: _continueAsNewEvery, ...props } = node.props;
  const declared = Number(props.maxIterations);
  const bound = Number.isInteger(declared) && declared > 0 ? Math.min(declared, maxLoopIterations) : maxLoopIterations;
  return {
    ...node,
    props: {
      ...props,
      maxIterations: String(bound),
      onMaxReached: "return-last"
    },
    children
  };
}
function capLoops(graph, maxLoopIterations) {
  return {
    ...graph,
    xml: cloneWithLoopCap(graph.xml, maxLoopIterations)
  };
}
function globMatches2(pattern, value) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
function isAllowed(nodeId, allowlist) {
  return allowlist.some((entry) => globMatches2(entry, nodeId));
}
function errorCode(error) {
  return isRecord(error) && typeof error.code === "string" ? error.code : void 0;
}
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function failure(passIndex, cause, nodeId) {
  return {
    passIndex,
    ...nodeId ? { nodeId } : {},
    ...errorCode(cause) ? { code: errorCode(cause) } : {},
    message: errorMessage(cause),
    cause
  };
}
function invalidOutputError(task, message) {
  return Object.assign(new Error(`coverWorkflow(): task "${task.nodeId}" output failed validation: ${message}`), {
    name: "SimulationError",
    code: "INVALID_OUTPUT",
    details: { failureRetryable: false }
  });
}
function validateExternalOutput(task, value, passIndex, validations) {
  if (!task.outputSchema) return value;
  const parsed = task.outputSchema.safeParse(value);
  if (parsed.success) {
    validations.push({
      passIndex,
      nodeId: task.nodeId,
      iteration: task.iteration,
      valid: true
    });
    return parsed.data;
  }
  const message = parsed.error.issues.map((issue) => issue.message).join("; ");
  validations.push({
    passIndex,
    nodeId: task.nodeId,
    iteration: task.iteration,
    valid: false,
    message
  });
  throw invalidOutputError(task, message);
}
function normalizeApproval(value) {
  if (value === true || value === "approve") return { approved: true };
  if (value === false || value === "deny") return { approved: false };
  return value;
}
function looksLikeApprovalValue(value) {
  return isRecord(value) && typeof value.approved === "boolean";
}
function taskContext(task, input, passIndex) {
  return {
    nodeId: task.nodeId,
    ...task.label ? { label: task.label } : {},
    iteration: task.iteration,
    input,
    passIndex
  };
}
function lookupByTask(values, task, extraKey) {
  if (Object.prototype.hasOwnProperty.call(values, task.nodeId)) return values[task.nodeId];
  if (task.label && Object.prototype.hasOwnProperty.call(values, task.label)) return values[task.label];
  if (extraKey && Object.prototype.hasOwnProperty.call(values, extraKey)) return values[extraKey];
  return values["*"];
}
async function approvalFor(options, task, input, passIndex) {
  const configured = options.approvals;
  let value;
  if (configured === void 0 || typeof configured === "boolean" || typeof configured === "string" || typeof configured === "function" || looksLikeApprovalValue(configured)) {
    value = configured;
  } else {
    value = lookupByTask(configured, task);
  }
  const resolved = typeof value === "function" ? await value(taskContext(task, input, passIndex)) : value;
  return normalizeApproval(resolved ?? true);
}
function approvalTaskOutput(task, decision) {
  if (decision.output !== void 0) return decision.output;
  const generated = schemaExample3(task);
  if (!isRecord(generated)) return generated;
  const output = { ...generated };
  if ("approved" in output) output.approved = decision.approved;
  if (decision.note !== void 0 && "note" in output) output.note = decision.note;
  if (decision.decidedBy !== void 0) {
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
async function eventPayloadFor(options, task, eventName, input, passIndex) {
  const eventValue = options.events ? lookupByTask(options.events, task, eventName) : void 0;
  const signalValue = options.signals ? lookupByTask(options.signals, task, eventName) : void 0;
  const configured = eventValue ?? signalValue;
  if (typeof configured !== "function") return configured === void 0 ? schemaExample3(task) : configured;
  const correlationId = typeof task.meta?.__correlationId === "string" ? task.meta.__correlationId : void 0;
  return configured({
    ...taskContext(task, input, passIndex),
    eventName,
    ...correlationId ? { correlationId } : {}
  });
}
function isIsolatedSideEffect(task) {
  return Boolean(task.sideEffect || task.meta?.__sandbox || task.meta?.__subflow);
}
async function runEffect(effect) {
  return Effect2.runPromise(effect);
}
async function decideAgain(session) {
  const graph = await runEffect(session.getCurrentGraph());
  if (!graph) throw new Error("coverWorkflow(): workflow session has no current graph");
  return runEffect(session.submitGraph(graph));
}
function waitingTask(state, states, expectedState, predicate) {
  return [...state.descriptors.values()].reverse().find((task) => states.get(stateKey(task)) === expectedState && (!predicate || predicate(task)));
}
function timerDeadline(state, task) {
  const key = stateKey(task);
  const existing = state.timerDeadlines.get(key);
  if (existing !== void 0) return existing;
  const until = task.meta?.__timerUntil;
  let deadline;
  if (typeof until === "string" && until.length > 0) {
    const parsed = Date.parse(until);
    if (Number.isFinite(parsed)) deadline = Math.floor(parsed);
  } else {
    const duration = task.meta?.__timerDuration;
    if (typeof duration === "string") {
      const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(duration.trim().toLowerCase());
      const multipliers = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
      const multiplier = match ? multipliers[match[2] ?? "ms"] : void 0;
      const amount = match ? Number(match[1]) : Number.NaN;
      if (multiplier !== void 0 && Number.isFinite(amount)) {
        deadline = state.nowMs + Math.floor(amount * multiplier);
      }
    }
  }
  if (deadline !== void 0) state.timerDeadlines.set(key, deadline);
  return deadline;
}
function appendOutput(record, key, value) {
  (record[key] ??= []).push(value);
}
function mergeOutputs(target, source) {
  for (const [key, values] of Object.entries(source)) {
    (target[key] ??= []).push(...values);
  }
}
async function runCoveragePass(workflow, options, input, passIndex, rootDir, maxLoopIterations) {
  const state = {
    defined: /* @__PURE__ */ new Set(),
    descriptors: /* @__PURE__ */ new Map(),
    executionOrder: [],
    suppressTaskStart: /* @__PURE__ */ new Set(),
    externalTaskOutputs: {},
    externalTableOutputs: {},
    validations: [],
    approvals: [],
    taskFailures: [],
    approvalOutputs: /* @__PURE__ */ new Map(),
    timerDeadlines: /* @__PURE__ */ new Map(),
    nowMs: Date.now()
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
      workflowPath: options.workflowPath
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
          valid: true
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
            message: errorMessage(error)
          });
        }
      },
      executeUnmocked: async (task) => {
        if (task.kind === "human") {
          return {
            handled: true,
            value: state.approvalOutputs.get(stateKey(task)) ?? schemaExample3(task)
          };
        }
        if (task.needsApproval && (task.meta?.requestTitle || task.approvalMode !== "gate")) {
          return {
            handled: true,
            value: state.approvalOutputs.get(stateKey(task)) ?? schemaExample3(task)
          };
        }
        if (isIsolatedSideEffect(task)) {
          return options.executeSideEffects ? { handled: false } : { handled: true, value: schemaExample3(task) };
        }
        if (!options.executeCompute && task.computeFn) {
          return { handled: true, value: schemaExample3(task) };
        }
        return { handled: false };
      },
      resolveWait: async (reason, session) => {
        if (reason._tag === "Approval") {
          const states = await runEffect(session.getTaskStates());
          const task = waitingTask(state, states, "waiting-approval", (candidate) => candidate.nodeId === reason.nodeId) ?? [...state.descriptors.values()].reverse().find((candidate) => candidate.nodeId === reason.nodeId);
          if (!task) throw new Error(`coverWorkflow(): approval task "${reason.nodeId}" was not rendered`);
          const decision = await approvalFor(options, task, input, passIndex);
          const output = approvalTaskOutput(task, decision);
          state.approvalOutputs.set(stateKey(task), output);
          state.approvals.push({
            passIndex,
            nodeId: task.nodeId,
            iteration: task.iteration,
            approved: decision.approved,
            ...decision.note ? { note: decision.note } : {},
            ...decision.decidedBy ? { decidedBy: decision.decidedBy } : {}
          });
          state.executionOrder.push(task.nodeId);
          state.suppressTaskStart.add(stateKey(task));
          return runEffect(
            session.approvalResolved(task.nodeId, {
              approved: decision.approved,
              ...decision.note !== void 0 ? { note: decision.note } : {},
              ...decision.decidedBy !== void 0 ? { decidedBy: decision.decidedBy } : {},
              ...decision.optionKey !== void 0 ? { optionKey: decision.optionKey } : {},
              ...decision.output !== void 0 ? { payload: decision.output } : {}
            })
          );
        }
        if (reason._tag === "Event") {
          const states = await runEffect(session.getTaskStates());
          const task = waitingTask(
            state,
            states,
            "waiting-event",
            (candidate) => candidate.meta?.__eventName === reason.eventName
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
          const states = await runEffect(session.getTaskStates());
          const waiting = [...state.descriptors.values()].reverse().filter((candidate) => states.get(stateKey(candidate)) === "waiting-timer");
          const deadlines = waiting.map((candidate) => ({ candidate, deadline: timerDeadline(state, candidate) }));
          const task = deadlines.find(({ deadline }) => deadline === reason.resumeAtMs)?.candidate ?? deadlines.filter((entry) => entry.deadline !== void 0).sort((left, right) => left.deadline - right.deadline)[0]?.candidate ?? (waiting.length === 1 ? waiting[0] : void 0);
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
          error: new Error(`coverWorkflow(): cannot auto-resolve ${reason._tag} wait`)
        };
      }
    }
  );
  let runError;
  try {
    await sim.run();
  } catch (error) {
    runError = error;
  }
  const taskOutputs = {};
  for (const nodeId of new Set(sim.executed)) {
    taskOutputs[nodeId] = sim.task(nodeId).outputs;
  }
  mergeOutputs(taskOutputs, state.externalTaskOutputs);
  const outputs = {};
  mergeOutputs(outputs, sim.outputs);
  mergeOutputs(outputs, state.externalTableOutputs);
  const finalTaskFailures = state.taskFailures.filter(
    (item) => item.nodeId !== void 0 && sim.task(item.nodeId).status === "failed"
  );
  const errors = finalTaskFailures.length > 0 ? finalTaskFailures : runError !== void 0 ? [failure(passIndex, runError)] : [];
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
    warnings: sim.warnings
  };
}
function normalizeInputs(options) {
  if (options.input !== void 0 && options.inputs !== void 0) {
    throw new TypeError("coverWorkflow(): use either input or inputs, not both");
  }
  if (options.inputs !== void 0) {
    if (options.inputs.length === 0) throw new TypeError("coverWorkflow(): inputs must contain at least one value");
    return options.inputs;
  }
  return [options.input ?? {}];
}
function normalizeLoopCap(value) {
  const cap = value ?? 3;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new TypeError("coverWorkflow(): maxLoopIterations must be a positive integer");
  }
  return cap;
}
async function coverWorkflow(workflowModule, options = {}) {
  const workflow = workflowFromModule(workflowModule);
  const inputs = normalizeInputs(options);
  const maxLoopIterations = normalizeLoopCap(options.maxLoopIterations);
  const temporaryRoot = options.rootDir ? void 0 : await mkdtemp(join2(tmpdir(), "smithers-coverage-"));
  const rootDir = options.rootDir ?? temporaryRoot;
  const passes = [];
  try {
    for (let passIndex = 0; passIndex < inputs.length; passIndex += 1) {
      passes.push(await runCoveragePass(workflow, options, inputs[passIndex], passIndex, rootDir, maxLoopIterations));
    }
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
  const outputs = {};
  const taskOutputs = {};
  for (const pass of passes) {
    mergeOutputs(outputs, pass.outputs);
    mergeOutputs(taskOutputs, pass.taskOutputs);
  }
  const executed = passes.flatMap((pass) => pass.executed);
  const definedNodes = [...new Set(passes.flatMap((pass) => pass.definedNodes))];
  const coveredNodes = [...new Set(executed)];
  const coveredSet = new Set(coveredNodes);
  const definedSet = new Set(definedNodes);
  const allowUnreached = [...options.allowUnreached ?? []];
  const expectedNodes = [.../* @__PURE__ */ new Set([...options.expectedNodes ?? [], ...allowUnreached])];
  const result = {
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
    allowUnreached
  };
  if (options.assert !== false) expectFullCoverage(result);
  return result;
}
function expectFullCoverage(result) {
  const failures = [];
  const unfinished = result.passes.filter((pass) => pass.status !== "finished");
  if (unfinished.length > 0) {
    failures.push(
      `unfinished passes: ${unfinished.map((pass) => `${pass.passIndex} (${JSON.stringify(pass.status)})`).join(", ")}`
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
      `invalid structured outputs: ${invalid.map((item) => `${item.nodeId} (${item.message ?? "invalid"})`).join(", ")}`
    );
  }
  if (result.errors.length > 0) {
    failures.push(
      `errors: ${result.errors.map((item) => `${item.nodeId ? `${item.nodeId}: ` : ""}${item.message}`).join("; ")}`
    );
  }
  if (failures.length > 0) {
    throw new WorkflowCoverageError(`Workflow coverage failed:
- ${failures.join("\n- ")}`, result);
  }
  return result;
}
export {
  WorkflowCoverageError,
  coverWorkflow,
  expectFullCoverage
};
