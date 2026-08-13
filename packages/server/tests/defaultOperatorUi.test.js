import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Gateway } from "../src/gateway.js";
import { DEFAULT_OPERATOR_UI_ENTRY, loadDefaultOperatorUiClientJs } from "../src/gatewayUi/defaultOperatorUi.js";
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

    test("loadDefaultOperatorUiClientJs resolves a non-empty IIFE string", async () => {
      const clientJs = await loadDefaultOperatorUiClientJs();
      expect(typeof clientJs).toBe("string");
      expect(clientJs.length).toBeGreaterThan(1000);
      // The stringified client is wrapped in an IIFE: (function defaultOperatorUiClient(){...})();
      expect(clientJs).toStartWith("(function defaultOperatorUiClient(");
      expect(clientJs).toEndWith("();\n");
    });

    test("the operator UI client is syntactically valid JavaScript", async () => {
      // new Function() parses the body and throws SyntaxError if malformed
      const clientJs = await loadDefaultOperatorUiClientJs();
      expect(() => new Function(clientJs)).not.toThrow();
    });

    test("the operator UI client contains expected behavioral landmarks", async () => {
      const clientJs = await loadDefaultOperatorUiClientJs();
      expect(clientJs).toContain("smithers.gateway.console.token");
      expect(clientJs).toContain("sessionStorage");
      expect(clientJs).toContain("submitApproval");
      expect(clientJs).toContain("launchRun");
      expect(clientJs).toContain("listWorkflows");
      expect(clientJs).toContain("listRuns");
      expect(clientJs).toContain("setInterval");
    });

    test("the operator UI client inlines the style-guide theme CSS", async () => {
      const clientJs = await loadDefaultOperatorUiClientJs();
      expect(clientJs).not.toContain("__SMITHERS_WORKFLOW_UI_THEME_CSS__");
      expect(clientJs).toContain("--brand");
    });

    test("renderDefaultConsoleClient returns the operator UI client", async () => {
      expect(await renderDefaultConsoleClient()).toBe(await loadDefaultOperatorUiClientJs());
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
        try {
          rmSync(p, { force: true });
        } catch {}
        try {
          rmSync(`${p}-shm`, { force: true });
        } catch {}
        try {
          rmSync(`${p}-wal`, { force: true });
        } catch {}
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
      expect(body).toBe(await loadDefaultOperatorUiClientJs());
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
