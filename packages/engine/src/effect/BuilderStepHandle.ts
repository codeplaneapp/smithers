import type { Effect, Schema } from "effect";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { CachePolicy } from "@smthrs/scheduler/CachePolicy";
import type { RetryPolicy } from "@smthrs/scheduler/RetryPolicy";

// `unknown` here made every concrete `Schema.Struct<...>` unassignable (schema
// type params are invariant), so the documented Effect API could not typecheck
// at all. `any` keeps the shape while accepting any concrete schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = Schema.Schema<any>;
type AnyEffect = unknown | Promise<unknown> | Effect.Effect<unknown, unknown, unknown>;

type BuilderStepContext = Record<string, unknown> & {
  input: unknown;
  executionId: string;
  stepId: string;
  attempt: number;
  signal: AbortSignal;
  iteration: number;
  heartbeat: (data?: unknown) => void;
  lastHeartbeat: unknown | null;
};

type ApprovalOptions = {
  needs?: Record<string, BuilderStepHandle>;
  request: (ctx: Record<string, unknown>) => {
    title: string;
    summary?: string | null;
  };
  onDeny?: "fail" | "continue" | "skip";
};

export type BuilderStepHandle = {
  kind: "step" | "approval";
  id: string;
  localId: string;
  tableKey: string;
  tableName: string;
  table: SQLiteTable;
  output: AnySchema;
  needs: Record<string, BuilderStepHandle>;
  run?: (ctx: BuilderStepContext) => AnyEffect;
  request?: ApprovalOptions["request"];
  onDeny?: "fail" | "continue" | "skip";
  retries: number;
  retryPolicy?: RetryPolicy;
  timeoutMs: number | null;
  skipIf?: (ctx: BuilderStepContext) => boolean;
  loopId?: string;
  cache?: CachePolicy;
};
