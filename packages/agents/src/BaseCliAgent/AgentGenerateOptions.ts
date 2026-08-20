import type { AgentCliEvent } from "./AgentCliEvent";
import type { HostLike, AgentStep } from "@flows/harness/AgentStep";
import type { AgentCheckpoint, AgentCheckpointMode, AgentCheckpointPublisher } from "../AgentCheckpoint";

/**
 * Loosely-typed generation options. The AI SDK passes a dynamic shape here
 * (GenerateTextOptions / StreamTextOptions and provider-specific extensions)
 * so we keep this permissive but avoid raw `any`.
 */
type AgentGenerateOptionsBase = {
  prompt?: unknown;
  messages?: unknown;
  timeout?: unknown;
  abortSignal?: AbortSignal;
  rootDir?: string;
  /** Awaited durability fence for publishing checkpoints during generation. */
  onCheckpoint?: AgentCheckpointPublisher;
  /** Effective per-run checkpoint ceiling, never above Smithers's system maximum. */
  maxAgentCheckpointBytes?: number;
  maxOutputBytes?: number;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  onEvent?: (event: AgentCliEvent) => unknown;
  /** Full flows input used when invoking a harness-backed AgentLike. */
  harnessStep?: AgentStep;
  /** Protected host layer used when invoking a harness-backed AgentLike. */
  harnessHost?: HostLike;
  onProcess?: (event: {
    phase: "started" | "exited";
    pid: number | undefined;
    exitCode?: number | null;
    signal?: string | null;
  }) => void;
  onToolExecutionStart?: (event: { callId?: string; toolCall?: { toolCallId?: string } }) => unknown;
  onToolExecutionEnd?: (event: { callId?: string; toolCall?: { toolCallId?: string } }) => unknown;
  retry?: unknown;
  isRetry?: unknown;
  retryAttempt?: unknown;
  schemaRetry?: unknown;
  /**
   * Run context for the task this agent invocation belongs to. Surfaced to the
   * spawned agent process (and its subprocesses) as SMITHERS_RUN_ID / NODE_ID /
   * ITERATION / ATTEMPT so the agent can address its own run — e.g. to raise a
   * blocking `smithers ask-human` request. It also sets SMITHERS_INSIDE_RUN,
   * the recursion marker telling the agent's own skills that it is already
   * executing inside a run and must not launch or steer Smithers runs.
   */
  taskContext?: {
    runId?: string;
    nodeId?: string;
    iteration?: number;
    attempt?: number;
  };
  [key: string]: unknown;
};

/**
 * Continuation inputs are discriminated so a checkpoint always has an
 * explicit mode and cannot be combined with a provider session id.
 */
export type AgentCheckpointContinuationOptions =
  | {
      /** State captured from an earlier generation. */
      resumeCheckpoint: AgentCheckpoint;
      /** Whether the checkpoint continues one session or seeds an isolated fork. */
      checkpointMode: AgentCheckpointMode;
      resumeSession?: never;
    }
  | {
      resumeCheckpoint?: never;
      checkpointMode?: never;
      resumeSession?: string;
    };

export type AgentGenerateOptions = AgentGenerateOptionsBase & AgentCheckpointContinuationOptions;
