import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  BaseCliAgent,
  normalizeCodexConfig,
  pushFlag,
  pushList,
  pushRepeated,
  isRecord,
  asString,
  asNumber,
  truncate,
  shouldSurfaceUnparsedStdout,
  createSyntheticIdGenerator,
} from "./BaseCliAgent/index.js";
import { normalizeCapabilityStringList } from "./capability-registry/index.js";
import { zodToOpenAISchema } from "./zodToOpenAISchema.js";
const execFileAsync = promisify(execFile);

/** Codex config key that widens the `workspace-write` sandbox. */
const WRITABLE_ROOTS_KEY = "sandbox_workspace_write.writable_roots";

/**
 * Absolute git directories for `cwd` that live outside it.
 *
 * A git worktree keeps its `.git` as a *file* pointing at a gitdir under the
 * parent repository, and a submodule's gitdir sits under `.git/modules`. A
 * sandbox scoped to the workspace therefore denies every git write — commits
 * fail on the lock file, which reads as a mysterious `HEAD.lock` error rather
 * than a permission error. Smithers' own `<Worktree>` lanes always produce
 * this layout, so lanes and sandboxed agents would otherwise be mutually
 * exclusive.
 *
 * Returns only paths that are not already inside `cwd`, so an ordinary
 * repository contributes nothing and the emitted argv is unchanged.
 *
 * @param {string} cwd
 * @returns {Promise<string[]>}
 */
export const externalGitDirs = async (cwd) => {
  if (typeof cwd !== "string" || cwd.length === 0) return [];
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--git-dir", "--git-common-dir"]));
  } catch {
    // Not a repository, or git is unavailable: nothing to widen.
    return [];
  }
  const root = resolve(cwd);
  const seen = new Set();
  for (const line of stdout.split("\n")) {
    const value = line.trim();
    if (value.length === 0) continue;
    const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
    const rel = relative(root, absolute);
    const inside = rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
    if (!inside) seen.add(absolute);
  }
  return [...seen];
};

/** @typedef {import("./BaseCliAgent/BaseCliAgentOptions.ts").BaseCliAgentOptions} BaseCliAgentOptions */
/** @typedef {import("./BaseCliAgent/CodexConfigOverrides.ts").CodexConfigOverrides} CodexConfigOverrides */
/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./BaseCliAgent/AgentCliEvent.ts").AgentCliEvent} AgentCliEvent */
/** @typedef {import("./CodexAgentOptions.ts").CodexAgentOptions} CodexAgentOptions */

/**
 * @param {CodexAgentOptions} opts
 */
function resolveCodexBuiltIns(opts) {
  if (opts.enable?.length || opts.disable?.length) {
    return normalizeCapabilityStringList([
      ...(opts.enable ?? []).map((feature) => `enable:${feature}`),
      ...(opts.disable ?? []).map((feature) => `disable:${feature}`),
    ]);
  }
  return ["default"];
}
/**
 * @param {CodexAgentOptions} [opts]
 * @returns {AgentCapabilityRegistry}
 */
export function createCodexCapabilityRegistry(opts = {}) {
  return {
    version: 1,
    engine: "codex",
    runtimeTools: {},
    mcp: {
      bootstrap: "inline-config",
      supportsProjectScope: true,
      supportsUserScope: false,
    },
    skills: {
      supportsSkills: false,
      smithersSkillIds: [],
    },
    humanInteraction: {
      supportsUiRequests: false,
      methods: [],
    },
    fileChanges: {
      supportsFileChanges: true,
      supportsUnifiedDiff: false,
    },
    builtIns: resolveCodexBuiltIns(opts),
  };
}
const CODEX_CHANGE_KIND = { add: "created", update: "modified", delete: "deleted" };
/**
 * Normalize codex's native `item.changes: {path, kind}[]` — path+kind only,
 * no diff content ships in the protocol.
 *
 * @param {unknown} rawChanges
 * @returns {import("./agent-contract/AgentFileChange.ts").AgentFileChange[] | undefined}
 */
function parseCodexFileChanges(rawChanges) {
  if (!Array.isArray(rawChanges)) return undefined;
  const changes = rawChanges
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const path = asString(entry.path);
      const rawKind = asString(entry.kind);
      if (!path || !rawKind) return null;
      return { path, kind: CODEX_CHANGE_KIND[rawKind] ?? "modified", source: "reported" };
    })
    .filter((entry) => Boolean(entry));
  return changes.length > 0 ? changes : undefined;
}
export class CodexAgent extends BaseCliAgent {
  opts;
  capabilities;
  cliEngine = "codex";
  /**
   * @param {CodexAgentOptions} [opts]
   */
  constructor(opts = {}) {
    super(opts, "CodexAgent");
    this.opts = opts;
    this.capabilities = createCodexCapabilityRegistry(opts);
    // Native structured output (`codex exec --output-schema`) constrains the
    // model to emit only final JSON and makes it refuse tool calls ("tool calls
    // are constrained by a JSON response schema"), which breaks any agentic task
    // (read/edit/run). It is therefore OPT-IN: by default Codex is treated like
    // the other CLI engines (supportsNativeStructuredOutput=false), so the engine
    // prompt-injects the schema and extracts JSON from the agent's final text,
    // leaving tool use intact. Set nativeStructuredOutput:true for pure, tool-free
    // extraction tasks that want strict schema enforcement.
    this.supportsNativeStructuredOutput = opts.nativeStructuredOutput === true;
  }
  /**
   * @returns {CliOutputInterpreter}
   */
  createOutputInterpreter() {
    let turnIndex = 0;
    let threadId;
    let finalAnswer = "";
    let didEmitCompleted = false;
    const nextSyntheticId = createSyntheticIdGenerator();
    /**
     * @param {Record<string, unknown>} item
     * @param {"started" | "updated" | "completed"} phase
     * @returns {AgentCliEvent | null}
     */
    const actionForItem = (item, phase) => {
      const itemId = asString(item.id) ?? nextSyntheticId("item");
      const itemType = asString(item.type) ?? "note";
      if (itemType === "agent_message") {
        if (phase === "completed") {
          const text = asString(item.text)?.trim();
          if (text) {
            finalAnswer = text;
            return {
              type: "action",
              engine: this.cliEngine,
              phase: "completed",
              entryType: "message",
              action: {
                id: itemId,
                kind: "note",
                title: "assistant",
                detail: { type: itemType },
              },
              message: text,
              ok: true,
              level: "info",
            };
          }
        }
        return null;
      }
      if (itemType === "reasoning") {
        return {
          type: "action",
          engine: this.cliEngine,
          phase,
          entryType: "thought",
          action: {
            id: itemId,
            kind: "reasoning",
            title: "reasoning",
            detail: { type: itemType },
          },
          message: asString(item.text),
          ok: phase === "completed" ? true : undefined,
          level: "info",
        };
      }
      if (itemType === "command_execution") {
        const status = asString(item.status);
        const exitCode = asNumber(item.exit_code);
        const command = asString(item.command) ?? "command";
        return {
          type: "action",
          engine: this.cliEngine,
          phase,
          entryType: "thought",
          action: {
            id: itemId,
            kind: "command",
            title: truncate(command, 160),
            detail: {
              type: itemType,
              status,
              exitCode,
            },
          },
          message: phase === "started" ? `Running ${truncate(command, 120)}` : undefined,
          ok: phase === "completed" ? status === "completed" && (exitCode === undefined || exitCode === 0) : undefined,
          level: phase === "completed" && status === "failed" ? "warning" : "info",
        };
      }
      if (itemType === "file_change") {
        const rawChanges = Array.isArray(item.changes) ? item.changes : [];
        const files = rawChanges
          .map((entry) => {
            if (!isRecord(entry)) return null;
            const pathValue = asString(entry.path);
            const kindValue = asString(entry.kind);
            if (!pathValue || !kindValue) return null;
            return `${kindValue} ${pathValue}`;
          })
          .filter((entry) => Boolean(entry));
        const message = files.length > 0 ? files.slice(0, 4).join(", ") : "Updated files";
        const fileChanges = parseCodexFileChanges(rawChanges);
        return {
          type: "action",
          engine: this.cliEngine,
          phase: "completed",
          entryType: "thought",
          action: {
            id: itemId,
            kind: "file_change",
            title: "file changes",
            detail: {
              type: itemType,
              changes: rawChanges,
              ...(fileChanges ? { fileChanges } : {}),
            },
          },
          message,
          ok: asString(item.status) !== "failed",
          level: "info",
        };
      }
      if (itemType === "mcp_tool_call") {
        const server = asString(item.server) ?? "mcp";
        const tool = asString(item.tool) ?? "tool";
        const status = asString(item.status);
        const errorMessage = isRecord(item.error) ? asString(item.error.message) : undefined;
        return {
          type: "action",
          engine: this.cliEngine,
          phase,
          entryType: "thought",
          action: {
            id: itemId,
            kind: "tool",
            title: `${server}.${tool}`,
            detail: {
              type: itemType,
              server,
              tool,
              status,
              arguments: item.arguments,
            },
          },
          message: errorMessage,
          ok: phase === "completed" ? status !== "failed" : undefined,
          level: phase === "completed" && status === "failed" ? "warning" : "info",
        };
      }
      if (itemType === "web_search") {
        const query = asString(item.query) ?? "";
        return {
          type: "action",
          engine: this.cliEngine,
          phase: "completed",
          entryType: "thought",
          action: {
            id: itemId,
            kind: "web_search",
            title: "web search",
            detail: {
              type: itemType,
              query,
            },
          },
          message: query ? `Web search: ${truncate(query, 120)}` : undefined,
          ok: true,
          level: "info",
        };
      }
      if (itemType === "todo_list") {
        const items = Array.isArray(item.items) ? item.items : [];
        const completedCount = items.filter((entry) => isRecord(entry) && entry.completed === true).length;
        const message = `${completedCount}/${items.length} tasks complete`;
        return {
          type: "action",
          engine: this.cliEngine,
          phase,
          entryType: "thought",
          action: {
            id: itemId,
            kind: "todo_list",
            title: "todo list",
            detail: {
              type: itemType,
              items,
            },
          },
          message,
          ok: phase === "completed" ? true : undefined,
          level: "info",
        };
      }
      if (itemType === "error") {
        return {
          type: "action",
          engine: this.cliEngine,
          phase: "completed",
          entryType: "thought",
          action: {
            id: itemId,
            kind: "warning",
            title: "warning",
            detail: { type: itemType },
          },
          message: asString(item.message) ?? "Codex reported a warning",
          ok: true,
          level: "warning",
        };
      }
      return {
        type: "action",
        engine: this.cliEngine,
        phase,
        entryType: "thought",
        action: {
          id: itemId,
          kind: "note",
          title: itemType,
          detail: { item },
        },
        level: "debug",
      };
    };
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
        if (!shouldSurfaceUnparsedStdout(trimmedLine)) {
          return [];
        }
        return [
          {
            type: "action",
            engine: this.cliEngine,
            phase: "completed",
            entryType: "thought",
            action: {
              id: nextSyntheticId("codex-line"),
              kind: "warning",
              title: "stdout",
              detail: {},
            },
            message: truncate(trimmedLine, 220),
            ok: true,
            level: "warning",
          },
        ];
      }
      if (!isRecord(payload)) {
        return [];
      }
      const payloadType = asString(payload.type);
      if (!payloadType) {
        return [];
      }
      if (payloadType === "thread.started") {
        const parsedThreadId = asString(payload.thread_id);
        if (parsedThreadId) {
          threadId = parsedThreadId;
        }
        return [
          {
            type: "started",
            engine: this.cliEngine,
            title: "Codex",
            resume: threadId,
            detail: threadId ? { threadId } : undefined,
          },
        ];
      }
      if (payloadType === "turn.started") {
        turnIndex += 1;
        return [
          {
            type: "action",
            engine: this.cliEngine,
            phase: "started",
            entryType: "thought",
            action: {
              id: `turn-${turnIndex}`,
              kind: "turn",
              title: `turn ${turnIndex}`,
              detail: {},
            },
            message: `Turn ${turnIndex} started`,
            level: "info",
          },
        ];
      }
      if (payloadType === "item.started" || payloadType === "item.updated" || payloadType === "item.completed") {
        const item = isRecord(payload.item) ? payload.item : null;
        if (!item) {
          return [];
        }
        const phase =
          payloadType === "item.started" ? "started" : payloadType === "item.updated" ? "updated" : "completed";
        const action = actionForItem(item, phase);
        return action ? [action] : [];
      }
      if (payloadType === "turn.completed") {
        if (didEmitCompleted) {
          return [];
        }
        didEmitCompleted = true;
        return [
          {
            type: "completed",
            engine: this.cliEngine,
            ok: true,
            answer: finalAnswer,
            resume: threadId,
            usage: isRecord(payload.usage) ? payload.usage : undefined,
          },
        ];
      }
      if (payloadType === "turn.failed") {
        if (didEmitCompleted) {
          return [];
        }
        didEmitCompleted = true;
        const errorMessage = isRecord(payload.error) ? asString(payload.error.message) : undefined;
        return [
          {
            type: "completed",
            engine: this.cliEngine,
            ok: false,
            answer: finalAnswer || undefined,
            error: errorMessage ?? "Codex turn failed",
            resume: threadId,
          },
        ];
      }
      if (payloadType === "error") {
        const message = asString(payload.message) ?? "Codex stream error";
        if (/reconnecting/i.test(message)) {
          return [
            {
              type: "action",
              engine: this.cliEngine,
              phase: "updated",
              entryType: "thought",
              action: {
                id: nextSyntheticId("codex-reconnect"),
                kind: "warning",
                title: "stream reconnect",
                detail: { message },
              },
              message,
              ok: true,
              level: "warning",
            },
          ];
        }
        if (didEmitCompleted) {
          return [
            {
              type: "action",
              engine: this.cliEngine,
              phase: "completed",
              entryType: "thought",
              action: {
                id: nextSyntheticId("codex-error"),
                kind: "warning",
                title: "stream error",
                detail: { message },
              },
              message,
              ok: false,
              level: "error",
            },
          ];
        }
        didEmitCompleted = true;
        return [
          {
            type: "completed",
            engine: this.cliEngine,
            ok: false,
            answer: finalAnswer || undefined,
            error: message,
            resume: threadId,
          },
        ];
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
        return [
          {
            type: "action",
            engine: this.cliEngine,
            phase: "completed",
            entryType: "thought",
            action: {
              id: nextSyntheticId("codex-stderr"),
              kind: "warning",
              title: "stderr",
              detail: {},
            },
            message: truncate(trimmedLine, 220),
            ok: true,
            level: "warning",
          },
        ];
      },
      onExit: (result) => {
        if (didEmitCompleted) {
          return [];
        }
        const isSuccess = (result.exitCode ?? 0) === 0;
        didEmitCompleted = true;
        return [
          {
            type: "completed",
            engine: this.cliEngine,
            ok: isSuccess,
            answer: finalAnswer || undefined,
            error: isSuccess ? undefined : `Codex exited with code ${result.exitCode ?? -1}`,
            resume: threadId,
          },
        ];
      },
    };
  }
  /**
   * Normalize a `file_change` action (as emitted by {@link createOutputInterpreter})
   * into {@link AgentFileChange} records. `action.detail.changes` is codex's
   * native `{path, kind}[]` — no diff content in the protocol.
   *
   * @param {unknown} action
   * @returns {import("./agent-contract/AgentFileChange.ts").AgentFileChange[] | undefined}
   */
  parseFileChanges(action) {
    const fileAction = /** @type {{ detail?: { changes?: unknown } } | undefined} */ (action);
    return parseCodexFileChanges(fileAction?.detail?.changes);
  }
  /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
  async buildCommand(params) {
    const resumeSession = typeof params.options?.resumeSession === "string" ? params.options.resumeSession : undefined;
    const args = resumeSession ? ["exec", "resume"] : ["exec"];
    const yoloEnabled = this.opts.yolo ?? this.yolo;
    // First-class effort → model_reasoning_effort (explicit config wins).
    // Documented ceiling: Codex historically accepts only
    // minimal | low | medium | high (xhigh on newer gpt-5-codex). This is a
    // pass-through — `max` from the shared ladder is NOT a Codex value, so
    // forwarding it is the caller's responsibility (Codex will reject it).
    const effort =
      (typeof this.opts.effort === "string" && this.opts.effort) ||
      (typeof this.effort === "string" && this.effort) ||
      null;
    /** @type {CodexConfigOverrides | undefined} */
    let configForNorm = this.opts.config;
    if (effort) {
      if (Array.isArray(configForNorm)) {
        const entries = configForNorm.map(String);
        const hasExplicitEffort = entries.some((entry) => /^\s*model_reasoning_effort\s*=/.test(entry));
        configForNorm = hasExplicitEffort ? entries : [...entries, `model_reasoning_effort=${effort}`];
      } else {
        const base =
          configForNorm && typeof configForNorm === "object"
            ? { .../** @type {Record<string, unknown>} */ (configForNorm) }
            : {};
        if (base.model_reasoning_effort == null) {
          base.model_reasoning_effort = effort;
        }
        configForNorm = base;
      }
    }
    const configOverrides = normalizeCodexConfig(configForNorm);
    for (const entry of configOverrides) {
      args.push("-c", entry);
    }
    // codex-cli parses `--enable`/`--disable` as one FEATURE per occurrence
    // (clap Vec without num_args; verified against codex-cli 0.149.0
    // codex-rs/utils/cli/src/shared_options.rs and empirically: a second value
    // becomes the positional PROMPT). `--image` is genuinely variadic
    // (`num_args = 1..`), so it stays on pushList.
    pushRepeated(args, "--enable", this.opts.enable);
    pushRepeated(args, "--disable", this.opts.disable);
    pushList(args, "--image", this.opts.image);
    pushFlag(args, "--model", this.opts.model ?? this.model);
    if (!resumeSession && this.opts.oss) args.push("--oss");
    if (!resumeSession) pushFlag(args, "--local-provider", this.opts.localProvider);
    if (!resumeSession) pushFlag(args, "--sandbox", this.opts.sandbox);
    if (!resumeSession) pushFlag(args, "--profile", this.opts.profile);
    if (!resumeSession && this.opts.fullAuto && !this.opts.sandbox) {
      // codex-cli 0.147 removed `--full-auto` entirely (it errors with
      // "unexpected argument"); it was an alias for `--sandbox
      // workspace-write`, so emit the canonical flag. An explicit sandbox
      // option still wins via the pushFlag above.
      args.push("--sandbox", "workspace-write");
    } else if (yoloEnabled || this.opts.dangerouslyBypassApprovalsAndSandbox) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    // `workspace-write` permits writes under the workspace and /tmp only, so a
    // worktree or submodule whose gitdir lives in the parent repository cannot
    // be committed to. Widen the sandbox to those gitdirs alone. An explicit
    // `writable_roots` in the caller's config wins, exactly as an explicit
    // `sandbox` wins over `fullAuto` above.
    const sandboxMode = !resumeSession && this.opts.fullAuto && !this.opts.sandbox
      ? "workspace-write"
      : this.opts.sandbox;
    if (
      !resumeSession &&
      sandboxMode === "workspace-write" &&
      !configOverrides.some((entry) => entry.startsWith(`${WRITABLE_ROOTS_KEY}=`))
    ) {
      const gitDirs = await externalGitDirs(params.cwd);
      if (gitDirs.length > 0) {
        args.push("-c", `${WRITABLE_ROOTS_KEY}=[${gitDirs.map((dir) => JSON.stringify(dir)).join(",")}]`);
      }
    }
    if (!resumeSession) pushFlag(args, "--cd", this.opts.cd);
    if (this.opts.skipGitRepoCheck) args.push("--skip-git-repo-check");
    // `--add-dir` takes one DIR per occurrence in codex-cli; a second value
    // would be parsed as the positional prompt (#1622).
    if (!resumeSession) pushRepeated(args, "--add-dir", this.opts.addDir);
    if (!resumeSession) {
      pushFlag(args, "--output-schema", this.opts.outputSchema);
    }
    pushFlag(args, "--color", this.opts.color);
    // Always enable JSON output to capture JSONL events including
    // turn.completed with token usage for metrics. extractUsageFromOutput
    // in BaseCliAgent will parse these automatically.
    args.push("--json");
    // Auto-wire output schema from task context if not explicitly set — only when
    // native structured output is opted in. Otherwise the engine handles the schema
    // via prompt-injection and Codex keeps full tool access (see constructor note).
    // Skip when resuming — `codex exec resume` does not accept --output-schema.
    let schemaCleanupFile = null;
    if (
      !resumeSession &&
      this.opts.nativeStructuredOutput === true &&
      !this.opts.outputSchema &&
      params.options?.outputSchema
    ) {
      const schema = params.options.outputSchema;
      const jsonSchema = await zodToOpenAISchema(schema);
      const schemaFile = join(tmpdir(), `smithers-schema-${randomUUID()}.json`);
      await fs.writeFile(schemaFile, JSON.stringify(jsonSchema), "utf8");
      pushFlag(args, "--output-schema", schemaFile);
      schemaCleanupFile = schemaFile;
    }
    const outputFile = this.opts.outputLastMessage ?? join(tmpdir(), `smithers-codex-${randomUUID()}.txt`);
    pushFlag(args, "--output-last-message", outputFile);
    if (this.extraArgs?.length) args.push(...this.extraArgs);
    if (resumeSession) args.push(resumeSession);
    const systemPrefix = params.systemPrompt ? `${params.systemPrompt}\n\n` : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;
    args.push("-");
    const accountEnv = {};
    if (this.opts.configDir) accountEnv.CODEX_HOME = this.opts.configDir;
    if (this.opts.apiKey) accountEnv.OPENAI_API_KEY = this.opts.apiKey;
    return {
      command: "codex",
      args,
      stdin: fullPrompt,
      outputFile,
      outputFormat: "stream-json",
      env: Object.keys(accountEnv).length > 0 ? accountEnv : undefined,
      stdoutBannerPatterns: [
        // Codex CLI prints a startup banner like:
        // "OpenAI Codex v0.99.0-alpha.13 (research preview)"
        /^OpenAI Codex v[^\n]*$/gm,
      ],
      cleanup: async () => {
        if (!this.opts.outputLastMessage) {
          await fs.rm(outputFile, { force: true }).catch(() => undefined);
        }
        if (schemaCleanupFile) {
          await fs.rm(schemaCleanupFile, { force: true }).catch(() => undefined);
        }
      },
    };
  }
}
