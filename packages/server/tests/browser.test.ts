import { describe, expect, test } from "bun:test";
import { createBrowserSessionRegistry } from "../src/browser.js";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { request as requestHttp } from "node:http";
import { connect as connectTcp } from "node:net";
import { WebSocket } from "ws";
import { Gateway } from "../src/gateway.js";

const page = { url: () => "http://example.com/", title: async () => "Example", evaluate: async () => false, goto: async () => {}, goBack: async () => {}, goForward: async () => {}, reload: async () => {}, mouse: { click: async () => {}, wheel: async () => {} }, keyboard: { press: async () => {} }, getByRole: () => ({ click: async () => {}, fill: async () => {} }) };
const playwright = { chromium: { launch: async () => ({ newContext: async () => ({ newPage: async () => page, route: async () => {}, close: async () => {} }), close: async () => {} }) } };

describe("browser session registry", () => {
  test("deduplicates actions and fences stale revisions", async () => {
    const registry = createBrowserSessionRegistry({ playwright });
    expect(registry.getArtifact).toBeUndefined();
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
  test("pins DNS across a real proxied redirect and subresource fetch", async () => {
    let publicRequests = 0;
    let privateRequests = 0;
    const fixture = createServer((request, response) => {
      publicRequests += 1;
      if (request.url === "/") return void response.writeHead(302, { location: "/page" }).end();
      response.end(request.url === "/page" ? "<img src='/private'>page" : "fixture");
    });
    const privateFixture = createServer(() => { privateRequests += 1; });
    await Promise.all([
      new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => privateFixture.listen(0, "127.0.0.1", resolve)),
    ]);
    const fixturePort = (fixture.address() as { port: number }).port;
    const privatePort = (privateFixture.address() as { port: number }).port;
    const lookups: string[] = [];
    let proxyServer: string;
    const connectedAddresses: string[] = [];
    const resolveHost = async (host: string) => {
      lookups.push(host);
      return lookups.length === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
    };
    const fetchThroughProxy = async (url: string): Promise<{ status: number; headers: Headers; body: string }> => {
      const proxy = new URL(proxyServer);
      const response = await new Promise<{ status: number; headers: Headers; body: string }>((resolve, reject) => {
        const request = requestHttp({ hostname: proxy.hostname, port: Number(proxy.port), path: url, headers: { host: new URL(url).host } }, (result) => {
          const chunks: Buffer[] = [];
          result.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          result.on("end", () => resolve({ status: result.statusCode || 0, headers: new Headers(result.headers as Record<string, string>), body: Buffer.concat(chunks).toString() }));
        });
        request.on("error", reject);
        request.end();
      });
      if (response.status >= 300 && response.status < 400) return fetchThroughProxy(new URL(response.headers.get("location")!, url).toString());
      const body = response.body;
      const resource = body.match(/src='([^']+)'/)?.[1];
      if (resource) await fetchThroughProxy(new URL(resource, url).toString());
      return { ...response, body };
    };
    const rebindingPlaywright = { chromium: { launch: async (options: any) => {
      proxyServer = options.proxy.server;
      return { newContext: async () => ({ newPage: async () => ({ ...page, goto: (url: string) => fetchThroughProxy(url) }), close: async () => {} }), close: async () => {} };
    } } };
    const connect = (port: number, address: string) => {
      connectedAddresses.push(address);
      return connectTcp(port === 80 ? (address === "93.184.216.34" ? fixturePort : privatePort) : privatePort, "127.0.0.1");
    };
    const request = (options: any, callback: any) => {
      connectedAddresses.push(options.hostname);
      return requestHttp({ ...options, hostname: "127.0.0.1", port: options.hostname === "93.184.216.34" ? fixturePort : privatePort }, callback);
    };
    const registry = createBrowserSessionRegistry({ playwright: rebindingPlaywright, resolveHost, connect, request });
    try {
      const session = await registry.create({ source: { kind: "url", url: "http://rebound.example/" } });
      expect(session.status).toBe("ready");
      expect(publicRequests).toBe(3);
      expect(privateRequests).toBe(0);
      expect(connectedAddresses).toEqual(["93.184.216.34", "93.184.216.34", "93.184.216.34"]);
      expect(lookups).toEqual(["rebound.example"]);
      await registry.close(session.sessionId);
    } finally {
      await registry.shutdown();
      await Promise.all([
        new Promise<void>((resolve) => fixture.close(() => resolve())),
        new Promise<void>((resolve) => privateFixture.close(() => resolve())),
      ]);
    }
  });
  test("rejects a mixed public and private DNS answer", async () => {
    const registry = createBrowserSessionRegistry({ playwright, resolveHost: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] });
    await expect(registry.create({ source: { kind: "url", url: "http://mixed.example/" } })).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });
  test("does not consume quota for invalid viewports", async () => {
    const registry = createBrowserSessionRegistry({ playwright, limits: { maxConcurrent: 1 } });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(registry.create({ source: { kind: "dev-server", port: 3000 }, viewport: { width: 0, height: 720 } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    const session = await registry.create({ source: { kind: "dev-server", port: 3000 } });
    expect(session.status).toBe("ready");
    await registry.close(session.sessionId);
  });

  test.each([
    ["newContext", "browser"],
    ["newPage", "context"],
  ])("cleans up when Playwright %s fails", async (failure, expectedClose) => {
    const closes = { browser: 0, context: 0 };
    let shouldFail = true;
    const browser = {
      newContext: async () => {
        if (shouldFail && failure === "newContext") { shouldFail = false; throw new Error("newContext failed"); }
        return {
          newPage: async () => { if (shouldFail && failure === "newPage") { shouldFail = false; throw new Error("newPage failed"); } return page; },
          close: async () => { closes.context += 1; },
        };
      },
      close: async () => { closes.browser += 1; },
    };
    const failingPlaywright = { chromium: { launch: async () => browser } };
    const registry = createBrowserSessionRegistry({ playwright: failingPlaywright, limits: { maxConcurrent: 1 } });

    await expect(registry.create({ source: { kind: "dev-server", port: 3000 } })).rejects.toMatchObject({ message: `${failure} failed` });
    expect(closes.browser).toBe(1);
    expect(closes.context).toBe(expectedClose === "context" ? 1 : 0);
    expect(await registry.list()).toHaveLength(0);

    const valid = await registry.create({ source: { kind: "dev-server", port: 3000 } });
    expect(valid.status).toBe("ready");
    await registry.close(valid.sessionId);
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
      // Viewer keyboard input arrives as one `press` per keystroke; with a
      // sensitive field focused the raw key must never reach the journal,
      // while non-printable keys (Enter) stay readable for debugging.
      await registry.act({ sessionId: session.sessionId, actionId: "focus-password", action: { kind: "click", locator: { testId: "password" } } });
      const pressed = await registry.act({ sessionId: session.sessionId, actionId: "press-masked", action: { kind: "press", key: "s" } });
      expect(pressed.outcome).toMatchObject({ ok: true, redacted: true });
      const entered = await registry.act({ sessionId: session.sessionId, actionId: "press-return", action: { kind: "press", key: "Enter" } });
      expect(entered.outcome).toMatchObject({ ok: true });
      expect(entered.outcome).not.toHaveProperty("redacted");
      const pressJournal = (await registry.context({ sessionId: session.sessionId, include: ["recent-actions"] })).recentActions;
      expect(pressJournal.find((entry: any) => entry.actionId === "press-masked").action.key).toMatchObject({ redacted: true, length: 1 });
      expect(pressJournal.find((entry: any) => entry.actionId === "press-return").action.key).toBe("Enter");
      expect(picked.screenshot?.data).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(Buffer.from(picked.screenshot.data, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      await registry.close(session.sessionId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("rejects screenshots over the 512 KiB inline limit", async () => {
    const oversizedPage = { ...page, screenshot: async () => Buffer.alloc(512 * 1024 + 1) };
    const registry = createBrowserSessionRegistry({ playwright: { chromium: { launch: async () => ({ newContext: async () => ({ newPage: async () => oversizedPage, route: async () => {}, close: async () => {} }), close: async () => {} }) } } });
    const session = await registry.create({ source: { kind: "url", url: "https://example.com" } });
    const context = await registry.context({ sessionId: session.sessionId, include: ["screenshot"] });
    expect(context.screenshot).toBeNull();
    expect(context.reason).toBe("CAPTURE_FAILED");
    await registry.close(session.sessionId);
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
    expect(afterDuplicate.payload.screenshot).toBeUndefined();
    const captured = await request("browserContext", { sessionId, include: ["screenshot"] });
    const capturedBytes = Buffer.from(captured.payload.screenshot.data, "base64");
    expect(capturedBytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(captured.payload.screenshot.ref).toBeUndefined();
    const pickedByTestId = await request("browserPick", { sessionId, point: { x: 30, y: 10 } });
    expect(pickedByTestId.payload.locator).toEqual({ testId: "counter" });
    const pickedByRole = await request("browserPick", { sessionId, point: { x: 30, y: 50 } });
    expect(pickedByRole.payload.locator).toEqual({ role: "button", name: "Continue" });
    for (let index = 0; index < 25; index += 1) await request("browserPick", { sessionId, point: { x: 30, y: 50 } });
    const selections = await request("browserContext", { sessionId, include: ["selections"] });
    expect(selections.payload.selections).toHaveLength(20);
    expect(selections.payload.selections.every((selection: any) => selection.screenshot === undefined && JSON.stringify(selection).includes("s3cr3t") === false)).toBe(true);
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
