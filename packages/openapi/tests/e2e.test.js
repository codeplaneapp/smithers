// ---------------------------------------------------------------------------
// End-to-end: load spec, create tools, call tool, verify real HTTP round-trip
// No fetch mocking — a real Bun server receives and responds to every request.
// ---------------------------------------------------------------------------
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createOpenApiTools, createOpenApiTool } from "../src/tool-factory.js";

describe("OpenAPI e2e — real HTTP round-trip", () => {
    /** @type {import("bun").Server} */
    let server;
    let baseUrl;

    /** Requests received by the test server, reset between each test. */
    const capturedRequests = [];

    beforeAll(() => {
        server = Bun.serve({
            port: 0,
            async fetch(req) {
                const url = new URL(req.url);
                const method = req.method;
                const headers = Object.fromEntries(req.headers);
                let body = undefined;
                const ct = req.headers.get("content-type") ?? "";
                if (ct.includes("application/json") && method !== "GET" && method !== "DELETE") {
                    body = await req.json();
                }
                capturedRequests.push({ method, url, headers, body });

                if (url.pathname === "/pets" && method === "GET") {
                    return Response.json([
                        { id: 1, name: "Fido", tag: "dog" },
                        { id: 2, name: "Whiskers", tag: "cat" },
                    ]);
                }
                if (url.pathname.startsWith("/pets/") && method === "GET") {
                    const petId = url.pathname.slice("/pets/".length);
                    return Response.json({ id: Number(petId), name: "Buddy" });
                }
                if (url.pathname === "/pets" && method === "POST") {
                    return new Response(JSON.stringify({ id: 99, name: "NewPet" }), {
                        status: 201,
                        headers: { "content-type": "application/json" },
                    });
                }
                if (method === "DELETE") {
                    return new Response(null, { status: 204 });
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
        capturedRequests.length = 0;
    });

    /** Builds a petstore spec pointing at the local test server. */
    function makeSpec() {
        return {
            openapi: "3.0.0",
            info: { title: "Pet Store", version: "1.0.0" },
            servers: [{ url: baseUrl }],
            paths: {
                "/pets": {
                    get: {
                        operationId: "listPets",
                        summary: "List all pets",
                        parameters: [
                            { name: "limit", in: "query", schema: { type: "integer" } },
                            { name: "tag", in: "query", schema: { type: "string" } },
                        ],
                        responses: { "200": { description: "A list of pets" } },
                    },
                    post: {
                        operationId: "createPet",
                        summary: "Create a pet",
                        requestBody: {
                            required: true,
                            content: {
                                "application/json": {
                                    schema: {
                                        type: "object",
                                        required: ["name"],
                                        properties: {
                                            name: { type: "string", description: "The pet name" },
                                            tag: { type: "string", description: "Optional tag" },
                                        },
                                    },
                                },
                            },
                        },
                        responses: { "201": { description: "Pet created" } },
                    },
                },
                "/pets/{petId}": {
                    get: {
                        operationId: "getPet",
                        summary: "Get a pet by ID",
                        parameters: [
                            { name: "petId", in: "path", required: true, schema: { type: "string" } },
                        ],
                        responses: { "200": { description: "A pet" } },
                    },
                    delete: {
                        operationId: "deletePet",
                        summary: "Delete a pet",
                        parameters: [
                            { name: "petId", in: "path", required: true, schema: { type: "string" } },
                        ],
                        responses: { "204": { description: "Pet deleted" } },
                    },
                },
            },
        };
    }

    test("full flow: create tools from spec object → call listPets → verify real HTTP", async () => {
        const tools = await createOpenApiTools(makeSpec(), {
            auth: { type: "bearer", token: "test-token" },
        });

        expect(Object.keys(tools)).toEqual(
            expect.arrayContaining(["listPets", "createPet", "getPet", "deletePet"]),
        );

        const result = await tools.listPets.execute({ limit: 5 });

        expect(capturedRequests).toHaveLength(1);
        const { method, url, headers } = capturedRequests[0];
        expect(url.pathname).toBe("/pets");
        expect(url.searchParams.get("limit")).toBe("5");
        expect(method).toBe("GET");
        expect(headers["authorization"]).toBe("Bearer test-token");
        expect(result).toEqual([
            { id: 1, name: "Fido", tag: "dog" },
            { id: 2, name: "Whiskers", tag: "cat" },
        ]);
    });

    test("full flow: create single tool → call getPet with path param", async () => {
        const getPet = await createOpenApiTool(makeSpec(), "getPet");

        const result = await getPet.execute({ petId: "42" });

        expect(capturedRequests).toHaveLength(1);
        expect(capturedRequests[0].url.pathname).toBe("/pets/42");
        expect(result).toEqual({ id: 42, name: "Buddy" });
    });

    test("full flow: create tools with prefix and filter", async () => {
        const tools = await createOpenApiTools(makeSpec(), {
            include: ["listPets", "getPet"],
            namePrefix: "store_",
        });

        expect(Object.keys(tools).sort()).toEqual(["store_getPet", "store_listPets"]);

        await tools.store_listPets.execute({});
        expect(capturedRequests).toHaveLength(1);
        expect(capturedRequests[0].url.pathname).toBe("/pets");
    });

    test("full flow: POST with request body", async () => {
        const tools = await createOpenApiTools(makeSpec());

        const result = await tools.createPet.execute({
            body: { name: "NewPet", tag: "fish" },
        });

        expect(capturedRequests).toHaveLength(1);
        const { method, url, body } = capturedRequests[0];
        expect(url.pathname).toBe("/pets");
        expect(method).toBe("POST");
        expect(body).toEqual({ name: "NewPet", tag: "fish" });
        expect(result).toEqual({ id: 99, name: "NewPet" });
    });

    test("tool execution: non-2xx HTTP response surfaces as error object", async () => {
        // Add a path the server returns 404 for to exercise the error-surfacing path.
        const spec = makeSpec();
        spec.paths["/missing"] = {
            get: {
                operationId: "getMissing",
                summary: "Get a missing resource",
                responses: { "404": { description: "Not found" } },
            },
        };
        const tools = await createOpenApiTools(spec);
        const result = await tools.getMissing.execute({});

        expect(result).toHaveProperty("error", true);
        expect(result.message).toMatch(/404/);
    });
});
