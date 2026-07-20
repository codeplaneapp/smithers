// ---------------------------------------------------------------------------
// Redirect hardening — injected auth headers must never leak across origins.
//
// executeRequest injects the operator's Authorization / API-key headers and
// follows redirects. Two REAL Bun servers (no fetch mocking): the "api" server
// is the configured OpenAPI service origin and issues redirects; the "other"
// server is a second, foreign origin that records everything it receives.
// A redirect to the foreign origin must be refused BEFORE any request is sent
// there (fail closed), while same-origin and explicitly allowlisted redirects
// keep working like standard `redirect: "follow"`.
// ---------------------------------------------------------------------------
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createOpenApiToolsSync } from "../src/tool-factory.js";

/** @type {import("bun").Server} */
let apiServer;
/** @type {import("bun").Server} */
let otherServer;
/** @type {string} */
let apiOrigin;
/** @type {string} */
let otherOrigin;

/** Requests received by the api-origin server, reset between tests. */
const apiRequests = [];
/** Requests received by the foreign-origin server, reset between tests. */
const otherRequests = [];

beforeAll(() => {
    otherServer = Bun.serve({
        port: 0,
        fetch(req) {
            const url = new URL(req.url);
            otherRequests.push({
                method: req.method,
                path: url.pathname,
                headers: Object.fromEntries(req.headers),
            });
            return Response.json({ reachedOtherOrigin: true });
        },
    });
    otherOrigin = `http://${otherServer.hostname}:${otherServer.port}`;

    apiServer = Bun.serve({
        port: 0,
        async fetch(req) {
            const url = new URL(req.url);
            apiRequests.push({
                method: req.method,
                path: url.pathname,
                headers: Object.fromEntries(req.headers),
                body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
            });
            switch (url.pathname) {
                case "/pets":
                    return Response.json([{ id: 1, name: "Fido" }]);
                // Same-origin redirects (relative and absolute Location).
                case "/same-redirect":
                    return new Response(null, { status: 302, headers: { location: "/pets" } });
                case "/hop1":
                    return new Response(null, { status: 302, headers: { location: "/hop2" } });
                case "/hop2":
                    return new Response(null, { status: 301, headers: { location: `${apiOrigin}/pets` } });
                // Cross-origin redirects, single- and multi-hop.
                case "/cross-redirect":
                    return new Response(null, { status: 302, headers: { location: `${otherOrigin}/collect` } });
                case "/hop-then-cross":
                    return new Response(null, { status: 302, headers: { location: "/hop-then-cross-2" } });
                case "/hop-then-cross-2":
                    return new Response(null, { status: 308, headers: { location: `${otherOrigin}/collect` } });
                // Method-rewrite semantics.
                case "/submit":
                    return new Response(null, { status: 303, headers: { location: "/pets" } });
                case "/preserve":
                    return new Response(null, { status: 307, headers: { location: "/echo-post" } });
                case "/echo-post":
                    return Response.json({ echoed: true });
                case "/loop":
                    return new Response(null, { status: 302, headers: { location: "/loop" } });
                default:
                    return new Response("Not Found", { status: 404 });
            }
        },
    });
    apiOrigin = `http://${apiServer.hostname}:${apiServer.port}`;
});

afterAll(() => {
    apiServer?.stop(true);
    otherServer?.stop(true);
});

beforeEach(() => {
    apiRequests.length = 0;
    otherRequests.length = 0;
});

/** @returns {Record<string, unknown>} */
function makeSpec() {
    return {
        openapi: "3.0.0",
        info: { title: "Redirect Hardening", version: "1.0.0" },
        servers: [{ url: apiOrigin }],
        paths: {
            "/pets": { get: { operationId: "listPets", responses: { "200": { description: "ok" } } } },
            "/same-redirect": { get: { operationId: "sameRedirect", responses: { "200": { description: "ok" } } } },
            "/hop1": { get: { operationId: "multiHop", responses: { "200": { description: "ok" } } } },
            "/cross-redirect": { get: { operationId: "crossRedirect", responses: { "200": { description: "ok" } } } },
            "/hop-then-cross": { get: { operationId: "hopThenCross", responses: { "200": { description: "ok" } } } },
            "/loop": { get: { operationId: "loopForever", responses: { "200": { description: "ok" } } } },
            "/submit": {
                post: {
                    operationId: "submit",
                    requestBody: {
                        content: {
                            "application/json": {
                                schema: { type: "object", properties: { name: { type: "string" } } },
                            },
                        },
                    },
                    responses: { "200": { description: "ok" } },
                },
            },
            "/preserve": {
                post: {
                    operationId: "preservePost",
                    requestBody: {
                        content: {
                            "application/json": {
                                schema: { type: "object", properties: { name: { type: "string" } } },
                            },
                        },
                    },
                    responses: { "200": { description: "ok" } },
                },
            },
        },
    };
}

const bearerAuth = /** @type {const} */ ({ type: "bearer", token: "REDIRECT-SECRET" });

describe("same-origin redirects stay authorized", () => {
    test("relative-Location redirect is followed and auth reaches the final hop", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), { auth: bearerAuth });
        const result = await tools.sameRedirect.execute({});
        expect(result).toEqual([{ id: 1, name: "Fido" }]);
        const final = apiRequests.at(-1);
        expect(final.path).toBe("/pets");
        expect(final.headers.authorization).toBe("Bearer REDIRECT-SECRET");
    });

    test("multi-hop same-origin redirect chain (relative then absolute) keeps auth on every hop", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), { auth: bearerAuth });
        const result = await tools.multiHop.execute({});
        expect(result).toEqual([{ id: 1, name: "Fido" }]);
        expect(apiRequests.map((r) => r.path)).toEqual(["/hop1", "/hop2", "/pets"]);
        for (const request of apiRequests) {
            expect(request.headers.authorization).toBe("Bearer REDIRECT-SECRET");
        }
    });

    test("303 rewrites POST to GET and drops the body, preserving auth", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), { auth: bearerAuth });
        const result = await tools.submit.execute({ body: { name: "Fido" } });
        expect(result).toEqual([{ id: 1, name: "Fido" }]);
        const final = apiRequests.at(-1);
        expect(final.path).toBe("/pets");
        expect(final.method).toBe("GET");
        expect(final.headers.authorization).toBe("Bearer REDIRECT-SECRET");
        expect(final.headers["content-type"]).toBeUndefined();
    });

    test("307 preserves the POST method and body on a same-origin redirect", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), { auth: bearerAuth });
        const result = await tools.preservePost.execute({ body: { name: "Fido" } });
        expect(result).toEqual({ echoed: true });
        const final = apiRequests.at(-1);
        expect(final.path).toBe("/echo-post");
        expect(final.method).toBe("POST");
        expect(final.body).toBe(JSON.stringify({ name: "Fido" }));
        expect(final.headers.authorization).toBe("Bearer REDIRECT-SECRET");
    });

    test("a same-origin redirect loop errors out instead of hanging", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), { auth: bearerAuth });
        const result = await tools.loopForever.execute({});
        expect(result).toMatchObject({ error: true, status: "failed" });
        expect(result.message).toContain("redirects");
    });
});

describe("cross-origin redirects fail closed (no request to the foreign origin)", () => {
    test("bearer token never reaches the foreign origin", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), { auth: bearerAuth });
        const result = await tools.crossRedirect.execute({});
        expect(result).toMatchObject({ error: true, status: "failed" });
        // The refusal names the blocked origin and the escape hatch...
        expect(result.message).toContain(otherOrigin);
        expect(result.message).toContain("allowedRedirectOrigins");
        // ...but never the secret.
        expect(JSON.stringify(result)).not.toContain("REDIRECT-SECRET");
        // Fail closed: the foreign origin must receive NOTHING at all.
        expect(otherRequests).toHaveLength(0);
        // The same-origin first hop did go out (with auth) as usual.
        expect(apiRequests.map((r) => r.path)).toEqual(["/cross-redirect"]);
        expect(apiRequests[0].headers.authorization).toBe("Bearer REDIRECT-SECRET");
    });

    test("apiKey-in-header never reaches the foreign origin", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), {
            auth: { type: "apiKey", name: "X-Api-Key", value: "KEY-SECRET", in: "header" },
        });
        const result = await tools.crossRedirect.execute({});
        expect(result).toMatchObject({ error: true });
        expect(otherRequests).toHaveLength(0);
        expect(JSON.stringify(result)).not.toContain("KEY-SECRET");
    });

    test("operator options.headers never reach the foreign origin", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), {
            headers: { "X-Internal-Token": "HEADER-SECRET" },
        });
        const result = await tools.crossRedirect.execute({});
        expect(result).toMatchObject({ error: true });
        expect(otherRequests).toHaveLength(0);
        expect(JSON.stringify(result)).not.toContain("HEADER-SECRET");
    });

    test("multi-hop chain is validated on EVERY hop, not just the first", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), { auth: bearerAuth });
        const result = await tools.hopThenCross.execute({});
        expect(result).toMatchObject({ error: true });
        // The intermediate same-origin hop went through, the cross hop did not.
        expect(apiRequests.map((r) => r.path)).toEqual(["/hop-then-cross", "/hop-then-cross-2"]);
        expect(otherRequests).toHaveLength(0);
    });

    test("apiKey-in-query credential is not echoed into the refusal message", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), {
            auth: { type: "apiKey", name: "api_key", value: "QUERY-SECRET", in: "query" },
        });
        const result = await tools.crossRedirect.execute({});
        expect(result).toMatchObject({ error: true });
        expect(JSON.stringify(result)).not.toContain("QUERY-SECRET");
        expect(otherRequests).toHaveLength(0);
    });
});

describe("allowedRedirectOrigins allowlist", () => {
    test("an allowlisted foreign origin may be redirected to, and keeps the auth header", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), {
            auth: bearerAuth,
            allowedRedirectOrigins: [otherOrigin],
        });
        const result = await tools.crossRedirect.execute({});
        expect(result).toEqual({ reachedOtherOrigin: true });
        expect(otherRequests).toHaveLength(1);
        expect(otherRequests[0].path).toBe("/collect");
        // The operator explicitly trusts this origin, so auth rides along.
        expect(otherRequests[0].headers.authorization).toBe("Bearer REDIRECT-SECRET");
    });

    test("allowlist entries are matched as origins (full URLs are normalized)", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), {
            auth: bearerAuth,
            allowedRedirectOrigins: [`${otherOrigin}/some/unrelated/path?x=1`],
        });
        const result = await tools.crossRedirect.execute({});
        expect(result).toEqual({ reachedOtherOrigin: true });
        expect(otherRequests).toHaveLength(1);
    });

    test("an unparseable allowlist entry fails loudly instead of silently narrowing", async () => {
        const tools = createOpenApiToolsSync(makeSpec(), {
            auth: bearerAuth,
            allowedRedirectOrigins: ["not a url"],
        });
        const result = await tools.sameRedirect.execute({});
        expect(result).toMatchObject({ error: true });
        expect(result.message).toContain("allowedRedirectOrigins");
        expect(result.message).toContain("not a url");
    });
});
