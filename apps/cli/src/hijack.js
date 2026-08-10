import { spawn } from "node:child_process";
import { accountToProviderEnv, getAccount } from "@smthrs/accounts";
import { SmithersError } from "@smthrs/errors";
import { registeredAgentLabel } from "./registered-agent-id.js";
/** @typedef {import("./HijackCandidate.ts").HijackCandidate} HijackCandidate */
/** @typedef {import("./HijackLaunchSpec.ts").HijackLaunchSpec} HijackLaunchSpec */
/** @typedef {import("./NativeHijackEngine.ts").NativeHijackEngine} NativeHijackEngine */
/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {string | null} [metaJson]
 * @returns {Record<string, unknown>}
 */
function parseAttemptMeta(metaJson) {
  if (!metaJson) return {};
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
/**
 * @param {unknown} value
 * @returns {NativeHijackEngine | undefined}
 */
function asNativeHijackEngine(value) {
  return value === "claude-code" ||
    value === "antigravity" ||
    value === "codex" ||
    value === "pi" ||
    value === "omp" ||
    value === "kimi" ||
    value === "forge" ||
    value === "amp"
    ? value
    : undefined;
}
/**
 * @param {unknown} value
 * @returns {unknown[] | undefined}
 */
function asConversationMessages(value) {
  return Array.isArray(value) ? value : undefined;
}
/**
 * Launch flags the workflow agent ran with (model, permission mode, config
 * dir), recorded by the engine on the hijack hand-off. `--resume` restores
 * conversation state only — per-process argv must be re-emitted explicitly.
 * @param {unknown} value
 * @param {Record<string, unknown>} meta
 * @returns {import("./HijackCandidate.ts").HijackCandidateConfig | undefined}
 */
function extractHijackConfig(value, meta) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  /** @type {import("./HijackCandidate.ts").HijackCandidateConfig} */
  const config = {};
  const model =
    typeof source.model === "string" ? source.model : typeof meta.agentModel === "string" ? meta.agentModel : undefined;
  if (model) config.model = model;
  if (source.yolo === true) config.yolo = true;
  if (typeof source.permissionMode === "string") config.permissionMode = source.permissionMode;
  if (source.dangerouslySkipPermissions === true) config.dangerouslySkipPermissions = true;
  if (typeof source.configDir === "string") config.configDir = source.configDir;
  return Object.keys(config).length > 0 ? config : undefined;
}
/**
 * @param {Record<string, unknown>} meta
 * @returns {| { engine: string; mode: "native-cli"; resume: string } | { engine: string; mode: "conversation"; messages: unknown[] } | null}
 */
function extractContinuationFromMeta(meta) {
  const handoff = meta.hijackHandoff;
  if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
    const engine = typeof handoff.engine === "string" ? handoff.engine : undefined;
    const mode = handoff.mode === "conversation" ? "conversation" : "native-cli";
    const resume = typeof handoff.resume === "string" ? handoff.resume : undefined;
    const messages = asConversationMessages(handoff.messages);
    const accountLabel = registeredAgentLabel(handoff.agentId) ?? registeredAgentLabel(meta.agentId);
    const config = extractHijackConfig(handoff.config, meta);
    if (engine && mode === "native-cli" && resume) {
      return { engine, mode: "native-cli", resume, accountLabel, config };
    }
    if (engine && mode === "conversation" && messages?.length) {
      return { engine, mode: "conversation", messages, accountLabel, config };
    }
  }
  const engine = typeof meta.agentEngine === "string" ? meta.agentEngine : undefined;
  const resume = typeof meta.agentResume === "string" ? meta.agentResume : undefined;
  const accountLabel = registeredAgentLabel(meta.agentId);
  const config = extractHijackConfig(undefined, meta);
  if (engine && resume) {
    return { engine, mode: "native-cli", resume, accountLabel, config };
  }
  const messages = asConversationMessages(meta.agentConversation);
  if (engine && messages?.length) {
    return { engine, mode: "conversation", messages, accountLabel, config };
  }
  return null;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} [target]
 * @returns {Promise<HijackCandidate | null>}
 */
export async function resolveHijackCandidate(adapter, runId, target) {
  const attempts = await adapter.listAttemptsForRun(runId);
  const sortedAttempts = [...attempts].sort((a, b) => {
    const aMs = a.startedAtMs ?? 0;
    const bMs = b.startedAtMs ?? 0;
    if (aMs !== bMs) return bMs - aMs;
    if ((a.iteration ?? 0) !== (b.iteration ?? 0)) return (b.iteration ?? 0) - (a.iteration ?? 0);
    return (b.attempt ?? 0) - (a.attempt ?? 0);
  });
  for (const attempt of sortedAttempts) {
    const meta = parseAttemptMeta(attempt.metaJson);
    const extracted = extractContinuationFromMeta(meta);
    if (!extracted) continue;
    if (target && target !== extracted.engine && target !== attempt.nodeId) continue;
    return {
      runId,
      nodeId: attempt.nodeId,
      iteration: attempt.iteration ?? 0,
      attempt: attempt.attempt,
      engine: extracted.engine,
      mode: extracted.mode,
      resume: extracted.mode === "native-cli" ? extracted.resume : undefined,
      messages: extracted.mode === "conversation" ? extracted.messages : undefined,
      accountLabel: extracted.accountLabel,
      cwd: attempt.jjCwd ?? process.cwd(),
      ...(extracted.config ? { config: extracted.config } : {}),
    };
  }
  // Auto-hijack emits this durable event before aborting the live task. Under
  // load, run shutdown can return before the final attempt metadata is flushed,
  // so recover native CLI handoffs from the event instead of falsely reporting
  // CHAT_CREATE_UNAVAILABLE.
  const hijackEvents =
    typeof adapter.listEventsByType === "function" ? await adapter.listEventsByType(runId, "RunHijacked") : [];
  for (const event of [...hijackEvents].reverse()) {
    const payload = parseAttemptMeta(event.payloadJson ?? event.payload_json);
    const engine = typeof payload.engine === "string" ? payload.engine : undefined;
    const resume = typeof payload.resume === "string" ? payload.resume : undefined;
    const nodeId =
      typeof payload.nodeId === "string"
        ? payload.nodeId
        : typeof event.nodeId === "string"
          ? event.nodeId
          : typeof event.node_id === "string"
            ? event.node_id
            : undefined;
    if (!engine || !resume || !nodeId) continue;
    if (target && target !== engine && target !== nodeId) continue;
    const iteration = typeof payload.iteration === "number" ? payload.iteration : 0;
    const attemptNumber = typeof payload.attempt === "number" ? payload.attempt : 1;
    const matchingAttempt = sortedAttempts.find(
      (attempt) =>
        attempt.nodeId === nodeId && (attempt.iteration ?? 0) === iteration && attempt.attempt === attemptNumber,
    );
    const matchingMeta = parseAttemptMeta(matchingAttempt?.metaJson);
    const eventConfig = extractHijackConfig(payload.config, matchingMeta);
    return {
      runId,
      nodeId,
      iteration,
      attempt: attemptNumber,
      engine,
      mode: "native-cli",
      resume,
      accountLabel: registeredAgentLabel(payload.agentId) ?? registeredAgentLabel(matchingMeta.agentId),
      cwd: typeof payload.cwd === "string" ? payload.cwd : process.cwd(),
      ...(eventConfig ? { config: eventConfig } : {}),
    };
  }
  return null;
}

const ACCOUNT_PROVIDERS_BY_ENGINE = {
  "claude-code": new Set(["claude-code", "anthropic-api"]),
  antigravity: new Set(["antigravity"]),
  codex: new Set(["codex", "openai-api"]),
  kimi: new Set(["kimi"]),
};

/**
 * Rehydrate the registered account chosen by the original agent without
 * persisting its credential. The durable candidate stores only the account
 * label; the current registry remains the source of the config dir/API key.
 *
 * @param {{ engine: string; accountLabel?: string }} candidate
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {Record<string, string>}
 */
export function buildHijackEnvironment(candidate, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (!candidate.accountLabel) return env;
  const account = getAccount(candidate.accountLabel, env);
  if (!account) {
    throw new SmithersError(
      "HIJACK_ACCOUNT_NOT_FOUND",
      `Registered agent account "${candidate.accountLabel}" is no longer available`,
      { accountLabel: candidate.accountLabel, engine: candidate.engine },
    );
  }
  if (!ACCOUNT_PROVIDERS_BY_ENGINE[candidate.engine]?.has(account.provider)) {
    throw new SmithersError(
      "HIJACK_ACCOUNT_MISMATCH",
      `Registered agent account "${candidate.accountLabel}" does not match ${candidate.engine}`,
      { accountLabel: candidate.accountLabel, engine: candidate.engine, provider: account.provider },
    );
  }
  Object.assign(env, accountToProviderEnv(account));
  // ClaudeCodeAgent clears ambient API billing for subscription accounts.
  // Preserve the original authentication choice in the resumed CLI too.
  if (candidate.engine === "claude-code" && account.provider === "claude-code") {
    env.ANTHROPIC_API_KEY = "";
  }
  return env;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ target?: string; timeoutMs?: number }} [options]
 * @returns {Promise<HijackCandidate>}
 */
export async function waitForHijackCandidate(adapter, runId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const run = await adapter.getRun(runId);
    const candidate = await resolveHijackCandidate(adapter, runId, options.target);
    if (run && run.status !== "running" && candidate) {
      return candidate;
    }
    await Bun.sleep(200);
  }
  throw new SmithersError("HIJACK_TIMEOUT", `Timed out waiting for Smithers to hand off run ${runId}`, {
    runId,
    timeoutMs,
  });
}
/**
 * @param {HijackCandidate} candidate
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {HijackLaunchSpec}
 */
export function buildHijackLaunchSpec(candidate, baseEnv = process.env) {
  if (candidate.mode !== "native-cli" || !candidate.resume) {
    throw new SmithersError(
      "HIJACK_LAUNCH_MODE",
      `Candidate ${candidate.engine} requires the Smithers conversation hijack flow, not a native CLI launch`,
      candidate,
    );
  }
  const env = buildHijackEnvironment(candidate, baseEnv);
  const config = candidate.config ?? {};
  const yolo = config.yolo === true || config.dangerouslySkipPermissions === true;
  if (config.configDir) {
    // Mirrors the agent env layer (e.g. ClaudeCodeAgent sets CLAUDE_CONFIG_DIR
    // from opts.configDir); a registered account already rehydrated above wins
    // only when the agent itself pinned no config dir.
    if (candidate.engine === "claude-code") env.CLAUDE_CONFIG_DIR = config.configDir;
    if (candidate.engine === "codex") env.CODEX_HOME = config.configDir;
    if (candidate.engine === "kimi") env.KIMI_SHARE_DIR = config.configDir;
  }
  if (candidate.engine === "claude-code") {
    if (env.CLAUDE_CODE_ENTRYPOINT) env.CLAUDE_CODE_ENTRYPOINT = "";
    if (env.CLAUDECODE) env.CLAUDECODE = "";
    const args = ["--resume", candidate.resume];
    if (config.yolo === true) {
      args.push("--allow-dangerously-skip-permissions");
      args.push("--dangerously-skip-permissions");
      if (!config.permissionMode) {
        args.push("--permission-mode", "bypassPermissions");
      }
    }
    if (config.dangerouslySkipPermissions === true) args.push("--dangerously-skip-permissions");
    if (config.permissionMode) args.push("--permission-mode", config.permissionMode);
    if (config.model) args.push("--model", config.model);
    return {
      command: "claude",
      args,
      cwd: candidate.cwd,
      env,
    };
  }
  if (candidate.engine === "antigravity") {
    const args = ["--conversation", candidate.resume];
    if (config.model) args.push("--model", config.model);
    if (yolo) args.push("--dangerously-skip-permissions");
    return {
      command: "agy",
      args,
      cwd: candidate.cwd,
      env,
    };
  }
  if (candidate.engine === "pi") {
    const args = ["--session", candidate.resume];
    if (config.model) args.push("--model", config.model);
    return {
      command: "pi",
      args,
      cwd: candidate.cwd,
      env,
    };
  }
  if (candidate.engine === "omp") {
    const args = ["--resume", candidate.resume, "--cwd", candidate.cwd];
    if (config.model) args.push("--model", config.model);
    if (yolo) args.push("--auto-approve");
    return {
      command: "omp",
      args,
      cwd: candidate.cwd,
      env,
    };
  }
  if (candidate.engine === "kimi") {
    const args = ["--session", candidate.resume, "--work-dir", candidate.cwd];
    if (config.model) args.push("--model", config.model);
    return {
      command: "kimi",
      args,
      cwd: candidate.cwd,
      env,
    };
  }
  if (candidate.engine === "forge") {
    const args = ["--conversation-id", candidate.resume, "-C", candidate.cwd];
    if (config.model) args.push("--model", config.model);
    return {
      command: "forge",
      args,
      cwd: candidate.cwd,
      env,
    };
  }
  if (candidate.engine === "amp") {
    const args = ["threads", "continue", candidate.resume];
    if (config.model) args.push("--model", config.model);
    if (yolo) args.push("--dangerously-allow-all");
    return {
      command: "amp",
      args,
      cwd: candidate.cwd,
      env,
    };
  }
  const args = ["resume", candidate.resume, "-C", candidate.cwd];
  if (config.model) args.push("--model", config.model);
  if (yolo) args.push("--dangerously-bypass-approvals-and-sandbox");
  return {
    command: "codex",
    args,
    cwd: candidate.cwd,
    env,
  };
}
/**
 * @param {HijackCandidate} candidate
 * @returns {candidate is HijackCandidate & { mode: "native-cli"; engine: NativeHijackEngine; resume: string }}
 */
export function isNativeHijackCandidate(candidate) {
  return (
    candidate.mode === "native-cli" &&
    typeof candidate.resume === "string" &&
    Boolean(asNativeHijackEngine(candidate.engine))
  );
}
/**
 * @param {HijackLaunchSpec} spec
 * @returns {Promise<number>}
 */
export function launchHijackSession(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}
