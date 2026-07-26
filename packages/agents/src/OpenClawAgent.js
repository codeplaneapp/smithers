import { BaseCliAgent, pushFlag, isRecord, asString, extractTextFromJsonValue } from "./BaseCliAgent/index.js";

/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./OpenClawAgentOptions.ts").OpenClawAgentOptions} OpenClawAgentOptions */

/**
 * Capability registry for the OpenClaw agent CLI.
 *
 * @returns {AgentCapabilityRegistry}
 */
export function createOpenClawCapabilityRegistry() {
  return {
    version: 1,
    engine: "openclaw",
    runtimeTools: {},
    mcp: {
      bootstrap: "project-config",
      supportsProjectScope: true,
      supportsUserScope: true,
    },
    skills: {
      supportsSkills: true,
      installMode: "plugin",
      smithersSkillIds: ["smithers-orchestrate"],
    },
    humanInteraction: {
      supportsUiRequests: false,
      methods: [],
    },
    builtIns: ["default"],
  };
}

/**
 * OpenClaw driven through its gateway-backed `openclaw agent` CLI.
 *
 * The command path mirrors OpenClaw's user-facing one-shot agent surface:
 *
 *   openclaw agent --agent <id> --message "<prompt>" --json
 *
 * It sends a Smithers task prompt into an OpenClaw agent session and returns the
 * final reply. OpenClaw itself owns its skills, tools, memory, channel context,
 * and gateway policy.
 */
export class OpenClawAgent extends BaseCliAgent {
  opts;
  /** @type {AgentCapabilityRegistry} */
  capabilities;
  cliEngine = "openclaw";
  /** @type {string | undefined} */
  issuedSessionId;

  /**
   * @param {OpenClawAgentOptions} [opts]
   */
  constructor(opts = {}) {
    super(opts);
    this.opts = opts;
    this.capabilities = createOpenClawCapabilityRegistry();
  }

  /**
   * @returns {CliOutputInterpreter}
   */
  createOutputInterpreter() {
    let emittedStarted = false;
    let sessionId = this.issuedSessionId;
    return {
      onStdoutLine: (line) => {
        sessionId = extractOpenClawSessionId(line) ?? sessionId;
        if (emittedStarted) return [];
        emittedStarted = true;
        return [
          {
            type: "started",
            engine: this.cliEngine,
            title: "OpenClaw",
            resume: sessionId,
          },
        ];
      },
      onExit: (result) => {
        sessionId = extractOpenClawSessionId(result.stdout) ?? sessionId;
        const started = !emittedStarted
          ? [
              {
                type: "started",
                engine: this.cliEngine,
                title: "OpenClaw",
                resume: sessionId,
              },
            ]
          : [];
        const ok = !result.exitCode || result.exitCode === 0;
        const answer = ok ? extractOpenClawAnswer(result.stdout) : undefined;
        return [
          ...started,
          {
            type: "completed",
            engine: this.cliEngine,
            ok,
            answer: answer || undefined,
            resume: sessionId,
            error: ok
              ? undefined
              : result.stderr.trim() ||
                extractOpenClawError(result.stdout) ||
                `OpenClaw exited with code ${result.exitCode}`,
          },
        ];
      },
    };
  }

  /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
  async buildCommand(params) {
    const args = ["agent"];

    const resumeSession = typeof params.options?.resumeSession === "string" ? params.options.resumeSession : undefined;
    const session = resumeSession ?? this.opts.sessionId ?? this.opts.session;
    this.issuedSessionId = session;

    pushFlag(args, "--agent", this.opts.agent);
    pushFlag(args, "--session-id", session);
    if (this.opts.continueSession) args.push("--continue");
    pushFlag(args, "--workspace", this.opts.workspace ?? params.cwd);

    if (this.opts.json !== false) args.push("--json");
    if (this.extraArgs?.length) args.push(...this.extraArgs);

    const systemPrefix = params.systemPrompt ? `${params.systemPrompt}\n\n` : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;
    pushFlag(args, "--message", fullPrompt);

    return {
      command: "openclaw",
      args,
      outputFormat: this.opts.json === false ? "text" : "json",
    };
  }
}

/**
 * @param {string} stdout
 */
function extractOpenClawAnswer(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  const parsed = parseJson(trimmed);
  if (!isRecord(parsed)) return trimmed;

  for (const key of ["text", "reply", "answer", "message", "output", "content", "payloads", "payload"]) {
    const value = parsed[key];
    const text = typeof value === "string" ? value : extractTextFromJsonValue(value);
    if (text) return text;
  }

  const result = parsed.result;
  if (isRecord(result)) {
    for (const key of ["text", "reply", "answer", "message", "output", "content", "payloads", "payload"]) {
      const value = result[key];
      const text = typeof value === "string" ? value : extractTextFromJsonValue(value);
      if (text) return text;
    }
  }

  return asString(parsed.id) ? JSON.stringify(parsed) : trimmed;
}

/**
 * @param {string} stdout
 */
function extractOpenClawError(stdout) {
  const parsed = parseJson(stdout.trim());
  if (!isRecord(parsed)) return "";
  return asString(parsed.error) ?? asString(parsed.message) ?? "";
}

/**
 * @param {string} stdout
 */
function extractOpenClawSessionId(stdout) {
  const parsed = parseJson(stdout.trim());
  if (!isRecord(parsed)) return undefined;
  return extractSessionIdFromRecord(parsed);
}

/**
 * @param {Record<string, unknown>} record
 * @returns {string | undefined}
 */
function extractSessionIdFromRecord(record) {
  const direct = asString(record.sessionId) ?? asString(record.session_id);
  if (direct) return direct;

  const session = record.session;
  if (typeof session === "string") return session;
  if (isRecord(session)) {
    const nested = extractSessionIdFromRecord(session);
    if (nested) return nested;
  }

  for (const key of ["meta", "result", "data"]) {
    const value = record[key];
    if (!isRecord(value)) continue;
    const nested = extractSessionIdFromRecord(value);
    if (nested) return nested;
  }

  return undefined;
}

/**
 * @param {string} raw
 */
function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
