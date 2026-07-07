import { describe, expect, it } from "bun:test";
import { pocJudgmentScorer, planSolidityScorer, estimateAccuracyScorer, tierFitScorer, humanPollScorer, delegationRunScore, weightedScore, extractDelegationEvents, resolvePlanningNodes, } from "../src/index.js";

/**
 * @param {string} responseText
 */
function mockJudge(responseText) {
    return {
        generate: async () => ({ text: responseText }),
    };
}

describe("extractDelegationEvents", () => {
    it("reads a bare event array from output", () => {
        const events = [{ t: "NODE_DONE", node: "c1" }];
        const payload = extractDelegationEvents({ output: events });
        expect(payload?.events).toEqual(events);
    });
    it("reads an { events, nodes } payload from output", () => {
        const payload = extractDelegationEvents({
            output: {
                events: [{ t: "NODE_DONE", node: "c1" }],
                nodes: [{ id: "c1", kind: "chunk" }],
            },
        });
        expect(payload?.events).toHaveLength(1);
        expect(payload?.nodes).toEqual([{ id: "c1", kind: "chunk" }]);
    });
    it("falls back to context when output has no events", () => {
        const payload = extractDelegationEvents({
            output: "final summary text",
            context: { events: [{ t: "EXEC_STARTED", node: "c1" }] },
        });
        expect(payload?.events).toHaveLength(1);
    });
    it("returns null when neither output nor context carries events", () => {
        expect(extractDelegationEvents({ output: "text", context: 42 })).toBeNull();
        expect(extractDelegationEvents({ output: [] })).toBeNull();
    });
    it("returns null for an object whose events field is not an array", () => {
        expect(
            extractDelegationEvents({ output: { events: "nope", notEvents: 1 } }),
        ).toBeNull();
    });
    it("filters non-event entries out of a bare array", () => {
        const payload = extractDelegationEvents({
            output: [{ t: "NODE_DONE", node: "c1" }, "junk", { notAnEvent: true }],
        });
        expect(payload?.events).toEqual([{ t: "NODE_DONE", node: "c1" }]);
    });
});

describe("resolvePlanningNodes", () => {
    it("excludes probe ids learned from FINDING_REPORTED", () => {
        const planning = resolvePlanningNodes({
            events: [
                { t: "PROBE_SPAWNED", parent: "c1", probe: "research" },
                { t: "FINDING_REPORTED", probe: "h1", toParent: "c1" },
            ],
        });
        expect(planning).toContain("c1");
        expect(planning).not.toContain("h1");
    });
    it("excludes non-planning kinds when node metadata is available", () => {
        const planning = resolvePlanningNodes({
            events: [
                { t: "NODE_DONE", node: "c1" },
                { t: "NODE_DONE", node: "p1" },
            ],
            nodes: [
                { id: "c1", kind: "chunk" },
                { id: "p1", kind: "poc" },
            ],
        });
        expect(planning).toEqual(["c1"]);
    });
    it("learns kinds from CHILDREN_DECLARED children", () => {
        const planning = resolvePlanningNodes({
            events: [
                {
                    t: "CHILDREN_DECLARED",
                    parent: "r0",
                    children: [
                        { id: "c1", kind: "chunk" },
                        { id: "p1", kind: "poc" },
                    ],
                },
                { t: "NODE_DONE", node: "c1" },
                { t: "NODE_DONE", node: "p1" },
            ],
        });
        expect(planning).toContain("r0");
        expect(planning).toContain("c1");
        expect(planning).not.toContain("p1");
    });
    it("includes declared planning nodes the events never mention", () => {
        const planning = resolvePlanningNodes({
            events: [{ t: "NODE_DONE", node: "c1" }],
            nodes: [
                { id: "c1", kind: "chunk" },
                { id: "c2", kind: "chunk" },
            ],
        });
        expect(planning).toContain("c2");
    });
});

describe("pocJudgmentScorer", () => {
    const scorer = pocJudgmentScorer();
    it("has correct id and name", () => {
        expect(scorer.id).toBe("poc-judgment");
        expect(scorer.name).toBe("POC Judgment");
    });
    it("skips when no delegation events are available", async () => {
        const result = await scorer.score({ input: "task", output: "plain text" });
        expect(result.score).toBe(1);
        expect(result.reason).toContain("No delegation events");
        expect(result.meta?.skipped).toBe(true);
    });
    it("skips when events contain no planning nodes", async () => {
        const result = await scorer.score({
            input: "task",
            output: { events: [{ t: "PROMPT_APPROVED" }] },
        });
        expect(result.score).toBe(1);
        expect(result.reason).toContain("No planning nodes");
        expect(result.meta?.skipped).toBe(true);
    });
    it("rewards a correct negative (flagged nothing, nothing broke)", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "GATES_DECLARED", node: "c3" },
                    { t: "EXEC_STARTED", node: "c3" },
                    { t: "NODE_DONE", node: "c3" },
                ],
            },
        });
        expect(result.score).toBe(0.75);
        expect(result.meta?.nodes.c3.classification).toBe("correctNegative");
    });
    it("rewards strongest when a probe finding CHANGED the plan", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "RISK_FLAGGED", node: "c1", risk: "store derivation unclear" },
                    { t: "PROBE_SPAWNED", parent: "c1", probe: "research" },
                    { t: "FINDING_REPORTED", probe: "h1", toParent: "c1" },
                    { t: "REPLAN_REQUESTED", from: "c1", reason: "human requests needed" },
                    { t: "NODE_DONE", node: "c1" },
                ],
            },
        });
        expect(result.meta?.nodes.c1.classification).toBe("correctPositiveChanged");
        expect(result.score).toBe(1);
    });
    it("treats a post-finding self-invalidation as a plan change", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "PROBE_SPAWNED", parent: "c4", probe: "poc" },
                    { t: "FINDING_REPORTED", probe: "p1", toParent: "c4" },
                    { t: "NODE_INVALIDATED", node: "c4" },
                    { t: "NODE_DONE", node: "c4" },
                ],
            },
        });
        expect(result.meta?.nodes.c4.classification).toBe("correctPositiveChanged");
    });
    it("rewards strongly when a probe finding confirmed the plan", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "RISK_FLAGGED", node: "c4", risk: "re-layout jank" },
                    { t: "PROBE_SPAWNED", parent: "c4", probe: "poc" },
                    { t: "FINDING_REPORTED", probe: "p1", toParent: "c4" },
                    { t: "NODE_REAFFIRMED", node: "c4" },
                    { t: "NODE_DONE", node: "c4" },
                ],
            },
        });
        expect(result.meta?.nodes.c4.classification).toBe("correctPositiveConfirmed");
        expect(result.score).toBe(0.9);
    });
    it("mildly penalizes a false positive with no probe finding", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "RISK_FLAGGED", node: "c2", risk: "imaginary" },
                    { t: "PROBE_SPAWNED", parent: "c2", probe: "research" },
                    { t: "NODE_DONE", node: "c2" },
                ],
            },
        });
        expect(result.meta?.nodes.c2.classification).toBe("falsePositive");
        expect(result.score).toBe(0.4);
    });
    it("mildly penalizes a finding with no downstream effect", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "PROBE_SPAWNED", parent: "c2", probe: "research" },
                    { t: "FINDING_REPORTED", probe: "h9", toParent: "c2" },
                    { t: "NODE_DONE", node: "c2" },
                ],
            },
        });
        expect(result.meta?.nodes.c2.classification).toBe("falsePositive");
    });
    it("punishes a false negative hardest (invalidated without flagging)", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "GATES_DECLARED", node: "c2" },
                    { t: "NODE_INVALIDATED", node: "c2" },
                ],
            },
        });
        expect(result.meta?.nodes.c2.classification).toBe("falseNegative");
        expect(result.score).toBe(0);
    });
    it("counts an unflagged execution gate failure as a false negative", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "GATES_DECLARED", node: "c4" },
                    { t: "EXEC_STARTED", node: "c4" },
                    { t: "GATE_FAILED", node: "c4" },
                ],
            },
        });
        expect(result.meta?.nodes.c4.classification).toBe("falseNegative");
    });
    it("credits a flagged risk that materialized in execution as confirmed", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "RISK_FLAGGED", node: "c4", risk: "review may fail" },
                    { t: "EXEC_STARTED", node: "c4" },
                    { t: "GATE_FAILED", node: "c4" },
                ],
            },
        });
        expect(result.meta?.nodes.c4.classification).toBe("correctPositiveConfirmed");
    });
    it("scores the simulation's Frame 10 quadrants with false negatives dominating", async () => {
        // r0 correct negative, c1 changed-the-plan, c2 false negative,
        // c3 correct negative, c4 confirmed — simulations/delegation-chain.md.
        const result = await scorer.score({
            input: "build the delegation-chain feature",
            output: {
                events: [
                    {
                        t: "CHILDREN_DECLARED",
                        parent: "r0",
                        children: [
                            { id: "c1", kind: "chunk" },
                            { id: "c2", kind: "chunk" },
                            { id: "c3", kind: "chunk" },
                            { id: "c4", kind: "chunk" },
                        ],
                    },
                    { t: "RISK_FLAGGED", node: "c4", risk: "ReactFlow re-layout" },
                    { t: "PROBE_SPAWNED", parent: "c4", probe: "poc" },
                    { t: "PROBE_SPAWNED", parent: "c1", probe: "research" },
                    { t: "FINDING_REPORTED", probe: "h1", toParent: "c1" },
                    { t: "REPLAN_REQUESTED", from: "c1", reason: "human requests" },
                    { t: "NODE_INVALIDATED", node: "c2" },
                    { t: "FINDING_REPORTED", probe: "p1", toParent: "c4" },
                    { t: "NODE_REAFFIRMED", node: "c4" },
                    { t: "EXEC_STARTED", node: "c1" },
                    { t: "NODE_DONE", node: "c1" },
                    { t: "NODE_DONE", node: "c2" },
                    { t: "NODE_DONE", node: "c3" },
                    { t: "NODE_DONE", node: "c4" },
                    { t: "NODE_DONE", node: "r0" },
                ],
            },
        });
        expect(result.meta?.nodes.r0.classification).toBe("correctNegative");
        expect(result.meta?.nodes.c1.classification).toBe("correctPositiveChanged");
        expect(result.meta?.nodes.c2.classification).toBe("falseNegative");
        expect(result.meta?.nodes.c3.classification).toBe("correctNegative");
        expect(result.meta?.nodes.c4.classification).toBe("correctPositiveConfirmed");
        expect(result.meta?.counts).toEqual({
            correctPositiveChanged: 1,
            correctPositiveConfirmed: 1,
            correctNegative: 2,
            falsePositive: 0,
            falseNegative: 1,
        });
        // (0.75 + 1 + 0 + 0.75 + 0.9) / (1 + 1 + 3 + 1 + 1)
        expect(result.score).toBeCloseTo(3.4 / 7, 5);
        // Probes never count as planning nodes.
        expect(result.meta?.nodes.h1).toBeUndefined();
        expect(result.meta?.nodes.p1).toBeUndefined();
    });
    it("skips when custom weights zero out every encountered classification", async () => {
        const custom = pocJudgmentScorer({ weights: { correctNegative: 0 } });
        const result = await custom.score({
            input: "task",
            output: { events: [{ t: "NODE_DONE", node: "c1" }] },
        });
        expect(result.score).toBe(1);
        expect(result.meta?.skipped).toBe(true);
    });
    it("honors custom values and weights", async () => {
        const custom = pocJudgmentScorer({
            values: { correctNegative: 1, falseNegative: 0.1 },
            weights: { falseNegative: 9 },
        });
        const result = await custom.score({
            input: "task",
            output: {
                events: [
                    { t: "NODE_DONE", node: "c1" },
                    { t: "NODE_INVALIDATED", node: "c2" },
                ],
            },
        });
        // (1 * 1 + 0.1 * 9) / (1 + 9)
        expect(result.score).toBeCloseTo(0.19, 5);
    });
    it("reads events from context when output is plain text", async () => {
        const result = await scorer.score({
            input: "task",
            output: "run summary",
            context: { events: [{ t: "NODE_DONE", node: "c1" }] },
        });
        expect(result.meta?.nodes.c1.classification).toBe("correctNegative");
    });
    it("accepts a bare event array as output", async () => {
        const result = await scorer.score({
            input: "task",
            output: [{ t: "NODE_INVALIDATED", node: "c2" }],
        });
        expect(result.score).toBe(0);
    });
});

describe("planSolidityScorer", () => {
    const scorer = planSolidityScorer();
    it("has correct id and name", () => {
        expect(scorer.id).toBe("plan-solidity");
        expect(scorer.name).toBe("Plan Solidity");
    });
    it("skips when no delegation events are available", async () => {
        const result = await scorer.score({ input: "task", output: "text" });
        expect(result.score).toBe(1);
        expect(result.meta?.skipped).toBe(true);
    });
    it("scores 1 when execution never started", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "NODE_INVALIDATED", node: "c2" },
                    { t: "REPLAN_REQUESTED", from: "c1" },
                ],
            },
        });
        expect(result.score).toBe(1);
        expect(result.reason).toContain("Execution never started");
        expect(result.meta?.execStartedIndex).toBeNull();
        expect(result.meta?.planPhase.NODE_INVALIDATED).toBe(1);
    });
    it("does not penalize plan-phase churn before EXEC_STARTED", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "NODE_INVALIDATED", node: "c2" },
                    { t: "REPLAN_REQUESTED", from: "c1" },
                    { t: "NODE_REAFFIRMED", node: "c4" },
                    { t: "EXEC_STARTED", node: "c1" },
                    { t: "NODE_DONE", node: "c1" },
                ],
            },
        });
        expect(result.score).toBe(1);
        expect(result.meta?.planPhase).toEqual({
            NODE_INVALIDATED: 1,
            REDELEGATED: 0,
            GATE_FAILED: 0,
            REPLAN_REQUESTED: 1,
        });
        expect(result.meta?.postExec.NODE_INVALIDATED).toBe(0);
    });
    it("scores 0.82 for one post-exec invalidation plus one redelegation (Frame 10)", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "EXEC_STARTED", node: "c1" },
                    { t: "NODE_INVALIDATED", node: "c2" },
                    { t: "REDELEGATED", node: "c4.inspector" },
                    { t: "NODE_DONE", node: "c4.inspector" },
                ],
            },
        });
        expect(result.score).toBeCloseTo(0.82, 5);
        expect(result.meta?.postExec.NODE_INVALIDATED).toBe(1);
        expect(result.meta?.postExec.REDELEGATED).toBe(1);
    });
    it("penalizes post-exec gate failures and replan requests", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                events: [
                    { t: "EXEC_STARTED", node: "c1" },
                    { t: "GATE_FAILED", node: "c4" },
                    { t: "REPLAN_REQUESTED", from: "c4" },
                ],
            },
        });
        // 1 - 0.05 - 0.04
        expect(result.score).toBeCloseTo(0.91, 5);
    });
    it("honors custom penalties", async () => {
        const custom = planSolidityScorer({
            penalties: { NODE_INVALIDATED: 0.5 },
        });
        const result = await custom.score({
            input: "task",
            output: {
                events: [
                    { t: "EXEC_STARTED", node: "c1" },
                    { t: "NODE_INVALIDATED", node: "c2" },
                ],
            },
        });
        expect(result.score).toBeCloseTo(0.5, 5);
    });
    it("clamps to 0 when churn exceeds the budget", async () => {
        const events = [{ t: "EXEC_STARTED", node: "c1" }];
        for (let i = 0; i < 20; i++) {
            events.push({ t: "NODE_INVALIDATED", node: `c${i}` });
        }
        const result = await scorer.score({ input: "task", output: { events } });
        expect(result.score).toBe(0);
    });
});

describe("estimateAccuracyScorer", () => {
    const scorer = estimateAccuracyScorer();
    it("has correct id and name", () => {
        expect(scorer.id).toBe("estimate-accuracy");
        expect(scorer.name).toBe("Estimate Accuracy");
    });
    it("skips when no estimate data is available", async () => {
        const result = await scorer.score({ input: "task", output: "text" });
        expect(result.score).toBe(1);
        expect(result.meta?.skipped).toBe(true);
    });
    it("skips when no node has both an estimate and actuals", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                plan: [{ logicalId: "r0", children: [{ logicalId: "c1", estimate: { tokens: 100 } }] }],
                exec: [{ logicalId: "c2", actual: { tokens: 90 } }],
            },
        });
        expect(result.score).toBe(1);
        expect(result.meta?.skipped).toBe(true);
    });
    it("scores over-estimation by symmetric ratio", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                plan: [{ children: [{ logicalId: "c1", estimate: { tokens: 200 } }] }],
                exec: [{ logicalId: "c1", actual: { tokens: 100 } }],
            },
        });
        expect(result.score).toBeCloseTo(0.5, 5);
    });
    it("scores under-estimation identically (symmetric)", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                plan: [{ children: [{ logicalId: "c1", estimate: { tokens: 100 } }] }],
                exec: [{ logicalId: "c1", actual: { tokens: 200 } }],
            },
        });
        expect(result.score).toBeCloseTo(0.5, 5);
    });
    it("averages over the dimensions available on both sides", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                plan: [{
                    children: [{
                        logicalId: "c1",
                        estimate: { tokens: 100, costUsd: 2, minutes: 8 },
                    }],
                }],
                exec: [{ logicalId: "c1", actual: { tokens: 50, costUsd: 2, minutes: 10 } }],
            },
        });
        // (0.5 + 1 + 0.8) / 3
        expect(result.score).toBeCloseTo(2.3 / 3, 5);
        expect(result.meta?.nodes[0].dimensions).toEqual({
            tokens: 0.5,
            costUsd: 1,
            minutes: 0.8,
        });
    });
    it("ignores dimensions missing from either side", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                plan: [{ children: [{ logicalId: "c1", estimate: { tokens: 100, minutes: 5 } }] }],
                exec: [{ logicalId: "c1", actual: { tokens: 100, costUsd: 3 } }],
            },
        });
        // Only tokens is present on both sides.
        expect(result.score).toBe(1);
        expect(result.meta?.nodes[0].dimensions).toEqual({ tokens: 1 });
    });
    it("uses the LATEST estimate when replans re-forecast a node", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                plan: [
                    { children: [{ logicalId: "c1", estimate: { tokens: 1000 } }] },
                    { children: [{ logicalId: "c1", estimate: { tokens: 100 } }] },
                ],
                exec: [{ logicalId: "c1", actual: { tokens: 100 } }],
            },
        });
        expect(result.score).toBe(1);
        expect(result.meta?.nodes[0].predicted).toEqual({ tokens: 100 });
    });
    it("weights nodes by predicted costUsd so big nodes matter more", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                plan: [{
                    children: [
                        { logicalId: "big", estimate: { tokens: 100, costUsd: 9 } },
                        { logicalId: "small", estimate: { tokens: 100, costUsd: 1 } },
                    ],
                }],
                exec: [
                    { logicalId: "big", actual: { tokens: 100, costUsd: 9 } },
                    { logicalId: "small", actual: { tokens: 25, costUsd: 1 } },
                ],
            },
        });
        // big: ratio 1, weight 9 · small: ratio (0.25 + 1) / 2 = 0.625, weight 1
        expect(result.score).toBeCloseTo((1 * 9 + 0.625 * 1) / 10, 5);
        expect(result.meta?.totals).toEqual({ predictedUsd: 10, actualUsd: 10 });
    });
    it("treats zero-vs-zero as perfect and zero-vs-nonzero as zero", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                plan: [{
                    children: [
                        { logicalId: "a", estimate: { minutes: 0 } },
                        { logicalId: "b", estimate: { minutes: 0 } },
                    ],
                }],
                exec: [
                    { logicalId: "a", actual: { minutes: 0 } },
                    { logicalId: "b", actual: { minutes: 5 } },
                ],
            },
        });
        // (1 + 0) / 2, equal fallback weights
        expect(result.score).toBeCloseTo(0.5, 5);
    });
    it("accepts plans/execs aliases and reads from context", async () => {
        const result = await scorer.score({
            input: "task",
            output: "run summary",
            context: {
                plans: [{ children: [{ id: "c1", estimate: { costUsd: 4 } }] }],
                execs: [{ id: "c1", actual: { costUsd: 2 } }],
            },
        });
        expect(result.score).toBeCloseTo(0.5, 5);
        expect(result.meta?.nodes[0].logicalId).toBe("c1");
    });
});

describe("tierFitScorer (LLM-based)", () => {
    it("has correct id and name", () => {
        const scorer = tierFitScorer(mockJudge('{"score": 1}'));
        expect(scorer.id).toBe("tier-fit");
        expect(scorer.name).toBe("Tier Fit");
    });
    it("passes tier, brief, stats, and output to the judge", async () => {
        let receivedPrompt = "";
        const judge = {
            generate: async ({ prompt }) => {
                receivedPrompt = prompt;
                return { text: '{"score": 0.74}' };
            },
        };
        const scorer = tierFitScorer(judge);
        await scorer.score({
            input: {
                tier: "sonnet",
                brief: "Implement the flux reducer with tests",
                stats: { costUsd: 0.42, outputTokens: 1800 },
            },
            output: "reducer implementation diff",
        });
        expect(receivedPrompt).toContain("sonnet");
        expect(receivedPrompt).toContain("Implement the flux reducer with tests");
        expect(receivedPrompt).toContain("0.42");
        expect(receivedPrompt).toContain("reducer implementation diff");
        expect(receivedPrompt).toContain("fable, opus, sonnet, haiku");
    });
    it("returns the parsed judge score and reason", async () => {
        const scorer = tierFitScorer(mockJudge('{"score": 0.74, "reason": "c2 leaves could have been cheaper"}'));
        const result = await scorer.score({
            input: { tier: "opus", brief: "short routine outputs" },
            output: "short output",
        });
        expect(result.score).toBe(0.74);
        expect(result.reason).toBe("c2 leaves could have been cheaper");
    });
    it("reads the node descriptor from context when input has no tier", async () => {
        let receivedPrompt = "";
        const judge = {
            generate: async ({ prompt }) => {
                receivedPrompt = prompt;
                return { text: '{"score": 1}' };
            },
        };
        const scorer = tierFitScorer(judge);
        await scorer.score({
            input: "the task prompt",
            output: "the output",
            context: { tier: "haiku", brief: "doc-reading probe" },
        });
        expect(receivedPrompt).toContain("haiku");
        expect(receivedPrompt).toContain("doc-reading probe");
    });
    it("notes missing node info instead of inventing it", async () => {
        let receivedPrompt = "";
        const judge = {
            generate: async ({ prompt }) => {
                receivedPrompt = prompt;
                return { text: '{"score": 0.5}' };
            },
        };
        const scorer = tierFitScorer(judge);
        await scorer.score({ input: "plain prompt", output: "output" });
        expect(receivedPrompt).toContain('"unknown"');
        expect(receivedPrompt).toContain("No brief provided");
        expect(receivedPrompt).toContain("No stats provided");
    });
});

describe("humanPollScorer", () => {
    const scorer = humanPollScorer();
    it("has correct id and name", () => {
        expect(scorer.id).toBe("human-poll");
        expect(scorer.name).toBe("Human Poll");
    });
    it("skips when no poll was submitted", async () => {
        const result = await scorer.score({ input: "task", output: "summary" });
        expect(result.score).toBe(1);
        expect(result.reason).toContain("No poll submitted");
        expect(result.meta?.skipped).toBe(true);
    });
    it("skips on an empty poll", async () => {
        const result = await scorer.score({ input: "task", output: { poll: [] } });
        expect(result.meta?.skipped).toBe(true);
    });
    it("normalizes 1-5 ratings linearly", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                poll: [
                    { question: "Plan quality?", answer: 5 },
                    { question: "Would you rerun it?", answer: 3 },
                ],
            },
        });
        // ((5-1)/4 + (3-1)/4) / 2
        expect(result.score).toBeCloseTo(0.75, 5);
        expect(result.meta?.answers).toHaveLength(2);
    });
    it("maps booleans to 0 and 1", async () => {
        const result = await scorer.score({
            input: "task",
            output: [
                { question: "Did it help?", answer: true },
                { question: "Any surprises?", answer: false },
            ],
        });
        expect(result.score).toBeCloseTo(0.5, 5);
    });
    it("mixes ratings and booleans and coerces numeric strings", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                poll: [
                    { question: "Rating", answer: "4" },
                    { question: "Ship it?", answer: true },
                ],
            },
        });
        // (0.75 + 1) / 2
        expect(result.score).toBeCloseTo(0.875, 5);
    });
    it("clamps out-of-range ratings to the 1-5 scale", async () => {
        const result = await scorer.score({
            input: "task",
            output: { poll: [{ question: "Rating", answer: 7 }, { question: "Rating", answer: 0 }] },
        });
        // (1 + 0) / 2
        expect(result.score).toBeCloseTo(0.5, 5);
    });
    it("ignores unrecognized answers and reports them in meta", async () => {
        const result = await scorer.score({
            input: "task",
            output: {
                poll: [
                    { question: "Rating", answer: 5 },
                    { question: "Free text", answer: "loved it" },
                ],
            },
        });
        expect(result.score).toBe(1);
        expect(result.meta?.ignored).toEqual([
            { question: "Free text", answer: "loved it" },
        ]);
        expect(result.reason).toContain("1 unrecognized answer(s) ignored");
    });
    it("skips when every answer is unrecognizable", async () => {
        const result = await scorer.score({
            input: "task",
            output: { poll: [{ question: "Free text", answer: "great" }] },
        });
        expect(result.score).toBe(1);
        expect(result.meta?.skipped).toBe(true);
    });
    it("reads the poll from context when output is plain text", async () => {
        const result = await scorer.score({
            input: "task",
            output: "summary",
            context: { poll: [{ question: "Rating", answer: 1 }] },
        });
        expect(result.score).toBe(0);
    });
    it("scores a context poll when output is an empty array", async () => {
        const result = await scorer.score({
            input: "task",
            output: [],
            context: { poll: [{ question: "q", answer: 1 }] },
        });
        expect(result.score).toBe(0);
        expect(result.meta?.skipped).toBeFalsy();
    });
});

describe("delegationRunScore", () => {
    it("combines the five components with the default weights", () => {
        const result = delegationRunScore({
            pocJudgment: { score: 0.5 },
            planSolidity: { score: 0.82 },
            estimateAccuracy: { score: 0.9 },
            tierFit: { score: 0.74 },
            humanPoll: { score: 1 },
        });
        // 0.25*0.5 + 0.25*0.82 + 0.15*0.9 + 0.15*0.74 + 0.2*1
        expect(result.score).toBeCloseTo(0.776, 5);
        expect(result.meta?.components.pocJudgment.score).toBe(0.5);
        expect(result.meta?.components.humanPoll.appliedWeight).toBeCloseTo(0.2, 5);
    });
    it("renormalizes weights when components are missing", () => {
        const result = delegationRunScore({
            pocJudgment: { score: 0.5 },
            planSolidity: { score: 0.82 },
            tierFit: { score: 0.74 },
        });
        // (0.25*0.5 + 0.25*0.82 + 0.15*0.74) / 0.65
        expect(result.score).toBeCloseTo(0.441 / 0.65, 5);
        expect(result.meta?.components.estimateAccuracy.skipped).toBe(true);
        expect(result.meta?.components.humanPoll.skipped).toBe(true);
    });
    it("excludes skipped components (e.g. a never-submitted poll)", () => {
        const result = delegationRunScore({
            pocJudgment: { score: 0.4 },
            planSolidity: { score: 1 },
            tierFit: null,
            humanPoll: { score: 1, meta: { skipped: true } },
        });
        // (0.25*0.4 + 0.25*1) / 0.5
        expect(result.score).toBeCloseTo(0.7, 5);
        expect(result.meta?.components.estimateAccuracy.skipped).toBe(true);
        expect(result.meta?.components.tierFit.skipped).toBe(true);
        expect(result.meta?.components.humanPoll.skipped).toBe(true);
    });
    it("returns a skipped result when every component is missing", () => {
        const result = delegationRunScore({});
        expect(result.score).toBe(1);
        expect(result.meta?.skipped).toBe(true);
    });
    it("honors custom weights", () => {
        const result = delegationRunScore({
            pocJudgment: { score: 1 },
            planSolidity: { score: 0 },
            estimateAccuracy: { score: 0 },
            tierFit: { score: 0 },
            humanPoll: { score: 0 },
        }, {
            weights: {
                pocJudgment: 1,
                planSolidity: 0,
                estimateAccuracy: 0,
                tierFit: 0,
                humanPoll: 0,
            },
        });
        expect(result.score).toBe(1);
    });
    it("treats an undefined weight as skipped", () => {
        const result = delegationRunScore({
            pocJudgment: { score: 0.5 },
            planSolidity: { score: 1 },
        }, { weights: { planSolidity: undefined } });
        expect(Number.isFinite(result.score)).toBe(true);
        expect(result.score).toBeCloseTo(0.5, 5);
        expect(result.meta?.components.planSolidity.skipped).toBe(true);
    });
});

describe("weightedScore", () => {
    it("computes a weighted mean over arbitrary components", () => {
        const result = weightedScore({ a: { score: 1 }, b: { score: 0 } }, { a: 3, b: 1 });
        expect(result.score).toBeCloseTo(0.75, 5);
    });
    it("treats zero-weight components as skipped", () => {
        const result = weightedScore({ a: { score: 0.2 }, b: { score: 1 } }, { a: 1, b: 0 });
        expect(result.score).toBeCloseTo(0.2, 5);
        expect(result.meta?.components.b.skipped).toBe(true);
    });
    it("records renormalized applied weights", () => {
        const result = weightedScore({ a: { score: 1 }, b: null }, { a: 0.3, b: 0.7 });
        expect(result.meta?.components.a.appliedWeight).toBeCloseTo(1, 5);
    });
    it("treats a NaN weight as skipped", () => {
        const result = weightedScore({ a: { score: 1 }, b: { score: 0.5 } }, { a: 1, b: NaN });
        expect(Number.isFinite(result.score)).toBe(true);
        expect(result.score).toBeCloseTo(1, 5);
        expect(result.meta?.components.b.skipped).toBe(true);
    });
});
