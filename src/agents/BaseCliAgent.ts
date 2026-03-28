import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import type {
  Agent,
  GenerateTextResult,
  StreamTextResult,
  ModelMessage,
} from "ai";
import { spawnCaptureEffect } from "../effect/child-process";
import { runPromise } from "../effect/runtime";
import { getToolContext } from "../tools/context";
import { SmithersError } from "../utils/errors";
import { extractTextFromJsonValue } from "../utils/text-extraction";
import { normalizeTokenUsage } from "../utils/usage";
import { launchDiagnostics, enrichReportWithErrorAnalysis } from "./diagnostics";

type TimeoutInput = number | { totalMs?: number; idleMs?: number } | undefined;

export type BaseCliAgentOptions = {
  id?: string;
  model?: string;
  systemPrompt?: string;
  instructions?: string;
  cwd?: string;
  env?: Record<string, string>;
  yolo?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  extraArgs?: string[];
};

// PiExtensionUiRequest is defined here because RunRpcCommandOptions references it.
// It is re-exported from PiAgent.ts for the public API barrel.
export type PiExtensionUiRequest = {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  placeholder?: string;
  [key: string]: unknown;
};

export type PiExtensionUiResponse = {
  type: "extension_ui_response";
  id: string;
  value?: string;
  cancelled?: boolean;
  [key: string]: unknown;
};

type RunRpcCommandOptions = {
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onExtensionUiRequest?: (request: PiExtensionUiRequest) =>
    | Promise<PiExtensionUiResponse | null>
    | PiExtensionUiResponse
    | null;
  onEvent?: (event: unknown) => void;
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
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

type CliCommandSpec = {
  command: string;
  args: string[];
  stdin?: string;
  outputFormat?: string;
  outputFile?: string;
  cleanup?: () => Promise<void>;
  env?: Record<string, string>;
  stdoutBannerPatterns?: RegExp[];
  stdoutErrorPatterns?: RegExp[];
  errorOnBannerOnly?: boolean;
};

export function resolveTimeouts(
  timeout: TimeoutInput,
  fallback?: { totalMs?: number; idleMs?: number },
): { totalMs?: number; idleMs?: number } {
  if (typeof timeout === "number") {
    return { totalMs: timeout };
  }
  if (timeout && typeof timeout === "object") {
    return {
      totalMs: typeof timeout.totalMs === "number" ? timeout.totalMs : fallback?.totalMs,
      idleMs: typeof timeout.idleMs === "number" ? timeout.idleMs : fallback?.idleMs,
    };
  }
  return {
    totalMs: fallback?.totalMs,
    idleMs: fallback?.idleMs,
  };
}

export function combineNonEmpty(parts: Array<string | undefined>): string | undefined {
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

export function extractPrompt(options: any): PromptParts {
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
    systemFromMessages: systemParts.length
      ? systemParts.join("\n\n")
      : undefined,
  };
}

export function tryParseJson(text: string): unknown | undefined {
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

export { extractTextFromJsonValue };

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

export function extractTextFromPiNdjson(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  let turnEndMessage: any = null;
  let agentEndMessage: any = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!);
      if (parsed.type === "turn_end" && parsed.message?.role === "assistant") {
        turnEndMessage = parsed.message;
        break;
      }
      if (parsed.type === "agent_end" && Array.isArray(parsed.messages)) {
        for (let j = parsed.messages.length - 1; j >= 0; j--) {
          const msg = parsed.messages[j];
          if (msg?.role === "assistant") {
            agentEndMessage = msg;
            break;
          }
        }
        if (agentEndMessage) break;
      }
    } catch {
      continue;
    }
  }

  const message = turnEndMessage ?? agentEndMessage;
  if (message) {
    const text = extractTextFromJsonValue(message);
    if (text) return text;
  }

  return extractTextFromJsonPayload(raw);
}

export function truncateToBytes(text: string, maxBytes?: number): string {
  if (!maxBytes || maxBytes <= 0) return text;
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8");
}

export type CliUsageInfo = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};

/**
 * Extract token usage from raw CLI stdout. Each CLI harness reports usage
 * differently:
 *  - Claude Code stream-json: `message_start` has input, `message_delta` has output
 *  - Codex --json: `turn.completed` has usage
 *  - Gemini json: top-level `stats.models` with per-model tokens
 *  - Generic: any NDJSON line with a `usage` object
 */
export function extractUsageFromOutput(raw: string): CliUsageInfo | undefined {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const usage: CliUsageInfo = {};
  let found = false;

  const addUsage = (next: CliUsageInfo | null | undefined) => {
    if (!next) return false;
    let changed = false;
    for (const [key, value] of Object.entries(next) as Array<
      [keyof CliUsageInfo, number | undefined]
    >) {
      if (typeof value !== "number" || value <= 0) continue;
      usage[key] = (usage[key] ?? 0) + value;
      changed = true;
    }
    return changed;
  };

  for (const line of lines) {
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== "object") continue;

    // Claude Code stream-json: message_start contains input token counts
    if (parsed.type === "message_start" && parsed.message?.usage) {
      const normalized = normalizeTokenUsage(parsed.message.usage);
      found = addUsage({
        inputTokens: normalized?.inputTokens,
        cacheReadTokens: normalized?.cacheReadTokens,
        cacheWriteTokens: normalized?.cacheWriteTokens,
      }) || found;
      continue;
    }

    // Claude Code stream-json: message_delta has output token count
    if (parsed.type === "message_delta" && parsed.usage) {
      const normalized = normalizeTokenUsage(parsed.usage);
      found = addUsage({
        outputTokens: normalized?.outputTokens,
      }) || found;
      continue;
    }

    // Codex --json: turn.completed event
    if (parsed.type === "turn.completed" && parsed.usage) {
      found = addUsage(normalizeTokenUsage(parsed.usage)) || found;
      continue;
    }

    // Generic: any event with a top-level "usage" containing token fields
    if (parsed.usage && typeof parsed.usage === "object") {
      found = addUsage(normalizeTokenUsage(parsed.usage)) || found;
      continue;
    }
  }

  // Gemini JSON output: single result object with stats.models map
  if (!found) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed?.stats?.models && typeof parsed.stats.models === "object") {
        for (const data of Object.values(parsed.stats.models as Record<string, any>)) {
          if (data?.tokens) {
            found = addUsage(normalizeTokenUsage(data.tokens)) || found;
          }
        }
      }
    } catch { /* not single JSON */ }
  }

  return found ? usage : undefined;
}

function createOneShotTimer(timeoutMs: number | undefined, onTimeout: () => void) {
  if (!timeoutMs || !Number.isFinite(timeoutMs)) {
    return { clear: () => {} };
  }
  const timer = setTimeout(onTimeout, timeoutMs);
  return {
    clear: () => clearTimeout(timer),
  };
}

function createInactivityTimer(timeoutMs: number | undefined, onTimeout: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!timeoutMs || !Number.isFinite(timeoutMs)) {
    return {
      reset: () => {},
      clear: () => {},
    };
  }

  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onTimeout, timeoutMs);
  };

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  reset();
  return { reset, clear };
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

export function buildGenerateResult(
  text: string,
  output: unknown,
  modelId: string,
  usage?: any,
): GenerateTextResult<any, any> {
  const finalUsage = usage ?? emptyUsage();
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
    usage: finalUsage,
    totalUsage: finalUsage,
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

function asyncIterableToStream<T>(
  iterable: AsyncIterable<T>,
): ReadableStream<T> & AsyncIterable<T> {
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
  (stream as any)[Symbol.asyncIterator] =
    iterable[Symbol.asyncIterator].bind(iterable);
  return stream as any;
}

export function buildStreamResult(
  result: GenerateTextResult<any, any>,
): StreamTextResult<any, any> {
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
  } as unknown as StreamTextResult<any, any>;
}

export function runCommandEffect(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Effect.Effect<RunCommandResult, Error> {
  const {
    cwd,
    env,
    input,
    timeoutMs,
    idleTimeoutMs,
    signal,
    maxOutputBytes,
    onStdout,
    onStderr,
  } = options;
  return spawnCaptureEffect(command, args, {
    cwd,
    env,
    input,
    signal,
    timeoutMs,
    idleTimeoutMs,
    maxOutputBytes,
    onStdout,
    onStderr,
  }).pipe(
    Effect.annotateLogs({
      agentCommand: command,
      agentArgs: args.join(" "),
      cwd,
    }),
    Effect.annotateSpans({
      agentCommand: command,
      agentArgs: args.join(" "),
      cwd,
    }),
    Effect.withLogSpan(`agent:${command}`),
    Effect.withSpan(`agent:${command}`, {
      attributes: {
        agentCommand: command,
        agentArgs: args.join(" "),
        cwd,
      },
    }),
  );
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  return runPromise(runCommandEffect(command, args, options));
}

export function runRpcCommandEffect(command: string, args: string[], options: RunRpcCommandOptions): Effect.Effect<{
   text: string;
   output: unknown;
   stderr: string;
   exitCode: number | null;
   usage?: any;
 }, Error> {
   const { cwd, env, prompt, timeoutMs, idleTimeoutMs, signal, maxOutputBytes, onStdout, onStderr, onExtensionUiRequest } = options;
   return Effect.async<{
     text: string;
     output: unknown;
     stderr: string;
     exitCode: number | null;
     usage?: any;
   }, Error>((resume) => {
     let stderr = "";
     let settled = false;
     let exitCode: number | null = null;
     let textDeltas = "";
     let finalMessage: unknown | null = null;
     let promptResponseError: string | null = null;
     let extractedUsage: any = undefined;
 
     const child = spawn(command, args, {
       cwd,
       env,
       stdio: ["pipe", "pipe", "pipe"],
     });
 
     const rl = createInterface({ input: child.stdout });
 
     const handleError = (err: Error) => {
       if (settled) return;
       settled = true;
       try {
         rl.close();
       } catch {
         // ignore
       }
       resume(Effect.fail(err));
     };

     const finalize = (text: string, output: unknown) => {
       if (settled) return;
       settled = true;
       try {
         rl.close();
       } catch {
         // ignore
       }
       resume(Effect.succeed({ text, output, stderr, exitCode: child.exitCode, usage: extractedUsage }));
     };

     const terminateChild = () => {
       try {
         child.kill("SIGTERM");
       } catch {
         // ignore
       }
       const killTimer = setTimeout(() => {
         try {
           child.kill("SIGKILL");
         } catch {
           // ignore
         }
       }, 250);
       child.once("close", () => clearTimeout(killTimer));
     };
 
     const kill = (reason: string) => {
       terminateChild();
       handleError(new Error(reason));
     };

     const totalTimeout = createOneShotTimer(timeoutMs, () =>
       kill(`CLI timed out after ${timeoutMs}ms`),
     );
     const inactivity = createInactivityTimer(idleTimeoutMs, () =>
       kill(`CLI idle timed out after ${idleTimeoutMs}ms`),
     );

     if (signal) {
       if (signal.aborted) {
         kill("CLI aborted");
       } else {
         signal.addEventListener("abort", () => kill("CLI aborted"), { once: true });
       }
     }
 
     const maybeWriteExtensionResponse = async (request: PiExtensionUiRequest) => {
       const needsResponse = ["select", "confirm", "input", "editor"].includes(request.method);
       if (!needsResponse && !onExtensionUiRequest) return;
 
       let response = onExtensionUiRequest ? await onExtensionUiRequest(request) : null;
       if (!response && needsResponse) {
         response = { type: "extension_ui_response", id: request.id, cancelled: true };
       }
       if (!response) return;
       const normalized = { ...response, id: request.id, type: "extension_ui_response" } as PiExtensionUiResponse;
      if (!child.stdin) {
        handleError(new Error("Failed to send extension UI response: child stdin is not available"));
        terminateChild();
        return;
      }
      child.stdin.write(`${JSON.stringify(normalized)}\n`);
     };
 
    const handleLine = async (line: string) => {
      inactivity.reset();
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      try {
        options.onEvent?.(parsed);
      } catch {
        // ignore observer errors
      }
      const event = parsed as Record<string, unknown>;
       const type = event.type;
       if (type === "response" && event.command === "prompt" && event.success === false) {
         const errorMessage = typeof event.error === "string" ? event.error : "PI RPC prompt failed";
         promptResponseError = errorMessage;
         kill(errorMessage);
         return;
       }
       if (type === "message_update") {
         const assistantEvent = (event as any).assistantMessageEvent as { type?: string; delta?: string } | undefined;
         if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
           textDeltas += assistantEvent.delta;
         }
       }
       if (type === "message_end") {
         const message = (event as any).message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
         if (message?.role === "assistant") {
           finalMessage = (event as any).message;
           if (message.stopReason === "error" || message.stopReason === "aborted") {
             promptResponseError = message.errorMessage || `Request ${message.stopReason}`;
           }
         }
       }
       if (event.usage) {
         extractedUsage = event.usage;
       }

       if (type === "turn_end") {
         const message = (event as any).message as { role?: string; stopReason?: string; errorMessage?: string; usage?: any } | undefined;
         if (message?.role === "assistant") {
           finalMessage = (event as any).message ?? finalMessage;
           if (message.usage) extractedUsage = message.usage;
           if (message.stopReason === "error" || message.stopReason === "aborted") {
             promptResponseError = message.errorMessage || `Request ${message.stopReason}`;
             inactivity.clear();
             totalTimeout.clear();
             handleError(new Error(promptResponseError));
             return;
           }
           // Do not finalize on tool-use turns. Pi continues with additional
           // turns after tool execution and only reaches the real final answer
           // on a later turn/agent_end.
           if (message.stopReason !== "toolUse") {
             const extracted = finalMessage ? extractTextFromJsonValue(finalMessage) : undefined;
             const text = extracted ?? textDeltas;
             inactivity.clear();
             totalTimeout.clear();
             finalize(text, finalMessage ?? text);
             child.stdin?.end();
             terminateChild();
             return;
           }
         }
       }
       if (type === "agent_end") {
         const messages = (event as any).messages as Array<any> | undefined;
         if (Array.isArray(messages)) {
           for (let i = messages.length - 1; i >= 0; i--) {
             const message = messages[i];
             if (message?.role === "assistant") {
               finalMessage = message;
               if (message.usage) extractedUsage = message.usage;
               if (message.stopReason === "error" || message.stopReason === "aborted") {
                 promptResponseError = message.errorMessage || `Request ${message.stopReason}`;
               }
               break;
             }
           }
         }
         if (promptResponseError) {
           inactivity.clear();
           totalTimeout.clear();
           handleError(new Error(promptResponseError));
           return;
         }
         const extracted = finalMessage ? extractTextFromJsonValue(finalMessage) : undefined;
         const text = extracted ?? textDeltas;
         inactivity.clear();
         totalTimeout.clear();
         finalize(text, finalMessage ?? text);
         child.stdin?.end();
         terminateChild();
         return;
       }
       if (type === "extension_ui_request") {
         await maybeWriteExtensionResponse(event as PiExtensionUiRequest);
       }
     };
 
     let lineQueue = Promise.resolve();
     rl.on("line", (line) => {
       lineQueue = lineQueue.then(() => handleLine(line)).catch((err) => {
         handleError(err instanceof Error ? err : new Error(String(err)));
       });
     });

     child.stdout?.on("data", (chunk) => {
       inactivity.reset();
       const text = chunk.toString("utf8");
       onStdout?.(text);
     });

     child.stderr?.on("data", (chunk) => {
       inactivity.reset();
       const text = chunk.toString("utf8");
       stderr = truncateToBytes(stderr + text, maxOutputBytes);
       onStderr?.(text);
     });

     child.on("error", (err) => {
       inactivity.clear();
       totalTimeout.clear();
       handleError(err);
     });

     child.on("close", (code) => {
       exitCode = code ?? null;
       inactivity.clear();
       totalTimeout.clear();
       if (settled) return;
       if (promptResponseError) {
         handleError(new Error(promptResponseError));
         return;
       }
       if (code && code !== 0) {
         handleError(new Error(stderr.trim() || `CLI exited with code ${code}`));
         return;
       }
       const text = finalMessage ? extractTextFromJsonValue(finalMessage) ?? textDeltas : textDeltas;
       finalize(text ?? "", finalMessage ?? text ?? "");
     });
 
     const promptPayload = { id: randomUUID(), type: "prompt", message: prompt };
     if (!child.stdin) {
       handleError(new Error("Child process stdin is not available; cannot send prompt payload."));
       return;
     }
     child.stdin.write(`${JSON.stringify(promptPayload)}\n`);
     return Effect.sync(() => {
       try {
         rl.close();
       } catch {
         // ignore
       }
       try {
         child.kill("SIGKILL");
       } catch {
         // ignore
       }
     });
   }).pipe(
     Effect.annotateLogs({
       agentCommand: command,
       agentArgs: args.join(" "),
       cwd,
       rpc: true,
     }),
     Effect.annotateSpans({
       agentCommand: command,
       agentArgs: args.join(" "),
       cwd,
       rpc: true,
     }),
     Effect.withLogSpan(`agent:${command}:rpc`),
     Effect.withSpan(`agent:${command}:rpc`, {
       attributes: {
         agentCommand: command,
         agentArgs: args.join(" "),
         cwd,
         rpc: true,
       },
     }),
   );
}

export async function runRpcCommand(command: string, args: string[], options: RunRpcCommandOptions): Promise<{
   text: string;
   output: unknown;
   stderr: string;
   exitCode: number | null;
   usage?: any;
 }> {
   return runPromise(runRpcCommandEffect(command, args, options));
}

export abstract class BaseCliAgent implements Agent<any, any, any> {
  readonly version = "agent-v1" as const;
  readonly tools: Record<string, never> = {};
  readonly id: string;
  protected readonly model?: string;
  protected readonly systemPrompt?: string;
  protected readonly cwd?: string;
  protected readonly env?: Record<string, string>;
  protected readonly yolo: boolean;
  protected readonly timeoutMs?: number;
  protected readonly idleTimeoutMs?: number;
  protected readonly maxOutputBytes?: number;
  protected readonly extraArgs?: string[];

  constructor(opts: BaseCliAgentOptions) {
    this.id = opts.id ?? randomUUID();
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt ?? opts.instructions;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.yolo = opts.yolo ?? true;
    this.timeoutMs = opts.timeoutMs;
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.maxOutputBytes = opts.maxOutputBytes;
    this.extraArgs = opts.extraArgs;
  }

  async generate(options: any): Promise<GenerateTextResult<any, any>> {
    const { prompt, systemFromMessages } = extractPrompt(options);
    const callTimeouts = resolveTimeouts(options?.timeout, {
      totalMs: this.timeoutMs,
      idleMs: this.idleTimeoutMs,
    });
    const cwd = this.cwd ?? getToolContext()?.rootDir ?? process.cwd();
    const env = { ...process.env, ...(this.env ?? {}) } as Record<
      string,
      string
    >;
    const combinedSystem = combineNonEmpty([
      this.systemPrompt,
      systemFromMessages,
    ]);
    const commandSpec = await this.buildCommand({
      prompt,
      systemPrompt: combinedSystem,
      cwd,
      options,
    });
    const commandEnv = commandSpec.env
      ? ({ ...env, ...commandSpec.env } as Record<string, string>)
      : env;

    // Launch diagnostics optimistically alongside the agent
    const diagnosticsPromise = launchDiagnostics(commandSpec.command, commandEnv, cwd);

    try {
      const result = await runCommand(commandSpec.command, commandSpec.args, {
        cwd,
        env: commandEnv,
        input: commandSpec.stdin,
        timeoutMs: callTimeouts.totalMs,
        idleTimeoutMs: callTimeouts.idleMs,
        signal: options?.abortSignal,
        maxOutputBytes: this.maxOutputBytes ?? getToolContext()?.maxOutputBytes,
        onStdout: options?.onStdout,
        onStderr: options?.onStderr,
      });

      const stdout = commandSpec.outputFile
        ? await fs
            .readFile(commandSpec.outputFile, "utf8")
            .catch(() => result.stdout)
        : result.stdout;

      function filterBenignStderr(stderr: string): string {
        const benignPatterns = [
          /^.*state db missing rollout path.*$/gm,
          /^.*codex_core::rollout::list.*$/gm,
          /^.*failed to record rollout items: failed to queue rollout items: channel closed.*$/gim,
          /^.*Failed to shutdown rollout recorder.*$/gm,
          /^.*failed to renew cache TTL: Operation not permitted.*$/gim,
        ];
        let filtered = stderr;
        for (const pattern of benignPatterns) {
          filtered = filtered.replace(pattern, "");
        }
        // Clean up extra blank lines
        return filtered.replace(/\n{3,}/g, "\n\n").trim();
      }

      if (result.exitCode && result.exitCode !== 0) {
        const filteredStderr = filterBenignStderr(result.stderr);
        if (!(commandSpec.command === "codex" && filteredStderr.length === 0)) {
          const errorText =
            filteredStderr ||
            result.stdout.trim() ||
            `CLI exited with code ${result.exitCode}`;
          throw new SmithersError("AGENT_CLI_ERROR", errorText);
        }
      }

      // Some CLIs may print extra banners to stdout. Allow individual agents
      // to provide patterns so this logic stays opt-in and agent-specific.
      const stdoutBannerPatterns = commandSpec.stdoutBannerPatterns ?? [];
      let cleanedStdout = stdout;
      for (const pattern of stdoutBannerPatterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        cleanedStdout = cleanedStdout.replace(regex, "");
      }
      const rawText = cleanedStdout.trim();

      // Optionally treat "banner-only" output as an error when requested.
      if (commandSpec.errorOnBannerOnly && !rawText && stdout.trim()) {
        throw new SmithersError(
          "AGENT_CLI_ERROR",
          `CLI agent error (stdout): output was only a banner with no model response`,
        );
      }

      // Some CLIs report failures on stdout even with exit code 0. Keep
      // detection patterns opt-in so normal model text is not misclassified.
      const stdoutErrorPatterns = commandSpec.stdoutErrorPatterns ?? [];
      if (rawText && !rawText.startsWith("{") && !rawText.startsWith("[")) {
        for (const pattern of stdoutErrorPatterns) {
          const regex = new RegExp(pattern.source, pattern.flags);
          if (regex.test(rawText)) {
            throw new SmithersError("AGENT_CLI_ERROR", `CLI agent error (stdout): ${rawText.slice(0, 500)}`);
          }
        }
      }

      const outputFormat = commandSpec.outputFormat;
      const extractedText =
        outputFormat === "json" || outputFormat === "stream-json"
          ? (extractTextFromJsonPayload(rawText) ?? rawText)
          : rawText;

      const output = tryParseJson(extractedText);
      // Extract token usage from raw stdout before text extraction strips it.
      // Each CLI harness embeds usage differently (NDJSON events, JSON stats, etc.)
      const cliUsage = extractUsageFromOutput(stdout);
      const usage = cliUsage ? {
        inputTokens: cliUsage.inputTokens,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: cliUsage.cacheReadTokens,
          cacheWriteTokens: cliUsage.cacheWriteTokens,
        },
        outputTokens: cliUsage.outputTokens,
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: cliUsage.reasoningTokens,
        },
        totalTokens: (cliUsage.inputTokens ?? 0) + (cliUsage.outputTokens ?? 0) || undefined,
      } : undefined;
      return buildGenerateResult(
        extractedText,
        output,
        this.model ?? commandSpec.command,
        usage,
      );
    } catch (err) {
      // Enrich error with diagnostics on failure
      if (diagnosticsPromise) {
        const report = await diagnosticsPromise.catch(() => null);
        if (report && err instanceof SmithersError) {
          enrichReportWithErrorAnalysis(report, err.message);
          err.details = { ...err.details, diagnostics: report };
        }
      }
      throw err;
    } finally {
      if (commandSpec.cleanup) {
        await commandSpec.cleanup().catch(() => undefined);
      }
    }
  }

  async stream(options: any): Promise<StreamTextResult<any, any>> {
    const result = await this.generate(options);
    return buildStreamResult(result);
  }

  protected abstract buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }): Promise<CliCommandSpec>;
}

export function pushFlag(
  args: string[],
  flag: string,
  value?: string | number | boolean,
) {
  if (value === undefined) return;
  if (value === true) {
    args.push(flag);
  } else if (value === false) {
    return;
  } else {
    args.push(flag, String(value));
  }
}

export function pushList(args: string[], flag: string, values?: string[]) {
  if (!values || values.length === 0) return;
  args.push(flag, ...values.map(String));
}

export type CodexConfigOverrides =
  | Record<string, string | number | boolean | object | null>
  | string[];

export function normalizeCodexConfig(config?: CodexConfigOverrides): string[] {
  if (!config) return [];
  if (Array.isArray(config)) return config.map(String);
  const entries = Object.entries(config);
  return entries.map(([key, value]) => {
    if (value === null) return `${key}=null`;
    if (typeof value === "string") return `${key}=${value}`;
    if (typeof value === "number" || typeof value === "boolean")
      return `${key}=${value}`;
    return `${key}=${JSON.stringify(value)}`;
  });
}
