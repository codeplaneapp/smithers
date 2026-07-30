import type { AgentCheckpoint } from "./AgentCheckpoint";
import type { AgentGenerateOptions } from "./BaseCliAgent/AgentGenerateOptions";

export type NanocodexApiKeyAuth = {
  mode: "api-key-env";
  environmentVariable: string;
};

export type NanocodexChatGptAuth = {
  mode: "chatgpt";
  /** Absolute Unicode scalar managed-auth path without NUL, at most 4,096 UTF-16 code units. */
  authFile?: string;
};

export type NanocodexAuth = NanocodexApiKeyAuth | NanocodexChatGptAuth;

export type NanocodexThinking = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type NanocodexReasoningMode = "standard" | "pro";

/**
 * Per-call options accepted by {@link NanocodexAgent.generate}. Protocol v1
 * supports same-session checkpoint resume only and does not accept provider
 * session identifiers.
 */
export type NanocodexGenerateOptions = AgentGenerateOptions & {
  /** Nanocodex always uses its stock native tool set. */
  tools?: never;
  /** Provider options are configured on the agent, not per call. */
  options?: never;
  resumeCheckpoint?: AgentCheckpoint;
  checkpointMode?: "resume";
  resumeSession?: never;
};

/**
 * Configuration for one stock, headless Nanocodex worker per generate call.
 * Native Code Mode remains enabled; JavaScript tools, MCP, subagents, custom
 * endpoints, and workspace relocation are intentionally not configurable.
 * Protocol v1 requires Linux x86_64, glibc >=2.35, and a working Bubblewrap
 * installation.
 */
export type NanocodexAgentOptions = {
  id?: string;
  /** Absolute path or executable name resolved from the effective PATH. */
  binary?: string;
  cwd?: string;
  auth?: NanocodexAuth;
  /** Complete instruction replacement, at most 4 MiB encoded as UTF-8. */
  instructions?: string;
  thinking?: NanocodexThinking;
  reasoningMode?: NanocodexReasoningMode;
  fastMode?: boolean;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  /** Total timeout in milliseconds. Must not exceed 2^31 - 1. */
  timeoutMs?: number;
  /** Idle timeout in milliseconds. Must not exceed 2^31 - 1. */
  idleTimeoutMs?: number;
  /** Grace period for protocol cancellation. Must not exceed 2^31 - 1. */
  cancellationGraceMs?: number;
  maxCheckpointBytes?: number;
};
