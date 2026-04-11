import React from "react";
import { renderPromptToText } from "./Task";
import type { RetryPolicy } from "../RetryPolicy";

/** Valid output targets: a Zod schema, a Drizzle table object, or a string key. */
type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type HumanTaskProps = {
  id: string;
  /** Where to store the human's response. */
  output: OutputTarget;
  /** Zod schema the human must conform to. Used for validation. */
  outputSchema?: import("zod").ZodObject<any>;
  /** Instructions for the human (string or ReactNode). */
  prompt: string | React.ReactNode;
  /** Max validation retries before failure. */
  maxAttempts?: number;
  /** Do not block unrelated downstream flow while waiting for human input. */
  async?: boolean;
  skipIf?: boolean;
  timeoutMs?: number;
  continueOnFail?: boolean;
  /** Explicit dependency on other task node IDs. */
  dependsOn?: string[];
  /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
  needs?: Record<string, string>;
  label?: string;
  meta?: Record<string, unknown>;
  key?: string;
};

function isZodObject(value: any): value is import("zod").ZodObject<any> {
  return Boolean(value && typeof value === "object" && "shape" in value);
}

export function HumanTask(props: HumanTaskProps) {
  if (props.skipIf) return null;

  const maxAttempts = props.maxAttempts ?? 10;
  const outputSchema =
    props.outputSchema ?? (isZodObject(props.output) ? props.output : undefined);

  const promptText = renderPromptToText(props.prompt);

  const humanMeta = {
    humanTask: true,
    maxAttempts,
    prompt: promptText,
    ...props.meta,
  };

  return React.createElement("smithers:task", {
    id: props.id,
    key: props.key,
    output: props.output,
    outputSchema,
    dependsOn: props.dependsOn,
    needs: props.needs,
    needsApproval: true,
    waitAsync: props.async === true,
    approvalMode: "decision",
    timeoutMs: props.timeoutMs,
    retries: maxAttempts - 1,
    retryPolicy: { backoff: "fixed", initialDelayMs: 0 } satisfies RetryPolicy,
    continueOnFail: props.continueOnFail,
    label: props.label ?? `human:${props.id}`,
    meta: humanMeta,
    __smithersKind: "human",
  });
}
