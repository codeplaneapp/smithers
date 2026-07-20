// ---------------------------------------------------------------------------
// Coverage for previously-untested-but-correct behavior:
//   - PUT / PATCH extraction + execution (method casing, body serialization)
//   - head / options / trace operations are silently dropped
//   - Pre-loaded spec object missing the 'openapi' field is rejected (both
//     loaders) with the Swagger-2.0 guidance message
//   - Non-object / non-array request body serialization fallbacks
//     (multipart array fields, urlencoded array fields, raw octet-stream/csv)
// ---------------------------------------------------------------------------
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Effect } from "effect";
import { createOpenApiToolsSync, listOperations } from "../src/tool-factory.js";
import { extractOperations } from "../src/extractOperations.js";
import { loadSpecSync } from "../src/loadSpecSync.js";
import { loadSpecEffect } from "../src/loadSpecEffect.js";
import { isSmithersError } from "@smithers-orchestrator/errors/isSmithersError";

const originalFetch = globalThis.fetch;

const putPatchSpec = {
    openapi: "3.0.0",
    info: { title: "Update API", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
        "/pets/{id}": {
            put: {
                operationId: "replacePet",
                parameters: [
                    { name: "id", in: "path", required: true, schema: { type: "string" } },
                ],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["name"],
                                properties: { name: { type: "string" } },
                            },
                        },
                    },
                },
                responses: { "200": { description: "replaced" } },
            },
            patch: {
                operationId: "updatePet",
                parameters: [
                    { name: "id", in: "path", required: true, schema: { type: "string" } },
                ],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                properties: { tag: { type: "string" } },
                            },
                        },
                    },
                },
                responses: { "200": { description: "patched" } },
            },
        },
    },
};

describe("PUT / PATCH extraction and execution", () => {
    let mockFetch;
    beforeEach(() => {
        mockFetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            ),
        );
        globalThis.fetch = mockFetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test("extractOperations surfaces put and patch operations", () => {
        const ops = extractOperations(putPatchSpec);
        const byId = Object.fromEntries(ops.map((o) => [o.operationId, o]));
        expect(byId.replacePet.method).toBe("put");
        expect(byId.updatePet.method).toBe("patch");
    });

    test("listOperations reports PUT/PATCH method casing", () => {
        const ops = listOperations(putPatchSpec);
        const byId = Object.fromEntries(ops.map((o) => [o.operationId, o]));
        expect(byId.replacePet.method).toBe("PUT");
        expect(byId.updatePet.method).toBe("PATCH");
    });

    test("PUT executes with method PUT, JSON body, and substituted path param", async () => {
        const tools = createOpenApiToolsSync(putPatchSpec);
        await tools.replacePet.execute({ id: "abc", body: { name: "Rex" } });
        const [url, init] = mockFetch.mock.calls[0];
        expect(init.method).toBe("PUT");
        expect(init.body).toBe(JSON.stringify({ name: "Rex" }));
        expect(url).toContain("/pets/abc");
    });

    test("PATCH executes with method PATCH and JSON body", async () => {
        const tools = createOpenApiToolsSync(putPatchSpec);
        await tools.updatePet.execute({ id: "abc", body: { tag: "good" } });
        const [url, init] = mockFetch.mock.calls[0];
        expect(init.method).toBe("PATCH");
        expect(init.body).toBe(JSON.stringify({ tag: "good" }));
        expect(url).toContain("/pets/abc");
    });
});

describe("head / options / trace operations are dropped", () => {
    test("a spec whose only operation is head produces no operations or tools", () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "Head Only", version: "1.0.0" },
            servers: [{ url: "https://api.example.com" }],
            paths: {
                "/status": {
                    head: { operationId: "headStatus", responses: { "200": { description: "ok" } } },
                    options: { operationId: "optionsStatus", responses: { "200": { description: "ok" } } },
                    trace: { operationId: "traceStatus", responses: { "200": { description: "ok" } } },
                },
            },
        };
        expect(extractOperations(spec)).toEqual([]);
        expect(createOpenApiToolsSync(spec)).toEqual({});
    });

    test("a path with both get and head surfaces only the get-derived tool", () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "Get+Head", version: "1.0.0" },
            servers: [{ url: "https://api.example.com" }],
            paths: {
                "/status": {
                    get: { operationId: "getStatus", responses: { "200": { description: "ok" } } },
                    head: { operationId: "headStatus", responses: { "200": { description: "ok" } } },
                },
            },
        };
        const tools = createOpenApiToolsSync(spec);
        expect(Object.keys(tools)).toEqual(["getStatus"]);
    });
});

describe("pre-loaded spec object missing the 'openapi' field is rejected", () => {
    test("loadSpecSync throws the Swagger-2.0 guidance message", () => {
        expect(() => loadSpecSync({ swagger: "2.0", paths: {} })).toThrow(
            /missing an 'openapi' field/,
        );
    });

    test("loadSpecSync rejects any plain object lacking openapi", () => {
        expect(() => loadSpecSync({ paths: {} })).toThrow(/missing an 'openapi' field/);
    });

    test("loadSpecEffect FAILS (does not throw synchronously) with a SmithersError", async () => {
        // Constructing the Effect must not throw synchronously — that would
        // break Effect callers. The failure surfaces only on execution.
        const effect = loadSpecEffect({ swagger: "2.0", paths: {} });
        const exit = await Effect.runPromiseExit(effect);
        expect(exit._tag).toBe("Failure");
        const result = await Effect.runPromise(Effect.flip(effect));
        expect(isSmithersError(result)).toBe(true);
        expect(/** @type {Error} */ (result).message).toMatch(/missing an 'openapi' field/);
        expect(/** @type {{ details?: { operation?: string } }} */ (result).details?.operation).toBe(
            "openapi load spec",
        );
    });

    test("loadSpecEffect rejects via runPromise with the guidance message", async () => {
        await expect(
            Effect.runPromise(loadSpecEffect({ swagger: "2.0", paths: {} })),
        ).rejects.toThrow(/missing an 'openapi' field/);
    });
});

describe("request body serialization fallbacks", () => {
    let mockFetch;
    beforeEach(() => {
        mockFetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            ),
        );
        globalThis.fetch = mockFetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test("multipart array property appends one form entry per item", async () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "Multipart Array", version: "1.0.0" },
            servers: [{ url: "https://api.example.com" }],
            paths: {
                "/uploads": {
                    post: {
                        operationId: "upload",
                        requestBody: {
                            required: true,
                            content: {
                                "multipart/form-data": {
                                    schema: {
                                        type: "object",
                                        properties: {
                                            tags: { type: "array", items: { type: "string" } },
                                        },
                                    },
                                },
                            },
                        },
                        responses: { "200": { description: "ok" } },
                    },
                },
            },
        };
        const tools = createOpenApiToolsSync(spec);
        await tools.upload.execute({ body: { tags: ["a", "b"] } });
        const [, init] = mockFetch.mock.calls[0];
        expect(init.body).toBeInstanceOf(FormData);
        expect(init.body.getAll("tags")).toEqual(["a", "b"]);
    });

    test("urlencoded array property repeats the key per item", async () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "Urlencoded Array", version: "1.0.0" },
            servers: [{ url: "https://api.example.com" }],
            paths: {
                "/subscribe": {
                    post: {
                        operationId: "subscribe",
                        requestBody: {
                            required: true,
                            content: {
                                "application/x-www-form-urlencoded": {
                                    schema: {
                                        type: "object",
                                        properties: {
                                            topics: { type: "array", items: { type: "string" } },
                                        },
                                    },
                                },
                            },
                        },
                        responses: { "200": { description: "ok" } },
                    },
                },
            },
        };
        const tools = createOpenApiToolsSync(spec);
        await tools.subscribe.execute({ body: { topics: ["x", "y"] } });
        const [, init] = mockFetch.mock.calls[0];
        expect(init.body).toBeInstanceOf(URLSearchParams);
        expect(init.body.getAll("topics")).toEqual(["x", "y"]);
    });

    test("raw octet-stream string body is sent verbatim (not JSON-quoted)", async () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "Raw", version: "1.0.0" },
            servers: [{ url: "https://api.example.com" }],
            paths: {
                "/blobs": {
                    post: {
                        operationId: "putBlob",
                        requestBody: {
                            required: true,
                            content: {
                                "application/octet-stream": {
                                    schema: { type: "string", format: "binary" },
                                },
                            },
                        },
                        responses: { "200": { description: "ok" } },
                    },
                },
            },
        };
        const tools = createOpenApiToolsSync(spec);
        await tools.putBlob.execute({ body: "raw-bytes-here" });
        const [, init] = mockFetch.mock.calls[0];
        expect(init.headers["Content-Type"]).toBe("application/octet-stream");
        // Raw string passed through unchanged — NOT JSON.stringify'd.
        expect(init.body).toBe("raw-bytes-here");
        expect(init.body).not.toBe(JSON.stringify("raw-bytes-here"));
    });

    test("raw text/csv non-string body is JSON-stringified as a fallback", async () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "Csv", version: "1.0.0" },
            servers: [{ url: "https://api.example.com" }],
            paths: {
                "/import": {
                    post: {
                        operationId: "importCsv",
                        requestBody: {
                            required: true,
                            content: {
                                "text/csv": {
                                    schema: { type: "object" },
                                },
                            },
                        },
                        responses: { "200": { description: "ok" } },
                    },
                },
            },
        };
        const tools = createOpenApiToolsSync(spec);
        await tools.importCsv.execute({ body: { a: 1 } });
        const [, init] = mockFetch.mock.calls[0];
        expect(init.headers["Content-Type"]).toBe("text/csv");
        expect(init.body).toBe(JSON.stringify({ a: 1 }));
    });
});
