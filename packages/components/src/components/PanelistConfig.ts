import type { AgentLike } from "@smthrs/agents/AgentLike";

export type PanelistConfig = {
  /** A single agent, or a failover CHAIN (`AgentLike[]`) run as one panelist. */
  agent: AgentLike | AgentLike[];
  role?: string;
  label?: string;
};
