import {
  BaseCliAgent,
  pushFlag,
  isRecord,
  asString,
  truncate,
  toolKindFromName,
  createSyntheticIdGenerator,
} from "./BaseCliAgent/index.js";
import { normalizeCapabilityStringList } from "./capability-registry/index.js";

/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./PoolAgentOptions.ts").PoolAgentOptions} PoolAgentOptions */

/**
 * @param {PoolAgentOptions} [_opts]
 * @returns {AgentCapabilityRegistry}
 */
export function createPoolCapabilityRegistry(_opts = {}) {
  return {
    version: 1,
    engine: "pool",
    runtimeTools: {},
    mcp: {
      bootstrap: "project-config",
      supportsProjectScope: true,
      supportsUserScope: true,
    },
    skills: {
      supportsSkills: true,
      installMode: "plugin",
      smithersSkillIds: [],
    },
    humanInteraction: {
      supportsUiRequests: false,
      methods: [],
    },
    builtIns: normalizeCapabilityStringList([
      "default",
    ]),
  };
}

/**
 * Poolside's `pool` agent (Agent Context Protocol / ACP), driven through its CLI.
 *
 * Uses `pool exec -o json --unsafe-auto-allow` for headless, non-interactive
 * execution with streaming NDJSON output. Pool implements the Agent Context Protocol
 * (ACP) and provides built-in tools for file operations, bash, glob, grep, etc.
 *
 * Output format from pool exec -o json:
 *   {"reasoning":"...", "type":"reasoning"} - model thinking
 *   {"thought":"...", "type":"thought"} - assistant thoughts (streaming)
 *   {"args":{...}, "name":"<tool>", "type":"toolCall"} - tool invocation
 *   {"result":"...", "type":"toolCallResult"} - tool result
 *   {"args":{"success":true}, "name":"exit", "type":"toolCall"} - task completion
 */
export class PoolAgent extends BaseCliAgent {
  /** @type {PoolAgentOptions} */
  opts;
  /** @type {AgentCapabilityRegistry} */
  capabilities;
  /** @type {"pool"} */
  cliEngine = "pool";

  /**
   * @param {PoolAgentOptions} [opts]
   */
  constructor(opts = {}) {
    super({ ...opts, yolo: opts.yolo ?? true }); // pool uses --unsafe-auto-allow for non-interactive
    this.opts = opts;
    this.capabilities = createPoolCapabilityRegistry(opts);
  }

  /**
   * Create an output interpreter that parses Pool's NDJSON streaming format.
   *
   * @returns {CliOutputInterpreter}
   */
  createOutputInterpreter() {
    let didEmitStarted = false;
    let didEmitCompleted = false;
    let lastThought = "";
    let pendingToolCall = null;
    const nextSyntheticId = createSyntheticIdGenerator();

    /**
     * @param {string} title
     * @param {string} message
     * @param {"warning" | "error"} [level]
     * @returns {import("./BaseCliAgent/AgentCliEvent.ts").AgentCliEvent}
     */
    const warningAction = (title, message, level = "warning") => ({
      type: "action",
      engine: this.cliEngine,
      phase: "completed",
      entryType: "thought",
      action: {
        id: nextSyntheticId("pool-warning"),
        kind: "note",
        title,
        detail: {},
      },
      message,
      ok: level !== "error",
      level,
    });

    /**
     * @param {string} line
     * @returns {import("./BaseCliAgent/AgentCliEvent.ts").AgentCliEvent[]}
     */
    const parseLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return [];
      }

      if (!isRecord(payload)) return [];
      const eventType = asString(payload.type);
      if (!eventType) return [];

      // Emit started on first event if not yet emitted
      if (!didEmitStarted) {
        didEmitStarted = true;
        return [
          {
            type: "started",
            engine: this.cliEngine,
            title: "Pool",
          },
        ];
      }

      const events = [];

      // --- reasoning: model reasoning ---
      if (eventType === "reasoning") {
        const reasoning = asString(payload.reasoning);
        if (reasoning) {
          events.push({
            type: "action",
            engine: this.cliEngine,
            phase: "updated",
            entryType: "thought",
            action: {
              id: nextSyntheticId("pool-reasoning"),
              kind: "reasoning",
              title: "reasoning",
              detail: {},
            },
            message: truncate(reasoning, 500),
            ok: true,
            level: "info",
          });
        }
        return events;
      }

      // --- thought: assistant message ---
      if (eventType === "thought") {
        const thought = asString(payload.thought);
        if (thought) {
          lastThought = thought;
          events.push({
            type: "action",
            engine: this.cliEngine,
            phase: "updated",
            entryType: "message",
            action: {
              id: nextSyntheticId("pool-thought"),
              kind: "turn",
              title: "assistant",
              detail: {},
            },
            message: thought,
            ok: true,
            level: "info",
          });
        }
        return events;
      }

      // --- toolCall: tool invocation ---
      if (eventType === "toolCall") {
        const toolName = asString(payload.name) ?? "tool";
        const args = isRecord(payload.args) ? payload.args : {};

        // Track exit tool calls for task completion detection
        if (toolName === "exit") {
          const success = args && typeof args.success === "boolean" ? args.success : true;
          if (didEmitCompleted) return [];

          didEmitCompleted = true;
          return [
            {
              type: "completed",
              engine: this.cliEngine,
              ok: success,
              answer: lastThought || undefined,
            },
          ];
        }

        // Track pending tool call for result pairing
        pendingToolCall = {
          name: toolName,
          args,
        };

        events.push({
          type: "action",
          engine: this.cliEngine,
          phase: "started",
          entryType: "thought",
          action: {
            id: nextSyntheticId(`pool-tool-${toolName}`),
            kind: toolKindFromName(toolName),
            title: toolName,
            detail: { input: args },
          },
          message: `Running ${toolName}`,
          level: "info",
        });

        return events;
      }

      // --- toolCallResult: tool result ---
      if (eventType === "toolCallResult") {
        const result = asString(payload.result);
        const toolName = pendingToolCall?.name ?? "tool";

        // Check for tool error in result
        const isError = result && result.toLowerCase().includes("error:");

        events.push({
          type: "action",
          engine: this.cliEngine,
          phase: "completed",
          entryType: "thought",
          action: {
            id: nextSyntheticId(`pool-tool-${toolName}-result`),
            kind: toolKindFromName(toolName),
            title: toolName,
            detail: {},
          },
          message: result ? truncate(result, 300) : undefined,
          ok: !isError,
          level: isError ? "warning" : "info",
        });

        pendingToolCall = null;
        return events;
      }

      return [];
    };

    return {
      onStdoutLine: parseLine,

      onStderrLine: (line) => {
        const trimmed = line.trim();
        if (!trimmed) return [];
        return [warningAction("stderr", truncate(trimmed, 220), "warning")];
      },

      onExit: (result) => {
        if (didEmitCompleted) return [];
        didEmitCompleted = true;

        const ok = (result.exitCode ?? 0) === 0;

        // If no events were emitted yet, we still need to emit started
        const started = didEmitStarted
          ? []
          : [{
              type: "started",
              engine: this.cliEngine,
              title: "Pool",
            }];

        return [
          ...started,
          {
            type: "completed",
            engine: this.cliEngine,
            ok,
            answer: ok ? lastThought || undefined : undefined,
            error: ok
              ? undefined
              : result.stderr?.trim() || `Pool exited with code ${result.exitCode ?? -1}`,
          },
        ];
      },
    };
  }

  /**
   * Build the CLI command spec for `pool exec`.
   *
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any }} params
   */
  async buildCommand(params) {
    const args = ["exec"];
    const resumeSession = typeof params.options?.resumeSession === "string"
      ? params.options.resumeSession
      : undefined;

    // Output format: JSON for streaming NDJSON
    args.push("-o", "json");

    // Auto-allow for non-interactive mode
    args.push("--unsafe-auto-allow");

    // Working directory (pool exec uses -d/--directory)
    pushFlag(args, "-d", params.cwd);

    // Model selection
    pushFlag(args, "-m", this.opts.model ?? this.model);

    // Agent name (tenant mode)
    pushFlag(args, "-a", this.opts.agentName);

    // Session continuation (pool uses -r/--resume)
    if (resumeSession ?? this.opts.resume ?? this.opts.resumeSession) {
      pushFlag(args, "-r", resumeSession ?? this.opts.resume ?? this.opts.resumeSession);
    } else if (this.opts.continue) {
      pushFlag(args, "--continue", this.opts.continue);
    }

    // Sandbox mode
    pushFlag(args, "--sandbox", this.opts.sandbox);

    if (this.extraArgs?.length) {
      args.push(...this.extraArgs);
    }

    // System prompt prefix + user prompt
    const systemPrefix = params.systemPrompt
      ? `${params.systemPrompt}\n\n`
      : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;
    pushFlag(args, "-p", fullPrompt);

    return {
      command: "pool",
      args,
      outputFormat: "stream-json",
    };
  }
}
