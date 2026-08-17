import type { z } from "zod";
import type { AgentLike } from "@smthrs/agents/AgentLike";
import type { RetryPolicy } from "@smthrs/scheduler/RetryPolicy";
import type { OutputTarget } from "./OutputTarget.ts";

/**
 * One bounded repair task that runs after the owning task reaches a terminal
 * failure. Its output is durable and Zod-validated like any other task output.
 */
export type TaskRepair<Output extends OutputTarget = OutputTarget> = {
  /** Agent, or bounded fallback chain, used to repair the failed task's precondition. */
  agent: AgentLike | AgentLike[];
  /** Durable destination for the repair task's structured result. */
  output: Output;
  /** Optional schema override when `output` is not already a Zod object. */
  outputSchema?: z.ZodObject<z.ZodRawShape>;
  /** Additional instructions appended to the automatically generated failure context. */
  instructions?: string;
  /** Number of retries for the repair task itself. Defaults to 0 and must be finite. */
  retries?: number;
  retryPolicy?: RetryPolicy;
  timeoutMs?: number;
  heartbeatTimeoutMs?: number;
  heartbeatTimeout?: number;
  maxSchemaRetries?: number;
};
