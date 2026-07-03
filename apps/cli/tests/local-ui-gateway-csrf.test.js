import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
