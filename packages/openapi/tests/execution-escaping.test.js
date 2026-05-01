// ---------------------------------------------------------------------------
// executeRequest URL/path/header escaping edge cases.
// Verifies that buildUrl and buildAuthHeaders defend against header injection,
// double-encoding, and credential characters.
// ---------------------------------------------------------------------------
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createOpenApiToolsSync } from "../src/tool-factory.js";
import { petStoreSpec, complexSchemaSpec } from "./fixtures.js";

const originalFetch = globalThis.fetch;

describe("OpenAPI executeRequest escaping", () => {
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

    test("path param containing { and } is URL-encoded once, not double-encoded", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec);
        const value = "weird{id}";
        await tools.getPet.execute({ petId: value });
        const [url] = mockFetch.mock.calls[0];
        // encodeURIComponent(value) — single pass.
        expect(url).toContain(`/pets/${encodeURIComponent(value)}`);
        // Curly braces from the value should be percent-encoded once.
        expect(url).not.toContain("{id}");
        expect(url).not.toContain("%257B"); // would indicate double-encoding
    });

    test("query value containing = and & is encoded so it stays one parameter", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec);
        await tools.listPets.execute({ tag: "a=1&b=2" });
        const [url] = mockFetch.mock.calls[0];
        const parsed = new URL(url);
        expect(parsed.searchParams.getAll("tag")).toEqual(["a=1&b=2"]);
        // Raw ampersand from the value must not appear in the query string.
        const query = parsed.search.slice(1);
        expect(query.split("&")).toHaveLength(1);
    });

    test("header value containing newline is rejected by fetch (header-injection prevention)", async () => {
        const tools = createOpenApiToolsSync(complexSchemaSpec);
        // Real fetch would throw; our mock doesn't enforce this. To verify the
        // safety we restore real fetch for this assertion. The assertion is
        // that fetch — not buildAuthHeaders — refuses to send.
        globalThis.fetch = originalFetch;
        const result = await tools.search.execute({
            "X-Request-Id": "ok\r\nX-Injected: yes",
            body: { query: "x" },
        });
        // execute() catches errors and returns { error: true, ... }.
        expect(result).toMatchObject({ error: true });
    });

    test("basic auth credentials containing ':' and '@' are base64-encoded verbatim", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            auth: {
                type: "basic",
                username: "user@host",
                password: "p:a:s:s",
            },
        });
        await tools.listPets.execute({});
        const [, init] = mockFetch.mock.calls[0];
        const expected = `Basic ${btoa("user@host:p:a:s:s")}`;
        expect(init.headers["Authorization"]).toBe(expected);
    });

    test("apiKey auth in query is URL-encoded (special characters survive round-trip)", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            auth: {
                type: "apiKey",
                name: "api_key",
                value: "key with=&special",
                in: "query",
            },
        });
        await tools.listPets.execute({});
        const [url] = mockFetch.mock.calls[0];
        const parsed = new URL(url);
        expect(parsed.searchParams.get("api_key")).toBe("key with=&special");
    });
});
