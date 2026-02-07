import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, GenerateTextResult, StreamTextResult, ModelMessage } from "ai";
import { getToolContext } from "../tools/context";

type TimeoutInput = number | { totalMs?: number } | undefined;

type BaseCliAgentOptions = {
  id?: string;
  model?: string;
  systemPrompt?: string;
  instructions?: string;
  cwd?: string;
  env?: Record<string, string>;
  yolo?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  extraArgs?: string[];
};

type ClaudeCodeAgentOptions = BaseCliAgentOptions & {
  addDir?: string[];
  agent?: string;
  agents?: Record<string, { description?: string; prompt?: string }> | string;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  betas?: string[];
  chrome?: boolean;
  continue?: boolean;
  dangerouslySkipPermissions?: boolean;
  debug?: boolean | string;
  debugFile?: string;
  disableSlashCommands?: boolean;
  disallowedTools?: string[];
  fallbackModel?: string;
  file?: string[];
  forkSession?: boolean;
  fromPr?: string;
  ide?: boolean;
  includePartialMessages?: boolean;
  inputFormat?: "text" | "stream-json";
  jsonSchema?: string;
  maxBudgetUsd?: number;
  mcpConfig?: string[];
  mcpDebug?: boolean;
  model?: string;
  noChrome?: boolean;
  noSessionPersistence?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  permissionMode?: "acceptEdits" | "bypassPermissions" | "default" | "delegate" | "dontAsk" | "plan";
  pluginDir?: string[];
  replayUserMessages?: boolean;
  resume?: string;
  sessionId?: string;
  settingSources?: string;
  settings?: string;
  strictMcpConfig?: boolean;
  systemPrompt?: string;
  tools?: string[] | "default" | "";
  verbose?: boolean;
};

type CodexConfigOverrides = Record<string, string | number | boolean | object | null> | string[];

type CodexAgentOptions = BaseCliAgentOptions & {
  config?: CodexConfigOverrides;
  enable?: string[];
  disable?: string[];
  image?: string[];
  model?: string;
  oss?: boolean;
  localProvider?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  profile?: string;
  fullAuto?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  cd?: string;
  skipGitRepoCheck?: boolean;
  addDir?: string[];
  outputSchema?: string;
  color?: "always" | "never" | "auto";
  json?: boolean;
  outputLastMessage?: string;
};

type GeminiAgentOptions = BaseCliAgentOptions & {
  debug?: boolean;
  model?: string;
  sandbox?: boolean;
  yolo?: boolean;
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
  experimentalAcp?: boolean;
  allowedMcpServerNames?: string[];
  allowedTools?: string[];
  extensions?: string[];
  listExtensions?: boolean;
  resume?: string;
  listSessions?: boolean;
  deleteSession?: string;
  includeDirectories?: string[];
  screenReader?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
};

type PromptParts = {
  prompt: string;
  systemFromMessages?: string;
};

type RunCommandOptions = {
  cwd: string;
  env: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
};

type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

function resolveTimeoutMs(timeout: TimeoutInput, fallback?: number): number | undefined {
  if (typeof timeout === "number") return timeout;
  if (timeout && typeof timeout === "object" && typeof timeout.totalMs === "number") return timeout.totalMs;
  return fallback;
}

function combineNonEmpty(parts: Array<string | undefined>): string | undefined {
  const filtered = parts.map((part) => (part ?? "").trim()).filter(Boolean);
  return filtered.length ? filtered.join("\n\n") : undefined;
}

function contentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .join("");
  }
  if (content == null) return "";
  return String(content);
}

function extractPrompt(options: any): PromptParts {
  if (!options) return { prompt: "" };
  if ("prompt" in options) {
    const promptInput = options.prompt;
    if (typeof promptInput === "string") {
      return { prompt: promptInput };
    }
    if (Array.isArray(promptInput)) {
      return messagesToPrompt(promptInput as ModelMessage[]);
    }
    return { prompt: "" };
  }
  if (Array.isArray(options.messages)) {
    return messagesToPrompt(options.messages as ModelMessage[]);
  }
  return { prompt: "" };
}

function messagesToPrompt(messages: ModelMessage[]): PromptParts {
  const systemParts: string[] = [];
  const promptParts: string[] = [];
  for (const msg of messages) {
    const text = contentToText((msg as any).content);
    if (!text) continue;
    const role = (msg as any).role;
    if (role === "system") {
      systemParts.push(text);
      continue;
    }
    if (role) {
      promptParts.push(`${String(role).toUpperCase()}: ${text}`);
    } else {
      promptParts.push(text);
    }
  }
  return {
    prompt: promptParts.join("\n\n"),
    systemFromMessages: systemParts.length ? systemParts.join("\n\n") : undefined,
  };
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractTextFromJsonValue(value: any): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    const parts = value.content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
      })
      .join("");
    if (parts.trim()) return parts;
  }
  if (value.message) return extractTextFromJsonValue(value.message);
  if (value.result) return extractTextFromJsonValue(value.result);
  if (value.output) return extractTextFromJsonValue(value.output);
  if (value.data) return extractTextFromJsonValue(value.data);
  return undefined;
}

function extractTextFromJsonPayload(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return extractTextFromJsonValue(parsed);
  } catch {
    // Possibly JSONL
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const chunks: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const text = extractTextFromJsonValue(parsed);
      if (text) chunks.push(text);
    } catch {
      continue;
    }
  }
  return chunks.length ? chunks.join("") : undefined;
}

function truncateToBytes(text: string, maxBytes?: number): string {
  if (!maxBytes || maxBytes <= 0) return text;
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8");
}

function emptyUsage() {
  return {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens: undefined,
  };
}

function buildGenerateResult(text: string, output: unknown, modelId: string): GenerateTextResult<any, any> {
  const usage = emptyUsage();
  return {
    content: [{ type: "text", text }],
    text,
    reasoning: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls: [],
    staticToolCalls: [],
    dynamicToolCalls: [],
    toolResults: [],
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: "stop",
    rawFinishReason: undefined,
    usage,
    totalUsage: usage,
    warnings: undefined,
    request: {},
    response: {
      id: randomUUID(),
      timestamp: new Date(),
      modelId,
      messages: [],
    },
    providerMetadata: undefined,
    steps: [],
    experimental_output: output as any,
    output: output as any,
  } as GenerateTextResult<any, any>;
}

function asyncIterableToStream<T>(iterable: AsyncIterable<T>): ReadableStream<T> & AsyncIterable<T> {
  const stream = new ReadableStream<T>({
    async start(controller) {
      try {
        for await (const item of iterable) {
          controller.enqueue(item);
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
  });
  (stream as any)[Symbol.asyncIterator] = iterable[Symbol.asyncIterator].bind(iterable);
  return stream as any;
}

function buildStreamResult(result: GenerateTextResult<any, any>): StreamTextResult<any, any> {
  const text = result.text ?? "";
  const content = result.content ?? [];
  const steps = result.steps ?? [];
  const usage = result.usage ?? emptyUsage();
  const totalUsage = result.totalUsage ?? usage;
  const response = result.response ?? {
    id: randomUUID(),
    timestamp: new Date(),
    modelId: "unknown",
    messages: [],
  };
  const request = result.request ?? {};

  const textStream = asyncIterableToStream<string>(
    (async function* () {
      if (text) yield text;
    })(),
  );
  const fullStream = asyncIterableToStream<any>(
    (async function* () {
      const id = randomUUID();
      yield { type: "text-start", id };
      if (text) {
        yield { type: "text-delta", id, text };
      }
      yield { type: "text-end", id };
    })(),
  );

  return {
    content: Promise.resolve(content),
    text: Promise.resolve(text),
    reasoning: Promise.resolve(result.reasoning ?? []),
    reasoningText: Promise.resolve(result.reasoningText),
    files: Promise.resolve(result.files ?? []),
    sources: Promise.resolve(result.sources ?? []),
    toolCalls: Promise.resolve(result.toolCalls ?? []),
    staticToolCalls: Promise.resolve(result.staticToolCalls ?? []),
    dynamicToolCalls: Promise.resolve(result.dynamicToolCalls ?? []),
    staticToolResults: Promise.resolve(result.staticToolResults ?? []),
    dynamicToolResults: Promise.resolve(result.dynamicToolResults ?? []),
    toolResults: Promise.resolve(result.toolResults ?? []),
    finishReason: Promise.resolve(result.finishReason ?? "stop"),
    rawFinishReason: Promise.resolve(result.rawFinishReason),
    usage: Promise.resolve(usage),
    totalUsage: Promise.resolve(totalUsage),
    warnings: Promise.resolve(result.warnings),
    steps: Promise.resolve(steps),
    request: Promise.resolve(request),
    response: Promise.resolve(response),
    providerMetadata: Promise.resolve(result.providerMetadata),
    textStream: textStream as any,
    fullStream: fullStream as any,
  } as StreamTextResult<any, any>;
}

async function runCommand(command: string, args: string[], options: RunCommandOptions): Promise<RunCommandResult> {
  const { cwd, env, input, timeoutMs, signal, maxOutputBytes } = options;
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const onData = (chunk: Buffer, target: "stdout" | "stderr") => {
      const text = chunk.toString("utf8");
      const next = truncateToBytes(target === "stdout" ? stdout + text : stderr + text, maxOutputBytes);
      if (target === "stdout") stdout = next;
      else stderr = next;
    };

    child.stdout?.on("data", (chunk) => onData(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => onData(chunk, "stderr"));

    const finalize = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve({ stdout, stderr, exitCode: child.exitCode });
      }
    };

    const kill = (reason: string) => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finalize(new Error(reason));
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => kill(`CLI timed out after ${timeoutMs}ms`), timeoutMs);
    }

    if (signal) {
      if (signal.aborted) {
        kill("CLI aborted");
      } else {
        signal.addEventListener("abort", () => kill("CLI aborted"), { once: true });
      }
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      finalize(err);
    });
    child.on("close", () => {
      if (timer) clearTimeout(timer);
      finalize();
    });

    if (input) {
      child.stdin?.write(input);
    }
    child.stdin?.end();
  });
}

abstract class BaseCliAgent implements Agent<any, any, any> {
  readonly version = "agent-v1" as const;
  readonly tools: Record<string, never> = {};
  readonly id?: string;
  protected readonly model?: string;
  protected readonly systemPrompt?: string;
  protected readonly cwd?: string;
  protected readonly env?: Record<string, string>;
  protected readonly yolo: boolean;
  protected readonly timeoutMs?: number;
  protected readonly maxOutputBytes?: number;
  protected readonly extraArgs?: string[];

  constructor(opts: BaseCliAgentOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt ?? opts.instructions;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.yolo = opts.yolo ?? true;
    this.timeoutMs = opts.timeoutMs;
    this.maxOutputBytes = opts.maxOutputBytes;
    this.extraArgs = opts.extraArgs;
  }

  async generate(options: any): PromiseLike<GenerateTextResult<any, any>> {
    const { prompt, systemFromMessages } = extractPrompt(options);
    const callTimeout = resolveTimeoutMs(options?.timeout, this.timeoutMs);
    const cwd = this.cwd ?? getToolContext()?.rootDir ?? process.cwd();
    const env = { ...process.env, ...(this.env ?? {}) } as Record<string, string>;
    const combinedSystem = combineNonEmpty([this.systemPrompt, systemFromMessages]);
    const commandSpec = await this.buildCommand({
      prompt,
      systemPrompt: combinedSystem,
      cwd,
      options,
    });

    const result = await runCommand(commandSpec.command, commandSpec.args, {
      cwd,
      env,
      input: commandSpec.stdin,
      timeoutMs: callTimeout,
      signal: options?.abortSignal,
      maxOutputBytes: this.maxOutputBytes ?? getToolContext()?.maxOutputBytes,
    });

    const stdout = commandSpec.outputFile
      ? await fs.readFile(commandSpec.outputFile, "utf8").catch(() => result.stdout)
      : result.stdout;

    if (commandSpec.cleanup) {
      await commandSpec.cleanup();
    }

    if (result.exitCode && result.exitCode !== 0) {
      const errorText = result.stderr.trim() || result.stdout.trim() || `CLI exited with code ${result.exitCode}`;
      throw new Error(errorText);
    }

    const rawText = stdout.trim();
    const outputFormat = commandSpec.outputFormat;
    const extractedText =
      outputFormat === "json" || outputFormat === "stream-json"
        ? extractTextFromJsonPayload(rawText) ?? rawText
        : rawText;
    const output = tryParseJson(extractedText);
    return buildGenerateResult(extractedText, output, this.model ?? commandSpec.command);
  }

  async stream(options: any): PromiseLike<StreamTextResult<any, any>> {
    const result = await this.generate(options);
    return buildStreamResult(result);
  }

  protected abstract buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }): Promise<{
    command: string;
    args: string[];
    stdin?: string;
    outputFormat?: string;
    outputFile?: string;
    cleanup?: () => Promise<void>;
  }>;
}

function pushFlag(args: string[], flag: string, value?: string | number | boolean) {
  if (value === undefined) return;
  if (value === true) {
    args.push(flag);
  } else if (value === false) {
    return;
  } else {
    args.push(flag, String(value));
  }
}

function pushList(args: string[], flag: string, values?: string[]) {
  if (!values || values.length === 0) return;
  args.push(flag, ...values.map(String));
}

function normalizeCodexConfig(config?: CodexConfigOverrides): string[] {
  if (!config) return [];
  if (Array.isArray(config)) return config.map(String);
  const entries = Object.entries(config);
  return entries.map(([key, value]) => {
    if (value === null) return `${key}=null`;
    if (typeof value === "string") return `${key}=${value}`;
    if (typeof value === "number" || typeof value === "boolean") return `${key}=${value}`;
    return `${key}=${JSON.stringify(value)}`;
  });
}

export class ClaudeCodeAgent extends BaseCliAgent {
  private readonly opts: ClaudeCodeAgentOptions;

  constructor(opts: ClaudeCodeAgentOptions = {}) {
    super(opts);
    this.opts = opts;
  }

  protected async buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }) {
    const args: string[] = ["--print"];
    const outputFormat = this.opts.outputFormat ?? "text";

    pushList(args, "--add-dir", this.opts.addDir);
    pushFlag(args, "--agent", this.opts.agent);
    if (this.opts.agents) {
      const agentsJson = typeof this.opts.agents === "string" ? this.opts.agents : JSON.stringify(this.opts.agents);
      pushFlag(args, "--agents", agentsJson);
    }

    const yoloEnabled = this.opts.yolo ?? this.yolo;
    if (yoloEnabled) {
      args.push("--allow-dangerously-skip-permissions");
      args.push("--dangerously-skip-permissions");
      if (!this.opts.permissionMode) {
        args.push("--permission-mode", "bypassPermissions");
      }
    }

    if (this.opts.allowDangerouslySkipPermissions) args.push("--allow-dangerously-skip-permissions");
    if (this.opts.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    pushList(args, "--allowed-tools", this.opts.allowedTools);
    pushFlag(args, "--append-system-prompt", this.opts.appendSystemPrompt);
    pushList(args, "--betas", this.opts.betas);
    if (this.opts.chrome) args.push("--chrome");
    if (this.opts.noChrome) args.push("--no-chrome");
    if (this.opts.continue) args.push("--continue");
    if (this.opts.debug === true) {
      args.push("--debug");
    } else if (typeof this.opts.debug === "string") {
      pushFlag(args, "--debug", this.opts.debug);
    }
    pushFlag(args, "--debug-file", this.opts.debugFile);
    if (this.opts.disableSlashCommands) args.push("--disable-slash-commands");
    pushList(args, "--disallowed-tools", this.opts.disallowedTools);
    pushFlag(args, "--fallback-model", this.opts.fallbackModel);
    pushList(args, "--file", this.opts.file);
    if (this.opts.forkSession) args.push("--fork-session");
    pushFlag(args, "--from-pr", this.opts.fromPr);
    if (this.opts.ide) args.push("--ide");
    if (this.opts.includePartialMessages) args.push("--include-partial-messages");
    pushFlag(args, "--input-format", this.opts.inputFormat);
    pushFlag(args, "--json-schema", this.opts.jsonSchema);
    pushFlag(args, "--max-budget-usd", this.opts.maxBudgetUsd);
    pushList(args, "--mcp-config", this.opts.mcpConfig);
    if (this.opts.mcpDebug) args.push("--mcp-debug");
    pushFlag(args, "--model", this.opts.model ?? this.model);
    if (this.opts.noSessionPersistence) args.push("--no-session-persistence");
    pushFlag(args, "--output-format", outputFormat);
    pushFlag(args, "--permission-mode", this.opts.permissionMode);
    pushList(args, "--plugin-dir", this.opts.pluginDir);
    if (this.opts.replayUserMessages) args.push("--replay-user-messages");
    pushFlag(args, "--resume", this.opts.resume);
    pushFlag(args, "--session-id", this.opts.sessionId);
    pushFlag(args, "--setting-sources", this.opts.settingSources);
    pushFlag(args, "--settings", this.opts.settings);
    if (this.opts.strictMcpConfig) args.push("--strict-mcp-config");
    if (params.systemPrompt) {
      pushFlag(args, "--system-prompt", params.systemPrompt);
    }
    if (this.opts.tools !== undefined) {
      if (this.opts.tools === "") {
        pushFlag(args, "--tools", "");
      } else if (this.opts.tools === "default") {
        pushFlag(args, "--tools", "default");
      } else {
        pushList(args, "--tools", this.opts.tools as string[]);
      }
    }
    if (this.opts.verbose) args.push("--verbose");
    if (this.extraArgs?.length) args.push(...this.extraArgs);

    if (params.prompt) args.push(params.prompt);

    return {
      command: "claude",
      args,
      outputFormat,
    };
  }
}

export class CodexAgent extends BaseCliAgent {
  private readonly opts: CodexAgentOptions;

  constructor(opts: CodexAgentOptions = {}) {
    super(opts);
    this.opts = opts;
  }

  protected async buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }) {
    const args: string[] = ["exec"];
    const yoloEnabled = this.opts.yolo ?? this.yolo;

    const configOverrides = normalizeCodexConfig(this.opts.config);
    for (const entry of configOverrides) {
      args.push("-c", entry);
    }

    pushList(args, "--enable", this.opts.enable);
    pushList(args, "--disable", this.opts.disable);
    pushList(args, "--image", this.opts.image);
    pushFlag(args, "--model", this.opts.model ?? this.model);
    if (this.opts.oss) args.push("--oss");
    pushFlag(args, "--local-provider", this.opts.localProvider);
    pushFlag(args, "--sandbox", this.opts.sandbox);
    pushFlag(args, "--profile", this.opts.profile);
    if (this.opts.fullAuto) args.push("--full-auto");
    if (yoloEnabled || this.opts.dangerouslyBypassApprovalsAndSandbox) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    pushFlag(args, "--cd", this.opts.cd);
    if (this.opts.skipGitRepoCheck) args.push("--skip-git-repo-check");
    pushList(args, "--add-dir", this.opts.addDir);
    pushFlag(args, "--output-schema", this.opts.outputSchema);
    pushFlag(args, "--color", this.opts.color);
    if (this.opts.json) args.push("--json");

    const outputFile =
      this.opts.outputLastMessage ?? join(tmpdir(), `smithers-codex-${randomUUID()}.txt`);
    pushFlag(args, "--output-last-message", outputFile);

    if (this.extraArgs?.length) args.push(...this.extraArgs);

    const systemPrefix = params.systemPrompt ? `${params.systemPrompt}\n\n` : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;

    args.push("-");

    return {
      command: "codex",
      args,
      stdin: fullPrompt,
      outputFile,
      cleanup: async () => {
        if (!this.opts.outputLastMessage) {
          await fs.rm(outputFile, { force: true }).catch(() => undefined);
        }
      },
    };
  }
}

export class GeminiAgent extends BaseCliAgent {
  private readonly opts: GeminiAgentOptions;

  constructor(opts: GeminiAgentOptions = {}) {
    super(opts);
    this.opts = opts;
  }

  protected async buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }) {
    const args: string[] = [];
    const yoloEnabled = this.opts.yolo ?? this.yolo;
    const outputFormat = this.opts.outputFormat ?? "text";

    if (this.opts.debug) args.push("--debug");
    pushFlag(args, "--model", this.opts.model ?? this.model);
    if (this.opts.sandbox) args.push("--sandbox");
    if (this.opts.approvalMode) {
      pushFlag(args, "--approval-mode", this.opts.approvalMode);
    } else if (yoloEnabled) {
      args.push("--yolo");
    }
    if (this.opts.experimentalAcp) args.push("--experimental-acp");
    pushList(args, "--allowed-mcp-server-names", this.opts.allowedMcpServerNames);
    pushList(args, "--allowed-tools", this.opts.allowedTools);
    pushList(args, "--extensions", this.opts.extensions);
    if (this.opts.listExtensions) args.push("--list-extensions");
    pushFlag(args, "--resume", this.opts.resume);
    if (this.opts.listSessions) args.push("--list-sessions");
    pushFlag(args, "--delete-session", this.opts.deleteSession);
    pushList(args, "--include-directories", this.opts.includeDirectories);
    if (this.opts.screenReader) args.push("--screen-reader");
    pushFlag(args, "--output-format", outputFormat);
    if (this.extraArgs?.length) args.push(...this.extraArgs);

    const systemPrefix = params.systemPrompt ? `${params.systemPrompt}\n\n` : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;
    args.push("--prompt", fullPrompt);

    return {
      command: "gemini",
      args,
      outputFormat,
    };
  }
}
