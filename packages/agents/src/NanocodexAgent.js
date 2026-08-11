import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { SmithersError } from "@smthrs/errors/SmithersError";

import { DEFAULT_AGENT_CHECKPOINT_MAX_BYTES } from "./agent-checkpoint.js";
import { buildGenerateResult, extractPrompt, resolveTimeouts, toolKindFromName } from "./BaseCliAgent/index.js";
import { taskContextEnv } from "./BaseCliAgent/taskContextEnv.js";
import {
  NANOCODEX_CHECKPOINT_CAPABILITIES,
  NANOCODEX_CHECKPOINT_FORMATS,
  createNanocodexCheckpoint,
  createNanocodexPolicyFingerprint,
  getNanocodexResumeSnapshot,
} from "../internal/nanocodex/checkpoint.js";
import {
  createServerRecordValidator,
  createTurnCancelCommand,
  createTurnStartCommand,
  isHelloRecord,
  isTerminalServerRecord,
  parseNanocodexJson,
  validateNanocodexCapabilities,
} from "../internal/nanocodex/protocol.js";
import {
  resolveNanocodexExecutable,
  runNanocodexCapabilities,
  runNanocodexProcess,
} from "../internal/nanocodex/process.js";

/** @typedef {import("./NanocodexAgentOptions.ts").NanocodexAgentOptions} NanocodexAgentOptions */
/** @typedef {import("./NanocodexAgentOptions.ts").NanocodexGenerateOptions} NanocodexGenerateOptions */
/** @typedef {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} AgentGenerateOptions */
/** @typedef {import("./BaseCliAgent/AgentCliEvent.ts").AgentCliEvent} AgentCliEvent */
/** @typedef {import("../internal/nanocodex/protocol-types.ts").NanocodexCapabilities} NanocodexCapabilities */
/** @typedef {import("../internal/nanocodex/protocol-types.ts").NanocodexServerRecord} NanocodexServerRecord */

const FIXED_MODEL = "gpt-5.6-sol";
const SUPPORTED_TARGET = "x86_64-unknown-linux-gnu";
const MAX_CAPABILITIES_BYTES = 1024 * 1024;
const MAX_PROTOCOL_LINE_BYTES = 40 * 1024 * 1024;
const MAX_PROTOCOL_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_INSTRUCTIONS_BYTES = 4 * 1024 * 1024;
const MAX_AUTH_PATH_CODE_UNITS = 4_096;
const MIN_GLIBC_VERSION = [2, 35];
const OPTION_KEYS = new Set([
  "id",
  "binary",
  "cwd",
  "auth",
  "instructions",
  "thinking",
  "reasoningMode",
  "fastMode",
  "env",
  "inheritEnv",
  "timeoutMs",
  "idleTimeoutMs",
  "cancellationGraceMs",
  "maxCheckpointBytes",
]);
const THINKING_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const REASONING_MODES = new Set(["standard", "pro"]);
const RUST_UNICODE_WHITESPACE_ONLY = /^\p{White_Space}*$/u;
/** @type {Map<string, Promise<void>>} */
const MANAGED_AUTH_TURN_GATES = new Map();

/**
 * Focused Smithers adapter for one stock Nanocodex agent in one headless
 * bridge process per generate call.
 */
export class NanocodexAgent {
  /** @type {string} */
  id;
  model = FIXED_MODEL;
  supportsNativeStructuredOutput = false;
  checkpointFormats = NANOCODEX_CHECKPOINT_FORMATS;
  checkpointCapabilities = NANOCODEX_CHECKPOINT_CAPABILITIES;
  /** @type {NanocodexAgentOptions} */
  opts;

  /** @param {NanocodexAgentOptions} [opts] */
  constructor(opts = {}) {
    validateOptions(opts);
    this.opts = {
      ...opts,
      auth: opts.auth ? { ...opts.auth } : undefined,
      env: opts.env ? { ...opts.env } : undefined,
    };
    this.id = opts.id ?? randomUUID();
  }

  /**
   * Side-effect-free binary/protocol compatibility check. No agent, workspace
   * tool runtime, authentication request, or provider connection is created.
   *
   * @param {AgentGenerateOptions} [args]
   */
  async preflight(args) {
    assertSupportedHost();
    const cwd = await resolveWorkspace(args?.rootDir, this.opts.cwd);
    const overrides = this.environment(args);
    const effectiveEnvironment = this.opts.inheritEnv === false ? overrides : { ...process.env, ...overrides };
    const binary = resolveExecutable(this.binary(), cwd, effectiveEnvironment);
    const capabilities = await readCapabilities(
      binary,
      cwd,
      capabilityEnvironment(effectiveEnvironment),
      args?.abortSignal,
    );
    assertCompatibleTarget(capabilities);
  }

  /**
   * Generic `AgentLike` compatibility signature. The impossible receiver keeps
   * broad continuation options from becoming callable on a concrete instance.
   *
   * @overload
   * @this {never}
   * @param {AgentGenerateOptions} [args]
   * @returns {Promise<unknown>}
   */
  /**
   * @overload
   * @this {NanocodexAgent}
   * @param {NanocodexGenerateOptions} [args]
   * @returns {Promise<import("ai").GenerateTextResult<Record<string, never>, Record<string, unknown>, import("ai").Output.Output<string, string, never>> & import("./AgentCheckpoint.ts").AgentCheckpointResult>}
   */
  /** @param {AgentGenerateOptions} [args] */
  async generate(args = {}) {
    assertSupportedHost();
    assertGenerateBoundary(args);
    const { prompt, systemFromMessages } = extractPrompt(args);
    if (systemFromMessages) {
      throw configError(
        "Nanocodex does not accept per-call system messages; configure complete instructions on the agent.",
      );
    }
    if (typeof prompt !== "string" || RUST_UNICODE_WHITESPACE_ONLY.test(prompt) || hasUnpairedSurrogate(prompt)) {
      throw configError("Nanocodex requires non-empty Unicode scalar prompt text or a message list.");
    }

    const workspace = await resolveWorkspace(args.rootDir, this.opts.cwd);
    const environment = this.environment(args);
    const inheritEnv = this.opts.inheritEnv ?? true;
    const effectiveEnvironment = Object.freeze(inheritEnv ? { ...process.env, ...environment } : { ...environment });
    const configuredAuth = this.auth();
    assertConfiguredAuthentication(configuredAuth, effectiveEnvironment);
    const policyFingerprint = createNanocodexPolicyFingerprint(this.opts.instructions ?? null);
    const maxCheckpointBytes = resolveCheckpointLimit(this.opts.maxCheckpointBytes, args.maxAgentCheckpointBytes);
    const continuation = Object.hasOwn(args, "resumeCheckpoint")
      ? {
          mode: "resume",
          snapshot: resolveResumeSnapshot(args.resumeCheckpoint, workspace, policyFingerprint, maxCheckpointBytes),
        }
      : null;
    const auth = await resolveTurnAuthentication(configuredAuth, effectiveEnvironment, workspace);
    const requestId = randomUUID();
    const startCommandId = randomUUID();
    const start = createTurnStartCommand({
      commandId: startCommandId,
      requestId,
      prompt,
      workspace,
      auth,
      options: compactObject({
        instructions: this.opts.instructions,
        thinking: this.opts.thinking,
        reasoningMode: this.opts.reasoningMode,
        fastMode: this.opts.fastMode,
      }),
      continuation,
    });
    const validateRecord = createServerRecordValidator({ requestId, startCommandId });
    const timeouts = resolveTimeouts(args.timeout, {
      totalMs: this.opts.timeoutMs,
      idleMs: this.opts.idleTimeoutMs,
    });
    validateResolvedTimeouts(timeouts);
    const binary = resolveExecutable(this.binary(), workspace, effectiveEnvironment);
    /** @type {string | undefined} */
    let sessionId;
    /** @type {NanocodexServerRecord | undefined} */
    let terminal;
    /** @type {SmithersError | undefined} */
    let helloFailure;
    const terminalContext = {
      args,
      maxCheckpointBytes,
      policyFingerprint,
      workspace,
    };

    try {
      const capabilities = await readCapabilities(
        binary,
        workspace,
        capabilityEnvironment(effectiveEnvironment),
        args.abortSignal,
      );
      assertCompatibleTarget(capabilities);
      assertTurnFitsCapabilities(prompt, start, capabilities);
      const managedAuthLockKey = auth.mode === "chatgpt" ? auth.authFile : undefined;

      const processResult = await withManagedAuthTurnGate(managedAuthLockKey, args.abortSignal, () =>
        runNanocodexProcess({
          command: binary,
          args: ["serve", "--protocol-version", "1"],
          cwd: workspace,
          env: effectiveEnvironment,
          inheritEnv: false,
          validateRecord,
          isHello: isHelloRecord,
          onHello: async (record, control) => {
            try {
              const capabilities = validateNanocodexCapabilities(record.data);
              assertCompatibleTarget(capabilities);
              assertTurnFitsCapabilities(prompt, start, capabilities);
            } catch (cause) {
              helloFailure =
                cause instanceof SmithersError
                  ? cause
                  : configError("Nanocodex bridge hello is incompatible.", { failureRetryable: false }, cause);
              throw helloFailure;
            }
            await control.send(start);
          },
          onRecord: (record, control) => {
            if (record.type === "turn.accepted") sessionId = record.sessionId;
            projectRecord(record, args);
            if (isTerminalServerRecord(record)) {
              terminal = record;
              control.markTerminal(record);
            }
          },
          onCancel: async ({ reason, send }) => {
            const cancelCommand = createTurnCancelCommand({
              commandId: randomUUID(),
              requestId,
              ...(sessionId ? { sessionId } : {}),
              reason,
            });
            validateRecord.registerCancelCommand(cancelCommand);
            await send(cancelCommand);
          },
          signal: args.abortSignal,
          timeoutMs: timeouts.totalMs,
          idleTimeoutMs: timeouts.idleMs,
          maxLineBytes: MAX_PROTOCOL_LINE_BYTES,
          maxInputRecordBytes: capabilities.limits.maxInputRecordBytes,
          maxProtocolBytes: MAX_PROTOCOL_BYTES,
          maxStderrBytes: MAX_STDERR_BYTES,
          cancelGraceMs: this.opts.cancellationGraceMs,
          onStderr: args.onStderr,
          onProcess: args.onProcess,
        }),
      );
      if (!terminal || processResult.terminal !== terminal) {
        throw cliError("Nanocodex bridge exited without an authoritative terminal record.");
      }
      return await this.finishTerminal(terminal, terminalContext);
    } catch (error) {
      if (error instanceof CheckpointPublicationFailure) throw error.cause;
      let recoveredCheckpoint;
      try {
        recoveredCheckpoint = await this.recoverProcessCheckpoint(error, terminalContext);
      } catch (recoveryError) {
        if (recoveryError instanceof CheckpointPublicationFailure) throw recoveryError.cause;
        throw recoveryError;
      }
      if (processErrorCode(error) === "bridge_aborted") {
        if (args.abortSignal?.reason instanceof Error) throw args.abortSignal.reason;
        throw new DOMException("Nanocodex generation was aborted.", "AbortError");
      }
      if (helloFailure) throw helloFailure;
      const mappedError = error instanceof SmithersError ? error : mapProcessError(error);
      if (recoveredCheckpoint) attachRecoveryCheckpoint(mappedError, recoveredCheckpoint);
      throw mappedError;
    }
  }

  /**
   * Publish recovery carried by a process-cleanup failure without making the
   * bridge snapshot part of the durable error surface.
   *
   * @private
   * @param {unknown} error
   * @param {{ args: AgentGenerateOptions; maxCheckpointBytes: number; policyFingerprint: string; workspace: string }} context
   */
  async recoverProcessCheckpoint(error, context) {
    const processTerminal = getProcessErrorTerminal(error);
    if (processTerminal?.type === "turn.completed") {
      return await this.publishCheckpoint(processTerminal.data, context);
    }
    if (processTerminal?.type === "turn.failed" && processTerminal.data.completed) {
      return await this.publishCheckpoint(processTerminal.data.completed, context);
    }
    return undefined;
  }

  /**
   * @private
   * @param {NanocodexServerRecord} terminal
   * @param {{ args: AgentGenerateOptions; maxCheckpointBytes: number; policyFingerprint: string; workspace: string }} context
   */
  async finishTerminal(terminal, context) {
    if (terminal.type === "turn.completed") {
      const result = await this.completedResult(terminal.data, context);
      emitEvent(context.args, {
        type: "completed",
        engine: "nanocodex",
        ok: true,
        answer: terminal.data.finalMessage,
        usage: terminal.data.usage,
      });
      return result;
    }
    if (terminal.type === "turn.failed" || terminal.type === "process.failed") {
      let recoveredCheckpoint;
      if (terminal.type === "turn.failed" && terminal.data.completed) {
        recoveredCheckpoint = await this.publishCheckpoint(terminal.data.completed, context);
      }
      const error = mapBridgeError(terminal.data.error);
      if (recoveredCheckpoint) attachRecoveryCheckpoint(error, recoveredCheckpoint);
      emitEvent(context.args, {
        type: "completed",
        engine: "nanocodex",
        ok: false,
        error: error.summary,
      });
      throw error;
    }
    if (terminal.type === "turn.cancelled") {
      throw cliError("Nanocodex turn was cancelled.", { bridgeCode: "turn_cancelled" });
    }
    throw cliError("Nanocodex bridge returned an invalid terminal outcome.");
  }

  /**
   * @private
   * @param {import("../internal/nanocodex/protocol-types.ts").NanocodexCompletedData} completed
   * @param {{ args: AgentGenerateOptions; maxCheckpointBytes: number; policyFingerprint: string; workspace: string }} context
   */
  async completedResult(completed, context) {
    const checkpoint = await this.publishCheckpoint(completed, context);
    const usage = mapUsage(completed.usage);
    const result = buildGenerateResult(completed.finalMessage, undefined, FIXED_MODEL, usage);
    result.response.messages = [{ role: "assistant", content: [{ type: "text", text: completed.finalMessage }] }];
    result.providerMetadata = {
      nanocodex: {
        estimatedUsd: completed.usage.estimatedUsd,
        costStatus: completed.usage.costStatus,
        serviceTier: completed.usage.serviceTier,
      },
    };
    return Object.assign(result, { checkpoint });
  }

  /**
   * @private
   * @param {import("../internal/nanocodex/protocol-types.ts").NanocodexRecoveryData} completed
   * @param {{ args: AgentGenerateOptions; maxCheckpointBytes: number; policyFingerprint: string; workspace: string }} context
   */
  async publishCheckpoint(completed, context) {
    if (completed.canonicalWorkspace !== context.workspace) {
      throw new SmithersError(
        "AGENT_CHECKPOINT_INVALID",
        "Nanocodex returned a checkpoint for a different canonical workspace.",
        { failureRetryable: false, bridgeCode: "workspace_changed" },
      );
    }
    let checkpoint;
    try {
      checkpoint = createNanocodexCheckpoint(
        {
          snapshot: completed.snapshot,
          snapshotVersion: completed.snapshotVersion,
          canonicalWorkspace: context.workspace,
          policyFingerprint: context.policyFingerprint,
        },
        context.maxCheckpointBytes,
      );
    } catch (cause) {
      throw new SmithersError(
        "AGENT_CHECKPOINT_INVALID",
        "Nanocodex returned a checkpoint that violates the configured Smithers limit or envelope contract.",
        { failureRetryable: false },
        { cause },
      );
    }
    if (context.args.onCheckpoint) {
      try {
        await context.args.onCheckpoint(checkpoint);
      } catch (cause) {
        throw new CheckpointPublicationFailure(cause);
      }
    }
    return checkpoint;
  }

  /** @private */
  binary() {
    return this.opts.binary ?? "smithers-nanocodex";
  }

  /** @private */
  auth() {
    return this.opts.auth ? { ...this.opts.auth } : { mode: "api-key-env", environmentVariable: "OPENAI_API_KEY" };
  }

  /** @private @param {AgentGenerateOptions | undefined} args */
  environment(args) {
    return { ...this.opts.env, ...taskContextEnv(args?.taskContext) };
  }
}

class CheckpointPublicationFailure extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super("Nanocodex checkpoint publication failed.");
    this.name = "CheckpointPublicationFailure";
    this.cause = cause;
  }
}

/** @param {NanocodexAgentOptions} options */
function validateOptions(options) {
  if (!isPlainObject(options)) throw new TypeError("NanocodexAgent options must be a plain object.");
  if (Reflect.ownKeys(options).some((key) => typeof key !== "string" || !OPTION_KEYS.has(key))) {
    throw new TypeError("NanocodexAgent options contain an unsupported field.");
  }
  if (options.id !== undefined && (typeof options.id !== "string" || options.id.trim() === "")) {
    throw new TypeError("NanocodexAgent id must be a non-empty string.");
  }
  if (options.binary !== undefined && (typeof options.binary !== "string" || options.binary.trim() === "")) {
    throw new TypeError("NanocodexAgent binary must be a non-empty string.");
  }
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || !isAbsolute(options.cwd))) {
    throw new TypeError("NanocodexAgent cwd must be an absolute path.");
  }
  if (
    options.instructions !== undefined &&
    (typeof options.instructions !== "string" ||
      RUST_UNICODE_WHITESPACE_ONLY.test(options.instructions) ||
      Buffer.byteLength(options.instructions, "utf8") > MAX_INSTRUCTIONS_BYTES ||
      hasUnpairedSurrogate(options.instructions))
  ) {
    throw configError(
      `NanocodexAgent instructions must be non-empty Unicode scalar text no larger than ${MAX_INSTRUCTIONS_BYTES} UTF-8 bytes.`,
    );
  }
  if (
    options.env !== undefined &&
    (!isPlainObject(options.env) ||
      Reflect.ownKeys(options.env).some((key) => {
        if (typeof key !== "string" || key.length === 0 || key.includes("=") || key.includes("\0")) return true;
        const value = Object.getOwnPropertyDescriptor(options.env, key)?.value;
        return typeof value !== "string" || value.includes("\0");
      }))
  ) {
    throw new TypeError("NanocodexAgent env must contain valid string names and values.");
  }
  if (options.thinking !== undefined && !THINKING_LEVELS.has(options.thinking))
    throw new TypeError("NanocodexAgent thinking level is unsupported.");
  if (options.reasoningMode !== undefined && !REASONING_MODES.has(options.reasoningMode))
    throw new TypeError("NanocodexAgent reasoning mode is unsupported.");
  if (options.fastMode !== undefined && typeof options.fastMode !== "boolean")
    throw new TypeError("NanocodexAgent fastMode must be boolean.");
  if (options.inheritEnv !== undefined && typeof options.inheritEnv !== "boolean")
    throw new TypeError("NanocodexAgent inheritEnv must be boolean.");
  validateAuthentication(options.auth);
  for (const [name, value] of [
    ["timeoutMs", options.timeoutMs],
    ["idleTimeoutMs", options.idleTimeoutMs],
    ["cancellationGraceMs", options.cancellationGraceMs],
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_MS)) {
      throw new TypeError(`NanocodexAgent ${name} must be a non-negative integer no larger than ${MAX_TIMER_MS}.`);
    }
  }
  if (options.maxCheckpointBytes !== undefined) resolveCheckpointLimit(options.maxCheckpointBytes, undefined);
}

/** @param {unknown} auth */
function validateAuthentication(auth) {
  if (auth === undefined) return;
  if (!isPlainObject(auth)) throw new TypeError("NanocodexAgent auth must be a plain object.");
  if (auth.mode === "api-key-env") {
    if (!hasExactKeys(auth, ["mode", "environmentVariable"])) {
      throw new TypeError("NanocodexAgent API-key auth contains an unsupported field.");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(auth.environmentVariable ?? "")) {
      throw new TypeError("NanocodexAgent API-key environment variable name is invalid.");
    }
    return;
  }
  if (auth.mode === "chatgpt") {
    if (!hasExactKeys(auth, ["mode"], ["authFile"])) {
      throw new TypeError("NanocodexAgent managed auth contains an unsupported field.");
    }
    if (auth.authFile !== undefined) assertManagedAuthFilePath(auth.authFile);
    return;
  }
  throw new TypeError("NanocodexAgent authentication mode is unsupported.");
}

/** @param {unknown} authFile */
function assertManagedAuthFilePath(authFile) {
  if (
    typeof authFile !== "string" ||
    !isAbsolute(authFile) ||
    authFile.length > MAX_AUTH_PATH_CODE_UNITS ||
    authFile.includes("\0") ||
    hasUnpairedSurrogate(authFile)
  ) {
    throw configError(
      `NanocodexAgent managed authFile must be an absolute Unicode scalar path without NUL and no longer than ${MAX_AUTH_PATH_CODE_UNITS} UTF-16 code units.`,
    );
  }
}

/** @param {AgentGenerateOptions} args */
function assertGenerateBoundary(args) {
  if (!isPlainObject(args)) throw configError("Nanocodex generation options must be a plain object.");
  if (args.abortSignal !== undefined && !(args.abortSignal instanceof AbortSignal)) {
    throw configError("Nanocodex abortSignal must be an AbortSignal.");
  }
  if (args.resumeSession !== undefined)
    throw configError("Nanocodex continuation uses checkpoints, not resumeSession.");
  const hasCheckpoint = Object.hasOwn(args, "resumeCheckpoint");
  const hasCheckpointMode = Object.hasOwn(args, "checkpointMode");
  if (hasCheckpoint !== hasCheckpointMode) {
    throw configError("Nanocodex resumeCheckpoint and checkpointMode must be supplied together.");
  }
  if (hasCheckpointMode && args.checkpointMode !== "resume") {
    throw configError("Nanocodex protocol v1 supports checkpoint mode resume only.");
  }
  if (args.tools !== undefined)
    throw configError("Nanocodex uses its stock native tools and does not accept JavaScript tools.");
  if (args.options !== undefined && args.options !== null) {
    throw configError("Nanocodex provider options are configured on NanocodexAgent, not per call.");
  }
}

/** @param {{ totalMs?: number; idleMs?: number }} timeouts */
function validateResolvedTimeouts(timeouts) {
  for (const [name, value] of [
    ["total", timeouts.totalMs],
    ["idle", timeouts.idleMs],
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_MS)) {
      throw configError(`Nanocodex ${name} timeout must be a non-negative integer no larger than ${MAX_TIMER_MS}.`);
    }
  }
}

/** @param {unknown} error @returns {NanocodexServerRecord | undefined} */
function getProcessErrorTerminal(error) {
  if (!error || typeof error !== "object" || !("terminal" in error)) return undefined;
  const terminal = error.terminal;
  return isTerminalServerRecord(terminal) ? terminal : undefined;
}

/** @param {SmithersError} error @param {import("./AgentCheckpoint.ts").AgentCheckpoint} checkpoint */
function attachRecoveryCheckpoint(error, checkpoint) {
  Object.defineProperty(error, "checkpoint", {
    configurable: true,
    enumerable: false,
    value: checkpoint,
  });
}

/**
 * @param {unknown} checkpoint
 * @param {string} workspace
 * @param {string} policyFingerprint
 * @param {number} maxCheckpointBytes
 */
function resolveResumeSnapshot(checkpoint, workspace, policyFingerprint, maxCheckpointBytes) {
  try {
    return getNanocodexResumeSnapshot(checkpoint, {
      mode: "resume",
      canonicalWorkspace: workspace,
      policyFingerprint,
      maxBytes: maxCheckpointBytes,
    });
  } catch (cause) {
    throw new SmithersError(
      "AGENT_CHECKPOINT_INVALID",
      "Nanocodex resume checkpoint failed codec, version, workspace, policy, or size validation.",
      { failureRetryable: false },
      { cause },
    );
  }
}

function assertSupportedHost() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw configError("Nanocodex protocol v1 currently supports Linux x86_64 only.");
  }
  let glibcVersion;
  try {
    glibcVersion = process.report?.getReport?.().header?.glibcVersionRuntime;
  } catch {
    glibcVersion = undefined;
  }
  const parsed = parseVersionPair(glibcVersion);
  if (!parsed || compareVersionPair(parsed, MIN_GLIBC_VERSION) < 0) {
    throw configError("Nanocodex protocol v1 requires GNU libc 2.35 or newer; musl is not supported.");
  }
}

/** @param {unknown} value @returns {[number, number] | undefined} */
function parseVersionPair(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(value);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return undefined;
  return [major, minor];
}

/** @param {[number, number]} left @param {[number, number]} right */
function compareVersionPair(left, right) {
  return left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];
}

/** @param {NanocodexCapabilities} capabilities */
function assertCompatibleTarget(capabilities) {
  if (capabilities.target !== SUPPORTED_TARGET) {
    throw configError("Nanocodex bridge target is not supported by this adapter.");
  }
  if (
    capabilities.limits.maxOutputRecordBytes > MAX_PROTOCOL_LINE_BYTES ||
    capabilities.limits.maxEventTotalBytes + capabilities.limits.maxOutputRecordBytes > MAX_PROTOCOL_BYTES ||
    capabilities.limits.maxStderrBytes > MAX_STDERR_BYTES
  ) {
    throw configError("Nanocodex bridge limits exceed this adapter's containment limits.");
  }
}

/** @param {string | undefined} rootDir @param {string | undefined} fallback */
async function resolveWorkspace(rootDir, fallback) {
  const requested = rootDir ?? fallback ?? process.cwd();
  if (!isAbsolute(requested)) throw configError("Nanocodex workspace must be absolute.");
  try {
    const canonical = await realpath(requested);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (cause) {
    throw configError("Nanocodex workspace is unavailable or is not a directory.", undefined, cause);
  }
}

/**
 * @param {string} binary
 * @param {string} cwd
 * @param {Record<string, string>} env
 * @param {AbortSignal | undefined} signal
 */
async function readCapabilities(binary, cwd, env, signal) {
  let bytes;
  try {
    bytes = await runNanocodexCapabilities({
      command: binary,
      cwd,
      env,
      inheritEnv: false,
      signal,
      maxOutputBytes: MAX_CAPABILITIES_BYTES,
      maxStderrBytes: MAX_STDERR_BYTES,
    });
  } catch (error) {
    if (processErrorCode(error) === "bridge_aborted") throw error;
    throw configError("Nanocodex bridge capability preflight failed.", { failureRetryable: false });
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return validateNanocodexCapabilities(parseNanocodexJson(text.trim()));
  } catch {
    throw configError("Nanocodex bridge capabilities are incompatible.", { failureRetryable: false });
  }
}

/** @param {string} command @param {string} cwd @param {Record<string, string>} environment */
function resolveExecutable(command, cwd, environment) {
  try {
    return resolveNanocodexExecutable(command, cwd, environment);
  } catch {
    throw configError("Nanocodex bridge executable could not be resolved.", {
      bridgeCode: "bridge_spawn_failed",
      failureRetryable: false,
    });
  }
}

/** @param {string} prompt @param {unknown} start @param {NanocodexCapabilities} capabilities */
function assertTurnFitsCapabilities(prompt, start, capabilities) {
  if (Buffer.byteLength(prompt, "utf8") > capabilities.limits.maxPromptBytes) {
    throw configError("Nanocodex prompt exceeds the bridge capability limit.");
  }
  // maxInputRecordBytes excludes the JSONL LF delimiter.
  if (Buffer.byteLength(JSON.stringify(start), "utf8") > capabilities.limits.maxInputRecordBytes) {
    throw configError("Nanocodex turn input exceeds the bridge capability limit.");
  }
}

/**
 * Capability discovery needs executable lookup only. In particular it does
 * not need provider credentials or task-context environment values.
 *
 * @param {Record<string, string>} env
 */
function capabilityEnvironment(env) {
  return typeof env.PATH === "string" ? { PATH: env.PATH } : {};
}

/** @param {ReturnType<NanocodexAgent["auth"]>} auth @param {Record<string, string>} env */
function assertConfiguredAuthentication(auth, env) {
  if (
    auth.mode === "api-key-env" &&
    (typeof env[auth.environmentVariable] !== "string" || env[auth.environmentVariable].trim() === "")
  ) {
    throw configError("Nanocodex API-key authentication environment is unavailable.", { failureRetryable: false });
  }
}

/**
 * Resolve the same managed-auth fallback path used by the released bridge once
 * per turn. A canonical existing target makes aliases share one gate; a missing
 * target uses its normalized absolute path and is left for the bridge to
 * classify. The resolved path is both the gate key and the explicit wire path,
 * so a queued alias cannot retarget between admission and bridge startup. The
 * path never enters an error or observable event.
 *
 * @param {ReturnType<NanocodexAgent["auth"]>} auth
 * @param {Record<string, string>} env
 * @param {string} workspace
 */
async function resolveTurnAuthentication(auth, env, workspace) {
  if (auth.mode !== "chatgpt") return auth;
  let candidate = auth.authFile;
  if (candidate === undefined && typeof env.NANOCODEX_AUTH_FILE === "string") {
    candidate = env.NANOCODEX_AUTH_FILE;
  }
  if (candidate === undefined && typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0) {
    candidate = join(env.CODEX_HOME, "auth.json");
  }
  if (candidate === undefined && typeof env.HOME === "string") {
    candidate = join(env.HOME, ".codex", "auth.json");
  }
  if (candidate === undefined && typeof env.USERPROFILE === "string") {
    candidate = join(env.USERPROFILE, ".codex", "auth.json");
  }
  if (candidate === undefined) return auth;
  const absolute = isAbsolute(candidate) ? candidate : resolve(workspace, candidate);
  assertManagedAuthFilePath(absolute);
  let authFile;
  try {
    authFile = await realpath(absolute);
  } catch {
    authFile = absolute;
  }
  assertManagedAuthFilePath(authFile);
  return { mode: "chatgpt", authFile };
}

/**
 * Serialize managed-auth bridge turns across agent instances without making an
 * aborted waiter hold or bypass the active predecessor. Capability preflight
 * remains provider-free and concurrent; the gate covers serve through verified
 * process closure only.
 *
 * @template T
 * @param {string | undefined} key
 * @param {AbortSignal | undefined} signal
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
async function withManagedAuthTurnGate(key, signal, task) {
  if (key === undefined) return await task();
  const predecessor = MANAGED_AUTH_TURN_GATES.get(key) ?? Promise.resolve();
  /** @type {() => void} */
  let release;
  const gate = new Promise((resolveGate) => {
    release = resolveGate;
  });
  MANAGED_AUTH_TURN_GATES.set(key, gate);
  void gate.then(() => {
    if (MANAGED_AUTH_TURN_GATES.get(key) === gate) MANAGED_AUTH_TURN_GATES.delete(key);
  });

  let acquired = false;
  try {
    await waitForManagedAuthPredecessor(predecessor, signal);
    acquired = true;
    if (signal?.aborted) throw managedAuthWaitAborted();
    return await task();
  } finally {
    if (acquired) release();
    else void predecessor.then(release, release);
  }
}

/** @param {Promise<void>} predecessor @param {AbortSignal | undefined} signal */
function waitForManagedAuthPredecessor(predecessor, signal) {
  if (!signal) return predecessor;
  if (signal.aborted) return Promise.reject(managedAuthWaitAborted());
  return new Promise((resolveWait, rejectWait) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) rejectWait(error);
      else resolveWait();
    };
    const onAbort = () => finish(managedAuthWaitAborted());
    signal.addEventListener("abort", onAbort, { once: true });
    predecessor.then(
      () => finish(),
      () => finish(),
    );
    if (signal.aborted) onAbort();
  });
}

function managedAuthWaitAborted() {
  const error = new Error("Nanocodex generation was aborted while waiting for managed authentication.");
  error.name = "NanocodexManagedAuthWaitError";
  Object.assign(error, { code: "bridge_aborted", reason: "aborted" });
  return error;
}

/** @param {number | undefined} configured @param {number | undefined} runtime */
function resolveCheckpointLimit(configured, runtime) {
  for (const value of [configured, runtime]) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_AGENT_CHECKPOINT_MAX_BYTES)
    ) {
      throw new RangeError(
        `Nanocodex checkpoint limits must be positive safe integers no larger than ${DEFAULT_AGENT_CHECKPOINT_MAX_BYTES}.`,
      );
    }
  }
  return Math.min(configured ?? DEFAULT_AGENT_CHECKPOINT_MAX_BYTES, runtime ?? DEFAULT_AGENT_CHECKPOINT_MAX_BYTES);
}

/** @param {import("../internal/nanocodex/protocol-types.ts").NanocodexUsage} usage */
function mapUsage(usage) {
  const noCacheTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens);
  return {
    inputTokens: usage.inputTokens,
    inputTokenDetails: {
      noCacheTokens,
      cacheReadTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteInputTokens,
    },
    outputTokens: usage.outputTokens,
    outputTokenDetails: {
      textTokens: Math.max(0, usage.outputTokens - usage.reasoningOutputTokens),
      reasoningTokens: usage.reasoningOutputTokens,
    },
    totalTokens: usage.totalTokens,
  };
}

/** @param {NanocodexServerRecord} record @param {AgentGenerateOptions} args */
function projectRecord(record, args) {
  if (record.type === "turn.accepted") {
    emitEvent(args, { type: "started", engine: "nanocodex", title: "Nanocodex turn" });
    return;
  }
  if (record.type === "agent.event-truncated") {
    emitEvent(args, {
      type: "action",
      engine: "nanocodex",
      phase: "completed",
      level: "warning",
      action: { id: `truncated-${record.seq}`, kind: "warning", title: "Agent event omitted" },
    });
    return;
  }
  if (record.type === "turn.cancelled") {
    emitEvent(args, {
      type: "completed",
      engine: "nanocodex",
      ok: false,
      error: "Nanocodex turn was cancelled.",
    });
    return;
  }
  if (record.type !== "agent.event" || !isPlainObject(record.data.event)) return;
  const upstream = record.data.event;
  const type = typeof upstream.type === "string" ? upstream.type : "";
  const payload = isPlainObject(upstream.payload) ? upstream.payload : {};
  const upstreamSeq = Number.isSafeInteger(upstream.upstreamSeq) ? upstream.upstreamSeq : record.seq;
  const actionId = `event-${upstreamSeq}`;
  if (type === "assistant.delta" && typeof payload.text === "string") {
    args.onStdout?.(payload.text);
  } else if (type === "assistant.message" && typeof payload.text === "string") {
    emitEvent(args, {
      type: "action",
      engine: "nanocodex",
      phase: "completed",
      entryType: "message",
      action: { id: actionId, kind: "turn", title: "assistant" },
      message: payload.text,
      ok: true,
    });
  } else if (type === "tool.call" && typeof payload.tool === "string") {
    const modelCallIndex = nonNegativeSafeInteger(payload.modelCallIndex);
    emitEvent(args, {
      type: "action",
      engine: "nanocodex",
      phase: "started",
      action: {
        id: typeof payload.callId === "string" ? payload.callId : actionId,
        kind: toolKindFromName(payload.tool),
        title: payload.tool,
        detail: compactObject({ modelCallIndex }),
      },
    });
  } else if (type === "tool.result" && typeof payload.tool === "string") {
    const status = ["completed", "failed", "cancelled"].includes(payload.status) ? payload.status : "unknown";
    const durationNs = nonNegativeSafeInteger(payload.durationNs);
    emitEvent(args, {
      type: "action",
      engine: "nanocodex",
      phase: "completed",
      action: {
        id: typeof payload.callId === "string" ? payload.callId : actionId,
        kind: toolKindFromName(payload.tool),
        title: payload.tool,
        detail: compactObject({ durationNs, status }),
      },
      ok: status === "completed",
      ...(status === "failed" ? { level: "error" } : {}),
    });
  } else if (type === "run.error" || type.endsWith(".failed")) {
    emitEvent(args, {
      type: "action",
      engine: "nanocodex",
      phase: "completed",
      level: "warning",
      action: { id: actionId, kind: "warning", title: "Nanocodex lifecycle warning" },
    });
  }
}

/** @param {unknown} value */
function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** @param {AgentGenerateOptions} args @param {AgentCliEvent} event */
function emitEvent(args, event) {
  if (!args.onEvent) return;
  try {
    void Promise.resolve(args.onEvent(event)).catch(() => undefined);
  } catch {
    // Event observers do not own the generation lifecycle.
  }
}

/** @param {import("../internal/nanocodex/protocol-types.ts").NanocodexPublicError} error */
function mapBridgeError(error) {
  const details = {
    bridgeCode: error.code,
    bridgeCategory: error.category,
    retry: error.retry,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    failureRetryable: error.retry !== "never",
  };
  if (error.category === "checkpoint") {
    return new SmithersError(
      "AGENT_CHECKPOINT_INVALID",
      `Nanocodex checkpoint failed validation (${error.code}).`,
      details,
    );
  }
  if (error.category === "auth") {
    return new SmithersError("AGENT_CONFIG_INVALID", `Nanocodex authentication failed (${error.code}).`, details);
  }
  if (["protocol", "config", "workspace"].includes(error.category)) {
    return new SmithersError("AGENT_CONFIG_INVALID", `Nanocodex configuration failed (${error.code}).`, details);
  }
  if (/quota|usage_limit|rate_limit/.test(error.code)) {
    return new SmithersError(
      "AGENT_QUOTA_EXCEEDED",
      `Nanocodex provider capacity is unavailable (${error.code}).`,
      details,
    );
  }
  return cliError(`Nanocodex turn failed (${error.code}).`, details);
}

/** @param {unknown} error */
function mapProcessError(error) {
  const code = processErrorCode(error) ?? "bridge_failed";
  if (code === "bridge_cleanup_failed") {
    return cliError("Nanocodex bridge cleanup failed.", { bridgeCode: code, failureRetryable: false }, error);
  }
  if (code === "bridge_timeout" || code === "bridge_idle_timeout") {
    return cliError(
      code === "bridge_timeout" ? "Nanocodex exceeded its total timeout." : "Nanocodex exceeded its idle timeout.",
      {
        bridgeCode: code,
      },
    );
  }
  if (
    code === "bridge_spawn_failed" ||
    code === "bridge_containment_unavailable" ||
    code === "bridge_capabilities_failed" ||
    code === "bridge_capabilities_timeout"
  ) {
    return configError(
      code === "bridge_containment_unavailable"
        ? "Nanocodex process containment is unavailable."
        : code.startsWith("bridge_capabilities")
          ? "Nanocodex bridge capability preflight failed."
          : "Nanocodex bridge executable could not be started.",
      { bridgeCode: code, failureRetryable: false },
      error,
    );
  }
  return cliError("Nanocodex bridge failed.", { bridgeCode: code }, error);
}

/** @param {unknown} error */
function processErrorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

/** @param {string} value */
function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** @param {string} summary @param {Record<string, unknown>} [details] @param {unknown} [cause] */
function configError(summary, details = {}, cause) {
  return new SmithersError("AGENT_CONFIG_INVALID", summary, { failureRetryable: false, ...details }, { cause });
}

/** @param {string} summary @param {Record<string, unknown>} [details] @param {unknown} [cause] */
function cliError(summary, details = {}, cause) {
  return new SmithersError("AGENT_CLI_ERROR", summary, details, { cause });
}

/** @param {Record<string, unknown>} value */
function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {Record<string, unknown>} value @param {string[]} required @param {string[]} [optional] */
function hasExactKeys(value, required, optional = []) {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    keys.length >= required.length &&
    keys.length <= allowed.size &&
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
}
