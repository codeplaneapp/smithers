import type React from "react";
import type { AgentLike } from "@smthrs/agents/AgentLike";
import type { ForkFanOutTask, ForkFanOutTaskOptions } from "./ForkFanOutTask.ts";
import type { OutputTarget } from "./OutputTarget.ts";

export type ForkFanOutProps = {
  id?: string;
  /**
   * Logical id of the task whose final agent session every generated task forks.
   * Each fan-out task waits for it to complete, then starts from a copy of its
   * conversation snapshot in a fresh, independent session. The source is never
   * mutated.
   */
  fork: string;
  /** Fan-out entries. Each becomes one task forking `fork`. */
  tasks: ForkFanOutTask[];
  /** Default agent for entries that do not set one. */
  agent?: AgentLike | AgentLike[];
  /** Default output target for entries that do not set one (rows keyed by task id). */
  taskOutput?: OutputTarget;
  maxConcurrency?: number;
  /** Display label for the fan-out group in run views. */
  label?: string;
  /** Extra Task props applied to every generated task. Per-entry options win. */
  taskProps?: ForkFanOutTaskOptions;
  skipIf?: boolean;
  /** Optional shared preamble prepended to every entry prompt. */
  children?: string | React.ReactNode;
};
