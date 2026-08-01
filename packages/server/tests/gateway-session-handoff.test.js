/**
 * Browser session handoff (#gateway-auth): browsers cannot send the
 * Authorization header on top-level navigations or WebSocket upgrades, so
 * `GET /v1/auth/session` exchanges a bearer for an HttpOnly session cookie
 * and lands on the clean URL. Every authenticated surface — UI pages, UI
 * assets, the HTTP RPC/API, and the WS `connect` frame — must accept the
 * cookie as an alternative to the Bearer header.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { WebSocket } from "ws";
import { Gateway, GATEWAY_SESSION_COOKIE } from "../src/gateway.js";

const TOKEN = "session-token";

const TOKEN_AUTH = {
  mode: "token",
  tokens: {
    [TOKEN]: {
      role: "operator",
      scopes: ["*"],
      userId: "user:test",
    },
  },
};

function getPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Gateway did not expose a port");
  }
  return address.port;
}

/** @type {Gateway | undefined} */
let gateway;

afterEach(async () => {
  if (gateway) {
    await gateway.close();
    gateway = undefined;
  }
});

async function listenWithAuth() {
  gateway = new Gateway({ ui: true, auth: TOKEN_AUTH });
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  return getPort(server);
}

describe("gateway browser session handoff", () => {
  test("exchanges a bearer for an HttpOnly cookie and lands on the clean URL", async () => {
    const port = await listenWithAuth();
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/auth/session?token=${TOKEN}&next=${encodeURIComponent("/console?runId=r1")}`,
    );
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${GATEWAY_SESSION_COOKIE}=${TOKEN}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const html = await response.text();
    // location.replace (not a 30x) so the token URL leaves history.
    expect(html).toContain("location.replace");
    expect(html).toContain("/console?runId=r1");
    expect(html).not.toContain(TOKEN);
  });

  test("accepts a bearer header (or an existing cookie) when no ?token is present", async () => {
    const port = await listenWithAuth();
    const viaHeader = await fetch(`http://127.0.0.1:${port}/v1/auth/session?next=%2Fconsole`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.headers.get("set-cookie") ?? "").toContain(`${GATEWAY_SESSION_COOKIE}=${TOKEN}`);
    // Plain HTTP must NOT carry Secure, or the browser drops the cookie.
    expect(viaHeader.headers.get("set-cookie") ?? "").not.toContain("Secure");

    const viaCookie = await fetch(`http://127.0.0.1:${port}/v1/auth/session?next=%2Fconsole`, {
      headers: { cookie: `${GATEWAY_SESSION_COOKIE}=${TOKEN}` },
    });
    expect(viaCookie.status).toBe(200);
  });

  test("rejects an invalid token with 401 and no cookie", async () => {
    const port = await listenWithAuth();
    const response = await fetch(`http://127.0.0.1:${port}/v1/auth/session?token=wrong&next=%2Fconsole`);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("never becomes an open redirect: off-path next falls back to /", async () => {
    const port = await listenWithAuth();
    for (const next of ["https://evil.example", "//evil.example", "javascript:alert(1)"]) {
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/auth/session?token=${TOKEN}&next=${encodeURIComponent(next)}`,
      );
      const html = await response.text();
      expect(html).not.toContain("evil.example");
      expect(html).not.toContain("javascript:alert");
      expect(html).toContain('location.replace("/")');
    }
  });

  test("the session cookie unlocks UI pages, assets, and the HTTP RPC", async () => {
    const port = await listenWithAuth();
    const cookie = `${GATEWAY_SESSION_COOKIE}=${TOKEN}`;

    const page = await fetch(`http://127.0.0.1:${port}/console`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Smithers Operator Console</title>");

    const asset = await fetch(`http://127.0.0.1:${port}/console/__smithers_ui/client.js`, {
      headers: { cookie },
    });
    expect(asset.status).toBe(200);

    const rpc = await fetch(`http://127.0.0.1:${port}/v1/rpc/listWorkflows`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(rpc.status).toBe(200);
    const frame = await rpc.json();
    expect(frame.ok).toBe(true);
  });

  test("a bad cookie does not authenticate", async () => {
    const port = await listenWithAuth();
    const response = await fetch(`http://127.0.0.1:${port}/console`, {
      headers: { cookie: `${GATEWAY_SESSION_COOKIE}=wrong` },
    });
    expect(response.status).toBe(401);
  });

  test("WS connect authenticates from the session cookie when the frame carries no token", async () => {
    const port = await listenWithAuth();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { cookie: `${GATEWAY_SESSION_COOKIE}=${TOKEN}` },
    });
    ws.on("error", () => {});
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const id = "connect-cookie";
    const response = new Promise((resolve, reject) => {
      const onMessage = (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "res" && message.id === id) {
          ws.off("message", onMessage);
          resolve(message);
        }
      };
      ws.on("message", onMessage);
      ws.once("close", () => reject(new Error("Socket closed before connect response")));
    });
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "connect",
        params: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "session-handoff-test", version: "1.0.0", platform: "bun-test" },
        },
      }),
    );
    const frame = await response;
    expect(frame.ok).toBe(true);
    expect(frame.payload.auth.role).toBe("operator");
    ws.close();
  });

  test("no-auth gateway redirects through the handoff without setting a cookie", async () => {
    gateway = new Gateway({ ui: true });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);
    const response = await fetch(`http://127.0.0.1:${port}/v1/auth/session?next=%2Fconsole`);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain('location.replace("/console")');
  });
});

describe("gateway session handoff — security regressions", () => {
  test("rejects a backslash-authority `next` as an open redirect (lands on /)", async () => {
    const port = await listenWithAuth();
    // /%5Cevil.tld decodes to /\evil.tld, which a browser resolves to
    // http://evil.tld. The handoff must never emit it.
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/auth/session?token=${TOKEN}&next=${encodeURIComponent("/\\evil.example.com/x")}`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("evil.example.com");
    expect(html).toContain('location.replace("/")');
  });

  test("rejects a protocol-relative `next` (//evil) as an open redirect", async () => {
    const port = await listenWithAuth();
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/auth/session?token=${TOKEN}&next=${encodeURIComponent("//evil.example.com/x")}`,
    );
    const html = await response.text();
    expect(html).not.toContain("evil.example.com");
    expect(html).toContain('location.replace("/")');
  });

  test("refuses a cross-origin cookie-authenticated RPC even with an empty allow-list", async () => {
    const port = await listenWithAuth();
    // Simulate a same-site sibling origin's browser page: the SameSite=Lax
    // cookie rides along, but there is no Authorization header.
    const res = await fetch(`http://127.0.0.1:${port}/v1/rpc/listRuns`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${GATEWAY_SESSION_COOKIE}=${TOKEN}`,
        origin: "http://evil.example.com",
      },
      body: JSON.stringify({}),
    });
    const frame = await res.json().catch(() => null);
    expect(frame?.ok).toBe(false);
  });

  test("still accepts a cookie-authenticated request from the gateway's own origin", async () => {
    const port = await listenWithAuth();
    const res = await fetch(`http://127.0.0.1:${port}/v1/rpc/listRuns`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${GATEWAY_SESSION_COOKIE}=${TOKEN}`,
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({}),
    });
    const frame = await res.json().catch(() => null);
    expect(frame?.ok).toBe(true);
  });
});
