import type React from "react";
import type { AgentLike } from "@smthrs/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

/** Extra Task props applied to generated fork tasks (component-wide or per entry). */
export type ForkFanOutTaskOptions = {
  continueOnFail?: boolean;
  timeoutMs?: number;
  heartbeatTimeoutMs?: number;
  retries?: number;
};

/** One fan-out entry: a task that forks the shared source session and runs its own prompt. */
export type ForkFanOutTask = ForkFanOutTaskOptions & {
  /** Unique entry identifier; the generated task id is `<id>-<entry.id>`. */
  id: string;
  /** Prompt submitted after the forked session context loads. */
  prompt: string | React.ReactNode;
  /** Agent for this entry (falls back to the component-level `agent`). Fork requires an agent task. */
  agent?: AgentLike | AgentLike[];
  /** Per-entry output schema. */
  output?: OutputTarget;
  /** Human-readable label for run views. */
  label?: string;
  /** Skip only this entry. */
  skipIf?: boolean;
};
