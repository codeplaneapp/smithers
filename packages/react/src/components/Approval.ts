import React from "react";
import { z } from "zod";
import { SmithersContext } from "../context/index";
import { SmithersError } from "../utils/errors";

export const approvalDecisionSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
});

export const approvalSelectionSchema = z.object({
  selected: z.string(),
  notes: z.string().nullable(),
});

export const approvalRankingSchema = z.object({
  ranked: z.array(z.string()),
  notes: z.string().nullable(),
});

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalSelection = z.infer<typeof approvalSelectionSchema>;
export type ApprovalRanking = z.infer<typeof approvalRankingSchema>;

export type ApprovalRequest = {
  title: string;
  summary?: string;
  metadata?: Record<string, unknown>;
};

export type ApprovalMode = "approve" | "select" | "rank";

export type ApprovalOption = {
  key: string;
  label: string;
  summary?: string;
  metadata?: Record<string, unknown>;
};

export type ApprovalAutoApprove = {
  after?: number;
  condition?: ((ctx: any) => boolean) | (() => boolean);
  audit?: boolean;
  revertOn?: ((ctx: any) => boolean) | (() => boolean);
};

/** Valid output targets for Approval: Zod schema, Drizzle table, or string key. */
type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type ApprovalProps<Row = ApprovalDecision, Output extends OutputTarget = OutputTarget> = {
  id: string;
  mode?: ApprovalMode;
  options?: ApprovalOption[];
  /** Where to persist the approval decision. Pass a Zod schema from `outputs` (recommended), a Drizzle table, or a string key. */
  output: Output;
  outputSchema?: import("zod").ZodObject<any>;
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
  skipIf?: boolean;
  timeoutMs?: number;
  heartbeatTimeoutMs?: number;
  heartbeatTimeout?: number;
  retries?: number;
  retryPolicy?: import("../RetryPolicy").RetryPolicy;
  continueOnFail?: boolean;
  cache?: import("../CachePolicy").CachePolicy;
  label?: string;
  meta?: Record<string, unknown>;
  key?: string;
  children?: React.ReactNode;
  smithersContext?: React.Context<any>;
};

function isZodObject(value: any): value is import("zod").ZodObject<any> {
  return Boolean(value && typeof value === "object" && "shape" in value);
}

function defaultSchemaForMode(mode: ApprovalMode) {
  switch (mode) {
    case "select":
      return approvalSelectionSchema;
    case "rank":
      return approvalRankingSchema;
    default:
      return approvalDecisionSchema;
  }
}

function normalizeMode(mode: ApprovalMode | undefined) {
  switch (mode) {
    case "select":
      return "select" as const;
    case "rank":
      return "rank" as const;
    default:
      return "decision" as const;
  }
}

function normalizeOptions(options: ApprovalOption[] | undefined) {
  return options?.map((option) => ({
    key: option.key,
    label: option.label,
    ...(option.summary ? { summary: option.summary } : {}),
    ...(option.metadata ? { metadata: option.metadata } : {}),
  }));
}

function evaluateBooleanCallback(
  callback: ApprovalAutoApprove[keyof ApprovalAutoApprove],
  ctx: any,
) {
  if (typeof callback !== "function") {
    return undefined;
  }
  return Boolean((callback as any)(ctx));
}

export function Approval<Row = ApprovalDecision>(props: ApprovalProps<Row>) {
  if (props.skipIf) return null;

  const smithersContext = props.smithersContext ?? SmithersContext;
  const ctx = React.useContext(smithersContext);
  const mode = props.mode ?? "approve";
  const approvalMode = normalizeMode(mode);
  const options = normalizeOptions(props.options);
  if ((mode === "select" || mode === "rank") && (!options || options.length === 0)) {
    throw new SmithersError(
      "APPROVAL_OPTIONS_REQUIRED",
      `Approval ${props.id} requires options when mode="${mode}".`,
    );
  }

  const autoApprove = props.autoApprove
    ? {
        ...(typeof props.autoApprove.after === "number" ? { after: props.autoApprove.after } : {}),
        audit: props.autoApprove.audit !== false,
        ...(evaluateBooleanCallback(props.autoApprove.condition, ctx) !== undefined
          ? { conditionMet: evaluateBooleanCallback(props.autoApprove.condition, ctx) }
          : {}),
        ...(evaluateBooleanCallback(props.autoApprove.revertOn, ctx) !== undefined
          ? { revertOnMet: evaluateBooleanCallback(props.autoApprove.revertOn, ctx) }
          : {}),
      }
    : undefined;

  const requestMeta = {
    ...(props.request.summary ? { requestSummary: props.request.summary } : {}),
    ...(options ? { approvalOptions: options } : {}),
    ...(props.allowedScopes?.length ? { approvalAllowedScopes: props.allowedScopes } : {}),
    ...(props.allowedUsers?.length ? { approvalAllowedUsers: props.allowedUsers } : {}),
    ...(autoApprove ? { approvalAutoApprove: autoApprove } : {}),
    ...props.request.metadata,
    ...props.meta,
  };

  return React.createElement("smithers:task", {
    id: props.id,
    key: props.key,
    output: props.output,
    outputSchema:
      props.outputSchema ??
      (isZodObject(props.output) ? props.output : defaultSchemaForMode(mode)),
    dependsOn: props.dependsOn,
    needs: props.needs,
    needsApproval: true,
    waitAsync: props.async === true,
    approvalMode,
    approvalOnDeny: props.onDeny,
    approvalOptions: options,
    approvalAllowedScopes: props.allowedScopes,
    approvalAllowedUsers: props.allowedUsers,
    approvalAutoApprove: autoApprove,
    timeoutMs: props.timeoutMs,
    heartbeatTimeoutMs: props.heartbeatTimeoutMs,
    heartbeatTimeout: props.heartbeatTimeout,
    retries: props.retries,
    retryPolicy: props.retryPolicy,
    continueOnFail: props.continueOnFail,
    cache: props.cache,
    label: props.label ?? props.request.title,
    meta: Object.keys(requestMeta).length > 0 ? requestMeta : undefined,
    __smithersKind: "approval",
  });
}
