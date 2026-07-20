import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { evaluateAspectBudget } from "./evaluateAspectBudget.js";

/**
 * @typedef {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor} TaskDescriptor
 * @typedef {import("./createBudgetTracker.js").BudgetSnapshot} BudgetSnapshot
 */

/**
 * Apply Aspects budget `onExceeded` semantics for a task about to be dispatched.
 *
 * Shared by both engine bodies so the driver and legacy schedulers behave
 * identically. Returns:
 *   - "run"  — within budget (or `onExceeded: "warn"`); dispatch the task.
 *   - "skip" — `onExceeded: "skip-remaining"`; the task is persisted as skipped
 *              and recorded in `budgetSkippedKeys` so subsequent state
 *              derivation keeps it skipped. Do not dispatch.
 * and throws `ASPECT_BUDGET_EXCEEDED` for `onExceeded: "fail"`, which fails the
 * run.
 *
 * @param {{
 *   desc: TaskDescriptor;
 *   snapshot: BudgetSnapshot;
 *   adapter: any;
 *   runId: string;
 *   eventBus: any;
 *   budgetSkippedKeys: Set<string>;
 *   stateKey: string;
 *   nowMs: () => number;
 *   logWarning?: (message: string, context: Record<string, unknown>, scope: string) => void;
 * }} args
 * @returns {Promise<"run" | "skip">}
 */
export async function enforceDispatchBudget(args) {
    const { desc, snapshot, adapter, runId, eventBus, budgetSkippedKeys, stateKey, nowMs, logWarning, } = args;
    if (budgetSkippedKeys.has(stateKey)) {
        return "skip";
    }
    const breach = evaluateAspectBudget(desc.aspects, snapshot);
    if (!breach) {
        return "run";
    }
    const detail = { kind: breach.kind, limit: breach.limit, current: breach.current };
    if (breach.onExceeded === "warn") {
        logWarning?.("aspect budget exceeded; continuing (onExceeded: warn)", { runId, nodeId: desc.nodeId, iteration: desc.iteration, ...detail }, "engine:aspects");
        return "run";
    }
    if (breach.onExceeded === "skip-remaining") {
        budgetSkippedKeys.add(stateKey);
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "skipped",
            lastAttempt: null,
            updatedAtMs: nowMs(),
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "NodeSkipped",
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            timestampMs: nowMs(),
        }));
        logWarning?.("aspect budget exceeded; skipping task (onExceeded: skip-remaining)", { runId, nodeId: desc.nodeId, iteration: desc.iteration, ...detail }, "engine:aspects");
        return "skip";
    }
    throw new SmithersError("ASPECT_BUDGET_EXCEEDED", `Aspects ${breach.kind} budget exceeded for task "${desc.nodeId}": ${breach.current} >= ${breach.limit}`, detail);
}
