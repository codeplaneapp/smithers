import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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

export type FakeAgentScript<T> =
  | AutoMock
  | FakeAgentResult<T>
  | T
  | FakeAgentScriptFn<T>;

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
  return Boolean(value && typeof value === "object" && (value as Record<typeof autoMarker, unknown>)[autoMarker] === true);
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

async function writeFiles(rootDir: string | undefined, files: FakeAgentFiles | undefined): Promise<void> {
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

function buildFakeAgent<T>(schema: SafeSchema<T>, script: FakeAgentScript<T>, options: FakeAgentOptions = {}): FakeAgent<T> {
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
