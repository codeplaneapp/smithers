import {
  BaseCliAgent,
  pushFlag,
  pushList,
  isRecord,
  asString,
  truncate,
  toolKindFromName,
  shouldSurfaceUnparsedStdout,
  createSyntheticIdGenerator,
} from "./BaseCliAgent/index.js";

/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./BaseCliAgent/AgentCliEvent.ts").AgentCliEvent} AgentCliEvent */
/** @typedef {import("./CursorAgentOptions.ts").CursorAgentOptions} CursorAgentOptions */

/**
 * @param {CursorAgentOptions} opts
 * @returns {string[]}
 */
function resolveCursorBuiltIns(opts) {
  const mode = opts.mode ?? (opts.plan ? "plan" : undefined);
  const entries = ["default"];
  if (mode) entries.push(`mode:${mode}`);
  if (opts.force ?? opts.yolo ?? true) entries.push("force");
  if (opts.autoReview) entries.push("auto-review");
  return entries;
}

/**
 * @param {CursorAgentOptions} [opts]
 * @returns {AgentCapabilityRegistry}
 */
export function createCursorCapabilityRegistry(opts = {}) {
  return {
    version: 1,
    engine: "cursor",
    runtimeTools: {},
    mcp: {
      bootstrap: "project-config",
      supportsProjectScope: true,
      supportsUserScope: true,
    },
    skills: {
      supportsSkills: true,
      installMode: "files",
      smithersSkillIds: [],
    },
    humanInteraction: {
      supportsUiRequests: false,
      methods: [],
    },
    builtIns: resolveCursorBuiltIns(opts),
  };
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function textFromContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => (isRecord(entry) ? asString(entry.text) : undefined))
    .filter(Boolean)
    .join("");
}

export class CursorAgent extends BaseCliAgent {
  /** @type {CursorAgentOptions} */
  opts;
  /** @type {AgentCapabilityRegistry} */
  capabilities;
  /** @type {"cursor"} */
  cliEngine = "cursor";

  /**
   * @param {CursorAgentOptions} [opts]
   */
  constructor(opts = {}) {
    super(opts);
    this.opts = opts;
    this.capabilities = createCursorCapabilityRegistry(opts);
  }

  /**
   * @returns {CliOutputInterpreter}
   */
  createOutputInterpreter() {
    let sessionId;
    let finalAnswer = "";
    let didEmitStarted = false;
    let didEmitCompleted = false;
    const nextSyntheticId = createSyntheticIdGenerator();

    /**
     * @param {string} title
     * @param {string} message
     * @param {"info" | "warning" | "error" | "debug"} [level]
     * @returns {AgentCliEvent}
     */
    const action = (title, message, level = "info") => ({
      type: "action",
      engine: this.cliEngine,
      phase: "completed",
      entryType: "thought",
      action: {
        id: nextSyntheticId("cursor-action"),
        kind: level === "warning" || level === "error" ? "warning" : "note",
        title,
        detail: {},
      },
      message,
      ok: level !== "error",
      level,
    });

    /**
     * @returns {AgentCliEvent[]}
     */
    const startIfNeeded = () => {
      if (didEmitStarted) return [];
      didEmitStarted = true;
      return [{
        type: "started",
        engine: this.cliEngine,
        title: "Cursor",
        resume: sessionId,
        detail: sessionId ? { sessionId } : undefined,
      }];
    };

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
        return shouldSurfaceUnparsedStdout(trimmed)
          ? [action("stdout", truncate(trimmed, 220), "warning")]
          : [];
      }

      if (!isRecord(payload)) return [];
      const payloadType = asString(payload.type);
      if (!payloadType) return [];

      const parsedSessionId = asString(payload.session_id) ?? asString(payload.sessionId);
      if (parsedSessionId) sessionId = parsedSessionId;

      if (payloadType === "system" && asString(payload.subtype) === "init") {
        return startIfNeeded();
      }

      if (payloadType === "assistant") {
        const message = isRecord(payload.message) ? payload.message : {};
        const text = textFromContent(message.content) ?? asString(payload.text);
        if (!text?.trim()) return startIfNeeded();
        const isPartialDelta = payload.timestamp_ms != null && payload.model_call_id == null;
        finalAnswer = isPartialDelta ? `${finalAnswer}${text}` : text;
        return [
          ...startIfNeeded(),
          {
            type: "action",
            engine: this.cliEngine,
            phase: "updated",
            entryType: "message",
            action: {
              id: nextSyntheticId("cursor-message"),
              kind: "note",
              title: "assistant",
              detail: {},
            },
            message: text,
            ok: true,
            level: "info",
          },
        ];
      }

      if (payloadType === "thinking") {
        const text = asString(payload.text)?.trim();
        return [
          ...startIfNeeded(),
          {
            type: "action",
            engine: this.cliEngine,
            phase: asString(payload.subtype) === "completed" ? "completed" : "updated",
            entryType: "thought",
            action: {
              id: nextSyntheticId("cursor-thinking"),
              kind: "reasoning",
              title: "thinking",
              detail: { subtype: asString(payload.subtype) },
            },
            message: text || undefined,
            ok: asString(payload.subtype) === "completed" ? true : undefined,
            level: "info",
          },
        ];
      }

      if (payloadType === "tool_call") {
        const subtype = asString(payload.subtype);
        const rawName = asString(payload.name) ?? asString(payload.tool) ?? "tool";
        const name = rawName.endsWith("ToolCall")
          ? rawName.slice(0, -"ToolCall".length)
          : rawName;
        return [
          ...startIfNeeded(),
          {
            type: "action",
            engine: this.cliEngine,
            phase: subtype === "completed" ? "completed" : "started",
            entryType: "thought",
            action: {
              id: asString(payload.tool_call_id) ?? asString(payload.id) ?? nextSyntheticId("cursor-tool"),
              kind: toolKindFromName(name),
              title: name,
              detail: { arguments: payload.args ?? payload.arguments },
            },
            message: subtype === "completed" ? undefined : `Running ${name}`,
            ok: subtype === "completed" ? asString(payload.status) !== "failed" : undefined,
            level: subtype === "completed" && asString(payload.status) === "failed" ? "warning" : "info",
          },
        ];
      }

      if (payloadType === "result") {
        if (didEmitCompleted) return [];
        const resultText = asString(payload.result) ?? asString(payload.text);
        const errorText = asString(payload.error);
        const subtype = asString(payload.subtype);
        const ok = subtype !== "error" && !errorText;
        if (ok && resultText) finalAnswer = resultText;
        didEmitCompleted = true;
        return [
          ...startIfNeeded(),
          {
            type: "completed",
            engine: this.cliEngine,
            ok,
            answer: ok ? resultText || finalAnswer || undefined : undefined,
            error: ok ? undefined : errorText ?? resultText ?? "Cursor run failed",
            resume: sessionId,
            usage: isRecord(payload.usage) ? payload.usage : undefined,
          },
        ];
      }

      if (payloadType === "error") {
        if (didEmitCompleted) return [];
        didEmitCompleted = true;
        return [
          ...startIfNeeded(),
          {
            type: "completed",
            engine: this.cliEngine,
            ok: false,
            answer: finalAnswer || undefined,
            error: asString(payload.message) ?? "Cursor stream error",
            resume: sessionId,
          },
        ];
      }

      return startIfNeeded();
    };

    return {
      onStdoutLine: parseLine,
      onStderrLine: (line) => {
        const trimmed = line.trim();
        return trimmed ? [action("stderr", truncate(trimmed, 220), "warning")] : [];
      },
      onExit: (result) => {
        if (didEmitCompleted) return [];
        didEmitCompleted = true;
        const ok = (result.exitCode ?? 0) === 0;
        return [
          ...startIfNeeded(),
          {
            type: "completed",
            engine: this.cliEngine,
            ok,
            answer: ok ? finalAnswer || undefined : undefined,
            error: ok
              ? undefined
              : result.stderr?.trim() || `Cursor exited with code ${result.exitCode ?? -1}`,
            resume: sessionId,
          },
        ];
      },
    };
  }

  /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any }} params
   */
  async buildCommand(params) {
    const args = ["--print", "--output-format", "stream-json"];
    const streamPartialOutput = this.opts.streamPartialOutput ?? true;
    if (streamPartialOutput) args.push("--stream-partial-output");

    pushFlag(args, "--model", this.opts.model ?? this.model);
    const mode = this.opts.mode ?? (this.opts.plan ? "plan" : undefined);
    pushFlag(args, "--mode", mode);
    const yoloEnabled = this.opts.force ?? this.opts.yolo ?? this.yolo;
    if (yoloEnabled) args.push("--force");
    if (this.opts.autoReview) args.push("--auto-review");
    pushFlag(args, "--sandbox", this.opts.sandbox);
    if (this.opts.approveMcps) args.push("--approve-mcps");
    if (this.opts.trust ?? true) args.push("--trust");
    pushFlag(args, "--workspace", this.opts.workspace ?? params.cwd);
    pushList(args, "--plugin-dir", this.opts.pluginDir);

    const resumeSession = typeof params.options?.resumeSession === "string"
      ? params.options.resumeSession
      : undefined;
    const resume = resumeSession ?? this.opts.resume;
    if (resume === true) {
      args.push("--resume");
    } else {
      pushFlag(args, "--resume", typeof resume === "string" ? resume : undefined);
    }
    if (this.opts.continueSession || params.options?.continueSession) {
      args.push("--continue");
    }

    if (this.opts.worktree === true) {
      args.push("--worktree");
    } else {
      pushFlag(args, "--worktree", typeof this.opts.worktree === "string" ? this.opts.worktree : undefined);
    }
    pushFlag(args, "--worktree-base", this.opts.worktreeBase);
    if (this.opts.skipWorktreeSetup) args.push("--skip-worktree-setup");
    pushList(args, "--header", this.opts.header);
    if (this.extraArgs?.length) args.push(...this.extraArgs);

    const systemPrefix = params.systemPrompt
      ? `${params.systemPrompt}\n\n`
      : "";
    args.push("--");
    args.push(`${systemPrefix}${params.prompt ?? ""}`);

    const env = {};
    if (this.opts.apiKey) env.CURSOR_API_KEY = this.opts.apiKey;

    return {
      command: "cursor-agent",
      args,
      outputFormat: "stream-json",
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  }
}
