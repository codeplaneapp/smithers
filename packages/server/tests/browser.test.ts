import { describe, expect, test } from "bun:test";
import { createBrowserSessionRegistry } from "../src/browser.js";
import { createRequire } from "node:module";
import { createServer } from "node:http";

const page = { url: () => "http://example.com/", title: async () => "Example", evaluate: async () => false, goto: async () => {}, goBack: async () => {}, goForward: async () => {}, reload: async () => {}, mouse: { click: async () => {}, wheel: async () => {} }, keyboard: { press: async () => {} }, getByRole: () => ({ click: async () => {}, fill: async () => {} }) };
const playwright = { chromium: { launch: async () => ({ newContext: async () => ({ newPage: async () => page, route: async () => {}, close: async () => {} }), close: async () => {} }) } };

describe("browser session registry", () => {
  test("deduplicates actions and fences stale revisions", async () => {
    const registry = createBrowserSessionRegistry({ playwright });
    const session = await registry.create({ source: { kind: "url", url: "https://example.com" } });
    const first = await registry.act({ sessionId: session.sessionId, actionId: "a", action: { kind: "reload" } });
    expect((await registry.act({ sessionId: session.sessionId, actionId: "a", action: { kind: "reload" } })).revision).toBe(first.revision);
    await expect(registry.act({ sessionId: session.sessionId, actionId: "b", expectedRevision: 0, action: { kind: "reload" } })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });
  test("blocks private URLs and enforces quota", async () => {
    const registry = createBrowserSessionRegistry({ playwright, limits: { maxConcurrent: 1 } });
    await expect(registry.create({ source: { kind: "url", url: "http://127.0.0.1:1" } })).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    await registry.create({ source: { kind: "dev-server", port: 3000, path: "/" } });
    await expect(registry.create({ source: { kind: "url", url: "https://example.com" } })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });
  test("drives a real headless Chromium page", async () => {
    const require = createRequire(new URL("../../../apps/cli/package.json", import.meta.url));
    const { chromium } = require("playwright");
    const server = createServer((_request, response) => response.end(`<button>Continue</button><button>Same</button><button>Same</button><input data-testid="password" type="password"><p>${"x".repeat(21000)}</p>`));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const registry = createBrowserSessionRegistry({ playwright: { chromium } });
    try {
      const session = await registry.create({ source: { kind: "dev-server", port, path: "/" } });
      expect(session.status).toBe("ready");
      const result = await registry.act({ sessionId: session.sessionId, actionId: "smoke", action: { kind: "click", locator: { role: "button", name: "Continue" } } });
      expect(result.revision).toBe(1);
      const typed = await registry.act({ sessionId: session.sessionId, actionId: "password", action: { kind: "type", locator: { testId: "password" }, text: "secret" } });
      expect(typed.outcome).toMatchObject({ redacted: true, length: 6 });
      const context = await registry.context({ sessionId: session.sessionId, include: ["visible-text", "recent-actions"] });
      expect(context.visibleTextTruncated).toBe(true);
      expect(context.recentActions.at(-1).action.text).toMatchObject({ redacted: true });
      const picked = await registry.pick({ sessionId: session.sessionId, point: { x: 90, y: 10 } });
      expect(picked.locator).toHaveProperty("css");
      await registry.close(session.sessionId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
