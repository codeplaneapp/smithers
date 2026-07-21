import { Effect } from "effect";
import { BaseCliAgent, asString, extractPrompt, pushFlag, resolveTimeouts, runAgentPromise, runRpcCommandEffect, buildGenerateResult, toolKindFromName } from "./BaseCliAgent/index.js";
import { normalizeCapabilityStringList } from "./capability-registry/index.js";

/** @typedef {import("./OmpAgentOptions.ts").OmpAgentOptions} OmpAgentOptions */
/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */

/** @param {OmpAgentOptions} [opts] @returns {AgentCapabilityRegistry} */
export function createOmpCapabilityRegistry(opts = {}) {
  return {
    version: 1,
    engine: "omp",
    runtimeTools: {},
    mcp: { bootstrap: "unsupported", supportsProjectScope: false, supportsUserScope: false },
    skills: { supportsSkills: !opts.noSkills, installMode: "files", smithersSkillIds: normalizeCapabilityStringList(opts.skills) },
    humanInteraction: { supportsUiRequests: false, methods: [] },
    builtIns: opts.noTools ? [] : normalizeCapabilityStringList(opts.tools?.length ? opts.tools : ["default"]),
  };
}

export class OmpAgent extends BaseCliAgent {
  /** @type {OmpAgentOptions} */ opts;
  /** @type {AgentCapabilityRegistry} */ capabilities;
  cliEngine = "omp";
  issuedSessionId;
  constructor(opts = {}) {
    super({ ...opts, yolo: opts.yolo ?? opts.autoApprove ?? false });
    this.opts = opts;
    this.capabilities = createOmpCapabilityRegistry(opts);
  }
  resolveMode(options) { return this.opts.mode ?? (options?.onEvent ? "json" : "text"); }
  buildArgs({ prompt, cwd, options, mode }) {
    const args = [];
    const { systemFromMessages } = extractPrompt(options);
    const resume = typeof options?.resumeSession === "string" ? options.resumeSession : this.opts.resume;
    this.issuedSessionId = resume;
    if (mode !== "rpc" && this.opts.print !== false) args.push("--print");
    if (mode !== "text") args.push("--mode", mode);
    pushFlag(args, "--model", this.opts.model ?? this.model);
    pushFlag(args, "--provider", this.opts.provider);
    pushFlag(args, "--api-key", this.opts.apiKey);
    pushFlag(args, "--system-prompt", this.opts.systemPrompt ?? this.systemPrompt);
    pushFlag(args, "--append-system-prompt", [this.opts.appendSystemPrompt, systemFromMessages].filter(Boolean).join("\n\n") || undefined);
    pushFlag(args, "--cwd", this.opts.cwd ?? cwd);
    if (resume) args.push("--resume", resume);
    else if (this.opts.continueSession || options?.continueSession) args.push("--continue");
    pushFlag(args, "--session-dir", this.opts.sessionDir);
    if (this.opts.noSession) args.push("--no-session");
    if (this.opts.tools?.length) args.push("--tools", this.opts.tools.join(","));
    if (this.opts.noTools) args.push("--no-tools");
    for (const value of this.opts.extensions ?? []) args.push("--extension", value);
    if (this.opts.noExtensions) args.push("--no-extensions");
    if (this.opts.skills?.length) args.push("--skills", this.opts.skills.join(","));
    if (this.opts.noSkills) args.push("--no-skills");
    pushFlag(args, "--thinking", this.opts.thinking);
    if (this.opts.hideThinking) args.push("--hide-thinking");
    if (this.opts.printThoughts) args.push("--print-thoughts");
    for (const value of this.opts.hooks ?? []) args.push("--hook", value);
    pushFlag(args, "--max-time", this.opts.maxTime == null ? undefined : String(this.opts.maxTime));
    if (this.opts.approvalMode) args.push("--approval-mode", this.opts.approvalMode);
    else if (this.opts.autoApprove || this.opts.yolo) args.push("--auto-approve");
    if (this.extraArgs?.length) args.push(...this.extraArgs);
    if (mode === "rpc" && options?.files?.length) throw new Error("OMP RPC mode does not support file arguments");
    if (mode !== "rpc" && prompt) args.push(prompt);
    return args;
  }
  createOutputInterpreter() {
    let answer = ""; let started = false; let completed = false;
    const eventsFor = (payload) => {
      if (!payload || typeof payload !== "object") return [];
      const events = [];
      const start = () => { if (!started) { started = true; events.push({ type: "started", engine: "omp", title: "OMP", resume: this.issuedSessionId }); } };
      start();
      if (payload.type === "session") this.issuedSessionId = asString(payload.id) ?? this.issuedSessionId;
      if (payload.type === "session_info_update") this.issuedSessionId = asString(payload.sessionId) ?? asString(payload.sessionFile) ?? this.issuedSessionId;
      if (payload.type === "response" && payload.command === "get_state") this.issuedSessionId = asString(payload.data?.sessionId) ?? this.issuedSessionId;
      const ae = payload.assistantMessageEvent;
      if (payload.type === "message_update" && ae?.type === "text_delta" && typeof ae.delta === "string") { answer += ae.delta; events.push({ type: "action", engine: "omp", phase: "updated", entryType: "message", action: { id: "omp-answer", kind: "turn", title: "assistant" }, message: ae.delta }); }
      if (payload.type === "tool_execution_start" || payload.type === "tool_execution_update" || payload.type === "tool_execution_end") {
        const name = asString(payload.toolName) ?? "tool"; const phase = payload.type === "tool_execution_start" ? "started" : payload.type === "tool_execution_end" ? "completed" : "updated";
        events.push({ type: "action", engine: "omp", phase, entryType: "thought", action: { id: asString(payload.toolCallId) ?? name, kind: toolKindFromName(name), title: name }, message: name, ok: payload.isError !== true });
      }
      if (payload.type === "agent_end" || payload.type === "prompt_result") {
        completed = true;
        const messages = Array.isArray(payload.messages) ? payload.messages : [payload.message];
        const assistant = messages.find((message) => message?.role === "assistant");
        const failed = assistant?.stopReason === "error" || assistant?.stopReason === "aborted";
        events.push({ type: "completed", engine: "omp", ok: !failed, answer: answer || undefined, error: failed ? (assistant.errorMessage || `Request ${assistant.stopReason}`) : undefined, resume: this.issuedSessionId });
      }
      return events;
    };
    return { onStdoutLine: (line) => { try { return eventsFor(JSON.parse(line)); } catch { return []; } }, onExit: (result) => completed ? [] : [{ type: "completed", engine: "omp", ok: (result.exitCode ?? 0) === 0, answer: answer || undefined, error: (result.exitCode ?? 0) === 0 ? undefined : result.stderr?.trim() || `omp exited with code ${result.exitCode}`, resume: this.issuedSessionId }] };
  }
  async buildCommand({ prompt, cwd, options }) {
    const mode = this.resolveMode(options);
    if (mode === "rpc") throw new Error("OMP RPC mode uses the custom RPC transport");
    return { command: "omp", args: this.buildArgs({ prompt, cwd, options, mode }), outputFormat: mode };
  }
  async generate(options = {}) {
    if (this.resolveMode(options) !== "rpc") return super.generate(options);
    if (options.files?.length) throw new Error("OMP RPC mode does not support file arguments");
    const { prompt } = extractPrompt(options);
    const cwd = this.cwd ?? options.rootDir ?? process.cwd();
    const env = { ...process.env, ...this.env };
    const timeouts = resolveTimeouts(options.timeout, { totalMs: this.timeoutMs, idleMs: this.idleTimeoutMs });
    const interpreter = this.createOutputInterpreter();
    const program = Effect.gen(this, function* () {
      const result = yield* runRpcCommandEffect("omp", this.buildArgs({ prompt, cwd, options, mode: "rpc" }), { cwd, env, prompt, timeoutMs: timeouts.totalMs, idleTimeoutMs: timeouts.idleMs, signal: options.abortSignal, maxOutputBytes: this.maxOutputBytes ?? options.maxOutputBytes, onStdout: options.onStdout, onStderr: options.onStderr, onProcess: options.onProcess, onJsonEvent: (event) => { for (const value of interpreter.onStdoutLine?.(JSON.stringify(event)) ?? []) void Promise.resolve(options.onEvent?.(value)).catch(() => undefined); } });
      for (const value of interpreter.onExit?.({ stdout: result.text, stderr: result.stderr, exitCode: result.exitCode }) ?? []) void Promise.resolve(options.onEvent?.(value)).catch(() => undefined);
      return buildGenerateResult(result.text, result.output, this.opts.model ?? "omp", result.usage);
    }.bind(this));
    return runAgentPromise(program);
  }
  diagnosticHints() { return { provider: this.opts.provider, model: this.opts.model ?? this.model, apiKey: this.opts.apiKey }; }
}
