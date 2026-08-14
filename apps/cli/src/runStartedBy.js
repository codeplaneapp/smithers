import { normalizeRunStartedBy } from "@smthrs/driver";

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Infer the harness that launched this short-lived CLI/MCP process. This is
 * intentionally not used by the engine or long-lived Gateway process.
 *
 * @param {Record<string, unknown>} env
 * @returns {{ harness: string; sessionId?: string } | undefined}
 */
function detectHarness(env) {
  const codexThreadId = nonEmptyString(env.CODEX_THREAD_ID);
  if (codexThreadId) return { harness: "codex", sessionId: codexThreadId };
  const claudeSessionId = nonEmptyString(env.CLAUDE_CODE_SESSION_ID);
  if (claudeSessionId) return { harness: "claude-code", sessionId: claudeSessionId };
  if (nonEmptyString(env.CODEX_CI)) return { harness: "codex" };
  if (nonEmptyString(env.CLAUDECODE) || nonEmptyString(env.CLAUDE_CODE_ENTRYPOINT)) return { harness: "claude-code" };
  return undefined;
}

/** @param {unknown} value */
function isMissingIdentity(value) {
  return value === undefined || (typeof value === "string" && !value.trim());
}

/**
 * Merge explicit CLI/MCP attribution with a trustworthy process environment.
 * Explicit fields always win. `detected` records only identity values actually
 * supplied by inference; prompts are never inferred.
 *
 * @param {{ harness?: unknown; sessionId?: unknown; prompt?: unknown }} explicit
 * @param {Record<string, unknown>} [env]
 * @returns {import("@smthrs/driver/RunStartedBy").RunStartedBy | undefined}
 */
export function resolveCliStartedBy(explicit = {}, env = process.env) {
  const detected = detectHarness(env);
  const inferredHarness = isMissingIdentity(explicit.harness) ? detected?.harness : undefined;
  const inferredSessionId = isMissingIdentity(explicit.sessionId) ? detected?.sessionId : undefined;
  const harness = inferredHarness ?? explicit.harness;
  const sessionId = inferredSessionId ?? explicit.sessionId;
  return normalizeRunStartedBy({
    ...(harness !== undefined ? { harness } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(explicit.prompt !== undefined ? { prompt: explicit.prompt } : {}),
    ...(inferredHarness || inferredSessionId ? { detected: true } : {}),
  });
}
