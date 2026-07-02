// Real HTTP fixture speaking the Telegram Bot API wire format (Bun.serve).
// getUpdates implements real long-poll semantics: `offset` acknowledges and
// discards earlier updates, and the request is held open until updates are
// available or the `timeout` (seconds) elapses. Not a mock of the code under
// test — the real fetch-based client talks to it over real HTTP.

export const FIXTURE_BOT_TOKEN = "424242:TEST-fixture-bot-token";

/**
 * @param {{ token?: string }} [options]
 */
export function startTelegramFixture(options = {}) {
    const token = options.token ?? FIXTURE_BOT_TOKEN;
    /** @type {Array<Record<string, any>>} pending updates (ascending update_id) */
    let updates = [];
    /** @type {Array<{ method: string; body: any; contentType: string }>} */
    const requests = [];
    /** @type {Map<string, Array<{ status?: number; body: any }>>} scripted responses per method */
    const scripted = new Map();
    let nextMessageId = 1000;
    let nextUpdateId = 1;
    const server = Bun.serve({
        port: 0,
        idleTimeout: 30,
        fetch: async (request) => {
            const url = new URL(request.url);
            const match = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
            if (!match) {
                return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
            }
            if (match[1] !== token) {
                return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
            }
            const method = match[2];
            const contentType = request.headers.get("content-type") ?? "";
            /** @type {any} */
            let body = {};
            if (contentType.includes("multipart/form-data")) {
                const form = await request.formData();
                body = {};
                for (const [key, value] of form.entries()) {
                    body[key] = typeof value === "string"
                        ? value
                        : { filename: value.name, size: value.size, type: value.type, text: await value.text() };
                }
            }
            else {
                try {
                    body = await request.json();
                }
                catch {
                    body = {};
                }
            }
            requests.push({ method, body, contentType });
            const queue = scripted.get(method);
            if (queue && queue.length > 0) {
                const next = /** @type {{ status?: number; body: any }} */ (queue.shift());
                return Response.json(next.body, { status: next.status ?? 200 });
            }
            switch (method) {
                case "getUpdates": {
                    // Real semantics: offset acknowledges everything below it.
                    if (typeof body.offset === "number") {
                        updates = updates.filter((update) => update.update_id >= body.offset);
                    }
                    const timeoutMs = Math.max(0, Number(body.timeout ?? 0)) * 1000;
                    const deadline = Date.now() + timeoutMs;
                    while (updates.length === 0 && Date.now() < deadline) {
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    return Response.json({ ok: true, result: [...updates] });
                }
                case "sendMessage": {
                    nextMessageId += 1;
                    return Response.json({
                        ok: true,
                        result: {
                            message_id: nextMessageId,
                            date: Math.floor(Date.now() / 1000),
                            chat: { id: body.chat_id, type: "private" },
                            text: body.text,
                        },
                    });
                }
                case "editMessageText": {
                    return Response.json({
                        ok: true,
                        result: {
                            message_id: body.message_id,
                            chat: { id: body.chat_id, type: "private" },
                            text: body.text,
                            edit_date: Math.floor(Date.now() / 1000),
                        },
                    });
                }
                case "sendDocument": {
                    nextMessageId += 1;
                    return Response.json({
                        ok: true,
                        result: {
                            message_id: nextMessageId,
                            chat: { id: body.chat_id },
                            document: { file_id: `file-${nextMessageId}` },
                        },
                    });
                }
                case "sendChatAction":
                case "answerCallbackQuery": {
                    return Response.json({ ok: true, result: true });
                }
                default:
                    return Response.json({ ok: false, error_code: 404, description: `Unknown method ${method}` }, { status: 404 });
            }
        },
    });
    return {
        token,
        apiBaseUrl: `http://localhost:${server.port}`,
        requests,
        /** Requests for one Bot API method, in arrival order. */
        calls: (/** @type {string} */ method) => requests.filter((entry) => entry.method === method),
        /** Queue a scripted response for the next call to `method`. */
        queueResponse: (/** @type {string} */ method, /** @type {{ status?: number; body: any }} */ response) => {
            const queue = scripted.get(method) ?? [];
            queue.push(response);
            scripted.set(method, queue);
        },
        /** Seed an incoming update (auto-assigns update_id, returns it). */
        pushUpdate: (/** @type {Record<string, any>} */ update) => {
            const withId = { update_id: update.update_id ?? nextUpdateId, ...update };
            nextUpdateId = withId.update_id + 1;
            updates.push(withId);
            updates.sort((a, b) => a.update_id - b.update_id);
            return withId.update_id;
        },
        pendingUpdateCount: () => updates.length,
        stop: () => server.stop(true),
    };
}
