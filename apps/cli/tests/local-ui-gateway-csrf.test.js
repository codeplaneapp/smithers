import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalUiServer } from "../src/localUiServer.js";

// The local UI reverse-proxies gateway paths, rewriting Host/Origin to loopback.
// A cross-origin browser must be rejected BEFORE that rewrite, otherwise it
// reaches the unauthenticated local gateway looking same-origin (CSRF against
// run control). gatewayBase points at a dead port so an ALLOWED request 502s
// while a BLOCKED one 403s without ever proxying.
let tempDir;
let server;
let baseUrl;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "smithers-csrf-"));
  mkdirSync(join(tempDir, "dist"));
  writeFileSync(join(tempDir, "dist", "index.html"), "<main>ui</main>");
  server = await startLocalUiServer({
    distDir: join(tempDir, "dist"),
    gatewayBase: "http://127.0.0.1:1",
    conciergePort: 1,
    port: 0,
    workspaceRoot: tempDir,
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

async function rpc(origin) {
  return fetch(`${baseUrl}/v1/rpc/launchRun`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      ...(origin === undefined ? {} : { origin }),
    },
    body: JSON.stringify({ params: {} }),
  });
}

describe("local UI gateway reverse-proxy CSRF guard", () => {
  test("rejects a cross-origin browser RPC with 403 (before proxying)", async () => {
    const response = await rpc("https://evil.example.com");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Cross-origin");
  });

  test("allows a same-origin RPC through to the proxy (502 from the dead gateway, not 403)", async () => {
    const response = await rpc(baseUrl);
    expect(response.status).not.toBe(403);
  });

  test("allows an Origin-less request (CLI / same-origin GET) through to the proxy", async () => {
    const response = await rpc(undefined);
    expect(response.status).not.toBe(403);
  });

  test("rejects an Origin-less gateway request with a rebound Host", async () => {
    const response = await fetch(`${baseUrl}/v1/rpc/listRuns`, {
      headers: { host: "evil.example.com" },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Cross-origin");
  });

  test("rejects an Origin-less concierge request with a rebound Host", async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      headers: { host: "evil.example.com" },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Cross-origin");
  });

  test("rejects a rebound Host on WebSocket upgrades before proxying", async () => {
    let upgradeCount = 0;
    const gateway = createServer();
    gateway.on("upgrade", () => {
      upgradeCount += 1;
    });
    await new Promise((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen(0, "127.0.0.1", resolve);
    });
    const gatewayAddress = gateway.address();
    if (!gatewayAddress || typeof gatewayAddress === "string") {
      throw new Error("gateway did not bind");
    }

    const proxy = await startLocalUiServer({
      distDir: join(tempDir, "dist"),
      gatewayBase: `http://127.0.0.1:${gatewayAddress.port}`,
      port: 0,
      workspaceRoot: tempDir,
    });
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") {
      throw new Error("proxy did not bind");
    }

    const socket = connect(proxyAddress.port, "127.0.0.1");
    socket.on("error", () => {});
    const closed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("WebSocket upgrade socket was not closed"));
      }, 2_000);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    socket.once("connect", () => {
      socket.write(
        "GET /v1/rpc HTTP/1.1\r\n" +
          "Host: evil.example.com\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n\r\n",
      );
    });

    try {
      await closed;
      expect(upgradeCount).toBe(0);
    } finally {
      socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
      await new Promise((resolve) => gateway.close(resolve));
    }
  });
});
