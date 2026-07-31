import type { Schema } from "effect";

export type TaggedWorkerError =
  | {
      _tag: "TaskAborted";
      message: string;
      details?: Schema.JsonObject;
      name?: string;
    }
  | {
      _tag: "TaskTimeout";
      message: string;
      nodeId: string;
      attempt: number;
      timeoutMs: number;
    }
  | {
      _tag: "TaskHeartbeatTimeout";
      message: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timeoutMs: number;
      staleForMs: number;
      lastHeartbeatAtMs: number;
    }
  | { _tag: "RunNotFound"; message: string; runId: string }
  | {
      _tag: "InvalidInput";
      message: string;
      details?: Schema.JsonObject;
    }
  | {
      _tag: "DbWriteFailed";
      message: string;
      details?: Schema.JsonObject;
    }
  | {
      _tag: "AgentCliError";
      message: string;
      details?: Schema.JsonObject;
    }
  | {
      _tag: "WorkflowFailed";
      message: string;
      details?: Schema.JsonObject;
      status?: number;
    };
