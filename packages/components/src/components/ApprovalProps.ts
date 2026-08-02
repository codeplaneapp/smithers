import type React from "react";
import type { z } from "zod";
import type { SmithersCtx } from "@smthrs/driver";
import type { ProofBinding } from "@smthrs/graph/ProofBinding";
import type { ApprovalMode } from "./ApprovalMode.ts";
import type { ApprovalOption } from "./ApprovalOption.ts";
import type { ApprovalRequest } from "./ApprovalRequest.ts";
import type { ApprovalAutoApprove } from "./ApprovalAutoApprove.ts";
import type { ApprovalDecision } from "./ApprovalDecision.ts";
import type { OutputTarget } from "./OutputTarget.ts";

export type ApprovalProps<_Row = ApprovalDecision, Output extends OutputTarget = OutputTarget> = {
  id: string;
  mode?: ApprovalMode;
  options?: ApprovalOption[];
  /** Where to persist the approval decision. Pass a Zod schema from `outputs` (recommended), a Drizzle table, or a string key. */
  output: Output;
  outputSchema?: z.ZodObject<z.ZodRawShape>;
  request: ApprovalRequest;
  onDeny?: "fail" | "continue" | "skip";
  allowedScopes?: string[];
  allowedUsers?: string[];
  autoApprove?: ApprovalAutoApprove;
  /** Do not block unrelated downstream flow while this approval is pending. */
  async?: boolean;
  /** Explicit dependency on other task node IDs. */
  dependsOn?: string[];
  /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
  needs?: Record<string, string>;
  /** Accept a decision only while every bound authority row still has the proved content digest. */
  bind?: ProofBinding | ProofBinding[];
  skipIf?: boolean;
  timeoutMs?: number;
  heartbeatTimeoutMs?: number;
  heartbeatTimeout?: number;
  retries?: number;
  retryPolicy?: import("@smthrs/scheduler/RetryPolicy").RetryPolicy;
  continueOnFail?: boolean;
  cache?: import("@smthrs/scheduler/CachePolicy").CachePolicy;
  label?: string;
  meta?: Record<string, unknown>;
  key?: string;
  children?: React.ReactNode;
  smithersContext?: React.Context<SmithersCtx<unknown> | null>;
};
