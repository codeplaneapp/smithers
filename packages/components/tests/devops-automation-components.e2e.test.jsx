/** @jsxImportSource smithers-orchestrator */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { dirname } from "node:path";
import { z } from "zod";
import { Effect } from "effect";
import {
    CheckSuite,
    ContentPipeline,
    DriftDetector,
    Kanban,
    Runbook,
    ScanFixVerify,
    Sequence,
    Task,
    Workflow,
    approvalDecisionSchema,
    approveNode,
    denyNode,
    runWorkflow,
} from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers } from "./helpers.js";

setDefaultTimeout(30_000);

const checkResultSchema = z.object({
    passed: z.boolean(),
    ok: z.boolean().optional(),
    command: z.string().optional(),
    exitCode: z.number().nullable().optional(),
    signal: z.string().nullable().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    error: z.string().optional(),
    marker: z.string().optional(),
    passCount: z.number().optional(),
    total: z.number().optional(),
    strategy: z.string().optional(),
    results: z.record(z.string(), z.boolean()).optional(),
});

function tableRows(db, table) {
    return db.select().from(table).all();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function runInTestRoot(workflow, dbPath, opts) {
    return Effect.runPromise(
        runWorkflow(workflow, { ...opts, rootDir: dirname(dbPath) }),
    );
}

function command(script) {
    return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function scriptedAgent(id, script, extra = {}) {
    const calls = [];
    return {
        id,
        model: id,
        tools: {},
        supportsNativeStructuredOutput: true,
        calls,
        ...extra,
        async generate(args = {}) {
            calls.push(args);
            const result = await script(args, calls.length);
            if (result && typeof result === "object" && "output" in result) {
                return result;
            }
            return { output: result };
        },
    };
}

describe("devops automation components across the real workflow engine", () => {
    test("CheckSuite runs shell and agent checks and persists all-pass, majority, and any-pass verdicts", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            checkResult: checkResultSchema,
        });
        const passAgent = scriptedAgent("pass-agent", (args) => ({
            passed: true,
            ok: true,
            marker: String(args.taskContext?.nodeId ?? "pass"),
        }));
        const failAgent = scriptedAgent("fail-agent", (args) => ({
            passed: false,
            ok: false,
            marker: String(args.taskContext?.nodeId ?? "fail"),
        }));
        const passCommand = command("console.log('command-pass')");
        const failCommand = command("console.error('command-fail'); process.exit(7)");
        try {
            const workflow = smithers(() => (
                <Workflow name="checksuite-devops-e2e">
                    <Sequence>
                        <CheckSuite
                            id="all"
                            strategy="all-pass"
                            verdictOutput={outputs.checkResult}
                            maxConcurrency={2}
                            checks={[
                                { id: "cmd", command: passCommand },
                                { id: "agent", agent: passAgent },
                            ]}
                        />
                        <CheckSuite
                            id="majority"
                            strategy="majority"
                            verdictOutput={outputs.checkResult}
                            checks={[
                                { id: "cmd", command: passCommand },
                                { id: "agent-pass", agent: passAgent },
                                { id: "agent-fail", agent: failAgent },
                            ]}
                        />
                        <CheckSuite
                            id="any"
                            strategy="any-pass"
                            verdictOutput={outputs.checkResult}
                            checks={[
                                { id: "cmd-fail", command: failCommand },
                                { id: "agent-fail", agent: failAgent },
                                { id: "agent-pass", agent: passAgent },
                            ]}
                        />
                        <CheckSuite
                            id="half"
                            strategy="majority"
                            verdictOutput={outputs.checkResult}
                            checks={[
                                { id: "agent-pass", agent: passAgent },
                                { id: "agent-fail", agent: failAgent },
                            ]}
                        />
                    </Sequence>
                </Workflow>
            ));

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 4 }));

            expect(result.status).toBe("finished");
            const rows = tableRows(db, tables.checkResult);
            const byNode = (nodeId) => rows.find((row) => row.nodeId === nodeId);
            expect(byNode("all-cmd")).toMatchObject({
                passed: true,
                ok: true,
                exitCode: 0,
            });
            expect(byNode("all-cmd")?.stdout).toContain("command-pass");
            expect(byNode("any-cmd-fail")).toMatchObject({
                passed: false,
                ok: false,
                exitCode: 7,
            });
            expect(byNode("any-cmd-fail")?.stderr).toContain("command-fail");
            expect(byNode("all-verdict")).toMatchObject({
                passed: true,
                passCount: 2,
                total: 2,
                strategy: "all-pass",
            });
            expect(byNode("majority-verdict")).toMatchObject({
                passed: true,
                passCount: 2,
                total: 3,
                strategy: "majority",
            });
            expect(byNode("any-verdict")).toMatchObject({
                passed: true,
                passCount: 1,
                total: 3,
                strategy: "any-pass",
            });
            expect(byNode("half-verdict")).toMatchObject({
                passed: false,
                passCount: 1,
                total: 2,
                strategy: "majority",
            });
        }
        finally {
            cleanup();
        }
    });

    test("CheckSuite maxConcurrency serializes an otherwise parallel check group", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            checkResult: checkResultSchema,
        });
        let active = 0;
        let maxActive = 0;
        const slowAgent = scriptedAgent("slow-check", async (args) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await sleep(25);
            active -= 1;
            return {
                passed: true,
                ok: true,
                marker: String(args.taskContext?.nodeId ?? "slow"),
            };
        });
        try {
            const workflow = smithers(() => (
                <Workflow name="checksuite-concurrency-e2e">
                    <CheckSuite
                        id="serial"
                        strategy="all-pass"
                        verdictOutput={outputs.checkResult}
                        maxConcurrency={1}
                        checks={[
                            { id: "a", agent: slowAgent },
                            { id: "b", agent: slowAgent },
                            { id: "c", agent: slowAgent },
                        ]}
                    />
                </Workflow>
            ));

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 3 }));

            expect(result.status).toBe("finished");
            expect(maxActive).toBe(1);
            expect(tableRows(db, tables.checkResult).map((row) => row.nodeId).sort()).toEqual([
                "serial-a",
                "serial-b",
                "serial-c",
                "serial-verdict",
            ]);
        }
        finally {
            cleanup();
        }
    });

    test("Kanban uses dynamic tickets, column agent overrides, maxIterations, and completion output", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            columnResult: z.object({
                itemId: z.string(),
                column: z.string(),
                agentId: z.string(),
                attempt: z.number(),
            }),
            board: z.object({
                processed: z.number(),
                done: z.array(z.string()),
            }),
        });
        const baseAgent = scriptedAgent("base-agent", (args) => ({
            itemId: "unexpected",
            column: "base",
            agentId: "base-agent",
            attempt: Number(args.taskContext?.iteration ?? -1),
        }));
        const overrideAgent = scriptedAgent("override-agent", (args) => {
            const prompt = String(args.prompt ?? "");
            return {
                itemId: prompt.match(/item:(\w+)/)?.[1] ?? "unknown",
                column: "implement",
                agentId: "override-agent",
                attempt: Number(args.taskContext?.iteration ?? -1),
            };
        });
        try {
            const tickets = [{ id: "T1", title: "ship audit log" }];
            const workflow = smithers((ctx) => {
                const rows = ctx.outputs("columnResult");
                return (
                    <Workflow name="kanban-devops-e2e">
                        <Kanban
                            id="board"
                            columns={[
                                {
                                    name: "implement",
                                    agent: baseAgent,
                                    output: outputs.columnResult,
                                    prompt: ({ item }) => `item:${item.id}`,
                                },
                            ]}
                            useTickets={() => tickets}
                            agents={{ implement: overrideAgent }}
                            until={rows.length >= 2}
                            maxIterations={2}
                            maxConcurrency={1}
                            onComplete={outputs.board}
                        >
                            {{
                                processed: rows.length,
                                done: rows.map((row) => row.itemId).sort(),
                            }}
                        </Kanban>
                    </Workflow>
                );
            });

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 3 }));

            expect(result.status).toBe("finished");
            expect(baseAgent.calls).toHaveLength(0);
            expect(overrideAgent.calls).toHaveLength(2);
            expect(tableRows(db, tables.columnResult).map((row) => row.iteration)).toEqual([0, 1]);
            expect(tableRows(db, tables.columnResult).every((row) => row.agentId === "override-agent")).toBe(true);
            expect(tableRows(db, tables.board)[0]).toMatchObject({
                processed: 2,
                done: ["T1", "T1"],
            });
        }
        finally {
            cleanup();
        }
    });

    test("Runbook pauses for risky and critical approvals, applies request templates, and skips a denied critical step", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            step: z.object({
                step: z.string(),
                agentId: z.string(),
                prompt: z.string(),
            }),
            "deploy-migrate-approval-decision": approvalDecisionSchema,
            "deploy-cutover-approval-decision": approvalDecisionSchema,
        });
        const opsAgent = scriptedAgent("ops-agent", (args) => ({
            step: String(args.taskContext?.nodeId ?? "unknown"),
            agentId: "ops-agent",
            prompt: String(args.prompt ?? ""),
        }));
        const workflow = smithers(() => (
            <Workflow name="runbook-devops-e2e">
                <Runbook
                    id="deploy"
                    defaultAgent={opsAgent}
                    stepOutput={outputs.step}
                    onDeny="skip"
                    approvalRequest={{
                        title: "Change request CHG-9",
                        summary: "Follow the production deploy approval template.",
                        metadata: { changeId: "CHG-9" },
                    }}
                    steps={[
                        { id: "prepare", risk: "safe", command: "prepare cluster" },
                        { id: "migrate", risk: "risky", command: "run migration" },
                        { id: "cutover", risk: "critical", command: "flip traffic" },
                    ]}
                />
            </Workflow>
        ));
        const adapter = new SmithersDb(db);
        try {
            const first = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(first.status).toBe("waiting-approval");
            const migrateApproval = await adapter.getApproval(first.runId, "deploy-migrate-approval", 0);
            const migrateRequest = JSON.parse(migrateApproval?.requestJson ?? "{}");
            expect(migrateRequest).toMatchObject({
                title: "Change request CHG-9",
                summary: "Follow the production deploy approval template.",
            });
            expect(migrateRequest.metadata).toMatchObject({
                changeId: "CHG-9",
                risk: "risky",
                stepId: "migrate",
            });

            await Effect.runPromise(
                approveNode(adapter, first.runId, "deploy-migrate-approval", 0, "approved", "tester"),
            );
            const second = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });
            expect(second.status).toBe("waiting-approval");
            const criticalApproval = await adapter.getApproval(first.runId, "deploy-cutover-approval", 0);
            const criticalRequest = JSON.parse(criticalApproval?.requestJson ?? "{}");
            expect(criticalRequest.metadata).toMatchObject({
                changeId: "CHG-9",
                elevated: true,
                risk: "critical",
                stepId: "cutover",
            });

            await Effect.runPromise(
                denyNode(adapter, first.runId, "deploy-cutover-approval", 0, "not safe", "tester"),
            );
            const final = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });

            expect(final.status).toBe("finished");
            expect(tableRows(db, tables.step).map((row) => row.nodeId)).toEqual([
                "deploy-prepare",
                "deploy-migrate",
            ]);
            expect(tableRows(db, tables.step).map((row) => row.agentId)).toEqual([
                "ops-agent",
                "ops-agent",
            ]);
        }
        finally {
            cleanup();
        }
    });

    test("ScanFixVerify runs the scanner-fixer-verifier loop up to maxRetries and uses a fixer chain", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            scan: z.object({
                issues: z.array(z.string()),
                attempt: z.number(),
            }),
            fix: z.object({
                fixedBy: z.string(),
                attempt: z.number(),
            }),
            verify: z.object({
                ok: z.boolean(),
                attempt: z.number(),
            }),
            report: z.object({
                summary: z.string(),
                verifyRows: z.number(),
            }),
        });
        const scanner = scriptedAgent("scanner", (args) => ({
            issues: [`issue-${args.taskContext?.iteration}`],
            attempt: Number(args.taskContext?.iteration ?? -1),
        }));
        const unavailableFixer = scriptedAgent(
            "unavailable-fixer",
            () => {
                throw new Error("unavailable fixer should fail preflight before generate");
            },
            {
                async preflight() {
                    throw new Error("fixer unavailable");
                },
            },
        );
        const fixer = scriptedAgent("fallback-fixer", (args) => ({
            fixedBy: "fallback-fixer",
            attempt: Number(args.taskContext?.iteration ?? -1),
        }));
        const verifier = scriptedAgent("verifier", (args) => {
            const nodeId = String(args.taskContext?.nodeId ?? "");
            if (nodeId === "qa-report") {
                return { summary: "reported", verifyRows: tableRows(db, tables.verify).length };
            }
            return {
                ok: false,
                attempt: Number(args.taskContext?.iteration ?? -1),
            };
        });
        try {
            const workflow = smithers(() => (
                <Workflow name="scan-fix-verify-devops-e2e">
                    <ScanFixVerify
                        id="qa"
                        scanner={scanner}
                        fixer={[unavailableFixer, fixer]}
                        verifier={verifier}
                        scanOutput={outputs.scan}
                        fixOutput={outputs.fix}
                        verifyOutput={outputs.verify}
                        reportOutput={outputs.report}
                        maxRetries={2}
                        maxConcurrency={1}
                    >
                        scan deployment automation
                    </ScanFixVerify>
                </Workflow>
            ));

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

            expect(result.status).toBe("finished");
            expect(unavailableFixer.calls).toHaveLength(0);
            expect(fixer.calls).toHaveLength(2);
            expect(tableRows(db, tables.scan).map((row) => row.iteration)).toEqual([0, 1]);
            expect(tableRows(db, tables.fix).map((row) => row.fixedBy)).toEqual([
                "fallback-fixer",
                "fallback-fixer",
            ]);
            expect(tableRows(db, tables.verify).map((row) => row.iteration)).toEqual([0, 1]);
            expect(tableRows(db, tables.report)[0]).toMatchObject({
                summary: "reported",
                verifyRows: 2,
            });
        }
        finally {
            cleanup();
        }
    });

    test("ScanFixVerify cycles healthy fixer agents across deterministic scan issues", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            scan: z.object({
                issues: z.array(z.string()),
            }),
            fix: z.object({
                issue: z.string(),
                fixedBy: z.string(),
            }),
            verify: z.object({
                ok: z.boolean(),
            }),
            report: z.object({
                summary: z.string(),
                fixRows: z.number(),
            }),
        });
        const issueFromPrompt = (prompt) => {
            const text = String(prompt ?? "");
            const match = text.match(/: (lint|type)$/);
            return match?.[1] ?? "unknown";
        };
        const scanner = scriptedAgent("scanner-two-issues", () => ({
            issues: ["lint", "type"],
        }));
        const lintFixer = scriptedAgent("lint-fixer", (args) => ({
            issue: issueFromPrompt(args.prompt),
            fixedBy: "lint-fixer",
        }));
        const typeFixer = scriptedAgent("type-fixer", (args) => ({
            issue: issueFromPrompt(args.prompt),
            fixedBy: "type-fixer",
        }));
        const verifier = scriptedAgent("verifier-two-issues", (args) => {
            if (args.taskContext?.nodeId === "qa-report") {
                return {
                    summary: "reported",
                    fixRows: tableRows(db, tables.fix).length,
                };
            }
            return { ok: true };
        });
        try {
            const workflow = smithers(() => (
                <Workflow name="scan-fix-verify-multi-fixer-e2e">
                    <ScanFixVerify
                        id="qa"
                        scanner={scanner}
                        fixer={[lintFixer, typeFixer]}
                        verifier={verifier}
                        scanOutput={outputs.scan}
                        fixOutput={outputs.fix}
                        verifyOutput={outputs.verify}
                        reportOutput={outputs.report}
                        maxRetries={1}
                        maxConcurrency={2}
                    >
                        scan lint and type automation checks
                    </ScanFixVerify>
                </Workflow>
            ));

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

            expect(result.status).toBe("finished");
            expect(lintFixer.calls).toHaveLength(1);
            expect(typeFixer.calls).toHaveLength(1);
            expect(tableRows(db, tables.fix)
                .map((row) => ({ issue: row.issue, fixedBy: row.fixedBy }))
                .sort((left, right) => left.issue.localeCompare(right.issue))).toEqual([
                    { issue: "lint", fixedBy: "lint-fixer" },
                    { issue: "type", fixedBy: "type-fixer" },
                ]);
            expect(tableRows(db, tables.report)[0]).toMatchObject({
                summary: "reported",
                fixRows: 2,
            });
        }
        finally {
            cleanup();
        }
    });

    test("DriftDetector captures a baseline, polls with a custom alert predicate, and ContentPipeline chains stages", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            capture: z.object({
                snapshot: z.string(),
                prompt: z.string(),
                attempt: z.number(),
            }),
            compare: z.object({
                drifted: z.boolean(),
                severity: z.string(),
                prompt: z.string(),
                attempt: z.number(),
            }),
            alert: z.object({
                message: z.string(),
                attempt: z.number(),
            }),
            outline: z.object({ stage: z.string(), prompt: z.string() }),
            draft: z.object({ stage: z.string(), prompt: z.string() }),
            publish: z.object({ stage: z.string(), prompt: z.string() }),
        });
        const captureAgent = scriptedAgent("capture", (args) => ({
            snapshot: `snapshot-${args.taskContext?.iteration}`,
            prompt: String(args.prompt ?? ""),
            attempt: Number(args.taskContext?.iteration ?? -1),
        }));
        const compareAgent = scriptedAgent("compare", (args) => {
            const iteration = Number(args.taskContext?.iteration ?? -1);
            return {
                drifted: iteration === 1,
                severity: iteration === 1 ? "critical" : "minor",
                prompt: String(args.prompt ?? ""),
                attempt: iteration,
            };
        });
        const alertAgent = scriptedAgent("alert", (args) => ({
            message: String(args.prompt ?? ""),
            attempt: Number(args.taskContext?.iteration ?? -1),
        }));
        const stageAgent = (stage) =>
            scriptedAgent(`stage-${stage}`, (args) => ({
                stage,
                prompt: String(args.prompt ?? ""),
            }));
        try {
            const workflow = smithers(() => (
                <Workflow name="drift-content-devops-e2e">
                    <Sequence>
                        <DriftDetector
                            id="config"
                            captureAgent={captureAgent}
                            compareAgent={compareAgent}
                            captureOutput={outputs.capture}
                            compareOutput={outputs.compare}
                            baseline={{ expected: "v1" }}
                            alertIf={(comparison) => comparison?.severity === "critical"}
                            alert={
                                <Task id="notify" output={outputs.alert} agent={alertAgent}>
                                    notify operators
                                </Task>
                            }
                            poll={{ intervalMs: 1, maxPolls: 2 }}
                        />
                        <ContentPipeline
                            stages={[
                                { id: "outline", output: outputs.outline, agent: stageAgent("outline"), label: "Outline" },
                                { id: "draft", output: outputs.draft, agent: stageAgent("draft"), label: "Draft" },
                                { id: "publish", output: outputs.publish, agent: stageAgent("publish"), label: "Publish" },
                            ]}
                        >
                            write incident notes
                        </ContentPipeline>
                    </Sequence>
                </Workflow>
            ));

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

            expect(result.status).toBe("finished");
            expect(tableRows(db, tables.capture).map((row) => row.iteration)).toEqual([0, 1]);
            expect(tableRows(db, tables.compare).map((row) => row.severity)).toEqual(["minor", "critical"]);
            expect(tableRows(db, tables.capture)[0]?.prompt).toContain('"expected":"v1"');
            expect(tableRows(db, tables.compare)[0]?.prompt).toContain('"expected":"v1"');
            expect(tableRows(db, tables.alert)).toHaveLength(1);
            expect(tableRows(db, tables.alert)[0]).toMatchObject({
                message: "notify operators",
                iteration: 1,
            });
            expect(tableRows(db, tables.outline)[0]).toMatchObject({
                stage: "outline",
                prompt: "write incident notes",
            });
            expect(tableRows(db, tables.draft)[0]?.prompt).toContain("Continue from the previous stage");
            expect(tableRows(db, tables.publish)[0]?.prompt).toContain("Publish");
        }
        finally {
            cleanup();
        }
    });
});

describe("devops automation components hardening e2e", () => {
    test("Runbook default onDeny=fail fails the run on denial and never executes later steps", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            step: z.object({ step: z.string(), prompt: z.string() }),
            "release-restart-approval-decision": approvalDecisionSchema,
        });
        const opsAgent = scriptedAgent("ops-agent", (args) => ({
            step: String(args.taskContext?.nodeId ?? "unknown"),
            prompt: String(args.prompt ?? ""),
        }));
        const workflow = smithers(() => (
            <Workflow name="runbook-deny-fail-e2e">
                <Runbook
                    id="release"
                    defaultAgent={opsAgent}
                    stepOutput={outputs.step}
                    steps={[
                        { id: "backup", risk: "safe", command: "back up the database" },
                        { id: "restart", risk: "risky", command: "restart the production fleet" },
                        { id: "announce", risk: "safe", command: "announce completion" },
                    ]}
                />
            </Workflow>
        ));
        const adapter = new SmithersDb(db);
        try {
            const first = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(first.status).toBe("waiting-approval");
            expect(tableRows(db, tables.step).map((row) => row.nodeId)).toEqual([
                "release-backup",
            ]);

            await Effect.runPromise(
                denyNode(adapter, first.runId, "release-restart-approval", 0, "too risky", "tester"),
            );
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });

            expect(resumed.status).toBe("failed");
            expect(tableRows(db, tables.step).map((row) => row.nodeId)).toEqual([
                "release-backup",
            ]);
            expect(opsAgent.calls).toHaveLength(1);
        }
        finally {
            cleanup();
        }
    });

    test("CheckSuite record-form checks derive node ids from keys and one failing check sinks the all-pass verdict", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            checkResult: checkResultSchema,
        });
        const passAgent = scriptedAgent("record-pass", () => ({ passed: true, ok: true }));
        try {
            const workflow = smithers(() => (
                <Workflow name="checksuite-record-form-e2e">
                    <CheckSuite
                        id="gate"
                        strategy="all-pass"
                        verdictOutput={outputs.checkResult}
                        checks={{
                            lint: { command: command("console.log('lint ok')"), label: "Lint" },
                            unit: { agent: passAgent },
                            audit: { command: command("process.exit(3)") },
                        }}
                    />
                </Workflow>
            ));

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 3 }));

            expect(result.status).toBe("finished");
            const rows = tableRows(db, tables.checkResult);
            const byNode = (nodeId) => rows.find((row) => row.nodeId === nodeId);
            expect(rows.map((row) => row.nodeId).sort()).toEqual([
                "gate-audit",
                "gate-lint",
                "gate-unit",
                "gate-verdict",
            ]);
            expect(byNode("gate-lint")).toMatchObject({ passed: true, exitCode: 0 });
            expect(byNode("gate-audit")).toMatchObject({ passed: false, exitCode: 3 });
            const verdict = byNode("gate-verdict");
            expect(verdict).toMatchObject({
                passed: false,
                passCount: 2,
                total: 3,
                strategy: "all-pass",
            });
            const results = typeof verdict.results === "string"
                ? JSON.parse(verdict.results)
                : verdict.results;
            expect(results).toEqual({ lint: true, unit: true, audit: false });
        }
        finally {
            cleanup();
        }
    });

    test("Kanban tickets sourced from prior outputs expand mid-iteration and until stops the loop before maxIterations", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            ticket: z.object({ itemId: z.string(), spawn: z.string().nullable() }),
            board: z.object({ processed: z.number() }),
        });
        const triageAgent = scriptedAgent("triage-agent", (args) => {
            const itemId = String(args.prompt ?? "").match(/item:([\w-]+)/)?.[1] ?? "unknown";
            return { itemId, spawn: itemId === "T1" ? "T1-follow-up" : null };
        });
        try {
            const workflow = smithers((ctx) => {
                const rows = ctx.outputs("ticket");
                const spawned = rows
                    .filter((row) => row.spawn)
                    .map((row) => ({ id: row.spawn }));
                const tickets = [{ id: "T1" }, ...spawned];
                return (
                    <Workflow name="kanban-dynamic-tickets-e2e">
                        <Kanban
                            id="board"
                            columns={[
                                {
                                    name: "triage",
                                    agent: triageAgent,
                                    output: outputs.ticket,
                                    prompt: ({ item }) => `item:${item.id}`,
                                },
                            ]}
                            useTickets={() => tickets}
                            until={rows.length >= 2}
                            maxIterations={4}
                            onComplete={outputs.board}
                        >
                            {{ processed: rows.length }}
                        </Kanban>
                    </Workflow>
                );
            });

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

            expect(result.status).toBe("finished");
            expect(triageAgent.calls).toHaveLength(2);
            const rows = tableRows(db, tables.ticket);
            expect(rows.map((row) => row.itemId).sort()).toEqual(["T1", "T1-follow-up"]);
            expect(rows.map((row) => row.nodeId).sort()).toEqual([
                "board-triage-T1",
                "board-triage-T1-follow-up",
            ]);
            expect(rows.every((row) => row.iteration === 0)).toBe(true);
            expect(tableRows(db, tables.board)[0]).toMatchObject({ processed: 2 });
        }
        finally {
            cleanup();
        }
    });

    test("DriftDetector without polling runs a single capture-compare pass and the default predicate gates the alert on drifted", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            capture: z.object({ snapshot: z.string() }),
            compare: z.object({ drifted: z.boolean() }),
            alert: z.object({ message: z.string() }),
        });
        const captureAgent = scriptedAgent("capture-once", () => ({ snapshot: "current" }));
        const driftedCompare = scriptedAgent("compare-drifted", () => ({ drifted: true }));
        const steadyCompare = scriptedAgent("compare-steady", () => ({ drifted: false }));
        const hotAlertAgent = scriptedAgent("hot-alert-agent", (args) => ({
            message: String(args.prompt ?? ""),
        }));
        const coldAlertAgent = scriptedAgent("cold-alert-agent", (args) => ({
            message: String(args.prompt ?? ""),
        }));
        try {
            const workflow = smithers(() => (
                <Workflow name="drift-single-shot-e2e">
                    <Sequence>
                        <DriftDetector
                            id="hot"
                            captureAgent={captureAgent}
                            compareAgent={driftedCompare}
                            captureOutput={outputs.capture}
                            compareOutput={outputs.compare}
                            baseline="prod-v1"
                            alert={
                                <Task id="hot-alert" output={outputs.alert} agent={hotAlertAgent}>
                                    page the on-call
                                </Task>
                            }
                        />
                        <DriftDetector
                            id="cold"
                            captureAgent={captureAgent}
                            compareAgent={steadyCompare}
                            captureOutput={outputs.capture}
                            compareOutput={outputs.compare}
                            baseline="prod-v1"
                            alert={
                                <Task id="cold-alert" output={outputs.alert} agent={coldAlertAgent}>
                                    page the on-call
                                </Task>
                            }
                        />
                    </Sequence>
                </Workflow>
            ));

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

            expect(result.status).toBe("finished");
            expect(tableRows(db, tables.capture).map((row) => row.nodeId).sort()).toEqual([
                "cold-capture",
                "hot-capture",
            ]);
            expect(tableRows(db, tables.compare).map((row) => row.nodeId).sort()).toEqual([
                "cold-compare",
                "hot-compare",
            ]);
            const alerts = tableRows(db, tables.alert);
            expect(alerts).toHaveLength(1);
            expect(alerts[0]).toMatchObject({
                nodeId: "hot-alert",
                message: "page the on-call",
            });
            expect(coldAlertAgent.calls).toHaveLength(0);
        }
        finally {
            cleanup();
        }
    });

    test("ScanFixVerify with a clean scan skips all fix work through the real engine and still verifies and reports", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            scan: z.object({ issues: z.array(z.string()) }),
            fix: z.object({ fixedBy: z.string() }),
            verify: z.object({ ok: z.boolean() }),
            report: z.object({ summary: z.string() }),
        });
        const scanner = scriptedAgent("clean-scanner", () => ({ issues: [] }));
        const fixer = scriptedAgent("unused-fixer", () => ({ fixedBy: "unused-fixer" }));
        const verifier = scriptedAgent("clean-verifier", (args) => {
            if (args.taskContext?.nodeId === "qa-report") {
                return { summary: "clean" };
            }
            return { ok: true };
        });
        try {
            const workflow = smithers(() => (
                <Workflow name="scan-fix-verify-clean-e2e">
                    <ScanFixVerify
                        id="qa"
                        scanner={scanner}
                        fixer={fixer}
                        verifier={verifier}
                        scanOutput={outputs.scan}
                        fixOutput={outputs.fix}
                        verifyOutput={outputs.verify}
                        reportOutput={outputs.report}
                        maxRetries={1}
                    >
                        scan a healthy deployment
                    </ScanFixVerify>
                </Workflow>
            ));

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

            expect(result.status).toBe("finished");
            expect(fixer.calls).toHaveLength(0);
            expect(tableRows(db, tables.fix)).toHaveLength(0);
            expect(tableRows(db, tables.scan)).toHaveLength(1);
            expect(tableRows(db, tables.verify)).toHaveLength(1);
            expect(tableRows(db, tables.report)[0]).toMatchObject({ summary: "clean" });
        }
        finally {
            cleanup();
        }
    });
});
