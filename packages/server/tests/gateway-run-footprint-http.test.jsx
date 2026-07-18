import { afterEach, describe, expect, test } from "bun:test";
import { Gateway } from "../src/gateway.js";

function portOf(server) {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("gateway did not expose a TCP port");
    return address.port;
}

describe("GET /v1/api/runs/:runId/footprint", () => {
    let gateway;

    afterEach(async () => {
        await gateway?.close();
        gateway = undefined;
    });

    test("uses run:read fallback scope and preserves HTTP API response/status contracts", async () => {
        gateway = new Gateway({
            auth: {
                mode: "token",
                tokens: {
                    reader: { role: "reader", scopes: ["run:read"], userId: "reader" },
                    denied: { role: "none", scopes: [], userId: "denied" },
                },
            },
        });
        gateway.resolveRun = async (runId) => runId === "known"
            ? { adapter: { listAttemptsForRun: async () => [] } }
            : null;
        const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const base = `http://127.0.0.1:${portOf(server)}/v1/api/runs`;

        const forbidden = await fetch(`${base}/known/footprint`, { headers: { authorization: "Bearer denied" } });
        expect(forbidden.status).toBe(403);

        const unknown = await fetch(`${base}/unknown/footprint`, { headers: { authorization: "Bearer reader" } });
        expect(unknown.status).toBe(404);
        expect((await unknown.json()).error.code).toBe("RunNotFound");

        const response = await fetch(`${base}/known/footprint`, { headers: { authorization: "Bearer reader" } });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            ok: true,
            data: expect.objectContaining({
                runId: "known",
                filesChanged: 0,
                totalFiles: 0,
                directories: [],
                files: [],
                skippedNodes: 0,
            }),
        });
    });
});
