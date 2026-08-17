import {
  BaseCliAgent,
  asString,
  createSyntheticIdGenerator,
  isRecord,
  pushFlag,
  truncate,
  toolKindFromName,
} from "./BaseCliAgent/index.js";
import { normalizeCapabilityStringList } from "./capability-registry/index.js";
import { zodToOpenAISchema } from "./zodToOpenAISchema.js";

/** @typedef {import("./GrokAgentOptions.ts").GrokAgentOptions} GrokAgentOptions */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */

/**
 * @param {GrokAgentOptions} [opts]
 * @returns {AgentCapabilityRegistry}
 */
export function createGrokCapabilityRegistry(opts = {}) {
  return {
    version: 1,
    engine: "grok",
    runtimeTools: {},
    mcp: {
      bootstrap: "project-config",
      supportsProjectScope: true,
      supportsUserScope: true,
    },
    skills: {
      supportsSkills: true,
      installMode: "dir",
      smithersSkillIds: [],
    },
    humanInteraction: {
      supportsUiRequests: false,
      methods: [],
    },
    fileChanges: {
      supportsFileChanges: false,
      supportsUnifiedDiff: false,
    },
    builtIns: opts.tools?.length ? normalizeCapabilityStringList(opts.tools) : ["default"],
  };
}

/**
 * Remove the configured API key from any vendor-controlled payload before it
 * can become an event, error, or persisted answer.
 *
 * @param {unknown} value
 * @param {string | undefined} secret
 * @returns {unknown}
 */
function redactCredential(value, secret) {
  if (!secret) return value;
  if (typeof value === "string") return value.split(secret).join("[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redactCredential(item, secret));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCredential(item, secret)]));
  }
  return value;
}

/** xAI Grok Build CLI adapter. */
export class GrokAgent extends BaseCliAgent {
  opts;
  capabilities;
  cliEngine = "grok";
  supportsNativeStructuredOutput = true;

  /** @param {GrokAgentOptions} [opts] */
  constructor(opts = {}) {
    super(opts, "GrokAgent");
    this.opts = opts;
    this.capabilities = createGrokCapabilityRegistry(opts);
  }

  /** @returns {CliOutputInterpreter} */
  createOutputInterpreter() {
    const apiKey = this.opts.apiKey ?? this.opts.env?.XAI_API_KEY ?? process.env.XAI_API_KEY;
    let emittedStarted = false;
    let didEmitCompleted = false;
    let finalAnswer = "";
    let sessionId;
    let terminalError;
    let terminalUsage;
    const nextSyntheticId = createSyntheticIdGenerator();
    const toolNames = new Map();

    const started = () => {
      if (emittedStarted) return [];
      emittedStarted = true;
      return [
        {
          type: "started",
          engine: this.cliEngine,
          title: "Grok Build",
          resume: sessionId,
          detail: { model: this.opts.model ?? this.model },
        },
      ];
    };

    /** @param {string} line */
    const parseLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let payload;
      try {
        payload = redactCredential(JSON.parse(trimmed), apiKey);
      } catch {
        return [];
      }
      if (!isRecord(payload)) return [];
      const type = asString(payload.type);
      if (!type) return [];
      const events = started();
      if (type === "text") {
        const text = asString(payload.data);
        if (text) {
          finalAnswer += text;
          events.push({
            type: "action",
            engine: this.cliEngine,
            phase: "updated",
            entryType: "message",
            action: {
              id: nextSyntheticId("grok-message"),
              kind: "note",
              title: "assistant",
              detail: {},
            },
            message: text,
            ok: true,
            level: "info",
          });
        }
        return events;
      }
      if (type === "thought") return events;
      if (type === "tool_call") {
        const id = asString(payload.toolCallId) ?? nextSyntheticId("grok-tool");
        const name = asString(payload.toolName) ?? asString(payload.title) ?? "tool";
        toolNames.set(id, name);
        events.push({
          type: "action",
          engine: this.cliEngine,
          phase: "started",
          entryType: "thought",
          action: {
            id,
            kind: toolKindFromName(name),
            title: name,
            detail: { input: payload.rawInput, locations: payload.locations },
          },
          message: `Running ${name}`,
          level: "info",
        });
        return events;
      }
      if (type === "tool_call_update") {
        const id = asString(payload.toolCallId) ?? nextSyntheticId("grok-tool");
        const name = toolNames.get(id) ?? "tool result";
        const status = asString(payload.status);
        const ok = status !== "failed" && status !== "error";
        if (status === "completed" || !ok) toolNames.delete(id);
        events.push({
          type: "action",
          engine: this.cliEngine,
          phase: status === "completed" || !ok ? "completed" : "updated",
          entryType: "thought",
          action: {
            id,
            kind: toolKindFromName(name),
            title: name,
            detail: { output: payload.rawOutput, locations: payload.locations },
          },
          message: typeof payload.rawOutput === "string" ? truncate(payload.rawOutput, 400) : undefined,
          ok,
          level: ok ? "info" : "warning",
        });
        return events;
      }
      if (type === "usage") {
        if (isRecord(payload.usage)) terminalUsage = payload.usage;
        return events;
      }
      if (type === "error") {
        terminalError = asString(payload.message) ?? "Grok Build failed";
        return events;
      }
      if (type === "end") {
        if (didEmitCompleted) return events;
        didEmitCompleted = true;
        sessionId = asString(payload.sessionId);
        if (isRecord(payload.usage)) terminalUsage = payload.usage;
        const structuredOutputError = asString(payload.structuredOutputError);
        if (structuredOutputError) terminalError = structuredOutputError;
        if (Object.hasOwn(payload, "structuredOutput") && !structuredOutputError) {
          finalAnswer = JSON.stringify(payload.structuredOutput);
        }
        events.push({
          type: "completed",
          engine: this.cliEngine,
          ok: !terminalError,
          answer: finalAnswer || undefined,
          error: terminalError,
          resume: sessionId,
          usage: terminalUsage,
        });
        return events;
      }
      return events;
    };

    return {
      onStdoutLine: parseLine,
      onExit: (result) => {
        if (didEmitCompleted) return [];
        didEmitCompleted = true;
        return [
          {
            type: "completed",
            engine: this.cliEngine,
            ok: result.exitCode === 0 && !terminalError,
            answer: finalAnswer || undefined,
            error:
              terminalError ??
              (result.exitCode === 0
                ? undefined
                : /** @type {string} */ (
                    redactCredential(result.stderr.trim() || `Grok exited with code ${result.exitCode}`, apiKey)
                  )),
            resume: sessionId,
            usage: terminalUsage,
          },
        ];
      },
    };
  }

  /** @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any }} params */
  async buildCommand(params) {
    const args = ["--no-auto-update", "--cwd", params.cwd, "--output-format", "streaming-json"];
    pushFlag(args, "--model", this.opts.model ?? this.model);
    pushFlag(args, "--effort", this.opts.effort);
    if (this.yolo) args.push("--yolo");
    pushFlag(args, "--sandbox", this.opts.sandbox);
    pushFlag(args, "--max-turns", this.opts.maxTurns);
    if (this.opts.tools?.length) pushFlag(args, "--tools", this.opts.tools.join(","));
    if (this.opts.disallowedTools?.length) pushFlag(args, "--disallowed-tools", this.opts.disallowedTools.join(","));
    if (this.opts.noPlan) args.push("--no-plan");
    if (this.opts.noSubagents) args.push("--no-subagents");
    if (this.opts.noMemory) args.push("--no-memory");
    if (this.opts.disableWebSearch) args.push("--disable-web-search");
    const rules = [params.systemPrompt, this.opts.rules].filter(Boolean).join("\n\n");
    pushFlag(args, "--rules", rules || undefined);
    const resumeSession = typeof params.options?.resumeSession === "string" ? params.options.resumeSession : undefined;
    if (resumeSession) pushFlag(args, "--resume", resumeSession);
    if (params.options?.outputSchema) {
      const jsonSchema = await zodToOpenAISchema(params.options.outputSchema);
      pushFlag(args, "--json-schema", JSON.stringify(jsonSchema));
    }
    if (this.extraArgs?.length) args.push(...this.extraArgs);
    pushFlag(args, "-p", params.prompt);
    return {
      command: "grok",
      args,
      outputFormat: "streaming-json",
      env: {
        ...(this.opts.configDir ? { GROK_HOME: this.opts.configDir } : {}),
        ...(this.opts.apiKey ? { XAI_API_KEY: this.opts.apiKey } : {}),
      },
    };
  }
}
