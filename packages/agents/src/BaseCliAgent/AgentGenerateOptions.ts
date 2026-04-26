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
  retry?: unknown;
  isRetry?: unknown;
  retryAttempt?: unknown;
  schemaRetry?: unknown;
  [key: string]: unknown;
};
