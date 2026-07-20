// Full inbound pipeline: real fixture Bot API server → makeTelegramSource
// long-poll → makeIntegrationRuntime supervision → deliverEvents dedupe →
// signalRun row on a run seeded exactly the way the engine parks a
// WaitForEvent (see helpers.seedWaitingEventRun).
import { describe, expect, test } from "bun:test";
import { Schedule } from "effect";
import { makeDbCursorStore } from "../src/core/CursorStore.js";
import { makeIntegrationRuntime } from "../src/core/IntegrationRuntime.js";
import { makeTelegramSource, TELEGRAM_CALLBACK_QUERY_EVENT, TELEGRAM_MESSAGE_EVENT } from "../src/telegram/TelegramSource.js";
import { createTestAdapter, seedWaitingEventRun } from "./helpers.js";
import { startTelegramFixture } from "./telegram-fixture.js";

/**
 * @param {() => Promise<boolean>} probe
 */
async function waitFor(probe, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await probe()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
}

describe("telegram end-to-end delivery pipeline", () => {
    test("update arrives → waiting run gets the signal row; redelivery is deduped", async () => {
        const fixture = startTelegramFixture();
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, {
            runId: "run-chat",
            signalName: TELEGRAM_MESSAGE_EVENT,
            correlationId: "chat:99",
        });
        await seedWaitingEventRun(adapter, {
            runId: "run-other-chat",
            signalName: TELEGRAM_MESSAGE_EVENT,
            correlationId: "chat:1234",
        });
        const source = makeTelegramSource({
            botToken: fixture.token,
            apiBaseUrl: fixture.apiBaseUrl,
            pollTimeoutSeconds: 1,
            schedule: Schedule.spaced("20 millis"),
            cursorStore: makeDbCursorStore(adapter),
        });
        const runtime = makeIntegrationRuntime({ adapter, sources: [source] });
        try {
            fixture.pushUpdate({
                message: {
                    message_id: 501,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: 99, type: "private" },
                    from: { id: 7, first_name: "Will" },
                    text: "wake up",
                },
            });
            expect(await waitFor(async () => (await adapter.listSignals("run-chat", { signalName: TELEGRAM_MESSAGE_EVENT })).length > 0)).toBe(true);
            const signals = await adapter.listSignals("run-chat", { signalName: TELEGRAM_MESSAGE_EVENT });
            expect(signals).toHaveLength(1);
            expect(signals[0].correlationId).toBe("chat:99");
            expect(signals[0].receivedBy).toBe("integration:telegram");
            const payload = JSON.parse(signals[0].payloadJson);
            expect(payload).toMatchObject({ message_id: 501, text: "wake up" });
            expect(payload.chat.id).toBe(99);
            // The other chat's run must not have been woken.
            expect(await adapter.listSignals("run-other-chat", { signalName: TELEGRAM_MESSAGE_EVENT })).toHaveLength(0);
            // Long-polling keeps running; give it a beat and confirm the same
            // update is never double-delivered (offset ack + dedupe table).
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(await adapter.listSignals("run-chat", { signalName: TELEGRAM_MESSAGE_EVENT })).toHaveLength(1);
        }
        finally {
            await runtime.shutdown();
            fixture.stop();
        }
    }, 15_000);
    test("thread-scoped and chat-scoped waits both wake from one topical update", async () => {
        const fixture = startTelegramFixture();
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, {
            runId: "run-chat-level",
            signalName: TELEGRAM_MESSAGE_EVENT,
            correlationId: "chat:50",
        });
        await seedWaitingEventRun(adapter, {
            runId: "run-thread-level",
            signalName: TELEGRAM_MESSAGE_EVENT,
            correlationId: "chat:50:thread:8",
        });
        const runtime = makeIntegrationRuntime({
            adapter,
            sources: [
                makeTelegramSource({
                    botToken: fixture.token,
                    apiBaseUrl: fixture.apiBaseUrl,
                    pollTimeoutSeconds: 1,
                    schedule: Schedule.spaced("20 millis"),
                    cursorStore: makeDbCursorStore(adapter),
                }),
            ],
        });
        try {
            fixture.pushUpdate({
                message: {
                    message_id: 601,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: 50, type: "supergroup" },
                    is_topic_message: true,
                    message_thread_id: 8,
                    text: "topic ping",
                },
            });
            expect(await waitFor(async () => (await adapter.listSignals("run-chat-level", { signalName: TELEGRAM_MESSAGE_EVENT })).length > 0 &&
                (await adapter.listSignals("run-thread-level", { signalName: TELEGRAM_MESSAGE_EVENT })).length > 0)).toBe(true);
            const threadSignals = await adapter.listSignals("run-thread-level", { signalName: TELEGRAM_MESSAGE_EVENT });
            expect(threadSignals[0].correlationId).toBe("chat:50:thread:8");
        }
        finally {
            await runtime.shutdown();
            fixture.stop();
        }
    }, 15_000);
    test("callback queries wake runs waiting on integration:telegram:callback_query", async () => {
        const fixture = startTelegramFixture();
        const { adapter } = createTestAdapter();
        await seedWaitingEventRun(adapter, {
            runId: "run-cb",
            signalName: TELEGRAM_CALLBACK_QUERY_EVENT,
            correlationId: "chat:75",
        });
        const runtime = makeIntegrationRuntime({
            adapter,
            sources: [
                makeTelegramSource({
                    botToken: fixture.token,
                    apiBaseUrl: fixture.apiBaseUrl,
                    pollTimeoutSeconds: 1,
                    schedule: Schedule.spaced("20 millis"),
                    cursorStore: makeDbCursorStore(adapter),
                }),
            ],
        });
        try {
            fixture.pushUpdate({
                callback_query: {
                    id: "cbq-1",
                    from: { id: 7 },
                    data: "approve",
                    message: { message_id: 700, date: 1, chat: { id: 75, type: "private" } },
                },
            });
            expect(await waitFor(async () => (await adapter.listSignals("run-cb", { signalName: TELEGRAM_CALLBACK_QUERY_EVENT })).length > 0)).toBe(true);
            const signals = await adapter.listSignals("run-cb", { signalName: TELEGRAM_CALLBACK_QUERY_EVENT });
            expect(JSON.parse(signals[0].payloadJson)).toMatchObject({ id: "cbq-1", data: "approve" });
        }
        finally {
            await runtime.shutdown();
            fixture.stop();
        }
    }, 15_000);
});
