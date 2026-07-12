import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { executeRequest } from "../src/tool-factory/_helpers.js";

const originalFetch = globalThis.fetch;
const originalStreamCancel = ReadableStream.prototype.cancel;
const originalReaderCancel = ReadableStreamDefaultReader.prototype.cancel;

/**
 * @param {string} mediaType
 * @returns {import("../src/ParsedOperation.ts").ParsedOperation}
 */
function operationFor(mediaType) {
    return {
        operationId: "sendBody",
        method: "post",
        path: "/body",
        summary: "",
        description: "",
        parameters: [],
        requestBody: {},
        requestBodyMediaType: mediaType,
        deprecated: false,
    };
}

const baseOptions = {
    baseUrl: "https://api.example.com",
    resolveHostname: async () => ["8.8.8.8"],
};

describe("OpenAPI outbound request byte limits", () => {
    let fetchMock;

    beforeEach(() => {
        fetchMock = mock(async () => new Response("ok", {
            status: 200,
            headers: { "content-type": "text/plain" },
        }));
        globalThis.fetch = fetchMock;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        ReadableStream.prototype.cancel = originalStreamCancel;
        ReadableStreamDefaultReader.prototype.cancel = originalReaderCancel;
    });

    test("rejects an invalid maxRequestBytes option before transport", async () => {
        await expect(executeRequest(
            operationFor("text/plain"),
            { body: "ok" },
            baseOptions.baseUrl,
            { ...baseOptions, maxRequestBytes: -1 },
        )).rejects.toMatchObject({
            code: "INVALID_OPTION",
            details: { option: "maxRequestBytes" },
        });
        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    test("rejects an invalid maxResponseBytes option before transport", async () => {
        await expect(executeRequest(
            operationFor("text/plain"),
            { body: "ok" },
            baseOptions.baseUrl,
            { ...baseOptions, maxResponseBytes: -1 },
        )).rejects.toMatchObject({
            code: "INVALID_OPTION",
            details: { option: "maxResponseBytes" },
        });
        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    test("rejects a declared Content-Length above the cap before serialization or transport", async () => {
        await expect(executeRequest(
            operationFor("text/plain"),
            { body: "ok" },
            baseOptions.baseUrl,
            {
                ...baseOptions,
                headers: { "content-length": "11" },
                maxRequestBytes: 10,
            },
        )).rejects.toMatchObject({
            code: "REQUEST_TOO_LARGE",
            details: { contentLength: 11, maxRequestBytes: 10 },
        });
        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    test.each([
        ["serialized JSON", "application/json", { value: "123456" }, 8],
        ["URL encoding", "application/x-www-form-urlencoded", { value: "a b" }, 8],
        ["raw UTF-8 text", "text/plain", "12345", 4],
        ["raw bytes", "application/octet-stream", new ArrayBuffer(5), 4],
    ])("rejects %s overflow before transport", async (_label, mediaType, body, limit) => {
        await expect(executeRequest(
            operationFor(mediaType),
            { body },
            baseOptions.baseUrl,
            { ...baseOptions, maxRequestBytes: limit },
        )).rejects.toMatchObject({
            code: "REQUEST_TOO_LARGE",
            details: { maxRequestBytes: limit },
        });
        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    test("rejects aggregate multipart wire bytes even when every part fits individually", async () => {
        await expect(executeRequest(
            operationFor("multipart/form-data"),
            { body: { first: "1234", second: "5678" } },
            baseOptions.baseUrl,
            { ...baseOptions, maxRequestBytes: 8 },
        )).rejects.toMatchObject({
            code: "REQUEST_TOO_LARGE",
            details: { maxRequestBytes: 8 },
        });
        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    test("multipart overflow does not await a hostile reader cancellation", async () => {
        let cancelled = false;
        ReadableStreamDefaultReader.prototype.cancel = function () {
            cancelled = true;
            return new Promise(() => {});
        };
        await expect(Promise.race([
            executeRequest(
                operationFor("multipart/form-data"),
                { body: { first: "1234", second: "5678" } },
                baseOptions.baseUrl,
                { ...baseOptions, maxRequestBytes: 8 },
            ),
            Bun.sleep(500).then(() => { throw new Error("multipart limit awaited cancellation"); }),
        ])).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
        expect(cancelled).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    test("an already-aborted multipart request does not await stream cancellation", async () => {
        let cancelled = false;
        ReadableStream.prototype.cancel = function () {
            cancelled = true;
            return new Promise(() => {});
        };
        const controller = new AbortController();
        const reason = new DOMException("cancelled before encoding", "AbortError");
        controller.abort(reason);
        await expect(Promise.race([
            executeRequest(
                operationFor("multipart/form-data"),
                { body: { field: "value" } },
                baseOptions.baseUrl,
                { ...baseOptions, maxRequestBytes: 1024 },
                controller.signal,
            ),
            Bun.sleep(500).then(() => { throw new Error("multipart abort awaited cancellation"); }),
        ])).rejects.toBe(reason);
        expect(cancelled).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    test("rejects an oversized multipart Blob from its declared size before encoding", async () => {
        await expect(executeRequest(
            operationFor("multipart/form-data"),
            { body: { file: new Blob(["12345"]) } },
            baseOptions.baseUrl,
            { ...baseOptions, maxRequestBytes: 4 },
        )).rejects.toMatchObject({
            code: "REQUEST_TOO_LARGE",
            details: { maxRequestBytes: 4, serializedBytes: 5 },
        });
        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    test("accepts the complete multipart wire representation at the exact cap", async () => {
        const observedBytes = [];
        fetchMock = mock(async (_url, init) => {
            observedBytes.push((await new Response(init.body).arrayBuffer()).byteLength);
            return new Response("ok", {
                status: 200,
                headers: { "content-type": "text/plain" },
            });
        });
        globalThis.fetch = fetchMock;
        const operation = operationFor("multipart/form-data");
        const args = { body: { file: new Blob(["contents"]), purpose: "avatar" } };

        await executeRequest(operation, args, baseOptions.baseUrl, {
            ...baseOptions,
            maxRequestBytes: 1024,
        });
        const exactWireBytes = observedBytes[0];

        await expect(executeRequest(operation, args, baseOptions.baseUrl, {
            ...baseOptions,
            maxRequestBytes: exactWireBytes,
        })).resolves.toBe("ok");
        expect(observedBytes).toEqual([exactWireBytes, exactWireBytes]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test.each([307, 308])(
        "replays identical buffered multipart bytes and headers across a safe %i redirect",
        async (status) => {
            const observed = [];
            fetchMock = mock(async (url, init) => {
                observed.push({
                    url: String(url),
                    contentType: new Headers(init.headers).get("content-type"),
                    body: new Uint8Array(await new Response(init.body).arrayBuffer()),
                    bodyType: init.body?.constructor?.name,
                });
                if (observed.length === 1) {
                    return new Response(null, {
                        status,
                        headers: { location: "/body-after-redirect" },
                    });
                }
                return new Response("ok", {
                    status: 200,
                    headers: { "content-type": "text/plain" },
                });
            });
            globalThis.fetch = fetchMock;

            await expect(executeRequest(
                operationFor("multipart/form-data"),
                { body: { file: new Blob(["contents"]), purpose: "avatar" } },
                baseOptions.baseUrl,
                { ...baseOptions, maxRequestBytes: 1024 },
            )).resolves.toBe("ok");

            expect(observed).toHaveLength(2);
            expect(observed[0].url).toBe("https://api.example.com/body");
            expect(observed[1].url).toBe("https://api.example.com/body-after-redirect");
            expect(observed[0].contentType).toMatch(/^multipart\/form-data;\s*boundary=.+$/i);
            expect(observed[1].contentType).toBe(observed[0].contentType);
            expect(observed[0].bodyType).toBe("Uint8Array");
            expect(observed[1].bodyType).toBe("Uint8Array");
            expect(observed[1].body).toEqual(observed[0].body);
        },
    );

    test.each([
        ["serialized JSON", "application/json", { ok: true }, '{"ok":true}'.length],
        ["URL encoding", "application/x-www-form-urlencoded", { value: "a b" }, "value=a+b".length],
        ["raw UTF-8 text", "text/plain", "é", 2],
        ["raw bytes", "application/octet-stream", new ArrayBuffer(4), 4],
    ])("accepts %s at the exact cap", async (_label, mediaType, body, limit) => {
        await expect(executeRequest(
            operationFor(mediaType),
            { body },
            baseOptions.baseUrl,
            { ...baseOptions, maxRequestBytes: limit },
        )).resolves.toBe("ok");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
