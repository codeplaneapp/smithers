import type { AgentCliEvent } from "./AgentCliEvent";

/**
 * Loosely-typed generation options. The AI SDK passes a dynamic shape here
 * (GenerateTextOptions / StreamTextOptions and provider-specific extensions)
 * so we keep this permissive but avoid raw `any`.
 */
export type AgentGenerateOptions = {
  prompt?: unknown;
  messages?: unknown;
  timeout?: unknown;
  abortSignal?: AbortSignal;
  rootDir?: string;
  resumeSession?: string;
  maxOutputBytes?: number;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  onEvent?: (event: AgentCliEvent) => unknown;
  onProcess?: (event: { phase: "started" | "exited"; pid: number | undefined }) => void;
  retry?: unknown;
  isRetry?: unknown;
  retryAttempt?: unknown;
  schemaRetry?: unknown;
  /**
   * Run context for the task this agent invocation belongs to. Surfaced to the
   * spawned agent process (and its subprocesses) as SMITHERS_RUN_ID / NODE_ID /
   * ITERATION / ATTEMPT so the agent can address its own run — e.g. to raise a
   * blocking `smithers ask-human` request.
   */
  taskContext?: {
    runId?: string;
    nodeId?: string;
    iteration?: number;
    attempt?: number;
  };
  [key: string]: unknown;
};
