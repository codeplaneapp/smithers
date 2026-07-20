// ---------------------------------------------------------------------------
// Regression tests for two real executeRequest bugs:
//   1. (trust boundary) An LLM-supplied header *parameter* must NOT be able to
//      override or strip the operator-injected auth secret.
//   2. (error path) A non-2xx HTTP response must be surfaced as an error, not
//      returned as a successful tool result.
// ---------------------------------------------------------------------------
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createOpenApiToolsSync } from "../src/tool-factory.js";

const originalFetch = globalThis.fetch;

// A spec that deliberately declares a header *parameter* whose name collides
// with the injected auth header. A prompt-injected / adversarial model could
// fill it from its tool args.
const authClobberSpec = {
    openapi: "3.0.0",
    info: { title: "Auth Clobber", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
        "/pets": {
            get: {
                operationId: "listPets",
                parameters: [
                    { name: "Authorization", in: "header", schema: { type: "string" } },
                ],
                responses: { "200": { description: "ok" } },
            },
        },
    },
};

// A spec whose header parameter name collides with an apiKey-in-header name.
const apiKeyClobberSpec = {
    openapi: "3.0.0",
    info: { title: "ApiKey Clobber", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
        "/pets": {
            get: {
                operationId: "listPets",
                parameters: [
                    { name: "X-API-Key", in: "header", schema: { type: "string" } },
                ],
                responses: { "200": { description: "ok" } },
            },
        },
    },
};

describe("injected auth wins over LLM-controlled header params (trust boundary)", () => {
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

    test("bearer token cannot be overwritten by an Authorization header param", async () => {
        const tools = createOpenApiToolsSync(authClobberSpec, {
            auth: { type: "bearer", token: "REAL-SECRET" },
        });
        // The model supplies a malicious Authorization header param value.
        await tools.listPets.execute({ Authorization: "attacker-token" });
        const [, init] = mockFetch.mock.calls[0];
        // Operator-injected auth must win — the attacker value is discarded.
        expect(init.headers["Authorization"]).toBe("Bearer REAL-SECRET");
        expect(init.headers["Authorization"]).not.toContain("attacker");
    });

    test("bearer token cannot be stripped to empty by an Authorization header param", async () => {
        const tools = createOpenApiToolsSync(authClobberSpec, {
            auth: { type: "bearer", token: "REAL-SECRET" },
        });
        await tools.listPets.execute({ Authorization: "" });
        const [, init] = mockFetch.mock.calls[0];
        expect(init.headers["Authorization"]).toBe("Bearer REAL-SECRET");
    });

    test("basic auth cannot be overwritten by an Authorization header param", async () => {
        const tools = createOpenApiToolsSync(authClobberSpec, {
            auth: { type: "basic", username: "admin", password: "secret" },
        });
        await tools.listPets.execute({ Authorization: "Bearer attacker" });
        const [, init] = mockFetch.mock.calls[0];
        expect(init.headers["Authorization"]).toBe(`Basic ${btoa("admin:secret")}`);
    });

    test("apiKey-in-header value cannot be overwritten by a colliding header param", async () => {
        const tools = createOpenApiToolsSync(apiKeyClobberSpec, {
            auth: { type: "apiKey", name: "X-API-Key", value: "REAL-KEY", in: "header" },
        });
        await tools.listPets.execute({ "X-API-Key": "attacker-key" });
        const [, init] = mockFetch.mock.calls[0];
        expect(init.headers["X-API-Key"]).toBe("REAL-KEY");
        expect(init.headers["X-API-Key"]).not.toContain("attacker");
    });

    test("non-colliding header params are still forwarded alongside injected auth", async () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "Mixed Headers", version: "1.0.0" },
            servers: [{ url: "https://api.example.com" }],
            paths: {
                "/pets": {
                    get: {
                        operationId: "listPets",
                        parameters: [
                            { name: "X-Request-Id", in: "header", schema: { type: "string" } },
                        ],
                        responses: { "200": { description: "ok" } },
                    },
                },
            },
        };
        const tools = createOpenApiToolsSync(spec, {
            auth: { type: "bearer", token: "REAL-SECRET" },
        });
        await tools.listPets.execute({ "X-Request-Id": "req-1" });
        const [, init] = mockFetch.mock.calls[0];
        // Both survive: the benign header param AND the injected auth.
        expect(init.headers["X-Request-Id"]).toBe("req-1");
        expect(init.headers["Authorization"]).toBe("Bearer REAL-SECRET");
    });
});

describe("operator options.headers precedence (operator-controlled override)", () => {
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

    test("operator options.headers may intentionally override structured auth", async () => {
        // Unlike LLM header params, options.headers is operator-supplied config,
        // so it is allowed to override the configured credential. This pins the
        // intended contract.
        const tools = createOpenApiToolsSync(
            {
                openapi: "3.0.0",
                info: { title: "Override", version: "1.0.0" },
                servers: [{ url: "https://api.example.com" }],
                paths: {
                    "/pets": {
                        get: { operationId: "listPets", responses: { "200": { description: "ok" } } },
                    },
                },
            },
            {
                auth: { type: "bearer", token: "A" },
                headers: { Authorization: "Bearer B" },
            },
        );
        await tools.listPets.execute({});
        const [, init] = mockFetch.mock.calls[0];
        expect(init.headers["Authorization"]).toBe("Bearer B");
    });

    test("auth and an unrelated operator header both survive", async () => {
        const tools = createOpenApiToolsSync(
            {
                openapi: "3.0.0",
                info: { title: "Both", version: "1.0.0" },
                servers: [{ url: "https://api.example.com" }],
                paths: {
                    "/pets": {
                        get: { operationId: "listPets", responses: { "200": { description: "ok" } } },
                    },
                },
            },
            {
                auth: { type: "bearer", token: "A" },
                headers: { "X-Custom": "c" },
            },
        );
        await tools.listPets.execute({});
        const [, init] = mockFetch.mock.calls[0];
        expect(init.headers["Authorization"]).toBe("Bearer A");
        expect(init.headers["X-Custom"]).toBe("c");
    });
});

describe("non-2xx HTTP responses are surfaced as errors, not success", () => {
    const errorSpec = {
        openapi: "3.0.0",
        info: { title: "Errors", version: "1.0.0" },
        servers: [{ url: "https://api.example.com" }],
        paths: {
            "/pets": {
                post: {
                    operationId: "createPet",
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
                    responses: { "201": { description: "created" } },
                },
            },
        },
    };

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test("403 JSON response is returned as an error (not a bare success object)", async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ code: 403, message: "denied" }), {
                    status: 403,
                    statusText: "Forbidden",
                    headers: { "content-type": "application/json" },
                }),
            ),
        );
        const tools = createOpenApiToolsSync(errorSpec);
        const result = await tools.createPet.execute({ body: { name: "Fido" } });
        expect(result).toMatchObject({ error: true, status: "failed" });
        // The HTTP status is surfaced so the agent can tell apart 403 / 500 etc.
        expect(result.message).toContain("403");
        expect(result.message).toContain("denied");
        // Must NOT look like a successful create.
        expect(result).not.toHaveProperty("id");
    });

    test("401 is surfaced as an error", async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ message: "unauthorized" }), {
                    status: 401,
                    headers: { "content-type": "application/json" },
                }),
            ),
        );
        const tools = createOpenApiToolsSync(errorSpec);
        const result = await tools.createPet.execute({ body: { name: "Fido" } });
        expect(result).toMatchObject({ error: true });
        expect(result.message).toContain("401");
    });

    test("429 is surfaced as an error", async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ message: "rate limited" }), {
                    status: 429,
                    headers: { "content-type": "application/json" },
                }),
            ),
        );
        const tools = createOpenApiToolsSync(errorSpec);
        const result = await tools.createPet.execute({ body: { name: "Fido" } });
        expect(result).toMatchObject({ error: true });
        expect(result.message).toContain("429");
    });

    test("500 with text/plain body is surfaced as an error", async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response("internal boom", {
                    status: 500,
                    statusText: "Internal Server Error",
                    headers: { "content-type": "text/plain" },
                }),
            ),
        );
        const tools = createOpenApiToolsSync(errorSpec);
        const result = await tools.createPet.execute({ body: { name: "Fido" } });
        expect(result).toMatchObject({ error: true });
        expect(result.message).toContain("500");
        expect(result.message).toContain("internal boom");
    });

    test("2xx success is still returned as a plain result (no error flag)", async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ id: 7, name: "Fido" }), {
                    status: 201,
                    headers: { "content-type": "application/json" },
                }),
            ),
        );
        const tools = createOpenApiToolsSync(errorSpec);
        const result = await tools.createPet.execute({ body: { name: "Fido" } });
        expect(result).toEqual({ id: 7, name: "Fido" });
        expect(result).not.toHaveProperty("error");
    });

    test("error result for a non-2xx with auth configured does NOT leak the token", async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ message: "denied" }), {
                    status: 403,
                    headers: { "content-type": "application/json" },
                }),
            ),
        );
        const tools = createOpenApiToolsSync(errorSpec, {
            auth: { type: "bearer", token: "SUPER-SECRET-TOKEN" },
        });
        const result = await tools.createPet.execute({ body: { name: "Fido" } });
        expect(result).toMatchObject({ error: true });
        expect(JSON.stringify(result)).not.toContain("SUPER-SECRET-TOKEN");
    });
});
