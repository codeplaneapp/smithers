import { BaseCliAgent, pushFlag, isRecord, asString, createSyntheticIdGenerator } from "./BaseCliAgent/index.js";

/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./BaseCliAgent/AgentCliEvent.ts").AgentCliEvent} AgentCliEvent */
/** @typedef {import("./VibeAgentOptions.ts").VibeAgentOptions} VibeAgentOptions */

/**
 * @param {VibeAgentOptions} [opts]
 * @returns {AgentCapabilityRegistry}
 */
export function createVibeCapabilityRegistry(opts = {}) {
  return {
    version: 1,
    engine: "vibe",
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
    fileChanges: {
      supportsFileChanges: false,
      supportsUnifiedDiff: false,
    },
    builtIns: ["default"],
  };
}

export class VibeAgent extends BaseCliAgent {
  /** @type {VibeAgentOptions} */
  opts;
  /** @type {AgentCapabilityRegistry} */
  capabilities;
  /** @type {"vibe"} */
  cliEngine = "vibe";
  /** @type {string | undefined} */
  issuedSessionId;

  /**
   * @param {VibeAgentOptions} [opts]
   */
  constructor(opts = {}) {
    super({ ...opts, yolo: opts.yolo ?? false }, "VibeAgent");
    this.opts = opts;
    this.capabilities = createVibeCapabilityRegistry(opts);
  }

  /**
   * @returns {CliOutputInterpreter}
   */
  createOutputInterpreter() {
    let finalAnswer = "";
    let didEmitStarted = false;
    let didEmitCompleted = false;
    const nextSyntheticId = createSyntheticIdGenerator();

    /**
     * @param {string} line
     * @returns {AgentCliEvent[]}
     */
    const parseLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];

      /** @type {Record<string, unknown>} */
      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return [];
      }

      if (!isRecord(payload)) return [];
      const role = asString(payload.role);
      const content = asString(payload.content);
      if (role !== "assistant" || !content) return [];

      const events = [];

      if (!didEmitStarted) {
        didEmitStarted = true;
        events.push({
          type: "started",
          engine: this.cliEngine,
          title: "Vibe",
          resume: this.issuedSessionId,
        });
      }

      const id = nextSyntheticId("vibe-message");
      finalAnswer += content;

      events.push({
        type: "action",
        engine: this.cliEngine,
        phase: "updated",
        entryType: "message",
        action: { id, kind: "turn", title: "assistant" },
        message: content,
      });

      return events;
    };

    return {
      onStdoutLine: parseLine,

      onExit: (result) => {
        if (didEmitCompleted) return [];
        didEmitCompleted = true;

        const ok = (result.exitCode ?? 0) === 0;

        const events = [];
        if (!didEmitStarted) {
          events.push({
            type: "started",
            engine: this.cliEngine,
            title: "Vibe",
            resume: this.issuedSessionId,
          });
        }

        events.push({
          type: "completed",
          engine: this.cliEngine,
          ok,
          answer: ok ? finalAnswer || undefined : undefined,
          error: ok ? undefined : result.stderr?.trim() || `vibe exited with code ${result.exitCode ?? -1}`,
          resume: this.issuedSessionId,
        });

        return events;
      },
    };
  }

  /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any }} params
   */
  async buildCommand(params) {
    const args = [];

    const resumeSession = typeof params.options?.resumeSession === "string" ? params.options.resumeSession : undefined;
    const effectiveSession = resumeSession ?? this.opts.sessionId;
    this.issuedSessionId = effectiveSession;
    if (this.opts.continueSession && !effectiveSession) {
      args.push("-c");
    }
    pushFlag(args, "--resume", effectiveSession);

    pushFlag(args, "--agent", this.opts.agent);
    if (this.opts.maxTurns !== undefined) {
      args.push("--max-turns", String(this.opts.maxTurns));
    }
    if (this.opts.maxPrice !== undefined) {
      args.push("--max-price", String(this.opts.maxPrice));
    }
    if (this.opts.maxTokens !== undefined) {
      args.push("--max-tokens", String(this.opts.maxTokens));
    }
    if (this.opts.enabledTools?.length) {
      for (const tool of this.opts.enabledTools) {
        args.push("--enabled-tools", tool);
      }
    }

    args.push("--trust");
    args.push("--output", "streaming");
    pushFlag(args, "--workdir", params.cwd);

    if (this.extraArgs?.length) args.push(...this.extraArgs);

    const systemPrefix = params.systemPrompt ? `${params.systemPrompt}\n\n` : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;
    pushFlag(args, "--prompt", fullPrompt);

    return {
      command: "vibe",
      args,
      outputFormat: "stream-json",
    };
  }
}
