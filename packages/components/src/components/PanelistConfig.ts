import type { AgentLike } from "@smithers-orchestrator/agents/AgentLike";

export type PanelistConfig = {
  /** A single agent, or a failover CHAIN (`AgentLike[]`) run as one panelist. */
  agent: AgentLike | AgentLike[];
  role?: string;
  label?: string;
};
