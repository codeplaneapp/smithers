import type { ReactNode } from "react";
import type { ZodType } from "zod";
import type { LinearConfig } from "./LinearConfig.ts";
import type { LinearPriority } from "./LinearClientTypes.ts";

/** Props shared by the Linear listener components (Signal.js pattern). */
export type LinearListenerProps<Schema extends ZodType = ZodType> = {
  id: string;
  key?: string | number;
  /** Wait for events about this issue (`ENG-123` correlation). */
  issueId?: string;
  /** Wait for events about this team's issues (`ENG` correlation). */
  teamKey?: string;
  /**
   * Registered createSmithers output schema the delivered payload is
   * validated against (see `linearIssueEventSchema` /
   * `linearCommentEventSchema` for the wire shape).
   */
  schema?: Schema;
  timeoutMs?: number;
  onTimeout?: "fail" | "skip";
  async?: boolean;
  dependsOn?: string[];
  needs?: Record<string, string>;
  label?: string;
  meta?: Record<string, unknown>;
  smithersContext?: unknown;
  skipIf?: boolean;
  children?: (payload: any) => ReactNode;
};

/** A prop that is either a value or derived from resolved deps. */
export type FromDeps<T> = T | ((deps: Record<string, any>) => T);

type OutboundBaseProps = {
  id: string;
  key?: string | number;
  /** Explicit Linear config; falls back to `configureLinear` then env. */
  config?: LinearConfig;
  /** Registered output schema (e.g. `linearIssueOutputSchema`). */
  output?: unknown;
  outputSchema?: unknown;
  retryPolicy?: unknown;
  timeoutMs?: number;
  async?: boolean;
  dependsOn?: string[];
  needs?: Record<string, string>;
  label?: string;
  /** Upstream outputs; function-valued props receive the resolved values. */
  deps?: Record<string, unknown>;
  smithersContext?: unknown;
  skipIf?: boolean;
};

export type CreateIssueProps = OutboundBaseProps & {
  teamKey?: FromDeps<string>;
  teamId?: FromDeps<string>;
  title: FromDeps<string>;
  description?: FromDeps<string | undefined>;
  priority?: FromDeps<LinearPriority | undefined>;
  labels?: FromDeps<string[] | undefined>;
  stateName?: FromDeps<string | undefined>;
  assigneeId?: FromDeps<string | undefined>;
};

export type UpdateIssueProps = OutboundBaseProps & {
  /** Issue UUID or identifier like `ENG-123`. */
  issue: FromDeps<string>;
  title?: FromDeps<string | undefined>;
  description?: FromDeps<string | undefined>;
  priority?: FromDeps<LinearPriority | undefined>;
  labels?: FromDeps<string[] | undefined>;
  stateName?: FromDeps<string | undefined>;
  assigneeId?: FromDeps<string | undefined>;
};

export type CommentOnIssueProps = OutboundBaseProps & {
  /** Issue UUID or identifier like `ENG-123`. */
  issue: FromDeps<string>;
  body: FromDeps<string>;
};
