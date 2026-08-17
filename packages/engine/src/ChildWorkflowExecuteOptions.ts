import type { ChildWorkflowDefinition } from "./ChildWorkflowDefinition.ts";
import type { RunStartedBy } from "@smthrs/driver/RunStartedBy";

export type ChildWorkflowExecuteOptions = {
  workflow: ChildWorkflowDefinition;
  input?: unknown;
  runId?: string;
  parentRunId?: string;
  rootDir?: string;
  allowNetwork?: boolean;
  maxOutputBytes?: number;
  maxAgentCheckpointBytes?: number;
  toolTimeoutMs?: number;
  workflowPath?: string;
  signal?: AbortSignal;
  pauseSignal?: AbortSignal;
  /** Additional durable child-run provenance/configuration. */
  config?: Record<string, unknown>;
  /** Override inherited launch attribution for this child. */
  startedBy?: RunStartedBy;
};
