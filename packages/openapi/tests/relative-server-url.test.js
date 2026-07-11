// ---------------------------------------------------------------------------
// Regression: a relative `servers[].url` (e.g. the Swagger Petstore v3 spec's
// "/api/v3") must not make every tool call fail with an opaque "Invalid URL".
//
// When the spec is loaded from a URL, the relative server URL is resolved
// against that document URL. When no base is available, tool creation throws a
// clear, actionable error naming the relative URL instead of failing later.
//
// The e2e portion uses a real Bun server (no fetch mocking): the same server
// serves the spec AND the API, so a resolved-wrong URL would 404 for real.
// ---------------------------------------------------------------------------
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createOpenApiTools, createOpenApiToolsSync } from "../src/tool-factory.js";
import { resolveBaseUrl } from "../src/tool-factory/_helpers.js";
import { SPEC_SOURCE_URL } from "../src/specSourceUrl.js";

/** Petstore-shaped spec whose server URL is relative, like the official v3 spec. */
function relativeServerSpec() {
    return {
        openapi: "3.0.0",
        info: { title: "Pet Store", version: "1.0.0" },
        servers: [{ url: "/api/v3" }],
        paths: {
            "/pet/{petId}": {
                get: {
                    operationId: "getPetById",
                    summary: "Find pet by ID",
                    parameters: [
                        { name: "petId", in: "path", required: true, schema: { type: "string" } },
                    ],
                    responses: { "200": { description: "A pet" } },
                },
            },
        },
    };
}

describe("relative server URL — real HTTP round-trip", () => {
    /** @type {import("bun").Server} */
    let server;
    let baseUrl;
    const capturedPaths = [];

    beforeAll(() => {
        server = Bun.serve({
            port: 0,
            fetch(req) {
                const url = new URL(req.url);
                capturedPaths.push(url.pathname);
                // Serve the spec itself from a path under /api/v3, mirroring how
                // the real Swagger Petstore hosts its openapi.json.
                if (url.pathname === "/api/v3/openapi.json") {
                    return Response.json(relativeServerSpec());
                }
                if (url.pathname === "/api/v3/pet/42") {
                    return Response.json({ id: 42, name: "Buddy" });
                }
                return new Response("Not Found", { status: 404 });
            },
        });
        baseUrl = `http://${server.hostname}:${server.port}`;
    });

    afterAll(() => {
        server?.stop(true);
    });

    beforeEach(() => {
        capturedPaths.length = 0;
    });

    test("relative server URL resolves against the URL the spec was loaded from", async () => {
        const specUrl = `${baseUrl}/api/v3/openapi.json`;
        const tools = await createOpenApiTools(specUrl, {
            // The fixture intentionally serves both the spec and API from a
            // loopback address; production public specs need no opt-in.
            allowPrivateNetwork: true,
        });

        const result = await tools.getPetById.execute({ petId: "42" });

        // The spec fetch, then the resolved tool call, both hit the real server.
        expect(capturedPaths).toContain("/api/v3/openapi.json");
        expect(capturedPaths).toContain("/api/v3/pet/42");
        expect(result).toEqual({ id: 42, name: "Buddy" });
    });
});

describe("relative server URL — resolution and errors", () => {
    test("resolveBaseUrl resolves a relative server URL against SPEC_SOURCE_URL", () => {
        const spec = relativeServerSpec();
        /** @type {Record<PropertyKey, unknown>} */ (spec)[SPEC_SOURCE_URL] =
            "https://petstore3.swagger.io/api/v3/openapi.json";
        expect(resolveBaseUrl(spec, {})).toBe("https://petstore3.swagger.io/api/v3");
    });

    test("resolveBaseUrl throws a clear error naming the relative URL when no base is available", () => {
        const spec = relativeServerSpec();
        expect(() => resolveBaseUrl(spec, {})).toThrow(/"\/api\/v3" is relative/);
        expect(() => resolveBaseUrl(spec, {})).toThrow(/baseUrl/);
    });

    test("options.baseUrl overrides a relative server URL without throwing", () => {
        const spec = relativeServerSpec();
        expect(resolveBaseUrl(spec, { baseUrl: "https://api.example.com" })).toBe(
            "https://api.example.com",
        );
    });

    test("absolute server URLs pass through unchanged", () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "X", version: "1.0.0" },
            servers: [{ url: "https://api.example.com/v2" }],
            paths: {},
        };
        expect(resolveBaseUrl(spec, {})).toBe("https://api.example.com/v2");
    });

    test("createOpenApiToolsSync surfaces the clear error for a relative-server spec object", () => {
        // A spec passed as an object has no source URL to resolve against, so
        // tool creation fails fast with an actionable message.
        expect(() => createOpenApiToolsSync(relativeServerSpec())).toThrow(
            /"\/api\/v3" is relative and no base URL is available/,
        );
    });
});
