import type { EventBus } from "./events.js";

export type AgentTraceCollectorOptions = {
  eventBus: EventBus;
  runId: string;
  workflowPath?: string | null;
  workflowHash?: string | null;
  cwd: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  agent: unknown;
  agentId?: string;
  model?: string;
  logDir?: string;
  annotations?: Record<string, string | number | boolean>;
};
