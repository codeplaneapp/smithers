import { closeSync, constants as fsConstants, writeFileSync } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { zodSchemaToJsonExample } from "@smithers-orchestrator/components/zod-to-example";

type SafeParseSuccess<T> = { success: true; data: T };
type SafeParseFailure = { success: false; error: { issues: unknown[] } };

export type SafeSchema<T = unknown> = {
  safeParse(value: unknown): SafeParseSuccess<T> | SafeParseFailure;
};

export type FakeAgentCall = {
  readonly args: Record<string, unknown>;
  readonly prompt: unknown;
  readonly rootDir?: string;
  readonly taskContext?: unknown;
};

export type FakeAgentFiles = Record<string, string | Uint8Array>;

export type FakeAgentResult<T> = {
  output?: T;
  text?: string;
  files?: FakeAgentFiles;
};

type FakeAgentScriptFn<T> = (
  args: Record<string, unknown>,
) => FakeAgentResult<T> | T | AutoMock | Promise<FakeAgentResult<T> | T | AutoMock>;

export type FakeAgentScript<T> = AutoMock | FakeAgentResult<T> | T | FakeAgentScriptFn<T>;

export type FakeAgentOptions = {
  id?: string;
  model?: string;
  supportsNativeStructuredOutput?: boolean;
};

export type FakeAgent<T> = {
  id: string;
  model: string;
  tools: Record<string, unknown>;
  supportsNativeStructuredOutput: boolean;
  calls: FakeAgentCall[];
  generate(args?: Record<string, unknown>): Promise<FakeAgentResult<T>>;
  lastPrompt(): unknown;
  reset(): void;
};

const autoMarker = Symbol.for("smithers.testing.auto");

export type AutoMock = {
  readonly [autoMarker]: true;
};

export const auto: AutoMock = Object.freeze({
  [autoMarker]: true,
});

export function isAuto(value: unknown): value is AutoMock {
  return Boolean(
    value && typeof value === "object" && (value as Record<typeof autoMarker, unknown>)[autoMarker] === true,
  );
}

function schemaExample<T>(schema: SafeSchema<T>): T {
  const raw = zodSchemaToJsonExample(schema as Parameters<typeof zodSchemaToJsonExample>[0]);
  const parsed = JSON.parse(raw);
  return assertSchema(schema, parsed);
}

function formatIssues(issues: unknown[]): string {
  if (issues.length === 0) return "unknown validation failure";
  return issues
    .map((issue) => {
      if (issue && typeof issue === "object" && "message" in issue) {
        return String((issue as { message?: unknown }).message);
      }
      return JSON.stringify(issue);
    })
    .join("; ");
}

function assertSchema<T>(schema: SafeSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new TypeError(`Fake agent output failed validation: ${formatIssues(result.error.issues)}`);
}

function hasResponseKeys(value: unknown): value is FakeAgentResult<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "output" in value || "text" in value || "files" in value;
}

function normalizeResult<T>(schema: SafeSchema<T>, result: FakeAgentResult<T> | T | AutoMock): FakeAgentResult<T> {
  if (isAuto(result)) {
    return { output: schemaExample(schema) };
  }
  // A text/files-only value is an explicit response wrapper. Handle it before
  // probing the value as a bare output: permissive schemas otherwise accept
  // the wrapper itself and silently discard its declared files.
  if (hasResponseKeys(result) && !("output" in result)) {
    const response: FakeAgentResult<T> = {};
    if (typeof result.text === "string") response.text = result.text;
    if (result.files) response.files = result.files;
    return response;
  }
  // Disambiguate the {output,text,files} wrapper from a bare task output.
  // Treat it as a wrapper only when it carries wrapper keys AND its nested
  // `output` validates as the schema — this dominates both tricky cases: a
  // genuine wrapper's `output` matches the schema (so files/text are honored
  // even under a permissive/all-optional schema), while a bare output whose own
  // fields happen to be named output/text/files does NOT have a nested `output`
  // that validates, so it falls through to the bare-output path below.
  if (hasResponseKeys(result) && "output" in result) {
    const parsedOutput = schema.safeParse(result.output);
    if (parsedOutput.success) {
      const response: FakeAgentResult<T> = { output: parsedOutput.data };
      if (typeof result.text === "string") response.text = result.text;
      if (result.files) response.files = result.files;
      return response;
    }
  }
  // Otherwise interpret the whole value as the bare task output when it validates.
  const asOutput = schema.safeParse(result);
  if (asOutput.success) {
    return { output: asOutput.data };
  }
  // A wrapper with an invalid nested output, or a bad bare output
  // (assertSchema throws a clear validation error).
  if (hasResponseKeys(result)) {
    const response: FakeAgentResult<T> = {};
    if ("output" in result) response.output = assertSchema(schema, result.output);
    if (typeof result.text === "string") response.text = result.text;
    if (result.files) response.files = result.files;
    return response;
  }
  return { output: assertSchema(schema, result) };
}

function assertSafeRelativePath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes("..")) {
    throw new TypeError(`Fake agent file path must stay inside rootDir: ${path}`);
  }
}

function unsafeFilePath(path: string): TypeError {
  return new TypeError(`Fake agent file path must stay inside rootDir: ${path}`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && ("code" in error || "errno" in error);
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureSafeParentDirectories(root: string, target: string, name: string): Promise<void> {
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
        // Another writer may have created this component after the lstat.
        if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      }
      stats = await lstat(current);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw unsafeFilePath(name);
    }
  }
}

async function writeFileWithoutFollowingSymlinks(
  root: string,
  target: string,
  name: string,
  contents: string | Uint8Array,
) {
  await ensureSafeParentDirectories(root, target, name);
  // Recheck every ancestor after directory creation to catch components that
  // were replaced while the parent directories were being prepared.
  await ensureSafeParentDirectories(root, target, name);

  const existingTarget = await lstatIfExists(target);
  if (existingTarget?.isSymbolicLink()) {
    throw unsafeFilePath(name);
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow, 0o666);
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

type PosixFs = {
  readonly openat: (...args: unknown[]) => number;
  readonly mkdirat: (directory: number, path: string, mode: number) => number;
  readonly errno: () => number;
  readonly errors: Record<string, number>;
};

let posixFsPromise: Promise<PosixFs> | undefined;

async function loadPosixFs(): Promise<PosixFs> {
  if (posixFsPromise) return posixFsPromise;
  posixFsPromise = import("koffi").then((module) => {
    const koffi = ("default" in module ? module.default : module) as typeof import("koffi");
    const libc = koffi.load(null);
    return {
      openat: libc.func("int openat(int dirfd, const char *path, int flags, ...)"),
      mkdirat: libc.func("int mkdirat(int dirfd, const char *path, int mode)"),
      errno: koffi.errno,
      errors: koffi.os.errno,
    };
  });
  return posixFsPromise;
}

function posixError(operation: string, path: string, errno: number): NodeJS.ErrnoException {
  const error = new Error(`${operation} failed for ${path} (errno ${errno})`) as NodeJS.ErrnoException;
  error.errno = errno;
  return error;
}

function isUnsafePosixError(posix: PosixFs, errno: number): boolean {
  return errno === posix.errors.ELOOP || errno === posix.errors.ENOTDIR;
}

function openAt(posix: PosixFs, directory: number, path: string, flags: number, mode?: number): number {
  const fd =
    mode === undefined ? posix.openat(directory, path, flags) : posix.openat(directory, path, flags, "int", mode);
  if (fd >= 0) return fd;
  throw posixError("openat", path, posix.errno());
}

function directoryOpenFlags(): number {
  return fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | closeOnExecFlag();
}

function closeOnExecFlag(): number {
  const constants = fsConstants as typeof fsConstants & { O_CLOEXEC?: number };
  return constants.O_CLOEXEC ?? 0;
}

function openExistingDirectoryAt(posix: PosixFs, directory: number, component: string, name: string): number {
  try {
    return openAt(posix, directory, component, directoryOpenFlags());
  } catch (error) {
    if (isErrnoException(error) && typeof error.errno === "number" && isUnsafePosixError(posix, error.errno)) {
      throw unsafeFilePath(name);
    }
    throw error;
  }
}

function openOrCreateDirectoryAt(posix: PosixFs, directory: number, component: string, name: string): number {
  try {
    return openExistingDirectoryAt(posix, directory, component, name);
  } catch (error) {
    if (!isErrnoException(error) || error.errno !== posix.errors.ENOENT) throw error;
  }

  if (posix.mkdirat(directory, component, 0o777) < 0) {
    const errno = posix.errno();
    if (errno !== posix.errors.EEXIST) throw posixError("mkdirat", component, errno);
  }
  return openExistingDirectoryAt(posix, directory, component, name);
}

function openCanonicalDirectory(posix: PosixFs, path: string, name: string): number {
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

async function openRootDirectory(posix: PosixFs, lexicalRoot: string): Promise<number> {
  const missing: string[] = [];
  let existing = lexicalRoot;
  let canonical: string;

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

function writeFileAt(posix: PosixFs, root: number, path: string, name: string, contents: string | Uint8Array): void {
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

    const flags =
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW | closeOnExecFlag();
    let file: number;
    try {
      file = openAt(posix, current, filename, flags, 0o666);
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

async function writeFiles(rootDir: string | undefined, files: FakeAgentFiles | undefined): Promise<void> {
  if (!files || Object.keys(files).length === 0) return;
  if (!rootDir) {
    throw new TypeError("Fake agent files require a rootDir");
  }
  const lexicalRoot = resolve(rootDir);
  if (process.platform === "win32") {
    await mkdir(lexicalRoot, { recursive: true });
    const root = await realpath(lexicalRoot);
    for (const [name, contents] of Object.entries(files)) {
      assertSafeRelativePath(name);
      const target = resolve(root, name);
      const rel = relative(root, target);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new TypeError(`Fake agent file path must stay inside rootDir: ${name}`);
      }
      await writeFileWithoutFollowingSymlinks(root, target, name, contents);
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

function buildFakeAgent<T>(
  schema: SafeSchema<T>,
  script: FakeAgentScript<T>,
  options: FakeAgentOptions = {},
): FakeAgent<T> {
  const calls: FakeAgentCall[] = [];
  const agent: FakeAgent<T> = {
    id: options.id ?? "fake-agent",
    model: options.model ?? "fake-agent",
    tools: {},
    supportsNativeStructuredOutput: options.supportsNativeStructuredOutput ?? true,
    calls,
    async generate(args = {}) {
      const call = {
        args,
        prompt: args.prompt,
        rootDir: typeof args.rootDir === "string" ? args.rootDir : undefined,
        taskContext: args.taskContext,
      };
      calls.push(call);
      const raw = typeof script === "function" ? await (script as FakeAgentScriptFn<T>)(args) : script;
      const response = normalizeResult(schema, raw);
      await writeFiles(call.rootDir, response.files);
      const generated: Record<string, unknown> = {};
      if ("output" in response) generated.output = response.output;
      if (response.text !== undefined) generated.text = response.text;
      return generated as FakeAgentResult<T>;
    },
    lastPrompt() {
      return calls.at(-1)?.prompt;
    },
    reset() {
      calls.length = 0;
    },
  };
  return agent;
}

function buildSequenceAgent<T>(
  schema: SafeSchema<T>,
  entries: readonly (FakeAgentResult<T> | T | AutoMock)[],
  options: FakeAgentOptions = {},
): FakeAgent<T> {
  let index = 0;
  return buildFakeAgent(
    schema,
    () => {
      if (index >= entries.length) {
        throw new Error(`Fake agent sequence exhausted after ${entries.length} call(s)`);
      }
      return entries[index++];
    },
    options,
  );
}

export const fakeAgent = Object.assign(buildFakeAgent, {
  sequence: buildSequenceAgent,
});
