// ---------------------------------------------------------------------------
// Header collision hardening: HTTP header names are case-insensitive, so an
// operation parameter must not combine with an operator-controlled credential
// after fetch normalizes the outgoing Headers.
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createOpenApiToolsSync } from "../src/tool-factory.js";

/** @type {import("bun").Server} */
let server;
/** @type {string} */
let baseUrl;
/** @type {Headers[]} */
const receivedHeaders = [];

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        fetch(request) {
            receivedHeaders.push(request.headers);
            return Response.json({ ok: true });
        },
    });
    baseUrl = `http://${server.hostname}:${server.port}`;
});

afterAll(() => {
    server?.stop(true);
});

beforeEach(() => {
    receivedHeaders.length = 0;
});

/** @param {string} headerName */
function makeSpec(headerName) {
    return {
        openapi: "3.0.0",
        info: { title: "Header Collision", version: "1.0.0" },
        servers: [{ url: baseUrl }],
        paths: {
            "/pets": {
                get: {
                    operationId: "listPets",
                    parameters: [
                        { name: headerName, in: "header", schema: { type: "string" } },
                    ],
                    responses: { "200": { description: "ok" } },
                },
            },
        },
    };
}

describe("operator credentials reject case-insensitive header parameter collisions", () => {
    const authorizationCasings = [
        "Authorization",
        "authorization",
        "AUTHORIZATION",
        "aUtHoRiZaTiOn",
    ];

    for (const headerName of authorizationCasings) {
        test(`bearer Authorization wins over ${headerName}`, async () => {
            const tools = createOpenApiToolsSync(makeSpec(headerName), {
                auth: { type: "bearer", token: "REAL-SECRET" },
            });

            await tools.listPets.execute({ [headerName]: "Bearer ATTACKER" });

            expect(receivedHeaders).toHaveLength(1);
            expect(receivedHeaders[0].get("authorization")).toBe("Bearer REAL-SECRET");
        });
    }

    const apiKeyCasings = [
        "X-API-Key",
        "x-api-key",
        "X-API-KEY",
        "x-ApI-kEy",
    ];

    for (const headerName of apiKeyCasings) {
        test(`configured X-API-Key wins over ${headerName}`, async () => {
            const tools = createOpenApiToolsSync(makeSpec(headerName), {
                auth: { type: "apiKey", name: "X-API-Key", value: "REAL-KEY", in: "header" },
            });

            await tools.listPets.execute({ [headerName]: "ATTACKER-KEY" });

            expect(receivedHeaders).toHaveLength(1);
            expect(receivedHeaders[0].get("x-api-key")).toBe("REAL-KEY");
        });
    }

    test("operator headers override structured auth without combining case variants", async () => {
        const headerName = "AUTHORIZATION";
        const tools = createOpenApiToolsSync(makeSpec(headerName), {
            auth: { type: "bearer", token: "STRUCTURED-SECRET" },
            headers: { authorization: "Bearer OPERATOR-OVERRIDE" },
        });

        await tools.listPets.execute({ [headerName]: "Bearer ATTACKER" });

        expect(receivedHeaders).toHaveLength(1);
        expect(receivedHeaders[0].get("authorization")).toBe("Bearer OPERATOR-OVERRIDE");
    });

    test("configured custom headers also reserve every case variant", async () => {
        const headerName = "x-operator-token";
        const tools = createOpenApiToolsSync(makeSpec(headerName), {
            headers: { "X-Operator-Token": "REAL-TOKEN" },
        });

        await tools.listPets.execute({ [headerName]: "ATTACKER-TOKEN" });

        expect(receivedHeaders).toHaveLength(1);
        expect(receivedHeaders[0].get("x-operator-token")).toBe("REAL-TOKEN");
    });
});
