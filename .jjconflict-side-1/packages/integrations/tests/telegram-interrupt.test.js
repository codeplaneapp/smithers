// Fiber-interruption tests against real delayed HTTP servers (Bun.serve).
// Interrupting a fiber that is waiting on the Telegram Bot API must abort the
// in-flight HTTP request — and any pending response-body read — promptly,
// instead of leaving the exchange running in the background. Not a mock: the
// real fetch-based client talks to a real server over real HTTP; the server
// only *delays*, and the test observes the client-side disconnect.
import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { makeTelegramClient } from "../src/telegram/TelegramClient.js";

const BOT_TOKEN = "424242:TEST-interrupt-bot-token";
/** How quickly the server must observe the disconnect after the interrupt. */
const PROMPT_MS = 2_000;

/** @param {number} port */
function makeClient(port) {
    return makeTelegramClient({ botToken: BOT_TOKEN, apiBaseUrl: `http://localhost:${port}` });
}

describe("TelegramClient fiber interruption", () => {
    test("interrupting mid-request aborts the in-flight HTTP request", async () => {
        const arrived = Promise.withResolvers();
        /** @type {PromiseWithResolvers<number>} */
        const aborted = Promise.withResolvers();
        // Real server that holds the response open until the client aborts
        // (or a 15s safety timeout, far beyond the promptness bound).
        const server = Bun.serve({
            port: 0,
            idleTimeout: 30,
            fetch: async (request) => {
                arrived.resolve(undefined);
                await new Promise((resolve) => {
                    request.signal.addEventListener("abort", () => {
                        aborted.resolve(Date.now());
                        resolve(undefined);
                    }, { once: true });
                    setTimeout(resolve, 15_000);
                });
                return Response.json({ ok: true, result: true });
            },
        });
        try {
            const fiber = Effect.runFork(makeClient(server.port).call("getMe"));
            await arrived.promise;
            const interruptedAt = Date.now();
            await Effect.runPromise(Fiber.interrupt(fiber));
            const abortedAt = await Promise.race([
                aborted.promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error("server never observed the request abort")), 5_000)),
            ]);
            expect(abortedAt - interruptedAt).toBeLessThan(PROMPT_MS);
        }
        finally {
            server.stop(true);
        }
    }, 20_000);
    test("interrupting mid-body-read cancels response consumption with the request", async () => {
        const bodyStarted = Promise.withResolvers();
        /** @type {PromiseWithResolvers<number>} */
        const cancelled = Promise.withResolvers();
        // Real server that sends headers plus a partial JSON body immediately,
        // then stalls the body forever — the client's fetch resolves and it
        // hangs inside response.json() until the exchange is torn down.
        const server = Bun.serve({
            port: 0,
            idleTimeout: 30,
            fetch: (request) => {
                request.signal.addEventListener("abort", () => cancelled.resolve(Date.now()), { once: true });
                const stream = new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('{"ok":true,"result":'));
                        bodyStarted.resolve(undefined);
                    },
                    cancel() {
                        cancelled.resolve(Date.now());
                    },
                });
                return new Response(stream, { headers: { "content-type": "application/json" } });
            },
        });
        try {
            const fiber = Effect.runFork(makeClient(server.port).call("getMe"));
            await bodyStarted.promise;
            // Let the client's fetch step complete so the fiber is parked in
            // the response.json() body read when the interrupt lands.
            await new Promise((resolve) => setTimeout(resolve, 100));
            const interruptedAt = Date.now();
            await Effect.runPromise(Fiber.interrupt(fiber));
            const cancelledAt = await Promise.race([
                cancelled.promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error("server never observed the body-read cancellation")), 5_000)),
            ]);
            expect(cancelledAt - interruptedAt).toBeLessThan(PROMPT_MS);
        }
        finally {
            server.stop(true);
        }
    }, 20_000);
});
