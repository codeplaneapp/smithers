import {
  BaseCliAgent,
  pushFlag,
  pushList,
  isRecord,
  asString,
  truncate,
  toolKindFromName,
  shouldSurfaceUnparsedStdout,
  isLikelyRuntimeMetadata,
  createSyntheticIdGenerator,
  parseAnthropicStyleFileChanges,
} from "./BaseCliAgent/index.js";
import { normalizeCapabilityStringList } from "./capability-registry/index.js";
import { isClaudeLimitBanner } from "./BaseCliAgent/isClaudeLimitBanner.js";
import { logWarning } from "@smthrs/observability/logging";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath, join as joinPath } from "node:path";
import { tmpdir } from "node:os";
/** @typedef {import("./BaseCliAgent/BaseCliAgentOptions.ts").BaseCliAgentOptions} BaseCliAgentOptions */
/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./ClaudeCodeAgentOptions.ts").ClaudeCodeAgentOptions} ClaudeCodeAgentOptions */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./BaseCliAgent/AgentCliEvent.ts").AgentCliEvent} AgentCliEvent */

/**
 * @param {ClaudeCodeAgentOptions} opts
 */
function resolveClaudeBuiltIns(opts) {
  if (opts.tools === "") {
    return [];
  }
  const allowed = opts.allowedTools?.length
    ? opts.allowedTools
    : Array.isArray(opts.tools) && opts.tools.length
      ? opts.tools
      : opts.tools === "default" || opts.tools === undefined
        ? ["default"]
        : [];
  const denied = (opts.disallowedTools ?? []).map((tool) => `!${tool}`);
  const slashCommands = opts.disableSlashCommands ? [] : ["slash-commands"];
  return normalizeCapabilityStringList([...allowed, ...denied, ...slashCommands]);
}
/**
 * @param {ClaudeCodeAgentOptions} [opts]
 * @returns {AgentCapabilityRegistry}
 */
export function createClaudeCodeCapabilityRegistry(opts = {}) {
  return {
    version: 1,
    engine: "claude-code",
    runtimeTools: {},
    mcp: {
      bootstrap: "project-config",
      supportsProjectScope: true,
      supportsUserScope: true,
    },
    skills: {
      supportsSkills: true,
      installMode: "plugin",
      smithersSkillIds: normalizeCapabilityStringList((opts.pluginDir ?? []).map((entry) => `plugin:${entry}`)),
    },
    humanInteraction: {
      supportsUiRequests: false,
      methods: [],
    },
    fileChanges: {
      supportsFileChanges: true,
      supportsUnifiedDiff: true,
    },
    builtIns: resolveClaudeBuiltIns(opts),
  };
}
const TOOL_OUTPUT_MAX_CHARS = 500;
let didWarnAnthropicApiKeyUnset = false;
/**
 * Deep-merge two plain settings objects. `base` holds Smithers-computed keys
 * (effortLevel, durability hooks, opts.settings); `overlay` holds the USER's
 * inline `--settings` JSON, which wins on scalar conflict. Nested plain objects
 * merge recursively (so a user `hooks` object refines rather than replaces
 * ours); arrays are concatenated base-then-overlay so an additive durability
 * `PostToolUse` hook survives alongside a user-declared one.
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} overlay
 * @returns {Record<string, unknown>}
 */
function deepMergeSettings(base, overlay) {
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = out[key];
    if (key === "fallbackModel") {
      out[key] = overlayValue;
    } else if (Array.isArray(baseValue) && Array.isArray(overlayValue)) {
      out[key] = [...baseValue, ...overlayValue];
    } else if (isRecord(baseValue) && isRecord(overlayValue)) {
      out[key] = deepMergeSettings(baseValue, overlayValue);
    } else {
      out[key] = overlayValue;
    }
  }
  return out;
}
/**
 * Read a `--settings` FILE path and parse it as a settings JSON object so its
 * keys can be folded into the single emitted `--settings` flag. Returns null
 * when the path is unreadable or not a JSON object — the caller then preserves
 * the verbatim path as the sole `--settings`, never clobbering the user's file.
 * Relative paths resolve against the agent cwd (the process cwd Claude would use).
 * @param {string} pathValue
 * @param {string | undefined} cwd
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readSettingsFileJson(pathValue, cwd) {
  try {
    const base = typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
    const abs = isAbsolute(pathValue) ? pathValue : resolvePath(base, pathValue);
    const parsed = JSON.parse(await readFile(abs, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return /** @type {Record<string, unknown>} */ (parsed);
    }
  } catch {
    // Unreadable / non-JSON — caller preserves the verbatim path.
  }
  return null;
}
/**
 * Write a merged settings object to a private (mode 0600) temp file and
 * return its path. Used instead of inlining the JSON onto argv, since a
 * merged object routinely contains secrets folded in from a user settings
 * file and argv is world-readable via `ps` on shared hosts.
 * @param {Record<string, unknown>} settings
 * @returns {Promise<{ filePath: string; cleanup: () => Promise<void> }>}
 */
async function writePrivateSettingsFile(settings) {
  const dir = await mkdtemp(joinPath(tmpdir(), "smithers-claude-settings-"));
  const filePath = joinPath(dir, "settings.json");
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await writeFile(filePath, JSON.stringify(settings), { mode: 0o600 });
    return { filePath, cleanup };
  } catch (error) {
    // mkdtemp succeeded, so a serialization/write failure must not strand a
    // secret-bearing partial file or its private directory.
    await cleanup();
    throw error;
  }
}
/**
 * @param {string} toolName
 * @param {string | undefined} rawOutput
 */
function summarizeToolOutput(toolName, rawOutput) {
  const output = rawOutput?.trim();
  if (!output) {
    return undefined;
  }
  const toolErrorMatch = output.match(/<tool_use_error>([\s\S]*?)<\/tool_use_error>/i);
  if (toolErrorMatch?.[1]) {
    return `Tool error: ${truncate(toolErrorMatch[1].trim(), 240)}`;
  }
  if (isLikelyRuntimeMetadata(output)) {
    return "Tool output omitted (runtime metadata).";
  }
  const normalizedToolName = toolName.toLowerCase();
  if (normalizedToolName.includes("read")) {
    const numberedLines = output.split("\n").filter((line) => /^\s*\d+→/.test(line));
    if (numberedLines.length > 8) {
      return `Read output (${numberedLines.length} lines)`;
    }
  }
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 5) {
    const preview = lines.slice(0, 3).join("\n");
    return `${truncate(preview, 300)}\n… (+${lines.length - 3} lines)`;
  }
  return truncate(output, TOOL_OUTPUT_MAX_CHARS);
}
export class ClaudeCodeAgent extends BaseCliAgent {
  opts;
  capabilities;
  cliEngine = "claude-code";
  /**
   * @param {ClaudeCodeAgentOptions} [opts]
   */
  constructor(opts = {}) {
    // Clear env vars that cause "Cannot run nested Claude Code instances" errors.
    // CLAUDE_CODE_ENTRYPOINT / CLAUDECODE are set by a parent Claude Code process;
    // child instances refuse to start when they detect these.
    // ANTHROPIC_API_KEY is cleared so Claude Code uses the subscription instead of API billing,
    // unless the caller explicitly opts in by passing `apiKey`.
    const parentEnvOverrides = {};
    if (process.env.CLAUDE_CODE_ENTRYPOINT) parentEnvOverrides.CLAUDE_CODE_ENTRYPOINT = "";
    if (process.env.CLAUDECODE) parentEnvOverrides.CLAUDECODE = "";
    if (process.env.ANTHROPIC_API_KEY && !opts.apiKey) {
      if (!didWarnAnthropicApiKeyUnset) {
        didWarnAnthropicApiKeyUnset = true;
        logWarning(
          "ClaudeCodeAgent: unsetting ANTHROPIC_API_KEY so Claude Code uses your subscription. " +
            "To use API billing instead, pass `apiKey` to ClaudeCodeAgent or use ToolLoopAgent from 'ai' with anthropic() provider.",
          {},
          "agent.init",
        );
      }
      parentEnvOverrides.ANTHROPIC_API_KEY = "";
    }
    if (Object.keys(parentEnvOverrides).length > 0) {
      opts = { ...opts, env: { ...parentEnvOverrides, ...opts.env } };
    }
    super(opts);
    this.opts = opts;
    this.capabilities = createClaudeCodeCapabilityRegistry(opts);
  }
  /**
   * @returns {CliOutputInterpreter}
   */
  createOutputInterpreter() {
    let sessionId;
    let didEmitStarted = false;
    let didEmitCompleted = false;
    let lastAssistantText = "";
    // Claude/Fable print usage/session-limit banners as ordinary assistant
    // text and still exit 0, so the banner never reaches the CLI error path.
    // Capture it here to force an error result the engine classifies as a
    // quota wait (pause + auto-resume) instead of a silent success.
    let limitBannerText = "";
    const toolNameByUseId = new Map();
    // Write tool_use inputs, keyed by use id. A Write only carries the NEW
    // full-file content, so whether an honest diff exists is decided by the
    // tool result: "File created successfully" means the old side was
    // genuinely empty (reconstruct), "has been updated" means prior content
    // is unknown (paths-only — never fabricate an empty-old diff).
    const writeInputByUseId = new Map();
    const nextSyntheticId = createSyntheticIdGenerator();
    /**
     * @param {string} title
     * @param {string} message
     * @param {"warning" | "error"} [level]
     * @returns {AgentCliEvent}
     */
    const warningAction = (title, message, level = "warning") => ({
      type: "action",
      engine: this.cliEngine,
      phase: "completed",
      entryType: "thought",
      action: {
        id: nextSyntheticId("claude-warning"),
        kind: "warning",
        title,
        detail: {},
      },
      message,
      ok: level !== "error",
      level,
    });
    /**
     * @param {string} line
     * @returns {AgentCliEvent[]}
     */
    const parseLine = (line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        return [];
      }
      let payload;
      try {
        payload = JSON.parse(trimmedLine);
      } catch {
        // Claude/Fable print usage/session-limit banners as RAW (non-JSON)
        // stdout lines, so they never reach the assistant/result blocks
        // below. Classify them here too, or the run treats the banner as a
        // normal (empty) answer and fails on output-schema validation
        // instead of parking as a resumable quota wait.
        if (!limitBannerText && isClaudeLimitBanner(trimmedLine)) {
          limitBannerText = trimmedLine;
        }
        if (!shouldSurfaceUnparsedStdout(trimmedLine)) {
          return [];
        }
        return [warningAction("stdout", truncate(trimmedLine, 220), "warning")];
      }
      if (!isRecord(payload)) {
        return [];
      }
      const payloadType = asString(payload.type);
      if (!payloadType) {
        return [];
      }
      if (payloadType === "rate_limit_event") {
        // A rejected rate_limit_event means the subscription window or
        // credits are exhausted; without this branch the line falls
        // through to `return []`, the run fails on empty output, and
        // the raw JSON tail gets stored as the error. Synthesize a
        // prose banner so the shared quota classifier parks the run as
        // waiting-quota (and picks up the reset time when present).
        const info = isRecord(payload.rate_limit_info) ? payload.rate_limit_info : {};
        const status = asString(info.status);
        const overageStatus = asString(info.overageStatus);
        // The CLI emits a rate_limit_event on HEALTHY streams too: with
        // overage disabled at the org, a successful request still carries
        // {status:"allowed", overageStatus:"rejected",
        //  overageDisabledReason:"org_level_disabled", isUsingOverage:false}
        // followed by a success result. overageStatus describes whether
        // overage COULD rescue a future rejection — it is informational
        // unless the request itself was rejected. Treating it as fatal
        // killed every claude attempt on overage-disabled orgs. Only
        // status decides; overageStatus is a fallback when status is
        // absent entirely (older CLI shapes).
        const rejected = status === "rejected" || (status == null && overageStatus === "rejected");
        if (rejected && !limitBannerText) {
          const windowLabel = asString(info.rateLimitType) ?? "usage";
          const reason = asString(info.overageDisabledReason);
          const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt : null;
          const resetSeconds = resetsAt != null ? Math.max(1, Math.round(resetsAt - Date.now() / 1000)) : null;
          limitBannerText = `Claude ${windowLabel} usage limit exceeded (rate_limit_event rejected${reason ? `: ${reason}` : ""}).${resetSeconds != null ? ` Retry after ${resetSeconds} seconds.` : ""}`;
        }
        return [];
      }
      if (payloadType === "system" && asString(payload.subtype) === "init") {
        const parsedSessionId = asString(payload.session_id);
        if (parsedSessionId) {
          sessionId = parsedSessionId;
        }
        if (!didEmitStarted) {
          didEmitStarted = true;
          return [
            {
              type: "started",
              engine: this.cliEngine,
              title: "Claude Code",
              resume: sessionId,
              detail: sessionId ? { sessionId } : undefined,
            },
          ];
        }
        return [];
      }
      if (payloadType === "assistant" || payloadType === "user") {
        const message = isRecord(payload.message) ? payload.message : null;
        const contentBlocks = message && Array.isArray(message.content) ? message.content : [];
        const events = [];
        for (const block of contentBlocks) {
          if (!isRecord(block)) continue;
          const blockType = asString(block.type);
          if (!blockType) continue;
          if (blockType === "text") {
            const text = asString(block.text)?.trim();
            if (payloadType === "assistant" && text) {
              lastAssistantText = text;
              if (!limitBannerText && isClaudeLimitBanner(text)) {
                limitBannerText = text;
              }
              events.push({
                type: "action",
                engine: this.cliEngine,
                phase: "updated",
                entryType: "message",
                action: {
                  id: nextSyntheticId("claude-text"),
                  kind: "note",
                  title: "assistant",
                  detail: {},
                },
                message: text,
                ok: true,
                level: "info",
              });
            }
            continue;
          }
          if (blockType === "tool_use") {
            const toolUseId = asString(block.id);
            const toolName = asString(block.name) ?? "tool";
            if (!toolUseId) continue;
            toolNameByUseId.set(toolUseId, toolName);
            if (toolName === "Write" && isRecord(block.input)) {
              writeInputByUseId.set(toolUseId, block.input);
            }
            const fileChanges = parseAnthropicStyleFileChanges(toolName, block.input);
            events.push({
              type: "action",
              engine: this.cliEngine,
              phase: "started",
              entryType: "thought",
              action: {
                id: toolUseId,
                kind: toolKindFromName(toolName),
                title: toolName,
                detail: isRecord(block.input)
                  ? {
                      input: block.input,
                      ...(fileChanges ? { fileChanges } : {}),
                    }
                  : {},
              },
              message: `Running ${toolName}`,
              level: "info",
            });
            continue;
          }
          if (blockType === "tool_result") {
            const toolUseId = asString(block.tool_use_id);
            if (!toolUseId) continue;
            const toolName = toolNameByUseId.get(toolUseId) ?? "tool";
            const toolResultContent = block.content;
            const resultSummary =
              typeof toolResultContent === "string"
                ? toolResultContent
                : Array.isArray(toolResultContent)
                  ? toolResultContent
                      .map((entry) => (isRecord(entry) ? asString(entry.text) : undefined))
                      .filter((entry) => Boolean(entry))
                      .join("\n")
                  : undefined;
            const isToolError = block.is_error === true;
            const summarizedMessage = summarizeToolOutput(toolName, resultSummary);
            const writeInput = writeInputByUseId.get(toolUseId);
            writeInputByUseId.delete(toolUseId);
            let completedFileChanges;
            if (writeInput && !isToolError) {
              const created =
                typeof resultSummary === "string" && resultSummary.startsWith("File created successfully at:");
              completedFileChanges = created
                ? parseAnthropicStyleFileChanges("Write", writeInput, { priorContent: "" })
                : parseAnthropicStyleFileChanges("Write", writeInput);
            }
            events.push({
              type: "action",
              engine: this.cliEngine,
              phase: "completed",
              entryType: "thought",
              action: {
                id: toolUseId,
                kind: toolKindFromName(toolName),
                title: toolName,
                detail: completedFileChanges ? { fileChanges: completedFileChanges } : {},
              },
              message: summarizedMessage,
              ok: !isToolError,
              level: isToolError ? "warning" : "info",
            });
          }
        }
        return events;
      }
      if (payloadType === "result") {
        if (didEmitCompleted) {
          return [];
        }
        const denials = Array.isArray(payload.permission_denials) ? payload.permission_denials : [];
        const events = denials
          .map((denial) => {
            if (!isRecord(denial)) return null;
            const toolName = asString(denial.tool_name) ?? "tool";
            return warningAction(`permission denied: ${toolName}`, `Permission denied for ${toolName}`, "warning");
          })
          .filter((event) => Boolean(event));
        const subtype = asString(payload.subtype) ?? "success";
        const resultText = asString(payload.result);
        const resultError = asString(payload.error);
        if (!limitBannerText && resultText && isClaudeLimitBanner(resultText)) {
          limitBannerText = resultText;
        }
        const isError = payload.is_error === true || subtype === "error" || Boolean(limitBannerText);
        didEmitCompleted = true;
        events.push({
          type: "completed",
          engine: this.cliEngine,
          ok: !isError,
          answer: !isError ? resultText || lastAssistantText || undefined : undefined,
          error: isError ? limitBannerText || resultError || "Claude run failed" : undefined,
          resume: asString(payload.session_id) ?? sessionId,
          usage: isRecord(payload.usage) ? payload.usage : undefined,
        });
        return events;
      }
      return [];
    };
    return {
      onStdoutLine: parseLine,
      onStderrLine: (line) => {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
          return [];
        }
        return [warningAction("stderr", truncate(trimmedLine, 220), "warning")];
      },
      onExit: (result) => {
        if (didEmitCompleted) {
          return [];
        }
        didEmitCompleted = true;
        const isSuccess = (result.exitCode ?? 0) === 0 && !limitBannerText;
        return [
          {
            type: "completed",
            engine: this.cliEngine,
            ok: isSuccess,
            answer: isSuccess ? lastAssistantText || undefined : undefined,
            error: isSuccess ? undefined : limitBannerText || `Claude exited with code ${result.exitCode ?? -1}`,
            resume: sessionId,
          },
        ];
      },
    };
  }
  /**
   * Normalize a `file_change` action (as emitted by {@link createOutputInterpreter})
   * into {@link AgentFileChange} records. `action` is `{ title, detail: { input } }`.
   *
   * @param {unknown} action
   * @returns {import("./agent-contract/AgentFileChange.ts").AgentFileChange[] | undefined}
   */
  parseFileChanges(action) {
    const fileAction = /** @type {{ title?: unknown; detail?: { input?: unknown } } | undefined} */ (action);
    return parseAnthropicStyleFileChanges(asString(fileAction?.title) ?? "", fileAction?.detail?.input);
  }
  /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
  async buildCommand(params) {
    const args = ["--print"];
    // Default to "stream-json" to capture NDJSON events that include token
    // usage (message_start has input_tokens, message_delta has output_tokens).
    // BaseCliAgent.extractUsageFromOutput will parse these for metrics.
    const outputFormat = this.opts.outputFormat ?? "stream-json";
    // Recent Claude CLI builds require --verbose when --print is combined with
    // --output-format=stream-json.
    const requiresVerbose = outputFormat === "stream-json";
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
    if (this.opts.continue || params.options?.continueSession) args.push("--continue");
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
    const resumeSession = typeof params.options?.resumeSession === "string" ? params.options.resumeSession : undefined;
    pushFlag(args, "--resume", resumeSession ?? this.opts.resume);
    pushFlag(args, "--session-id", this.opts.sessionId);
    pushFlag(args, "--setting-sources", this.opts.settingSources);
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
        pushList(args, "--tools", this.opts.tools);
      }
    }
    if (this.opts.verbose || requiresVerbose) args.push("--verbose");
    // Merge effort + durability hooks + opts.settings into a single --settings
    // JSON object. Any user extraArgs `--settings` is folded into this one
    // flag too (see the emit block below) — Claude Code's --settings is
    // single-valued, so a second flag would silently clobber the first.
    /** @type {Record<string, unknown>} */
    let settingsObj = {};
    if (typeof this.opts.settings === "string" && this.opts.settings !== "") {
      /** @type {unknown} */
      let parsed;
      let parsedOk = false;
      try {
        parsed = JSON.parse(this.opts.settings);
        parsedOk = true;
      } catch {
        parsedOk = false;
      }
      if (parsedOk && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        settingsObj = { .../** @type {Record<string, unknown>} */ (parsed) };
      } else {
        // Either it did not parse as JSON, OR it parsed to a scalar/array
        // (e.g. a settings file literally named `42` / `true`). Treat it as a
        // file PATH and pass it through as-is later — never silently drop it.
        settingsObj = { __rawSettingsPath: this.opts.settings };
      }
    } else if (this.opts.settings && typeof this.opts.settings === "object") {
      settingsObj = { .../** @type {Record<string, unknown>} */ (this.opts.settings) };
    }
    const effort =
      (typeof this.opts.effort === "string" && this.opts.effort) ||
      (typeof this.effort === "string" && this.effort) ||
      null;
    if (effort && settingsObj.effortLevel == null) {
      settingsObj.effortLevel = effort;
    }
    // Durability: inject a PostToolUse hook that calls back into smithers for a
    // strict Tier 1 snapshot at each file-edit / Bash boundary. Only when the
    // engine passes a socket path (durability enabled); folded into the single
    // --settings below (merged into a settings file's own hooks when present).
    const durabilitySocket =
      typeof params.options?.durabilitySocket === "string" ? params.options.durabilitySocket : undefined;
    if (durabilitySocket) {
      const hooks =
        settingsObj.hooks && typeof settingsObj.hooks === "object"
          ? /** @type {Record<string, unknown>} */ (settingsObj.hooks)
          : {};
      const post = Array.isArray(hooks.PostToolUse) ? [...hooks.PostToolUse] : [];
      post.push({
        matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash",
        hooks: [{ type: "command", command: "smithers snapshot-hook" }],
      });
      settingsObj.hooks = { ...hooks, PostToolUse: post };
    }
    // Emit EXACTLY ONE `--settings` flag. Claude Code's `--settings
    // <file-or-json>` is single-valued: the CLI arg parser keeps only the LAST
    // occurrence and silently discards earlier ones (it is NOT variadic like
    // `--betas <betas...>`). So two `--settings` flags would clobber whichever
    // came first — including a user's settings FILE. We therefore fold every
    // settings source into one value.
    //
    // Precedence (low→high, later wins on scalar conflict):
    //   ourSettings (effortLevel + durability hooks + opts.settings inline
    //   JSON) < opts.settings settings-FILE content < user extraArgs
    //   `--settings`. JSON sources — and settings FILES we can read+parse —
    //   deep-merge into a single object (arrays concatenate, so durability
    //   hooks survive alongside a file's own hooks). A genuinely
    //   unreadable/non-JSON file path can't be inlined, so the
    //   highest-precedence such path is emitted verbatim as the sole
    //   `--settings` (mergeable extras dropped) — never clobbering the file.
    const rawSettingsPath = typeof settingsObj.__rawSettingsPath === "string" ? settingsObj.__rawSettingsPath : null;
    /** @type {Record<string, unknown>} */
    const ourSettings = { ...settingsObj };
    delete ourSettings.__rawSettingsPath;
    const extra = Array.isArray(this.extraArgs) ? [...this.extraArgs] : [];
    const terminatorIndex = extra.indexOf("--");
    const terminatorTail = terminatorIndex >= 0 ? extra.splice(terminatorIndex) : [];
    // Extract and REMOVE every user `--settings` token (`--settings X` or
    // `--settings=X`) from extraArgs, low→high, so none rides through as a
    // duplicate flag; we re-emit exactly one merged flag ourselves.
    /** @type {string[]} */
    const userSettingsRawList = [];
    for (let i = 0; i < extra.length;) {
      const a = extra[i];
      if (a === "--settings") {
        userSettingsRawList.push(typeof extra[i + 1] === "string" ? /** @type {string} */ (extra[i + 1]) : "");
        extra.splice(i, extra[i + 1] !== undefined ? 2 : 1);
        continue;
      }
      if (typeof a === "string" && a.startsWith("--settings=")) {
        userSettingsRawList.push(a.slice("--settings=".length));
        extra.splice(i, 1);
        continue;
      }
      i++;
    }
    args.push(...extra);
    // Fold sources into one value. `mergedSettings` accumulates mergeable JSON
    // (higher wins); `opaqueSettingsPath` holds the highest-precedence file
    // path we could NOT read+parse. A higher mergeable source shadows a lower
    // opaque one (clears it) and vice-versa.
    /** @type {Record<string, unknown>} */
    let mergedSettings = { ...ourSettings };
    /** @type {string | null} */
    let opaqueSettingsPath = null;
    /**
     * @param {string} raw
     * @param {boolean} allowInlineJson opts.settings inline JSON was already
     *   folded into ourSettings, so only user extraArgs values may be inline.
     */
    const foldSettingsSource = async (raw, allowInlineJson) => {
      if (allowInlineJson) {
        try {
          const candidate = JSON.parse(raw);
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
            mergedSettings = deepMergeSettings(mergedSettings, /** @type {Record<string, unknown>} */ (candidate));
            opaqueSettingsPath = null;
            return;
          }
        } catch {
          // Not inline JSON — treat as a file path below.
        }
      }
      const parsed = await readSettingsFileJson(raw, params.cwd);
      if (parsed) {
        mergedSettings = deepMergeSettings(mergedSettings, parsed);
        opaqueSettingsPath = null;
      } else {
        opaqueSettingsPath = raw;
      }
    };
    // Security: a settings FILE routinely holds secrets (env.ANTHROPIC_API_KEY,
    // apiKeyHelper output, ...) and argv is world-readable via `ps` on shared
    // hosts. Only read+fold a settings file when Smithers actually has
    // something to inject (effort/durability/inline opts.settings); otherwise
    // pass the file path through untouched so its contents never round-trip
    // through this process's argv.
    const smithersHasInjections = Object.keys(ourSettings).length > 0;
    if (rawSettingsPath && (smithersHasInjections || userSettingsRawList.some((raw) => raw !== ""))) {
      await foldSettingsSource(rawSettingsPath, false);
    } else if (rawSettingsPath) {
      opaqueSettingsPath = rawSettingsPath;
    }
    for (const raw of userSettingsRawList) {
      if (raw !== "") {
        await foldSettingsSource(raw, true);
      }
    }
    /** @type {(() => Promise<void>) | undefined} */
    let settingsCleanup;
    try {
      if (opaqueSettingsPath) {
        // DELIBERATE tradeoff: Claude Code's `--settings` is single-valued, so an
        // unreadable/non-JSON settings FILE cannot be folded with our computed
        // keys — emitting a second flag would silently clobber the user's file. We
        // preserve the file and drop our keys, but that DISABLES crash-recovery
        // durability snapshots (and effort) for this agent, so warn loudly.
        if (Object.keys(mergedSettings).length > 0) {
          const losesDurability = !!(mergedSettings.hooks && durabilitySocket);
          logWarning(
            "ClaudeCodeAgent: could not read settings file " +
              `'${opaqueSettingsPath}' as JSON — passing it through as the sole ` +
              "--settings and dropping Smithers-computed keys (effort/durability). " +
              (losesDurability ? "CRASH-RECOVERY DURABILITY SNAPSHOTS ARE DISABLED for this agent. " : "") +
              "Supply effort/durability via a readable JSON settings file or inline " +
              "--settings JSON to combine them.",
            {},
            "agent.settings",
          );
        }
        pushFlag(args, "--settings", opaqueSettingsPath);
      } else if (Object.keys(mergedSettings).length > 0) {
        // A merged settings object routinely contains secrets from a folded
        // settings file — never inline it onto argv (world-readable via `ps`).
        // Write it to a private temp file instead and pass that path.
        const privateSettings = await writePrivateSettingsFile(mergedSettings);
        settingsCleanup = privateSettings.cleanup;
        pushFlag(args, "--settings", privateSettings.filePath);
      }
      args.push(...terminatorTail);
      if (params.prompt) args.push(params.prompt);
      const accountEnv = {};
      if (durabilitySocket) accountEnv.SMITHERS_SNAPSHOT_SOCK = durabilitySocket;
      if (this.opts.configDir) accountEnv.CLAUDE_CONFIG_DIR = this.opts.configDir;
      if (this.opts.apiKey) accountEnv.ANTHROPIC_API_KEY = this.opts.apiKey;
      return {
        command: "claude",
        args,
        outputFormat,
        env: Object.keys(accountEnv).length > 0 ? accountEnv : undefined,
        ...(settingsCleanup ? { cleanup: settingsCleanup } : {}),
      };
    } catch (error) {
      // BaseCliAgent cannot run commandSpec.cleanup until buildCommand returns.
      // Cover the post-create/pre-return window here instead.
      await settingsCleanup?.();
      throw error;
    }
  }
}
