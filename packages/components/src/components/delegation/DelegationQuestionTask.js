import React from "react";
import { getTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { buildHumanRequestId } from "@smithers-orchestrator/db/buildHumanRequestId";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { dcQuestionSchema } from "./delegationSchemas.ts";
/** @typedef {import("../OutputTarget.ts").OutputTarget} OutputTarget */

/**
 * Internal delegation-chain human task for one goal-refinement question.
 *
 * Mirrors `<HumanTask>` (durable json human request resolved from the
 * request's response or the approval note), but folds the human's answer into
 * a RESOLVED dcQuestion row: the delegation UI submits a bare value (string
 * for select/text, boolean for confirm), and this task merges it with the
 * haiku-rendered form metadata so the output row satisfies the dcQuestion
 * contract (`recommended` becomes the accepted answer, `resolved: true`).
 * A full dcQuestion-shaped object submission is also accepted and wins over
 * the form metadata field-by-field.
 *
 * @param {{
 *   id: string;
 *   output: OutputTarget;
 *   form: Record<string, any>;
 *   prompt: string;
 *   maxAttempts?: number;
 *   label?: string;
 * }} props
 */
export function DelegationQuestionTask(props) {
    const maxAttempts = props.maxAttempts ?? 10;
    const form = props.form;
    const computeAnswerRow = async () => {
        const runtime = getTaskRuntime();
        if (!runtime) {
            throw new SmithersError("HUMAN_TASK_OUTSIDE_RUNTIME", "DelegationQuestionTask can only be resolved while a Smithers task is executing.");
        }
        const adapter = new SmithersDb(runtime.db);
        const requestId = buildHumanRequestId(runtime.runId, props.id, runtime.iteration);
        const humanRequest = await adapter.getHumanRequest(requestId);
        const approval = await adapter.getApproval(runtime.runId, props.id, runtime.iteration);
        let rawInput = humanRequest?.responseJson ?? null;
        if (rawInput == null &&
            humanRequest?.status !== "cancelled" &&
            humanRequest?.status !== "expired" &&
            typeof approval?.note === "string") {
            rawInput = approval.note;
            await adapter.answerHumanRequest(requestId, rawInput, approval.decidedAtMs ?? Date.now(), approval.decidedBy ?? null);
        }
        if (rawInput == null) {
            if (humanRequest?.status === "cancelled") {
                throw new SmithersError("HUMAN_TASK_CANCELLED", `Human input for task "${props.id}" was cancelled.`);
            }
            throw new SmithersError("HUMAN_TASK_NO_INPUT", `No human input received for task "${props.id}".`);
        }
        /** @type {unknown} */
        let value;
        try {
            value = typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput;
        }
        catch {
            // A non-JSON note is treated as the literal answer text.
            value = rawInput;
        }
        const base = {
            logicalId: String(form.logicalId ?? "goal"),
            seq: Number(form.seq),
            question: String(form.question ?? ""),
            header: String(form.header ?? ""),
            kind: form.kind === "select" || form.kind === "confirm" ? form.kind : "text",
            ...(Array.isArray(form.options) ? { options: form.options } : {}),
            recommended: String(form.recommended ?? ""),
            reason: String(form.reason ?? ""),
            resolved: true,
        };
        const merged = value !== null && typeof value === "object" && !Array.isArray(value)
            ? { ...base, .../** @type {Record<string, unknown>} */ (value), resolved: true }
            : { ...base, recommended: typeof value === "boolean" ? (value ? "yes" : "no") : String(value) };
        const parsed = dcQuestionSchema.safeParse(merged);
        if (!parsed.success) {
            throw new SmithersError("HUMAN_TASK_VALIDATION_FAILED", `Answer for question "${props.id}" does not fold into a dcQuestion row: ${parsed.error.message}`);
        }
        return parsed.data;
    };
    return React.createElement("smithers:task", {
        id: props.id,
        output: props.output,
        outputSchema: dcQuestionSchema,
        needsApproval: true,
        approvalMode: "decision",
        retries: maxAttempts - 1,
        retryPolicy: { backoff: "fixed", initialDelayMs: 0 },
        label: props.label ?? `human:${props.id}`,
        meta: {
            humanTask: true,
            maxAttempts,
            prompt: props.prompt,
            dcQuestion: { seq: form.seq, logicalId: form.logicalId ?? "goal" },
        },
        __smithersKind: "human",
        __smithersComputeFn: computeAnswerRow,
    });
}
