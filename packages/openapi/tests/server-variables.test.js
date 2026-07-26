// ---------------------------------------------------------------------------
// Regression: a templated `servers[].url` ("https://{region}.api.example.com")
// must be substituted from `servers[].variables[].default`. Left verbatim it
// parses as an absolute URL whose host is literally "{region}.api.example.com",
// so every generated tool call dies on DNS resolution.
//
// The e2e portion uses a real Bun server (no fetch mocking): the server's own
// host:port is injected as a variable default, so an unsubstituted template
// would never reach it.
// ---------------------------------------------------------------------------
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createOpenApiToolsSync } from "../src/tool-factory.js";
import { resolveBaseUrl } from "../src/tool-factory/_helpers.js";

/** Spec whose only server is templated, like AWS/Twilio-style regional APIs. */
function templatedServerSpec(variables) {
    return {
        openapi: "3.0.0",
        info: { title: "Pet Store", version: "1.0.0" },
        servers: [{ url: "https://{region}.api.example.com/{version}", variables }],
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

describe("templated server URL — real HTTP round-trip", () => {
    /** @type {import("bun").Server} */
    let server;
    let host;
    const capturedPaths = [];

    beforeAll(() => {
        server = Bun.serve({
            port: 0,
            fetch(req) {
                const url = new URL(req.url);
                capturedPaths.push(url.pathname);
                if (url.pathname === "/v3/pet/42") {
                    return Response.json({ id: 42, name: "Buddy" });
                }
                return new Response("Not Found", { status: 404 });
            },
        });
        host = `${server.hostname}:${server.port}`;
    });

    afterAll(() => {
        server?.stop(true);
    });

    beforeEach(() => {
        capturedPaths.length = 0;
    });

    test("server variable defaults are substituted before the request is sent", async () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "Pet Store", version: "1.0.0" },
            servers: [
                {
                    url: "http://{host}/{version}",
                    variables: { host: { default: host }, version: { default: "v3" } },
                },
            ],
            paths: templatedServerSpec().paths,
        };
        const tools = createOpenApiToolsSync(spec);

        const result = await tools.getPetById.execute({ petId: "42" });

        expect(capturedPaths).toEqual(["/v3/pet/42"]);
        expect(result).toEqual({ id: 42, name: "Buddy" });
    });
});

describe("templated server URL — resolution and errors", () => {
    test("resolveBaseUrl substitutes every server variable default", () => {
        const spec = templatedServerSpec({
            region: { default: "us", enum: ["us", "eu"] },
            version: { default: "v1" },
        });
        expect(resolveBaseUrl(spec, {})).toBe("https://us.api.example.com/v1");
    });

    test("a templated relative server URL is substituted then resolved as relative", () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "X", version: "1.0.0" },
            servers: [{ url: "/{basePath}/v3", variables: { basePath: { default: "api" } } }],
            paths: {},
        };
        expect(() => resolveBaseUrl(spec, {})).toThrow(/"\/api\/v3" is relative/);
    });

    test("resolveBaseUrl throws a clear error when a variable declares no default", () => {
        const spec = templatedServerSpec({ region: { default: "us" } });
        expect(() => resolveBaseUrl(spec, {})).toThrow(/leaves variable "\{version\}" unresolved/);
        expect(() => resolveBaseUrl(spec, {})).toThrow(/baseUrl/);
    });

    test("options.baseUrl overrides a templated server URL without throwing", () => {
        const spec = templatedServerSpec();
        expect(resolveBaseUrl(spec, { baseUrl: "https://api.example.com" })).toBe(
            "https://api.example.com",
        );
    });

    test("untemplated server URLs are unaffected by variable substitution", () => {
        const spec = {
            openapi: "3.0.0",
            info: { title: "X", version: "1.0.0" },
            servers: [{ url: "https://api.example.com/v2", variables: { region: { default: "us" } } }],
            paths: {},
        };
        expect(resolveBaseUrl(spec, {})).toBe("https://api.example.com/v2");
    });
});
