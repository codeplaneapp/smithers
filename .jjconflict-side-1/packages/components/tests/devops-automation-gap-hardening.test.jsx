/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import {
    CheckSuite,
    DriftDetector,
    Runbook,
    ScanFixVerify,
    Task,
} from "../src/components/index.js";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import {
    SmithersContext,
    SmithersCtx,
} from "@smithers-orchestrator/react-reconciler/context";

const RUN_ID = "devops-gap-hardening";
const agent = { id: "agent", generate: async () => ({ text: "ok" }) };
const otherAgent = { id: "other", generate: async () => ({ text: "ok" }) };
const alertAgent = { id: "alert", generate: async () => ({ text: "ok" }) };

async function render(element, outputs = {}, ctxOverrides = {}) {
    const renderer = new SmithersRenderer();
    const ctx = new SmithersCtx({
        runId: RUN_ID,
        iteration: 0,
        input: {},
        outputs,
        ...ctxOverrides,
    });
    const graph = await renderer.render(
        <SmithersContext.Provider value={ctx}>{element}</SmithersContext.Provider>,
    );
    return { graph, root: renderer.getRoot(), ctx };
}

function byId(graph, id) {
    const task = graph.tasks.find((entry) => entry.nodeId === id);
    expect(task).toBeDefined();
    return task;
}

function findHosts(root, tag) {
    const found = [];
    const visit = (node) => {
        if (!node || node.kind === "text") {
            return;
        }
        if (node.tag === tag) {
            found.push(node);
        }
        for (const child of node.children ?? []) {
            visit(child);
        }
    };
    visit(root);
    return found;
}

function outputRow(nodeId, payload, iteration = 0) {
    return {
        runId: RUN_ID,
        nodeId,
        iteration,
        ...payload,
    };
}

describe("devops automation gap hardening", () => {
    test("CheckSuite command check maps a non-zero exit into a failed row without throwing", async () => {
        const failCommand = `${JSON.stringify(process.execPath)} -e "console.log('partial'); console.error('boom'); process.exit(3)"`;
        const { graph } = await render(
            <CheckSuite
                id="gate"
                verdictOutput="verdict_out"
                checks={[{ id: "broken", command: failCommand }]}
            />,
        );

        const row = await byId(graph, "gate-broken").computeFn();
        expect(row).toMatchObject({
            passed: false,
            ok: false,
            command: failCommand,
            exitCode: 3,
            signal: null,
        });
        expect(row.stdout).toContain("partial");
        expect(row.stderr).toContain("boom");
        expect(typeof row.error).toBe("string");
        expect(row.error.length).toBeGreaterThan(0);
    });

    test("CheckSuite command check kills a hanging command after timeoutMs instead of hanging forever", async () => {
        const hangCommand = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 60000)"`;
        const { graph } = await render(
            <CheckSuite
                id="gate"
                verdictOutput="verdict_out"
                checks={[{ id: "hung", command: hangCommand, timeoutMs: 200 }]}
            />,
        );

        const row = await byId(graph, "gate-hung").computeFn();
        expect(row).toMatchObject({
            passed: false,
            ok: false,
            command: hangCommand,
            timedOut: true,
        });
    }, 10_000);

    test("CheckSuite command check keeps the real exit code when stdout exceeds the capture limit", async () => {
        const largeCommand = `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(17 * 1024 * 1024) + 'tail-marker')"`;
        const { graph } = await render(
            <CheckSuite
                id="gate"
                verdictOutput="verdict_out"
                checks={[{ id: "large", command: largeCommand }]}
            />,
        );

        const row = await byId(graph, "gate-large").computeFn();
        expect(row).toMatchObject({
            passed: true,
            ok: true,
            command: largeCommand,
            exitCode: 0,
            signal: null,
            truncated: true,
        });
        expect(row.stdout).toHaveLength(16 * 1024 * 1024);
        expect(row.stdout.endsWith("tail-marker")).toBe(true);
        expect(row.diagnostic).toContain("only the tail was retained");
    });

    test("CheckSuite command fails when output exceeds the capture limit before exit 7", async () => {
        const overflowFailureCommand = `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(17 * 1024 * 1024), () => process.exit(7))"`;
        const { graph } = await render(
            <CheckSuite
                id="gate"
                verdictOutput="verdict_out"
                checks={[{ id: "overflow-failure", command: overflowFailureCommand }]}
            />,
        );

        const row = await byId(graph, "gate-overflow-failure").computeFn();
        expect(row).toMatchObject({
            passed: false,
            ok: false,
            command: overflowFailureCommand,
            exitCode: 7,
            signal: null,
            truncated: true,
        });
        expect(row.error).toContain("Command exited with code 7");
    });

    test("CheckSuite verdict passes primitive rows, fails passed:false markers, and any-pass with zero passes fails", async () => {
        const { graph } = await render(
            <CheckSuite
                id="mixed"
                strategy="all-pass"
                verdictOutput="verdict_out"
                checks={[
                    { id: "primitive", agent },
                    { id: "explicit", agent: otherAgent },
                ]}
            />,
            {
                verdict_out: [
                    // A non-object row (e.g. a bare string payload) has no
                    // failure markers, so it counts as a pass.
                    { runId: RUN_ID, nodeId: "mixed-primitive", iteration: 0 },
                    outputRow("mixed-explicit", { passed: false }),
                ],
            },
        );
        expect(await byId(graph, "mixed-verdict").computeFn()).toEqual({
            passed: false,
            passCount: 1,
            total: 2,
            strategy: "all-pass",
            results: { primitive: true, explicit: false },
        });

        const allFailed = await render(
            <CheckSuite
                id="zero"
                strategy="any-pass"
                verdictOutput="verdict_out"
                checks={[
                    { id: "a", agent },
                    { id: "b", agent: otherAgent },
                ]}
            />,
            {
                verdict_out: [
                    outputRow("zero-a", { passed: false }),
                    outputRow("zero-b", { failed: true }),
                ],
            },
        );
        expect(await byId(allFailed.graph, "zero-verdict").computeFn()).toEqual({
            passed: false,
            passCount: 0,
            total: 2,
            strategy: "any-pass",
            results: { a: false, b: false },
        });
    });

    test("ScanFixVerify treats a non-array issues payload as a clean scan instead of crashing on expansion", async () => {
        const { graph } = await render(
            <ScanFixVerify
                id="qa"
                scanner={agent}
                fixer={otherAgent}
                verifier={alertAgent}
                scanOutput="scan_out"
                fixOutput="fix_out"
                verifyOutput="verify_out"
                reportOutput="report_out"
            />,
            {
                scan_out: [outputRow("qa-scan", { issues: "corrupted payload" })],
            },
        );

        expect(graph.tasks.map((entry) => entry.nodeId)).toEqual([
            "qa-scan",
            "qa-verify",
            "qa-report",
        ]);
        expect(byId(graph, "qa-verify").dependsOn).toEqual(["qa-scan"]);
    });

    test("ScanFixVerify reads the scan row for the current loop iteration, not iteration 0", async () => {
        const { graph } = await render(
            <ScanFixVerify
                id="qa"
                scanner={agent}
                fixer={otherAgent}
                verifier={alertAgent}
                scanOutput="scan_out"
                fixOutput="fix_out"
                verifyOutput="verify_out"
                reportOutput="report_out"
                maxRetries={4}
            />,
            {
                scan_out: [
                    outputRow("qa-scan", { issues: ["stale one", "stale two"] }, 0),
                    outputRow("qa-scan", { issues: ["fresh issue"] }, 1),
                ],
            },
            { iterations: { "qa-loop": 1 } },
        );

        const fixIds = graph.tasks
            .map((entry) => entry.nodeId)
            .filter((nodeId) => nodeId.startsWith("qa-fix"));
        expect(fixIds).toEqual(["qa-fix-0"]);
        expect(byId(graph, "qa-fix-0").prompt).toBe(
            "Fix scan issue 1 of 1: fresh issue",
        );
        expect(byId(graph, "qa-verify").dependsOn).toEqual(["qa-fix-0"]);
    });

    test("DriftDetector without poll runs capture and compare once, outside any loop", async () => {
        const { graph, root } = await render(
            <DriftDetector
                id="once"
                captureAgent={agent}
                compareAgent={otherAgent}
                captureOutput="capture_out"
                compareOutput="compare_out"
                baseline="prod-v1"
            />,
        );

        expect(graph.tasks.map((entry) => entry.nodeId)).toEqual([
            "once-capture",
            "once-compare",
        ]);
        expect(byId(graph, "once-capture").ralphId).toBeUndefined();
        expect(byId(graph, "once-compare").ralphId).toBeUndefined();
        expect(findHosts(root, "smithers:ralph")).toEqual([]);
    });

    test("DriftDetector poll.intervalMs is reserved and does not leak into or alter the polling loop", async () => {
        const { root } = await render(
            <DriftDetector
                id="paced"
                captureAgent={agent}
                compareAgent={otherAgent}
                captureOutput="capture_out"
                compareOutput="compare_out"
                baseline="prod-v1"
                poll={{ intervalMs: 50, maxPolls: 4 }}
            />,
        );

        const loops = findHosts(root, "smithers:ralph");
        expect(loops.length).toBe(1);
        const loop = loops[0];
        expect(loop.rawProps.id).toBe("paced-poll");
        expect(loop.rawProps.maxIterations).toBe(4);
        expect(loop.rawProps.intervalMs).toBeUndefined();
        expect("intervalMs" in loop.rawProps).toBe(false);
    });

    test("DriftDetector never consults alertIf before a comparison row exists", async () => {
        let alertIfCalls = 0;
        const alert = (
            <Task id="notify" output="alert_out" agent={alertAgent}>
                alert operations
            </Task>
        );
        const { graph } = await render(
            <DriftDetector
                id="pending"
                captureAgent={agent}
                compareAgent={otherAgent}
                captureOutput="capture_out"
                compareOutput="compare_out"
                baseline="prod-v1"
                alertIf={() => {
                    alertIfCalls += 1;
                    return true;
                }}
                alert={alert}
            />,
        );

        expect(alertIfCalls).toBe(0);
        expect(graph.tasks.map((entry) => entry.nodeId)).toEqual([
            "pending-capture",
            "pending-compare",
        ]);
    });

    test("Runbook onDeny=skip with a pending decision keeps the step gated behind the unresolved approval output", async () => {
        const { graph, ctx } = await render(
            <Runbook
                id="pendbook"
                defaultAgent={agent}
                stepOutput="step_out"
                onDeny="skip"
                steps={[
                    { id: "migrate", risk: "risky", command: "pnpm db:migrate" },
                    { id: "cleanup", risk: "safe", command: "pnpm cleanup" },
                ]}
            />,
        );

        const approval = byId(graph, "pendbook-migrate-approval");
        expect(approval).toMatchObject({
            needsApproval: true,
            approvalOnDeny: "skip",
        });
        expect(approval.needs).toBeUndefined();

        // No decision row yet: the step must not be schedulable. It defers —
        // absent from the graph and recorded in _deferredDeps waiting on the
        // approval — rather than mounting as a free-running task.
        expect(
            graph.tasks.find((entry) => entry.nodeId === "pendbook-migrate"),
        ).toBeUndefined();
        expect(ctx._deferredDeps).toEqual([
            { nodeId: "pendbook-migrate", waitingOn: ["pendbook-migrate-approval"] },
        ]);

        // The safe follow-up step still chains off the executed step id, so an
        // eventual approval resumes the original order.
        expect(byId(graph, "pendbook-cleanup").needs).toEqual({
            previousStep: "pendbook-migrate",
        });
    });
});
