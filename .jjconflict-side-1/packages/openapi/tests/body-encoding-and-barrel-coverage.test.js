// ---------------------------------------------------------------------------
// Coverage for the remaining request-body encoding branches in
// tool-factory/_helpers.js (non-object multipart/urlencoded bodies, non-string
// form scalar values, the formatExampleValue JSON.stringify fallback) plus the
// public barrel re-exports in src/index.js.
// ---------------------------------------------------------------------------
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createOpenApiToolsSync, createOpenApiToolSync } from "../src/tool-factory.js";
import { petStoreSpec } from "./fixtures.js";
import * as barrel from "../src/index.js";

const originalFetch = globalThis.fetch;

/**
 * @param {string} mediaType
 * @param {import("../src/SchemaObject.ts").SchemaObject} schema
 */
function makeBodySpec(mediaType, schema) {
    return {
        openapi: "3.0.0",
        info: { title: "Bodies", version: "1.0.0" },
        servers: [{ url: "https://api.example.com" }],
        paths: {
            "/thing": {
                post: {
                    operationId: "doThing",
                    requestBody: {
                        required: true,
                        content: { [mediaType]: { schema } },
                    },
                    responses: { "200": { description: "ok" } },
                },
            },
        },
    };
}

describe("request-body encoding branches", () => {
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

    test("multipart numeric scalar field is coerced via String()", async () => {
        const tools = createOpenApiToolsSync(
            makeBodySpec("multipart/form-data", {
                type: "object",
                properties: { count: { type: "number" } },
            }),
        );
        await tools.doThing.execute({ body: { count: 5 } });
        const [, init] = mockFetch.mock.calls[0];
        expect(init.body).toBeInstanceOf(FormData);
        // toFormValue's String(value) fallback for a non-string, non-Blob value.
        expect(init.body.get("count")).toBe("5");
    });

    test("multipart non-object body falls back to a single 'body' entry", async () => {
        const tools = createOpenApiToolsSync(
            makeBodySpec("multipart/form-data", { type: "string" }),
        );
        await tools.doThing.execute({ body: "raw-payload" });
        const [, init] = mockFetch.mock.calls[0];
        expect(init.body).toBeInstanceOf(FormData);
        expect(init.body.get("body")).toBe("raw-payload");
        expect(init.headers["Content-Type"]).toBeUndefined();
    });

    test("urlencoded non-object body falls back to a single 'body' param", async () => {
        const tools = createOpenApiToolsSync(
            makeBodySpec("application/x-www-form-urlencoded", { type: "string" }),
        );
        await tools.doThing.execute({ body: "raw-payload" });
        const [, init] = mockFetch.mock.calls[0];
        expect(init.body).toBeInstanceOf(URLSearchParams);
        expect(init.body.get("body")).toBe("raw-payload");
        expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    });
});

describe("formatExampleValue fallback", () => {
    test("un-serializable response example value falls back to String()", () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "Ex", version: "1.0.0" },
            servers: [{ url: "https://api.example.com" }],
            paths: {
                "/thing": {
                    get: {
                        operationId: "getThing",
                        responses: { "200": { description: "ok" } },
                    },
                },
            },
        };
        const tools = createOpenApiToolsSync(spec, {
            operations: {
                getThing: {
                    description: "Get the thing.",
                    responseExamples: [
                        // JSON.stringify throws on a BigInt -> catch -> String(value).
                        { status: 200, description: "big", value: 10n },
                    ],
                },
            },
        });
        expect(tools.getThing.description).toContain("Get the thing.");
        expect(tools.getThing.description).toContain("200 big");
        expect(tools.getThing.description).toContain("10");
    });
});

describe("createOpenApiToolSync curation exclusion", () => {
    test("throws when the requested operation is excluded by curation", () => {
        expect(() =>
            createOpenApiToolSync(petStoreSpec, "listPets", {
                operations: { listPets: { include: false } },
            }),
        ).toThrow(/Operation "listPets" is excluded by OpenAPI tool curation options\./);
    });
});

describe("src/index.js barrel", () => {
    test("re-exports the public OpenAPI tool factory surface", () => {
        for (const name of [
            "createOpenApiTools",
            "createOpenApiToolsSync",
            "createOpenApiTool",
            "createOpenApiToolSync",
            "listOperations",
            "openApiToolCallsTotal",
            "openApiToolCallErrorsTotal",
            "openApiToolDuration",
            "extractOperations",
            "loadSpecEffect",
            "loadSpecSync",
            "jsonSchemaToZod",
            "buildOperationSchema",
        ]) {
            expect(barrel[name]).toBeDefined();
        }
    });
});
