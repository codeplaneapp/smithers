import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Gateway } from "../src/gateway.js";
import { DEFAULT_OPERATOR_UI_CLIENT_JS, DEFAULT_OPERATOR_UI_ENTRY } from "../src/gatewayUi/defaultOperatorUi.js";
import { renderDefaultConsoleClient } from "../src/gatewayUi/defaultConsole.js";

function makeDbPath(name) {
    return join(tmpdir(), `smithers-op-ui-${name}-${Math.random().toString(36).slice(2)}.db`);
}

function getPort(server) {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    return addr.port;
}

describe("defaultOperatorUi", () => {
    describe("exports", () => {
        test("DEFAULT_OPERATOR_UI_ENTRY is the expected specifier string", () => {
            expect(DEFAULT_OPERATOR_UI_ENTRY).toBe("smithers:default-operator-ui");
        });

        test("DEFAULT_OPERATOR_UI_CLIENT_JS is a non-empty IIFE string", () => {
            expect(typeof DEFAULT_OPERATOR_UI_CLIENT_JS).toBe("string");
            expect(DEFAULT_OPERATOR_UI_CLIENT_JS.length).toBeGreaterThan(1000);
            // The stringified client is wrapped in an IIFE: (function defaultOperatorUiClient(){...})();
            expect(DEFAULT_OPERATOR_UI_CLIENT_JS).toStartWith("(function defaultOperatorUiClient(");
            expect(DEFAULT_OPERATOR_UI_CLIENT_JS).toEndWith("();\n");
        });

        test("DEFAULT_OPERATOR_UI_CLIENT_JS is syntactically valid JavaScript", () => {
            // new Function() parses the body — throws SyntaxError if malformed
            expect(() => new Function(DEFAULT_OPERATOR_UI_CLIENT_JS)).not.toThrow();
        });

        test("DEFAULT_OPERATOR_UI_CLIENT_JS contains expected behavioral landmarks", () => {
            expect(DEFAULT_OPERATOR_UI_CLIENT_JS).toContain("smithers.gateway.console.token");
            expect(DEFAULT_OPERATOR_UI_CLIENT_JS).toContain("sessionStorage");
            expect(DEFAULT_OPERATOR_UI_CLIENT_JS).toContain("submitApproval");
            expect(DEFAULT_OPERATOR_UI_CLIENT_JS).toContain("launchRun");
            expect(DEFAULT_OPERATOR_UI_CLIENT_JS).toContain("listWorkflows");
            expect(DEFAULT_OPERATOR_UI_CLIENT_JS).toContain("listRuns");
            expect(DEFAULT_OPERATOR_UI_CLIENT_JS).toContain("setInterval");
        });

        test("renderDefaultConsoleClient returns DEFAULT_OPERATOR_UI_CLIENT_JS", () => {
            expect(renderDefaultConsoleClient()).toBe(DEFAULT_OPERATOR_UI_CLIENT_JS);
        });
    });

    describe("HTTP delivery via Gateway", () => {
        let gateway;
        let server;
        let port;
        const dbPaths = [];

        beforeEach(async () => {
            const dbPath = makeDbPath("op-ui");
            dbPaths.push(dbPath);
            gateway = new Gateway({
                protocol: 1,
                features: [],
                heartbeatMs: 60_000,
                operatorUi: { path: "/console", title: "Test Console" },
            });
            server = await gateway.listen({ port: 0, host: "127.0.0.1" });
            port = getPort(server);
        });

        afterEach(async () => {
            if (gateway) await gateway.close();
            for (const p of dbPaths) {
                try { rmSync(p, { force: true }); } catch { }
                try { rmSync(`${p}-shm`, { force: true }); } catch { }
                try { rmSync(`${p}-wal`, { force: true }); } catch { }
            }
            dbPaths.length = 0;
            gateway = undefined;
            server = undefined;
        });

        test("GET /console returns HTML shell with expected structure", async () => {
            const res = await fetch(`http://127.0.0.1:${port}/console`);
            expect(res.status).toBe(200);
            const body = await res.text();
            expect(body).toContain("<!doctype html>");
            expect(body).toContain('<div id="root">');
            expect(body).toContain("Test Console");
            expect(body).toContain("__SMITHERS_GATEWAY_UI__");
            expect(body).toContain("client.js");
        });

        test("GET /console/__smithers_ui/client.js returns the operator UI JavaScript", async () => {
            const res = await fetch(`http://127.0.0.1:${port}/console/__smithers_ui/client.js`);
            expect(res.status).toBe(200);
            const ct = res.headers.get("content-type") ?? "";
            expect(ct).toContain("text/javascript");
            const body = await res.text();
            expect(body).toBe(DEFAULT_OPERATOR_UI_CLIENT_JS);
        });

        test("GET /console/__smithers_ui/client.js carries no-store cache header", async () => {
            const res = await fetch(`http://127.0.0.1:${port}/console/__smithers_ui/client.js`);
            expect(res.headers.get("cache-control")).toBe("no-store");
        });

        test("unknown asset path under /console/__smithers_ui/ returns 404", async () => {
            const res = await fetch(`http://127.0.0.1:${port}/console/__smithers_ui/unknown.js`);
            expect(res.status).toBe(404);
        });

        test("paths outside /console are not served by the UI handler", async () => {
            const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
            // The root is handled by the gateway WS/health path, not the UI app
            expect(res.status).not.toBe(200);
        });
    });
});
