import type { Table } from "drizzle-orm";
import type React from "react";

export type XmlNode = XmlElement | XmlText;

export type XmlElement = {
  kind: "element";
  tag: string;
  props: Record<string, string>;
  children: XmlNode[];
};

export type XmlText = {
  kind: "text";
  text: string;
};

export type TaskDescriptor = {
  nodeId: string;
  ordinal: number;
  iteration: number;
  ralphId?: string;

  /** Set when task is inside <Worktree>. */
  worktreeId?: string;
  worktreePath?: string;

  outputTable: Table | null;
  outputTableName: string;
  outputSchema?: import("zod").ZodObject<any>; // Optional Zod schema for agent output

  parallelGroupId?: string;
  parallelMaxConcurrency?: number;

  needsApproval: boolean;
  skipIf: boolean;
  retries: number;
  timeoutMs: number | null;
  continueOnFail: boolean;

  agent?: AgentLike;
  prompt?: string;
  staticPayload?: unknown;

  label?: string;
  meta?: Record<string, unknown>;
};

/**
 * Minimal agent surface Smithers relies on at runtime.
 *
 * Tests use lightweight mocks that don't implement the full 
 * interface (e.g. missing  and ). Keep this structural
 * type narrow to avoid over-constraining users and tests.
 */
export type AgentLike = {
  id?: string;
  tools?: Record<string, any>;
  generate: (args: {
    options?: any;
    prompt: string;
    timeout?: { totalMs: number } | undefined;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    outputSchema?: import("zod").ZodObject<any>;
  }) => Promise<any>;
  // Allow additional fields provided by specific agent implementations
  [key: string]: any;
};

export type GraphSnapshot = {
  runId: string;
  frameNo: number;
  xml: XmlNode | null;
  tasks: TaskDescriptor[];
};

export type RunStatus =
  | "running"
  | "waiting-approval"
  | "finished"
  | "failed"
  | "cancelled";

export type RunOptions = {
  runId?: string;
  input: Record<string, unknown>;
  maxConcurrency?: number;
  onProgress?: (e: SmithersEvent) => void;
  signal?: AbortSignal;
  resume?: boolean;
  workflowPath?: string;
  rootDir?: string;
  logDir?: string | null;
  allowNetwork?: boolean;
  maxOutputBytes?: number;
  toolTimeoutMs?: number;
};

export type RunResult = {
  runId: string;
  status: "finished" | "failed" | "cancelled" | "waiting-approval";
  output?: unknown;
  error?: unknown;
};

export type OutputKey = { nodeId: string; iteration?: number };

export type SmithersWorkflowOptions = {
  cache?: boolean;
};

export type SchemaRegistryEntry = {
  table: any;
  zodSchema: import("zod").ZodObject<any>;
};

export type SmithersWorkflow<Schema> = {
  db: unknown;
  build: (ctx: SmithersCtx<Schema>) => React.ReactElement;
  opts: SmithersWorkflowOptions;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
};

export interface SmithersCtx<Schema> {
  runId: string;
  iteration: number;
  iterations?: Record<string, number>;
  input: Schema extends { input: infer T } ? T : never;
  outputs: OutputAccessor<Schema>;
  output<T extends keyof Schema>(
    table: Schema[T],
    key: OutputKey,
  ): InferRow<Schema[T]>;
  outputMaybe<T extends keyof Schema>(
    table: Schema[T],
    key: OutputKey,
  ): InferRow<Schema[T]> | undefined;

  /** Get the latest output row for a nodeId (highest iteration, not just current). */
  latest(table: any, nodeId: string): any;

  /** Get latest output row, then safely parse/validate an array field using a Zod schema. Drops invalid items. */
  latestArray(value: unknown, schema: import("zod").ZodType): any[];

  /** Count distinct iterations for a nodeId in a table. */
  iterationCount(table: any, nodeId: string): number;
}

export type OutputAccessor<Schema> = ((table: any) => any[]) &
  Record<string, any[]>;

export type InferRow<TTable> = TTable extends { $inferSelect: infer R }
  ? R
  : never;

export type SmithersEvent =
  | { type: "RunStarted"; runId: string; timestampMs: number }
  | {
      type: "RunStatusChanged";
      runId: string;
      status: RunStatus;
      timestampMs: number;
    }
  | { type: "RunFinished"; runId: string; timestampMs: number }
  | { type: "RunFailed"; runId: string; error: unknown; timestampMs: number }
  | { type: "RunCancelled"; runId: string; timestampMs: number }
  | {
      type: "FrameCommitted";
      runId: string;
      frameNo: number;
      xmlHash: string;
      timestampMs: number;
    }
  | {
      type: "NodePending";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "NodeStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timestampMs: number;
    }
  | {
      type: "NodeFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timestampMs: number;
    }
  | {
      type: "NodeFailed";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      error: unknown;
      timestampMs: number;
    }
  | {
      type: "NodeCancelled";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt?: number;
      reason?: string;
      timestampMs: number;
    }
  | {
      type: "NodeSkipped";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "NodeRetrying";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timestampMs: number;
    }
  | {
      type: "NodeWaitingApproval";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalRequested";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalGranted";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalDenied";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ToolCallStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      toolName: string;
      seq: number;
      timestampMs: number;
    }
  | {
      type: "ToolCallFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      toolName: string;
      seq: number;
      status: "success" | "error";
      timestampMs: number;
    }
  | {
      type: "NodeOutput";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      text: string;
      stream: "stdout" | "stderr";
      timestampMs: number;
    }
  | {
      type: "RevertStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      jjPointer: string;
      timestampMs: number;
    }
  | {
      type: "RevertFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      jjPointer: string;
      success: boolean;
      error?: string;
      timestampMs: number;
    };

export type WorkflowProps = {
  name: string;
  cache?: boolean;
  children?: React.ReactNode;
};

export type TaskProps<Row> = {
  key?: string;
  id: string;
  output: Table | string;
  outputSchema?: import("zod").ZodObject<any>; // Optional Zod schema for agent output
  agent?: AgentLike;
  skipIf?: boolean;
  needsApproval?: boolean;
  timeoutMs?: number;
  retries?: number;
  continueOnFail?: boolean;
  label?: string;
  meta?: Record<string, unknown>;
  children: string | Row | React.ReactNode;
};

export type SequenceProps = {
  skipIf?: boolean;
  children?: React.ReactNode;
};

export type ParallelProps = {
  maxConcurrency?: number;
  skipIf?: boolean;
  children?: React.ReactNode;
};

export type BranchProps = {
  if: boolean;
  then: React.ReactElement;
  else?: React.ReactElement;
  skipIf?: boolean;
};

export type RalphProps = {
  id?: string;
  until: boolean;
  maxIterations?: number;
  onMaxReached?: "fail" | "return-last";
  skipIf?: boolean;
  children?: React.ReactNode;
};

/**
 * Execute a subtree of tasks in a separate worktree rooted at `path`.
 *
 * - `id` provides stable identification for state tracking and scheduling.
 */
export type WorktreeProps = {
  id?: string;
  path: string;
  skipIf?: boolean;
  children?: React.ReactNode;
};

export type SmithersError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};
