import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type PoolAgentOptions = BaseCliAgentOptions & {
  /** Agent name to use (e.g., "default", or a custom configured agent) */
  agentName?: string;
  /** Model to use */
  model?: string;
  /** Sandbox mode: "required" or "disabled" */
  sandbox?: "required" | "disabled";
  /** Continue a previous conversation by Run ID */
  continue?: string;
  /** Resume a previous session by ID */
  resume?: string;
  /** Session id for continuation (preferred over continue) */
  resumeSession?: string;
};
