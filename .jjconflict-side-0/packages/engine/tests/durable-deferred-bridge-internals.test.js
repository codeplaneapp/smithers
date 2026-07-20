import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    __durableDeferredBridgeInternals,
    makeDurableDeferredBridgeExecutionId,
} from "../src/effect/durable-deferred-bridge.js";

const {
    buildResolvedWaitForEventMetaJson,
    decrementAsyncEventWaitPending,
    getAdapterNamespace,
    markWaitForEventResolved,
    normalizeCorrelationId,
    parseOptionalFiniteNumber,
    parseWaitForEventAttemptSnapshot,
} = __durableDeferredBridgeInternals;

const signal = {
    signalName: "deploy.ready",
    correlationId: " ticket-42 ",
    payloadJson: "{\"ok\":true}",
    seq: 7,
    receivedAtMs: 1234,
};

function makeAttempt(overrides = {}) {
    return {
        attempt: 1,
        state: "waiting-event",
        metaJson: JSON.stringify({
            waitForEvent: {
                signalName: " deploy.ready ",
                correlationId: " ticket-42 ",
                waitAsync: true,
            },
        }),
        ...overrides,
    };
}

describe("durable deferred bridge internals", () => {
    test("normalizes adapter namespaces and bridge execution ids", () => {
        const fileAdapter = { db: { $client: { filename: "relative.sqlite" } } };
        expect(makeDurableDeferredBridgeExecutionId(fileAdapter, "run", "node", 2)).toContain("sqlite:");

        const memoryAdapter = { db: { $client: { filename: ":memory:" } } };
        expect(getAdapterNamespace(memoryAdapter)).toBe(getAdapterNamespace(memoryAdapter));
        expect(getAdapterNamespace({})).not.toBe(getAdapterNamespace({}));
    });

    test("parses wait-for-event snapshots defensively", () => {
        expect(normalizeCorrelationId(" ticket ")).toBe("ticket");
        expect(normalizeCorrelationId("   ")).toBeNull();
        expect(normalizeCorrelationId(undefined)).toBeNull();

        expect(parseOptionalFiniteNumber(null)).toBeUndefined();
        expect(parseOptionalFiniteNumber("")).toBeUndefined();
        expect(parseOptionalFiniteNumber("9")).toBe(9);
        expect(parseOptionalFiniteNumber("nope")).toBeUndefined();

        expect(parseWaitForEventAttemptSnapshot(null)).toBeNull();
        expect(parseWaitForEventAttemptSnapshot("[]")).toBeNull();
        expect(parseWaitForEventAttemptSnapshot(JSON.stringify({ waitForEvent: [] }))).toBeNull();
        expect(parseWaitForEventAttemptSnapshot(JSON.stringify({ waitForEvent: { signalName: " " } }))).toBeNull();
        expect(parseWaitForEventAttemptSnapshot("{")).toBeNull();

        const snapshot = parseWaitForEventAttemptSnapshot(JSON.stringify({
            extra: true,
            waitForEvent: {
                signalName: " deploy.ready ",
                correlationId: " ticket-42 ",
                waitAsync: true,
                resolvedSignalSeq: "5",
                receivedAtMs: "not finite",
            },
        }));
        expect(snapshot).toEqual(expect.objectContaining({
            signalName: "deploy.ready",
            correlationId: "ticket-42",
            waitAsync: true,
            resolvedSignalSeq: 5,
            receivedAtMs: undefined,
        }));
    });

    test("builds resolved wait-for-event metadata", () => {
        const snapshot = parseWaitForEventAttemptSnapshot(JSON.stringify({
            waitForEvent: {
                signalName: "deploy.ready",
                correlationId: "ticket-42",
                waitAsync: false,
                keep: "value",
            },
        }));
        const meta = JSON.parse(buildResolvedWaitForEventMetaJson(snapshot, signal));
        expect(meta).toEqual({
            kind: "wait-for-event",
            waitForEvent: {
                signalName: "deploy.ready",
                correlationId: "ticket-42",
                waitAsync: false,
                keep: "value",
                resolvedSignalSeq: 7,
                receivedAtMs: 1234,
            },
        });
    });

    test("marks unresolved waiting attempts and leaves completed snapshots alone", async () => {
        const updates = [];
        const adapter = {
            listAttempts: () => Effect.succeed([
                makeAttempt({ attempt: 1, state: "failed" }),
                makeAttempt({ attempt: 2, state: "waiting-event" }),
            ]),
            updateAttempt: (...args) => Effect.sync(() => updates.push(args)),
        };

        await markWaitForEventResolved(adapter, "run", "wait", 0, signal);
        expect(updates).toHaveLength(1);
        expect(updates[0].slice(0, 4)).toEqual(["run", "wait", 0, 2]);
        expect(JSON.parse(updates[0][4].metaJson).waitForEvent).toEqual(expect.objectContaining({
            correlationId: "ticket-42",
            resolvedSignalSeq: 7,
            receivedAtMs: 1234,
        }));

        const noUpdates = [];
        await markWaitForEventResolved({
            listAttempts: () => Effect.succeed([]),
            updateAttempt: (...args) => Effect.sync(() => noUpdates.push(args)),
        }, "run", "wait", 0, signal);
        await markWaitForEventResolved({
            listAttempts: () => Effect.succeed([
                makeAttempt({
                    metaJson: JSON.stringify({
                        waitForEvent: {
                            signalName: "deploy.ready",
                            correlationId: "ticket-42",
                            resolvedSignalSeq: 1,
                        },
                    }),
                }),
            ]),
            updateAttempt: (...args) => Effect.sync(() => noUpdates.push(args)),
        }, "run", "wait", 0, signal);
        expect(noUpdates).toEqual([]);
    });

    test("swallows async wait metric update failures", async () => {
        await expect(decrementAsyncEventWaitPending(() => Effect.fail(new Error("metrics offline")))).resolves.toBeUndefined();
    });
});
