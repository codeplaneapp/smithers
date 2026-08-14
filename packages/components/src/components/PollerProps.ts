import type React from "react";
import type { AgentLike } from "@smthrs/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

export type PollerProps = {
  /** ID prefix for generated task/component ids. */
  id?: string;
  /** Agent or compute function that checks the condition. */
  check: AgentLike | (() => unknown | Promise<unknown>);
  /** Output schema for the check result. Must include `satisfied: boolean`. */
  checkOutput: OutputTarget;
  /** Maximum poll attempts. Default 30. */
  maxAttempts?: number;
  /** Strategy used to scale the inter-attempt delay. Default "fixed". */
  backoff?: "fixed" | "linear" | "exponential";
  /**
   * Base delay in milliseconds BETWEEN poll attempts; the first attempt runs
   * immediately. Enforced by a durable `<Timer>`. Default 5000.
   */
  intervalMs?: number;
  /** Timeout in ms for a single check attempt. Unbounded when unset. */
  checkTimeoutMs?: number;
  /** Behavior when maxAttempts is reached. Default "fail". */
  onTimeout?: "fail" | "return-last";
  /** Skip the entire component. */
  skipIf?: boolean;
  /** Prompt/condition description for the check agent. */
  children?: React.ReactNode;
};
