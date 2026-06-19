/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { buildHumanRequestId } from "@smithers-orchestrator/db/buildHumanRequestId";
import { withTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { AntigravityAgent } from "@smithers-orchestrator/agents/AntigravityAgent";
import { ClaudeCodeAgent } from "@smithers-orchestrator/agents/ClaudeCodeAgent";
import { PiAgent } from "@smithers-orchestrator/agents/PiAgent";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import {
    Approval,
    Aspects,
    ContinueAsNew,
    DriftDetector,
    HumanTask,
    Kanban,
    Poller,
    Runbook,
    Saga,
    Signal,
    Task,
    Timer,
    TryCatchFinally,
    Workflow,
    continueAsNew,
} from "../src/components/index.js";
import { forceContinueOnFail } from "../src/components/control-flow-utils.js";
import { markdownComponents } from "../src/markdownComponents.js";
import { renderPromptToText } from "../src/components/Task.js";
import { zodSchemaToJsonExample } from "../src/zod-to-example.js";
import { createTestSmithers } from "./helpers.js";

const agent = { id: "agent", generate: async () => ({ text: "ok" }) };

async function render(el) {
    const renderer = new SmithersRenderer();
    return renderer.render(el);
}

function runtimeFor(db, runId, nodeId, iteration = 0) {
    return { db, runId, nodeId, iteration };
}

function baseHumanRequest(runId, nodeId, overrides = {}) {
    return {
        requestId: buildHumanRequestId(runId, nodeId, 0),
        runId,
        nodeId,
        iteration: 0,
        kind: "json",
        status: "pending",
        prompt: "answer",
        schemaJson: null,
        optionsJson: null,
        responseJson: null,
        requestedAtMs: 1,
        answeredAtMs: null,
        answeredBy: null,
        timeoutAtMs: null,
        ...overrides,
    };
}

describe("remaining component branch coverage", () => {
    test("Approval validates options, auto-approval metadata, and compute decisions", async () => {
        expect(() =>
            renderToStaticMarkup(
                <Approval id="missing-options" output="out" mode="select" request={{ title: "Choose" }} />,
            ),
        ).toThrow('requires options when mode="select"');

        const rendered = await render(
            <Approval
                id="approval-select"
                output="out"
                mode="select"
                request={{ title: "Choose", summary: "Pick one", metadata: { requestId: "r1" } }}
                options={[
                    { key: "blue", label: "Blue", summary: "Primary", metadata: { hex: "#00f" } },
                ]}
                allowedScopes={["deploy"]}
                allowedUsers={["alice"]}
                autoApprove={{
                    after: 10,
                    audit: false,
                    condition: () => true,
                    revertOn: () => false,
                }}
                meta={{ owner: "ops" }}
            />,
        );
        expect(rendered.tasks[0].approvalMode).toBe("select");
        expect(rendered.tasks[0].approvalOptions).toEqual([
            { key: "blue", label: "Blue", summary: "Primary", metadata: { hex: "#00f" } },
        ]);
        expect(rendered.tasks[0].approvalAutoApprove).toEqual({
            after: 10,
            audit: false,
            conditionMet: true,
            revertOnMet: false,
        });
        expect(rendered.tasks[0].meta).toMatchObject({
            requestSummary: "Pick one",
            requestId: "r1",
            owner: "ops",
            approvalAllowedScopes: ["deploy"],
            approvalAllowedUsers: ["alice"],
        });

        const noCallbackAutoApprove = await render(
            <Approval id="approval-auto" output="out" request={{ title: "Auto" }} autoApprove={{ after: 1 }} />,
        );
        expect(noCallbackAutoApprove.tasks[0].approvalAutoApprove).toEqual({ after: 1, audit: true });

        await expect(rendered.tasks[0].computeFn()).rejects.toThrow("Approval decisions can only be resolved");

        const { db, cleanup } = createTestSmithers({});
        ensureSmithersTables(db);
        const adapter = new SmithersDb(db);
        try {
            await adapter.insertOrUpdateApproval({
                runId: "run",
                nodeId: "approval-select",
                iteration: 0,
                status: "approved",
                requestedAtMs: 1,
                decidedAtMs: 2,
                note: "fallback",
                decidedBy: "alice",
                requestJson: null,
                decisionJson: JSON.stringify({ selected: "blue", notes: "selected note" }),
                autoApproved: false,
            });
            await adapter.insertOrUpdateApproval({
                runId: "run",
                nodeId: "approval-rank",
                iteration: 0,
                status: "approved",
                requestedAtMs: 1,
                decidedAtMs: 2,
                note: "rank fallback",
                decidedBy: "bob",
                requestJson: null,
                decisionJson: JSON.stringify({ ranked: ["first", 2, "second"], notes: 12 }),
                autoApproved: false,
            });
            await adapter.insertOrUpdateApproval({
                runId: "run",
                nodeId: "approval-decision",
                iteration: 0,
                status: "approved",
                requestedAtMs: 1,
                decidedAtMs: 2,
                note: "approved note",
                decidedBy: "carol",
                requestJson: null,
                decisionJson: null,
                autoApproved: false,
            });
            await adapter.insertOrUpdateApproval({
                runId: "run",
                nodeId: "approval-invalid-json",
                iteration: 0,
                status: "approved",
                requestedAtMs: 1,
                decidedAtMs: 2,
                note: "invalid fallback",
                decidedBy: "dave",
                requestJson: null,
                decisionJson: "{",
                autoApproved: false,
            });

            const rank = await render(
                <Approval
                    id="approval-rank"
                    output="out"
                    mode="rank"
                    request={{ title: "Rank" }}
                    options={[{ key: "first", label: "First" }]}
                />,
            );
            const decision = await render(<Approval id="approval-decision" output="out" request={{ title: "Approve" }} />);
            const invalidJson = await render(
                <Approval
                    id="approval-invalid-json"
                    output="out"
                    mode="select"
                    request={{ title: "Choose" }}
                    options={[{ key: "fallback", label: "Fallback" }]}
                />,
            );

            await expect(
                withTaskRuntime(runtimeFor(db, "run", "approval-select"), () => rendered.tasks[0].computeFn()),
            ).resolves.toEqual({ selected: "blue", notes: "selected note" });
            await expect(
                withTaskRuntime(runtimeFor(db, "run", "approval-rank"), () => rank.tasks[0].computeFn()),
            ).resolves.toEqual({ ranked: ["first", "second"], notes: "rank fallback" });
            await expect(
                withTaskRuntime(runtimeFor(db, "run", "approval-decision"), () => decision.tasks[0].computeFn()),
            ).resolves.toEqual({
                approved: true,
                note: "approved note",
                decidedBy: "carol",
                decidedAt: new Date(2).toISOString(),
            });
            await expect(
                withTaskRuntime(runtimeFor(db, "run", "approval-invalid-json"), () => invalidJson.tasks[0].computeFn()),
            ).resolves.toEqual({ selected: "", notes: "invalid fallback" });
        }
        finally {
            cleanup();
        }
    });

    test("HumanTask compute handles runtime, request, approval fallback, and validation paths", async () => {
        const output = z.object({ answer: z.string() });
        const ok = HumanTask({ id: "human-ok", output, prompt: "Answer" });
        const okCompute = ok.props.__smithersComputeFn;
        await expect(okCompute()).rejects.toThrow("HumanTask can only be resolved");

        const { db, cleanup } = createTestSmithers({});
        ensureSmithersTables(db);
        const adapter = new SmithersDb(db);
        try {
            await adapter.insertHumanRequest(baseHumanRequest("run", "human-ok", {
                status: "answered",
                responseJson: JSON.stringify({ answer: "yes" }),
                answeredAtMs: 2,
                answeredBy: "alice",
            }));
            await expect(
                withTaskRuntime(runtimeFor(db, "run", "human-ok"), () => okCompute()),
            ).resolves.toEqual({ answer: "yes" });

            const fallback = HumanTask({ id: "human-fallback", output, prompt: "Answer" });
            await adapter.insertHumanRequest(baseHumanRequest("run", "human-fallback"));
            await adapter.insertOrUpdateApproval({
                runId: "run",
                nodeId: "human-fallback",
                iteration: 0,
                status: "approved",
                requestedAtMs: 1,
                decidedAtMs: 3,
                note: JSON.stringify({ answer: "from approval" }),
                decidedBy: "bob",
                requestJson: null,
                decisionJson: null,
                autoApproved: false,
            });
            await expect(
                withTaskRuntime(runtimeFor(db, "run", "human-fallback"), () => fallback.props.__smithersComputeFn()),
            ).resolves.toEqual({ answer: "from approval" });
            const answered = await adapter.getHumanRequest(buildHumanRequestId("run", "human-fallback", 0));
            expect(answered?.status).toBe("answered");

            const noSchema = HumanTask({ id: "human-plain", output: "plain_out", prompt: "Answer" });
            await adapter.insertHumanRequest(baseHumanRequest("run", "human-plain", {
                status: "answered",
                responseJson: JSON.stringify("plain answer"),
            }));
            await expect(
                withTaskRuntime(runtimeFor(db, "run", "human-plain"), () => noSchema.props.__smithersComputeFn()),
            ).resolves.toBe("plain answer");

            for (const [nodeId, request, error] of [
                ["human-cancelled", baseHumanRequest("run", "human-cancelled", { status: "cancelled" }), "was cancelled"],
                ["human-empty", baseHumanRequest("run", "human-empty", { status: "expired" }), "No human input received"],
                ["human-json", baseHumanRequest("run", "human-json", { status: "answered", responseJson: "{" }), "not valid JSON"],
                [
                    "human-invalid",
                    baseHumanRequest("run", "human-invalid", {
                        status: "answered",
                        responseJson: JSON.stringify({ answer: 1 }),
                    }),
                    "does not match the output schema",
                ],
            ]) {
                const task = HumanTask({ id: nodeId, output, prompt: "Answer" });
                await adapter.insertHumanRequest(request);
                await expect(
                    withTaskRuntime(runtimeFor(db, "run", nodeId), () => task.props.__smithersComputeFn()),
                ).rejects.toThrow(error);
            }
        }
        finally {
            cleanup();
        }
    });

    test("Task helper branches cover prompt failures, schema injection, aspect metadata, and CLI allowlists", async () => {
        const promptValue = {
            toString() {
                return "[object Object]";
            },
        };
        expect(() => renderPromptToText(promptValue)).toThrow("MDX prompt could not be rendered");
        expect(renderPromptToText({ toString: () => "custom prompt" })).toBe("custom prompt");

        const schema = z.object({ title: z.string().describe("Title") });
        function Prompt(props) {
            return <>{props.schema}</>;
        }

        const withSchema = await render(
            <Task id="schema-task" output={schema} agent={agent}>
                <Prompt />
            </Task>,
        );
        expect(withSchema.tasks[0].prompt).toContain("&quot;title&quot;: &quot;Title&quot;");

        const withAspects = await render(
            <Aspects tokenBudget={{ max: 100 }} latencySlo={{ maxMs: 250 }}>
                <Task id="aspect-task" output="out">
                    {{ ok: true }}
                </Task>
            </Aspects>,
        );
        expect(withAspects.tasks[0].nodeId).toBe("aspect-task");

        const claude = new ClaudeCodeAgent({ apiKey: "test", allowedTools: ["Read"] });
        const noClaudeTools = await render(
            <Task id="claude" output="out" agent={claude} allowTools={[]}>
                prompt
            </Task>,
        );
        expect(noClaudeTools.tasks[0].agent.opts.allowedTools).toEqual([]);
        expect(noClaudeTools.tasks[0].agent.opts.tools).toBe("");

        const pi = new PiAgent({ tools: [] });
        const piTools = await render(
            <Task id="pi" output="out" agent={pi} allowTools={["Read"]}>
                prompt
            </Task>,
        );
        expect(piTools.tasks[0].agent.opts.tools).toEqual(["Read"]);
        expect(piTools.tasks[0].agent.opts.noTools).toBe(false);

        const antigravity = new AntigravityAgent();
        const antigravityTools = await render(
            <Task id="antigravity" output="out" agent={antigravity} allowTools={["Read"]}>
                prompt
            </Task>,
        );
        expect(antigravityTools.tasks[0].agent.opts.allowedTools).toEqual(["Read"]);
    });

    test("direct primitives cover remaining declarative branches", async () => {
        expect(forceContinueOnFail("text")).toBe("text");
        const emptyElement = React.createElement("span");
        expect(forceContinueOnFail(emptyElement)).toBe(emptyElement);
        const plainElement = forceContinueOnFail(React.createElement("span", null, "plain"));
        expect(plainElement.type).toBe("span");
        const arrayChild = React.createElement("span");
        const forced = forceContinueOnFail([arrayChild, "plain"]);
        expect(forced[0]).toBe(arrayChild);
        expect(forced[1]).toBe("plain");

        expect(Timer({ id: "skip", duration: "1s", skipIf: true })).toBeNull();
        expect(() => Timer({ id: "bad" })).toThrow("requires exactly one");
        expect(() => Timer({ id: "every", duration: "1s", every: "1m" })).toThrow("does not support");
        const timer = Timer({ id: "until", until: new Date("2026-01-01T00:00:00.000Z"), meta: { owner: "ops" } });
        expect(timer.props.__smithersTimerUntil).toBe("2026-01-01T00:00:00.000Z");

        expect(continueAsNew({ cursor: "abc" }).type).toBe(ContinueAsNew);
        expect(ContinueAsNew({}).props.stateJson).toBeUndefined();

        const saga = Saga({
            id: "declarative",
            children: [
                <Saga.Step
                    key="one"
                    id="one"
                    compensation={<Task id="undo-one" output="out">{{ undone: true }}</Task>}
                >
                    <Task id="do-one" output="out">{{ done: true }}</Task>
                </Saga.Step>,
            ],
        });
        expect(Saga.Step({})).toBeNull();
        expect(saga.props.__sagaSteps).toEqual([{ id: "one", label: undefined }]);
        expect(saga.props.__sagaCompensations.one.props.id).toBe("undo-one");

        const tcf = TryCatchFinally({
            id: "cleanup",
            try: <Task id="try" output="out">{{ ok: true }}</Task>,
            catch: () => null,
            finally: <Task id="finally" output="out">{{ ok: true }}</Task>,
        });
        expect(tcf.props.__tcfCatchHandler).toEqual(expect.any(Function));
        expect(React.Children.toArray(tcf.props.children).some((child) => child.type === "smithers:tcf-finally")).toBe(true);
        const tcfNoFinally = TryCatchFinally({
            id: "no-cleanup",
            try: React.createElement("span"),
        });
        expect(React.Children.toArray(tcfNoFinally.props.children).some((child) => child?.type === "smithers:tcf-finally")).toBe(false);
        const tcfArray = TryCatchFinally({
            id: "array-try",
            try: [
                React.createElement("span", { key: "a" }),
                React.createElement("span", { key: "b" }),
            ],
        });
        expect(tcfArray.props.id).toBe("array-try");

        const drift = await render(
            <DriftDetector id="drift-string" captureAgent={agent} compareAgent={agent} captureOutput="capture" compareOutput="compare" baseline="main" />,
        );
        expect(drift.tasks[1].prompt).toContain("Baseline: main");

        const poller = await render(
            <Poller id="poll-agent" check={agent} checkOutput="check_out" backoff="linear" intervalMs={100}>
                Agent check
            </Poller>,
        );
        expect(poller.tasks[0].timeoutMs).toBe(100);
        expect(poller.tasks[0].agent).toBe(agent);
        const exponentialPoller = await render(
            <Poller id="poll-exp" check={() => ({ satisfied: false })} checkOutput="check_out" backoff="exponential" intervalMs={100} />,
        );
        expect(exponentialPoller.tasks[0].timeoutMs).toBe(100);

        const runbook = await render(
            <Runbook
                id="runbook-defaults"
                defaultAgent={agent}
                stepOutput="step_out"
                steps={[
                    { id: "risk", risk: "risky" },
                    { id: "critical", risk: "critical" },
                ]}
            />,
        );
        expect(runbook.tasks[0].meta.requestSummary).toContain("Risky step requires approval");
        expect(runbook.tasks[2].meta.requestSummary).toContain("CRITICAL step requires elevated approval");
        expect(runbook.tasks[2].meta).toMatchObject({ stepId: "critical", risk: "critical", elevated: true });

        const kanban = Kanban({
            columns: [{ name: "todo", output: "todo_out", agent }],
            useTickets: () => [{ id: "t1" }],
        });
        expect(kanban.props.id).toBe("kanban-loop");

        expect(() =>
            renderToStaticMarkup(
                <Signal id="needs-context" schema={z.object({ ok: z.boolean() })}>
                    {() => <Task id="after-signal" output="out">{{ ok: true }}</Task>}
                </Signal>,
            ),
        ).toThrow("Signal children require a workflow context");
    });

    test("zod examples cover structural fallbacks", () => {
        const fakeSchema = {
            shape: {
                arrayFallback: { _zod: { def: { type: "array" } } },
                enumFallback: { _zod: { def: { type: "enum" } } },
                enumEntries: { _zod: { def: { type: "enum", entries: { first: "first" } } } },
                objectFallback: { _zod: { def: { type: "object" } } },
                customDescription: { _zod: { def: { type: "custom", description: "Custom" } } },
                noDef: {},
            },
        };

        expect(JSON.parse(zodSchemaToJsonExample(fakeSchema))).toEqual({
            arrayFallback: ["value"],
            enumFallback: "enum",
            enumEntries: "first",
            objectFallback: {},
            customDescription: "Custom",
            noDef: "value",
        });
    });

    test("markdown component functions render every mapping", () => {
        for (const [name, Component] of Object.entries(markdownComponents)) {
            const node = Component({
                children: name === "code" ? "const x = 1;" : "text",
                className: name === "code" ? "language-js" : undefined,
                href: "https://example.test",
                alt: "alt",
                src: "image.png",
            });
            expect(React.isValidElement(node)).toBe(true);
        }
        expect(React.isValidElement(markdownComponents.code({ children: "inline" }))).toBe(true);
    });
});
