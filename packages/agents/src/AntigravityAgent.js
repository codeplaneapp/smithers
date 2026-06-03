import { BaseCliAgent, pushFlag, pushList, isRecord, asString, truncate, toolKindFromName, createSyntheticIdGenerator, } from "./BaseCliAgent/index.js";
import { normalizeCapabilityStringList, } from "./capability-registry/index.js";
/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./AntigravityAgentOptions.ts").AntigravityAgentOptions} AntigravityAgentOptions */

/**
 * @param {AntigravityAgentOptions} opts
 */
function resolveAntigravityBuiltIns(opts) {
    return opts.allowedTools?.length
        ? normalizeCapabilityStringList(opts.allowedTools)
        : ["default"];
}

/**
 * @param {AntigravityAgentOptions} [opts]
 * @returns {AgentCapabilityRegistry}
 */
export function createAntigravityCapabilityRegistry(opts = {}) {
    return {
        version: 1,
        engine: "antigravity",
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
        builtIns: resolveAntigravityBuiltIns(opts),
    };
}

export class AntigravityAgent extends BaseCliAgent {
    opts;
    capabilities;
    cliEngine = "antigravity";
    /**
   * @param {AntigravityAgentOptions} [opts]
   */
    constructor(opts = {}) {
        super(opts);
        this.opts = opts;
        this.capabilities = createAntigravityCapabilityRegistry(opts);
    }
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter() {
        let sessionId;
        let finalAnswer = "";
        let didEmitCompleted = false;
        const nextSyntheticId = createSyntheticIdGenerator();
        /**
     * @param {string} line
     * @returns {AgentCliEvent[]}
     */
        const parseLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed)
                return [];
            let payload;
            try {
                payload = JSON.parse(trimmed);
            }
            catch {
                return [];
            }
            if (!isRecord(payload))
                return [];
            const type = asString(payload.type);
            if (!type)
                return [];
            if (type === "init") {
                const resume = asString(payload.session_id);
                if (resume) {
                    sessionId = resume;
                }
                return [{
                        type: "started",
                        engine: this.cliEngine,
                        title: "Antigravity CLI",
                        resume: sessionId,
                        detail: {
                            model: asString(payload.model),
                        },
                    }];
            }
            if (type === "MESSAGE") {
                const role = asString(payload.role);
                const content = asString(payload.content);
                if (role === "assistant" && content) {
                    if (payload.delta === true) {
                        finalAnswer += content;
                    }
                    else {
                        finalAnswer = content;
                    }
                }
                return [];
            }
            if (type === "TOOL_USE") {
                const toolName = asString(payload.tool_name) ?? "tool";
                const toolId = asString(payload.tool_id) ?? nextSyntheticId("antigravity-tool");
                return [{
                        type: "action",
                        engine: this.cliEngine,
                        phase: "started",
                        entryType: "thought",
                        action: {
                            id: toolId,
                            kind: toolKindFromName(toolName),
                            title: toolName,
                            detail: {
                                parameters: payload.parameters,
                            },
                        },
                        message: `Running ${toolName}`,
                        level: "info",
                    }];
            }
            if (type === "TOOL_RESULT") {
                const toolId = asString(payload.tool_id) ?? nextSyntheticId("antigravity-tool");
                const ok = asString(payload.status) !== "error";
                const error = isRecord(payload.error) ? asString(payload.error.message) : undefined;
                const output = asString(payload.output);
                return [{
                        type: "action",
                        engine: this.cliEngine,
                        phase: "completed",
                        entryType: "thought",
                        action: {
                            id: toolId,
                            kind: "tool",
                            title: "tool result",
                            detail: {
                                status: asString(payload.status),
                                output: output ? truncate(output, 400) : undefined,
                            },
                        },
                        message: error ?? output,
                        ok,
                        level: ok ? "info" : "warning",
                    }];
            }
            if (type === "ERROR") {
                return [{
                        type: "action",
                        engine: this.cliEngine,
                        phase: "completed",
                        entryType: "thought",
                        action: {
                            id: nextSyntheticId("antigravity-warning"),
                            kind: "warning",
                            title: "warning",
                            detail: {
                                severity: asString(payload.severity),
                            },
                        },
                        message: asString(payload.message),
                        ok: asString(payload.severity) !== "error",
                        level: asString(payload.severity) === "error" ? "error" : "warning",
                    }];
            }
            if (type === "RESULT") {
                if (didEmitCompleted)
                    return [];
                didEmitCompleted = true;
                return [{
                        type: "completed",
                        engine: this.cliEngine,
                        ok: asString(payload.status) !== "error",
                        answer: finalAnswer || asString(payload.response),
                        resume: sessionId,
                        usage: isRecord(payload.stats) ? payload.stats : undefined,
                    }];
            }
            return [];
        };
        return {
            onStdoutLine: parseLine,
            onExit: (result) => {
                if (didEmitCompleted)
                    return [];
                if (result.exitCode === 0)
                    return [];
                didEmitCompleted = true;
                return [{
                        type: "completed",
                        engine: this.cliEngine,
                        ok: false,
                        answer: finalAnswer || undefined,
                        error: result.stderr.trim() || `Antigravity exited with code ${result.exitCode}`,
                        resume: sessionId,
                    }];
            },
        };
    }
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
    async buildCommand(params) {
        const args = [];
        const yoloEnabled = this.opts.dangerouslySkipPermissions ?? this.opts.yolo ?? this.yolo;
        // The Antigravity CLI has no `--output-format` flag. This only selects
        // how Smithers parses stdout; it is never forwarded to `agy`.
        const outputFormat = this.opts.outputFormat ??
            (params.options?.onEvent ? "stream-json" : "json");
        const resumeConversation = typeof params.options?.resumeSession === "string"
            ? params.options.resumeSession
            : this.opts.resume;
        pushFlag(args, "--model", this.opts.model ?? this.model);
        if (this.opts.sandbox)
            args.push("--sandbox");
        if (yoloEnabled)
            args.push("--dangerously-skip-permissions");
        pushList(args, "--allowed-mcp-server-names", this.opts.allowedMcpServerNames);
        if (this.opts.allowedTools !== undefined) {
            if (this.opts.allowedTools.length === 0) {
                pushFlag(args, "--allowed-tools", "");
            }
            else {
                pushList(args, "--allowed-tools", this.opts.allowedTools);
            }
        }
        // Resume a prior conversation. `agy` uses `--conversation=<id>` (alias
        // `-c`); there is no `--resume`. Listing/switching conversations is the
        // in-session `/resume` command, so there is no list/delete-session flag.
        if (resumeConversation)
            args.push(`--conversation=${resumeConversation}`);
        // Extra workspace roots: `agy` uses `--add-dir`, not `--include-directories`.
        pushList(args, "--add-dir", this.opts.includeDirectories);
        // Extensions are now Plugins, managed out-of-band via `agy plugin <action>`
        // rather than per-invocation `--extensions`/`--list-extensions` flags.
        // `--gemini_dir` still works even though it is no longer listed in `agy --help`.
        pushFlag(args, "--gemini_dir", this.opts.geminiDir ?? this.opts.configDir);
        if (this.extraArgs?.length)
            args.push(...this.extraArgs);
        const systemPrefix = params.systemPrompt
            ? `${params.systemPrompt}\n\n`
            : "";
        const jsonReminder = params.prompt?.includes("REQUIRED OUTPUT")
            ? "\n\nREMINDER: Your response MUST be ONLY the required raw JSON object. Do not include prose, markdown, or code fences. The first character must be `{` and the last character must be `}`.\n"
            : "";
        const fullPrompt = `${systemPrefix}${params.prompt ?? ""}${jsonReminder}`;
        args.push("--prompt", fullPrompt);
        const accountEnv = {};
        if (this.opts.apiKey)
            accountEnv.GEMINI_API_KEY = this.opts.apiKey;
        return {
            command: this.opts.binary ?? "agy",
            args,
            outputFormat,
            env: Object.keys(accountEnv).length > 0 ? accountEnv : undefined,
        };
    }
}
