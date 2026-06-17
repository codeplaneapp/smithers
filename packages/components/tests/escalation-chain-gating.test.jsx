/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import React from "react";
import {
    SmithersContext,
    SmithersCtx,
} from "@smithers-orchestrator/react-reconciler/context";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { EscalationChain } from "../src/components/index.js";

const agent = { id: "agent", generate: async () => ({ text: "ok" }) };
const otherAgent = { id: "other", generate: async () => ({ text: "ok" }) };

/**
 * Render an element inside a SmithersContext provider seeded with the given
 * output rows, mirroring how the runtime exposes prior level results to the
 * escalation chain.
 * @param {React.ReactElement} el
 * @param {Record<string, Array<Record<string, unknown>>>} outputs
 */
async function renderWithOutputs(el, outputs) {
    const ctx = new SmithersCtx({
        runId: "test-run",
        iteration: 0,
        input: {},
        outputs,
    });
    const renderer = new SmithersRenderer();
    return renderer.render(
        <SmithersContext.Provider value={ctx}>{el}</SmithersContext.Provider>,
    );
}

describe("EscalationChain gates levels on the real escalation decision", () => {
    test("does NOT mount the next level or the human fallback when the previous level succeeded (escalateIf false)", async () => {
        // Level 0 produced a result that escalateIf considers a success.
        const result = await renderWithOutputs(
            <EscalationChain
                id="incident"
                levels={[
                    {
                        agent,
                        output: "level_out",
                        label: "First",
                        escalateIf: (r) => r?.success !== true,
                    },
                    { agent: otherAgent, output: "level_out", label: "Second" },
                ]}
                escalationOutput="escalation_out"
                humanFallback
                humanRequest={{ title: "Human review", summary: "Escalate" }}
            >
                triage incident
            </EscalationChain>,
            {
                level_out: [
                    { nodeId: "incident-level-0", iteration: 0, success: true },
                ],
            },
        );

        const ids = result.tasks.map((task) => task.nodeId);
        // The check task always records the decision, but the gated second
        // level and the human fallback Approval must NOT be mounted.
        expect(ids).toContain("incident-level-0");
        expect(ids).toContain("incident-check-0");
        expect(ids).not.toContain("incident-level-1");
        expect(ids).not.toContain("incident-human-fallback");

        // The recorded decision reflects no escalation.
        const checkTask = result.tasks.find(
            (task) => task.nodeId === "incident-check-0",
        );
        expect(checkTask.computeFn()).toEqual({
            escalated: false,
            fromLevel: 0,
            toLevel: 1,
        });
    });

    test("DOES mount the next level and human fallback when the previous level escalates (escalateIf true)", async () => {
        const result = await renderWithOutputs(
            <EscalationChain
                id="incident"
                levels={[
                    {
                        agent,
                        output: "level_out",
                        label: "First",
                        escalateIf: (r) => r?.success !== true,
                    },
                    {
                        agent: otherAgent,
                        output: "level_out",
                        label: "Second",
                        escalateIf: (r) => r?.success !== true,
                    },
                ]}
                escalationOutput="escalation_out"
                humanFallback
                humanRequest={{ title: "Human review", summary: "Escalate" }}
            >
                triage incident
            </EscalationChain>,
            {
                // Both automated levels report failure, so escalation continues
                // through the chain and into the human fallback.
                level_out: [
                    { nodeId: "incident-level-0", iteration: 0, success: false },
                    { nodeId: "incident-level-1", iteration: 0, success: false },
                ],
            },
        );

        const ids = result.tasks.map((task) => task.nodeId);
        expect(ids).toEqual([
            "incident-level-0",
            "incident-check-0",
            "incident-level-1",
            "incident-human-fallback",
        ]);

        const checkTask = result.tasks.find(
            (task) => task.nodeId === "incident-check-0",
        );
        expect(checkTask.computeFn()).toEqual({
            escalated: true,
            fromLevel: 0,
            toLevel: 1,
        });
        const fallback = result.tasks.find(
            (task) => task.nodeId === "incident-human-fallback",
        );
        expect(fallback.needsApproval).toBe(true);
    });

    test("default failure predicate gates on the prior result when no escalateIf is provided", async () => {
        // No escalateIf on level 0 -> defaultEscalateIf is used. A successful
        // result (no error/failed/ok=false) must NOT escalate.
        const success = await renderWithOutputs(
            <EscalationChain
                id="incident"
                levels={[
                    { agent, output: "level_out", label: "First" },
                    { agent: otherAgent, output: "level_out", label: "Second" },
                ]}
                escalationOutput="escalation_out"
            >
                triage incident
            </EscalationChain>,
            {
                level_out: [
                    { nodeId: "incident-level-0", iteration: 0, ok: true },
                ],
            },
        );
        expect(success.tasks.map((t) => t.nodeId)).not.toContain(
            "incident-level-1",
        );

        // A failing result (ok === false) escalates under the default predicate.
        const failure = await renderWithOutputs(
            <EscalationChain
                id="incident"
                levels={[
                    { agent, output: "level_out", label: "First" },
                    { agent: otherAgent, output: "level_out", label: "Second" },
                ]}
                escalationOutput="escalation_out"
            >
                triage incident
            </EscalationChain>,
            {
                level_out: [
                    { nodeId: "incident-level-0", iteration: 0, ok: false },
                ],
            },
        );
        expect(failure.tasks.map((t) => t.nodeId)).toContain("incident-level-1");
    });
    test("default failure predicate escalates on error and failed results", async () => {
        for (const levelResult of [
            { nodeId: "incident-level-0", iteration: 0, error: "boom" },
            { nodeId: "incident-level-0", iteration: 0, failed: true },
        ]) {
            const result = await renderWithOutputs(
                <EscalationChain
                    id="incident"
                    levels={[
                        { agent, output: "level_out", label: "First" },
                        { agent: otherAgent, output: "level_out", label: "Second" },
                    ]}
                    escalationOutput="escalation_out"
                >
                    triage incident
                </EscalationChain>,
                { level_out: [levelResult] },
            );
            const ids = result.tasks.map((t) => t.nodeId);
            expect(ids).toContain("incident-level-1");
            expect(result.tasks.find((t) => t.nodeId === "incident-check-0").computeFn()).toEqual({
                escalated: true,
                fromLevel: 0,
                toLevel: 1,
            });
        }
    });
    test("human fallback uses the default request when no humanRequest is provided", async () => {
        const result = await renderWithOutputs(
            <EscalationChain
                id="incident"
                levels={[{ agent, output: "level_out", label: "First" }]}
                escalationOutput="escalation_out"
                humanFallback
            >
                triage incident
            </EscalationChain>,
            {
                level_out: [
                    { nodeId: "incident-level-0", iteration: 0, failed: true },
                ],
            },
        );
        const fallback = result.tasks.find(
            (task) => task.nodeId === "incident-human-fallback",
        );
        expect(fallback.needsApproval).toBe(true);
        expect(fallback.label).toBe("Escalation requires human review");
        expect(fallback.meta.requestSummary).toBe(
            "All 1 automated levels have been exhausted.",
        );
    });
});
