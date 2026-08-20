import type { AgentCapabilityRegistry } from "./capability-registry";
import type { AgentGenerateOptions } from "./BaseCliAgent/AgentGenerateOptions";
import type { AgentFileChange } from "./agent-contract/AgentFileChange";
import type { AgentCheckpointCapability, AgentCheckpointFormat } from "./AgentCheckpoint";
import type { AgentStep, HostLike } from "@flows/harness/AgentStep";
import type { Harness } from "@flows/harness/Harness";

/**
 * Represents an entity capable of generating responses or actions based on prompts.
 * This is typically an AI agent interface.
 */
export type AgentLike = {
  /** Optional unique identifier for the agent */
  id?: string;
  /** Available tools the agent can use */
  tools?: Record<string, unknown>;
  /** Optional structured capability registry for cache and diagnostics */
  capabilities?: AgentCapabilityRegistry;
  /** True when the agent consumes outputSchema through a native structured-output API. */
  supportsNativeStructuredOutput?: boolean;
  /** Optional harness-specific file-change normalizer. */
  parseFileChanges?: (rawEvent: unknown) => AgentFileChange[] | undefined;
  /** Version- and mode-aware checkpoint formats this agent can consume. */
  checkpointCapabilities?: readonly AgentCheckpointCapability[];
  /** Checkpoint formats this agent may return or publish during generation. */
  checkpointFormats?: readonly AgentCheckpointFormat[];
  /**
   * Performs deterministic startup checks before the first generation call in a
   * workflow run. A rejected promise fails the task without retrying.
   */
  preflight?: (args?: AgentGenerateOptions) => Promise<void>;
  /** Native flows Harness entrypoint exposed by first-class adapters. */
  run?: (step: AgentStep, host: HostLike) => ReturnType<Harness["run"]>;
  /**
   * Generates a response or action based on the provided arguments.
   *
   * @param args - The arguments for generation
   * @param args.options - Optional provider-specific configuration
   * @param args.abortSignal - Signal to abort the generation request
   * @param args.prompt - The input text prompt to generate from
   * @param args.timeout - Optional timeout configuration in milliseconds
   * @param args.onStdout - Callback for streaming standard output text
   * @param args.onStderr - Callback for streaming standard error text
   * @param args.outputSchema - Optional Zod schema defining the expected structured output format
   * @returns A promise resolving to the generated output. Results may include
   * an optional `checkpoint: AgentCheckpoint` for a later resume or fork.
   */
  generate: (args?: AgentGenerateOptions) => Promise<unknown>;
};
