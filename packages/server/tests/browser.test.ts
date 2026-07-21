import { describe, expect, test } from "bun:test";
import { createBrowserSessionRegistry } from "../src/browser.js";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway.js";

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
  test("coalesces a redirecting click into one journal entry and reaps idle sessions", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/start") return void response.writeHead(302, { location: "/final" }).end();
      response.end("<a href='/start'>Go</a>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const require = createRequire(new URL("../../../apps/cli/package.json", import.meta.url));
    const registry = createBrowserSessionRegistry({ limits: { idleTtlMs: 500, hardLifetimeMs: 5000 }, playwright: { chromium: require("playwright").chromium } });
    try {
      const session = await registry.create({ source: { kind: "dev-server", port, path: "/" } });
      const result = await registry.act({ sessionId: session.sessionId, actionId: "redirect", action: { kind: "click", locator: { role: "link", name: "Go" } } });
      expect(result.revision).toBe(1);
      expect((await registry.context({ sessionId: session.sessionId, include: ["recent-actions"] })).recentActions).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(await registry.list()).toHaveLength(0);
    } finally {
      await registry.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
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

  test("real gateway websocket drives Chromium and gates screencast frames", async () => {
    const fixture = createServer((_request, response) => response.end("<button data-testid='counter' onclick=\"document.body.dataset.count=(+(document.body.dataset.count||0)+1);document.querySelector('#value').textContent=document.body.dataset.count\">Count</button><button style='display:block;margin-top:20px'>Continue</button><input aria-label='Secret' type='password' oninput=\"console.log(this.value)\"><output id='value'>0</output>"));
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const port = (fixture.address() as { port: number }).port;
    const gateway = new Gateway({ browser: createBrowserSessionRegistry({ limits: { maxConcurrent: 1 }, playwright: { chromium: createRequire(new URL("../../../apps/cli/package.json", import.meta.url))("playwright").chromium } }) });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const address = server.address() as { port: number };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const frames: any[] = [];
    const pending = new Map<string, (value: any) => void>();
    socket.on("message", (raw) => { const frame = JSON.parse(String(raw)); if (frame.type === "event" && frame.event === "browser.frame") frames.push(frame.payload); if (frame.type === "res") pending.get(frame.id)?.(frame); });
    const request = (method: string, params: any) => new Promise<any>((resolve) => { const id = `${method}-${Math.random()}`; pending.set(id, resolve); socket.send(JSON.stringify({ type: "req", id, method, params })); });
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    await request("connect", { minProtocol: 1, maxProtocol: 1, client: { id: "browser-e2e", version: "1", platform: "test" }, subscribe: [] });
    const created = await request("createBrowserSession", { source: { kind: "dev-server", port, path: "/" } });
    expect(created.ok).toBe(true);
    const sessionId = created.payload.sessionId;
    const viewer = await fetch(`http://127.0.0.1:${address.port}/browser/${sessionId}/viewer?theme=dark&embed=1&hostOrigin=http%3A%2F%2Fexample.com`);
    expect(viewer.status).toBe(200);
    expect(await viewer.text()).toContain("Browser viewer");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(frames.some((frame) => frame.sessionId === sessionId)).toBe(false);
    await request("connect", { minProtocol: 1, maxProtocol: 1, client: { id: "browser-e2e", version: "1", platform: "test" }, subscribe: [`browser:${sessionId}`] });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(frames.some((frame) => frame.sessionId === sessionId)).toBe(true);
    const first = await request("browserAct", { sessionId, actionId: "counter", action: { kind: "click", locator: { testId: "counter" } } });
    const duplicate = await request("browserAct", { sessionId, actionId: "counter", action: { kind: "click", locator: { testId: "counter" } } });
    expect(duplicate.payload.revision).toBe(first.payload.revision);
    const afterDuplicate = await request("browserContext", { sessionId, include: ["visible-text"] });
    expect(afterDuplicate.payload.visibleText).toContain("1");
    const pickedByTestId = await request("browserPick", { sessionId, point: { x: 30, y: 10 } });
    expect(pickedByTestId.payload.locator).toEqual({ testId: "counter" });
    const pickedByRole = await request("browserPick", { sessionId, point: { x: 30, y: 50 } });
    expect(pickedByRole.payload.locator).toEqual({ role: "button", name: "Continue" });
    await request("browserAct", { sessionId, actionId: "password", action: { kind: "type", locator: { role: "textbox", name: "Secret" }, text: "s3cr3t" } });
    const safeContext = await request("browserContext", { sessionId, include: ["console-summary", "network-summary", "recent-actions"] });
    expect(JSON.stringify(safeContext.payload)).not.toContain("s3cr3t");
    await expect(new Promise((resolve, reject) => { const id = "stale"; pending.set(id, resolve); socket.send(JSON.stringify({ type: "req", id, method: "browserAct", params: { sessionId, actionId: "stale-action", expectedRevision: 0, action: { kind: "reload" } } })); })).resolves.toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    await request("connect", { minProtocol: 1, maxProtocol: 1, client: { id: "browser-e2e", version: "1", platform: "test" }, subscribe: [] });
    const count = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(frames.length).toBe(count);
    await request("closeBrowserSession", { sessionId });
    expect((await request("createBrowserSession", { source: { kind: "url", url: "http://127.0.0.1:1" } })).error.code).toBe("SSRF_BLOCKED");
    const second = await request("createBrowserSession", { source: { kind: "dev-server", port, path: "/" } });
    expect(second.ok).toBe(true);
    expect((await request("createBrowserSession", { source: { kind: "dev-server", port, path: "/" } })).error.code).toBe("QUOTA_EXCEEDED");
    await request("closeBrowserSession", { sessionId: second.payload.sessionId });
    socket.close();
    await gateway.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }, 20_000);
});
