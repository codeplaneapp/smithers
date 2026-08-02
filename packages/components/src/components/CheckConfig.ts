import type { AgentLike } from "@smthrs/agents/AgentLike";

export type CheckConfig = {
  id: string;
  agent?: AgentLike;
  command?: string;
  label?: string;
  /**
   * Kill `command` (SIGTERM) if it hasn't exited after this many
   * milliseconds, so a hanging check can't wedge the run. Defaults to 10
   * minutes; pass `0` to disable the timeout for this check.
   */
  timeoutMs?: number;
};
