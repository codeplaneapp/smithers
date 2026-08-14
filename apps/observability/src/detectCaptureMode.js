import { detectAgentFamily } from "./detectAgentFamily.js";
/**
 * @typedef {import('./agentTrace.ts').AgentCaptureMode} AgentCaptureMode
 */

/**
 * @param {any} agent
 * @returns {AgentCaptureMode}
 */
export function detectCaptureMode(agent) {
  const family = detectAgentFamily(agent);
  const constructorName = String(agent?.constructor?.name ?? "").toLowerCase();
  const mode = agent?.opts?.mode ?? agent?.mode;
  if (family === "pi") {
    if (mode === "rpc") return "rpc-events";
    if (mode === "json") return "cli-json-stream";
    return "cli-text";
  }
  // NanocodexAgent consumes its private JSONL bridge internally and exposes
  // already-decoded assistant text through onStdout plus sanitized lifecycle
  // events through onEvent. Parsing that text again as Codex CLI JSONL creates
  // false truncated-json-stream warnings and loses valid deltas.
  if (family === "codex") return constructorName.includes("nanocodexagent") ? "cli-text" : "cli-json-stream";
  const outputFormat = agent?.opts?.outputFormat ?? agent?.outputFormat;
  if (family === "openai" || family === "anthropic") return "sdk-events";
  if (outputFormat === "stream-json") return "cli-json-stream";
  if (outputFormat === "json" || agent?.opts?.json) return "cli-json";
  return "cli-text";
}
