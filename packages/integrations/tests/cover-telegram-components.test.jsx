// Coverage for the Telegram React components: the outbound builder compute
// functions (SendMessage / EditMessage / SendDocument / AnswerCallbackQuery
// children-object overrides + missing-field guards), the listener correlation
// helpers and render-prop, the outbound deps plumbing, and TelegramApproval's
// skip guard. Real renderFrame + real fixture Bot API — no mocks.
//
// NOTE: the outbound compute functions validate their inputs eagerly (before
// building the Effect), so a guard failure throws SYNCHRONOUSLY from the compute
// function rather than returning a rejected promise — the assertions below match
// that real contract.
import { afterAll, describe, expect, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmithers, renderFrame } from "smithers-orchestrator";
import { SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";
import { OnCallbackQuery, OnMessage, OnWebAppData } from "../src/telegram/components/OnMessage.js";
import { listenerCorrelationId } from "../src/telegram/components/listenerInternals.js";
import { resolveOutboundDeps } from "../src/telegram/components/outboundInternals.js";
import { AnswerCallbackQuery, EditMessage, SendDocument, SendMessage, TelegramSendResultSchema } from "../src/telegram/components/SendMessage.js";
import { TelegramApproval, telegramApprovalSchemas } from "../src/telegram/components/TelegramApproval.js";
import { telegramApprovalDecisionSchema } from "../src/telegram/approval.js";
import { startTelegramFixture } from "./telegram-fixture.js";

const fixture = startTelegramFixture();
afterAll(() => fixture.stop());
const telegramConfig = { botToken: fixture.token, apiBaseUrl: fixture.apiBaseUrl };

const NullContext = React.createContext(/** @type {any} */ (null));
const msgSchema = z.object({ text: z.string() }).passthrough();

function makeApi(schemas) {
    const dir = mkdtempSync(join(tmpdir(), "smithers-tgc-cov-"));
    return createSmithers(schemas, { dbPath: join(dir, "db.sqlite") });
}

function render(workflow, ctx) {
    return Effect.runPromise(renderFrame(workflow, new SmithersCtx({
        iteration: 0,
        input: {},
        outputs: {},
        zodToKeyName: workflow.zodToKeyName,
        ...ctx,
    })));
}

describe("listenerCorrelationId", () => {
    test("threadId requires chatId; chat/thread/none shapes", () => {
        expect(() => listenerCorrelationId({ threadId: 5 })).toThrow(/threadId requires chatId/);
        expect(listenerCorrelationId({ chatId: 7, threadId: 5 })).toBe("chat:7:thread:5");
        expect(listenerCorrelationId({ chatId: 7 })).toBe("chat:7");
        expect(listenerCorrelationId({})).toBeUndefined();
    });
});

describe("resolveOutboundDeps", () => {
    test("no deps resolves to an empty bag without touching the ctx", () => {
        const resolved = resolveOutboundDeps(null, undefined, undefined);
        expect(Object.keys(/** @type {any} */ (resolved))).toEqual([]);
    });
});

describe("telegram listeners", () => {
    test("OnMessage / edited / OnWebAppData / OnCallbackQuery signals and skipIf", async () => {
        const { smithers, Workflow } = makeApi({ msg: msgSchema });
        const workflow = smithers(() => React.createElement(Workflow, { name: "tg-listen" },
            React.createElement(OnMessage, { id: "m1", chatId: 777, schema: msgSchema }),
            React.createElement(OnMessage, { id: "m2", edited: true, chatId: 777, threadId: 5, schema: msgSchema }),
            React.createElement(OnWebAppData, { id: "w", chatId: 777, schema: msgSchema }),
            React.createElement(OnCallbackQuery, { id: "skipped", skipIf: true, chatId: 777, schema: msgSchema })));
        const frame = await render(workflow, { runId: "tg-listen" });
        const byId = Object.fromEntries(frame.tasks.map((task) => [task.nodeId, task]));
        expect(byId["m1"].meta.__eventName).toBe("integration:telegram:message");
        expect(byId["m1"].meta.__correlationId).toBe("chat:777");
        expect(byId["m2"].meta.__eventName).toBe("integration:telegram:edited_message");
        expect(byId["m2"].meta.__correlationId).toBe("chat:777:thread:5");
        expect(byId["w"].meta.__eventName).toBe("integration:telegram:web_app_data");
        expect(byId["skipped"]).toBeUndefined();
    });

    test("a listener render-prop fires with the parsed payload once the row exists", async () => {
        const { smithers, Workflow } = makeApi({ msg: msgSchema });
        /** @type {any[]} */
        const seen = [];
        const workflow = smithers(() => React.createElement(Workflow, { name: "tg-listen-children" },
            React.createElement(OnMessage, {
                id: "m",
                chatId: 777,
                schema: msgSchema,
                children: (payload) => {
                    seen.push(payload);
                    return null;
                },
            })));
        const frame = await render(workflow, {
            runId: "tg-listen-children",
            outputs: { msg: [{ runId: "tg-listen-children", nodeId: "m", iteration: 0, text: "hello" }] },
        });
        expect(frame.tasks.find((t) => t.nodeId === "m")).toBeDefined();
        expect(seen[0].text).toBe("hello");
    });

    test("a listener render-prop renders only the wait node while the row is absent", async () => {
        const { smithers, Workflow } = makeApi({ msg: msgSchema });
        let called = false;
        const workflow = smithers(() => React.createElement(Workflow, { name: "tg-listen-wait" },
            React.createElement(OnMessage, {
                id: "m",
                chatId: 777,
                schema: msgSchema,
                children: () => {
                    called = true;
                    return null;
                },
            })));
        await render(workflow, { runId: "tg-listen-wait" });
        expect(called).toBe(false);
    });

    test("listener children without a workflow context is rejected loudly", async () => {
        const { smithers, Workflow } = makeApi({ msg: msgSchema });
        const workflow = smithers(() => React.createElement(Workflow, { name: "tg-no-ctx" }, React.createElement(OnMessage, {
            id: "m",
            chatId: 777,
            schema: msgSchema,
            smithersContext: NullContext,
            children: () => null,
        })));
        await expect(render(workflow, { runId: "tg-no-ctx" })).rejects.toThrow(/workflow context/);
    });
});

describe("outbound guards", () => {
    test("skipIf renders nothing", async () => {
        const { smithers, Workflow, outputs } = makeApi({ sent: TelegramSendResultSchema });
        const workflow = smithers(() => React.createElement(Workflow, { name: "tg-skip" }, React.createElement(SendMessage, {
            id: "send",
            skipIf: true,
            chatId: 777,
            text: "never",
            config: telegramConfig,
            output: outputs.sent,
        })));
        const frame = await render(workflow, { runId: "tg-skip" });
        expect(frame.tasks).toHaveLength(0);
    });
    test("deps without a workflow context is rejected loudly", async () => {
        const { smithers, Workflow, outputs } = makeApi({
            sent: TelegramSendResultSchema,
            note: z.object({ text: z.string() }),
        });
        const workflow = smithers(() => React.createElement(Workflow, { name: "tg-deps-no-ctx" }, React.createElement(SendMessage, {
            id: "send",
            chatId: 777,
            config: telegramConfig,
            deps: { note: outputs.note },
            smithersContext: NullContext,
            output: outputs.sent,
            children: () => "x",
        })));
        await expect(render(workflow, { runId: "tg-deps-no-ctx" })).rejects.toThrow(/deps require a workflow context/);
    });
    test("deps that are not yet ready defer (render nothing)", async () => {
        const { smithers, Workflow, outputs } = makeApi({
            sent: TelegramSendResultSchema,
            note: z.object({ text: z.string() }),
        });
        const workflow = smithers(() => React.createElement(Workflow, { name: "tg-deps-defer" }, React.createElement(SendMessage, {
            id: "send",
            chatId: 777,
            config: telegramConfig,
            deps: { note: outputs.note },
            output: outputs.sent,
            children: (deps) => `Reply: ${deps.note.text}`,
        })));
        const frame = await render(workflow, { runId: "tg-deps-defer" });
        expect(frame.tasks.find((t) => t.nodeId === "send")).toBeUndefined();
    });
});

describe("outbound builders (compute functions against the real fixture)", () => {
    async function computeFns() {
        const { smithers, Workflow, outputs } = makeApi({
            sent: TelegramSendResultSchema,
            misc: z.object({ note: z.string() }),
        });
        const workflow = smithers(() => React.createElement(Workflow, { name: "tg-outbound" },
            React.createElement(SendMessage, { id: "send-obj", chatId: 777, config: telegramConfig, output: outputs.sent, children: () => ({ text: "from children", parseMode: "none", typing: false }) }),
            React.createElement(SendMessage, { id: "send-bad", chatId: 777, config: telegramConfig, output: outputs.sent, children: () => /** @type {any} */ (42) }),
            React.createElement(SendMessage, { id: "send-missing", chatId: 777, config: telegramConfig, output: outputs.sent }),
            React.createElement(EditMessage, { id: "edit-props", chatId: 777, messageId: 555, text: "edited text", parseMode: "none", config: telegramConfig, output: outputs.misc }),
            React.createElement(EditMessage, { id: "edit-children", chatId: 777, config: telegramConfig, output: outputs.misc, children: () => ({ text: "via children", messageId: 556, parseMode: "none" }) }),
            React.createElement(EditMessage, { id: "edit-missing", chatId: 777, text: "no message id", config: telegramConfig, output: outputs.misc }),
            React.createElement(SendDocument, { id: "doc-props", chatId: 777, document: "https://files.example/report.pdf", caption: "the report", config: telegramConfig, output: outputs.misc }),
            React.createElement(SendDocument, { id: "doc-missing", chatId: 777, config: telegramConfig, output: outputs.misc }),
            React.createElement(AnswerCallbackQuery, { id: "acq-props", callbackQueryId: "cbq-9", text: "done", config: telegramConfig, output: outputs.misc }),
            React.createElement(AnswerCallbackQuery, { id: "acq-missing", config: telegramConfig, output: outputs.misc })));
        const frame = await render(workflow, { runId: "tg-outbound" });
        /** @type {Record<string, () => Promise<any>>} */
        const fns = {};
        for (const task of frame.tasks) {
            expect(task.kind).toBe("compute");
            fns[task.nodeId] = /** @type {() => Promise<any>} */ (task.computeFn);
        }
        return fns;
    }

    test("children-object overrides, missing-field guards, and each Bot API call", async () => {
        const fns = await computeFns();
        // SendMessage with an options-object children return.
        const sent = await fns["send-obj"]();
        expect(sent).toMatchObject({ chatId: "777", chunkCount: 1 });
        expect(fixture.calls("sendMessage").at(-1)?.body).toMatchObject({ chat_id: 777, text: "from children" });
        // Guard failures throw synchronously (validated before the Effect builds).
        expect(() => fns["send-bad"]()).toThrow(/must return a string or an options object/);
        expect(() => fns["send-missing"]()).toThrow(/requires message text/);
        // EditMessage from props and from children.
        await fns["edit-props"]();
        expect(fixture.calls("editMessageText").at(-1)?.body).toMatchObject({ chat_id: 777, message_id: 555, text: "edited text" });
        await fns["edit-children"]();
        expect(fixture.calls("editMessageText").at(-1)?.body).toMatchObject({ message_id: 556, text: "via children" });
        expect(() => fns["edit-missing"]()).toThrow(/requires text and messageId/);
        // SendDocument via URL (JSON path).
        await fns["doc-props"]();
        expect(fixture.calls("sendDocument").at(-1)?.body).toMatchObject({
            chat_id: 777,
            document: "https://files.example/report.pdf",
            caption: "the report",
        });
        expect(() => fns["doc-missing"]()).toThrow(/requires a document/);
        // AnswerCallbackQuery.
        const answered = await fns["acq-props"]();
        expect(answered).toBe(true);
        expect(fixture.calls("answerCallbackQuery").at(-1)?.body).toMatchObject({ callback_query_id: "cbq-9", text: "done" });
        expect(() => fns["acq-missing"]()).toThrow(/requires callbackQueryId/);
    }, 20_000);
});

describe("TelegramApproval skip guard", () => {
    test("skipIf renders nothing", async () => {
        const { smithers, Workflow, outputs } = makeApi({
            ...telegramApprovalSchemas,
            decision: telegramApprovalDecisionSchema,
        });
        const workflow = smithers(() => React.createElement(Workflow, { name: "tg-approval-skip" }, React.createElement(TelegramApproval, {
            id: "gate",
            skipIf: true,
            chatId: 777,
            config: telegramConfig,
            request: { title: "Skip me" },
            output: outputs.decision,
        })));
        const frame = await render(workflow, { runId: "tg-approval-skip" });
        expect(frame.tasks).toHaveLength(0);
    });
});
