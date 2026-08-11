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
async function writeFakeAgentFiles(rootDir, files) {
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
      await writeFakeAgentFiles(call.rootDir, response.files);
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

// src/agentTraceVector.ts
import { readFileSync } from "fs";
import { extname } from "path";
function flattenGeneratePrompt(args) {
  if (!args) return "";
  if (typeof args.prompt === "string") return args.prompt;
  if (Array.isArray(args.messages)) {
    return args.messages.map((m) => {
      if (!m || typeof m !== "object") return "";
      const c = m.content;
      return typeof c === "string" ? c : JSON.stringify(c ?? "");
    }).join("\n");
  }
  if (args.prompt != null) return JSON.stringify(args.prompt);
  return "";
}
function selectTurn(vector, used, ctx) {
  for (let i = 0; i < vector.turns.length; i++) {
    if (used.has(i)) continue;
    const turn = vector.turns[i];
    const w = turn.when;
    if (!w || Object.keys(w).length === 0) continue;
    if (w.callIndex !== void 0 && w.callIndex !== ctx.callIndex) continue;
    if (w.attempt !== void 0 && w.attempt !== ctx.attempt) continue;
    if (w.iteration !== void 0 && w.iteration !== ctx.iteration) continue;
    if (w.promptIncludes !== void 0 && !ctx.promptText.includes(w.promptIncludes)) continue;
    return { index: i, turn };
  }
  for (let i = 0; i < vector.turns.length; i++) {
    if (used.has(i)) continue;
    const turn = vector.turns[i];
    if (turn.when && Object.keys(turn.when).length > 0) continue;
    return { index: i, turn };
  }
  throw new Error(
    `Agent trace vector "${vector.id}": no matching unused turn for callIndex=${ctx.callIndex}` + (ctx.attempt !== void 0 ? ` attempt=${ctx.attempt}` : "") + (ctx.iteration !== void 0 ? ` iteration=${ctx.iteration}` : "") + (ctx.promptText ? ` promptExcerpt=${JSON.stringify(ctx.promptText.slice(0, 80))}` : "")
  );
}

// src/virtualClock.ts
function createVirtualClock(options = {}) {
  const mode = options.mode === "real" ? "real" : "virtual";
  let current = typeof options.startMs === "number" && Number.isFinite(options.startMs) ? options.startMs : 0;
  async function advance(ms) {
    const n = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (mode === "real") {
      if (n > 0) {
        await new Promise((r) => setTimeout(r, n));
      }
      return;
    }
    current += n;
  }
  return {
    mode,
    now() {
      return mode === "real" ? Date.now() : current;
    },
    advance,
    sleep: advance,
    setNow(ms) {
      if (mode === "virtual" && typeof ms === "number" && Number.isFinite(ms)) {
        current = ms;
      }
    }
  };
}

// src/scriptedAgent.ts
function abortableDelay(ms, signal) {
  return new Promise((resolve2, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const error = new Error("Scripted agent aborted during hang");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve2();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function scriptedAgent(vector, options = {}) {
  const clock = options.clock ?? createVirtualClock();
  const calls = [];
  const used = /* @__PURE__ */ new Set();
  let callIndex = 0;
  const agent = {
    id: options.id ?? `scripted:${vector.id}`,
    model: options.model ?? "scripted-agent",
    tools: {},
    supportsNativeStructuredOutput: options.supportsNativeStructuredOutput ?? true,
    calls,
    vector,
    clock,
    get usedTurnIndexes() {
      return used;
    },
    async generate(args = {}) {
      const rootDir = typeof args.rootDir === "string" ? args.rootDir : void 0;
      const taskContext = args.taskContext && typeof args.taskContext === "object" ? args.taskContext : void 0;
      const attempt = typeof taskContext?.attempt === "number" ? taskContext.attempt : typeof args.retryAttempt === "number" ? args.retryAttempt : void 0;
      const iteration = typeof taskContext?.iteration === "number" ? taskContext.iteration : void 0;
      const promptText = flattenGeneratePrompt(args);
      const call = {
        args,
        prompt: args.prompt,
        rootDir,
        taskContext
      };
      calls.push(call);
      const { index, turn } = selectTurn(vector, used, {
        callIndex,
        attempt,
        iteration,
        promptText
      });
      used.add(index);
      callIndex += 1;
      const onStdout = typeof args.onStdout === "function" ? args.onStdout : void 0;
      const onEvent = typeof args.onEvent === "function" ? args.onEvent : void 0;
      if (options.pacing) {
        const lo = Math.max(0, options.pacing.minMs);
        const hi = Math.max(lo, options.pacing.maxMs);
        const thinkMs = lo + Math.floor(Math.random() * (hi - lo + 1));
        onStdout?.(`[scripted] thinking ${thinkMs}ms\u2026
`);
        await clock.advance(thinkMs);
      }
      if (Array.isArray(turn.stream)) {
        for (const ev of turn.stream) {
          if (ev.t === "delay") {
            await clock.advance(ev.ms);
          } else if (ev.t === "text") {
            onStdout?.(ev.text);
            onEvent?.({ type: "text", text: ev.text });
            if (clock.mode === "real" && options.pacing) {
              await clock.advance(80 + Math.floor(Math.random() * 120));
            }
          } else if (ev.t === "tool_start") {
            onEvent?.({ type: "tool_start", name: ev.name, input: ev.input });
            onStdout?.(`[tool_start ${ev.name}]
`);
          } else if (ev.t === "tool_end") {
            onEvent?.({ type: "tool_end", name: ev.name, output: ev.output });
            onStdout?.(`[tool_end ${ev.name}]
`);
          } else if (ev.t === "progress") {
            onEvent?.({ type: "progress", message: ev.message });
            onStdout?.(`${ev.message}
`);
          }
        }
      }
      const result = turn.result;
      if (result.kind === "hang") {
        const ms = result.ms ?? 6e4;
        if (clock.mode === "real") {
          const signal = args.abortSignal;
          await abortableDelay(ms, signal);
        } else {
          await clock.advance(ms);
        }
        throw Object.assign(new Error(`Scripted agent hang after ${ms}ms (vector ${vector.id})`), {
          code: "AGENT_TIMEOUT",
          details: { failureRetryable: false }
        });
      }
      if (result.kind === "fail") {
        const err = Object.assign(new Error(result.error), {
          code: result.retryable === false ? "AGENT_SCRIPT_FAIL" : "AGENT_SCRIPT_FAIL_RETRYABLE",
          details: { failureRetryable: result.retryable === true ? void 0 : false }
        });
        if (result.retryable === true) {
          delete err.details.failureRetryable;
        }
        throw err;
      }
      let output = result.output;
      if (options.schema && output !== void 0) {
        const parsed = options.schema.safeParse(output);
        if (!parsed.success) {
          const issues = parsed.error.issues.map(
            (issue) => issue && typeof issue === "object" && "message" in issue ? String(issue.message) : JSON.stringify(issue)
          ).join("; ");
          throw new TypeError(`Scripted agent output failed validation: ${issues}`);
        }
        output = parsed.data;
      }
      await writeFakeAgentFiles(rootDir, result.files);
      const generated = {};
      if (output !== void 0) generated.output = output;
      if (typeof result.text === "string") generated.text = result.text;
      generated.text = generated.text ?? (typeof output === "object" && output !== null ? JSON.stringify(output) : typeof output === "string" ? output : `scripted:${vector.id}`);
      return {
        ...generated,
        response: {
          messages: [{ role: "assistant", content: generated.text }]
        }
      };
    },
    lastPrompt() {
      return calls.at(-1)?.prompt;
    },
    reset() {
      calls.length = 0;
      used.clear();
      callIndex = 0;
    }
  };
  return agent;
}
export {
  scriptedAgent
};
