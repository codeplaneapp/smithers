import { afterEach, describe, expect, test } from "bun:test";
import { fetchOidcToken } from "../../action/src/fetchOidcToken";

const savedUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const savedToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

afterEach(() => {
  if (savedUrl === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = savedUrl;
  if (savedToken === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = savedToken;
});

describe("fetchOidcToken", () => {
  test("throws when env vars are missing", async () => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    await expect(fetchOidcToken()).rejects.toThrow("ACTIONS_ID_TOKEN_REQUEST_URL");
  });

  test("throws when only REQUEST_URL is set", async () => {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "http://example.invalid";
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    await expect(fetchOidcToken()).rejects.toThrow("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  });

  test("makes a real HTTP request and returns the token value", async () => {
    // Use a container object to capture request details — TypeScript does not
    // narrow object properties via control-flow analysis the way it narrows
    // let-bindings, so this avoids false "type never" errors.
    const capture: { url?: string; auth?: string } = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        capture.url = req.url;
        capture.auth = req.headers.get("authorization") ?? "";
        return Response.json({ value: "oidc.jwt.token" });
      },
    });

    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `http://127.0.0.1:${server.port}`;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runner_token";

    try {
      const token = await fetchOidcToken();
      expect(token).toBe("oidc.jwt.token");
      expect(capture.auth).toBe("Bearer runner_token");
      expect(capture.url).toContain("audience=smithers-review");
    } finally {
      server.stop(true);
    }
  });

  test("passes a custom audience in the query string", async () => {
    const capture: { url?: string } = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        capture.url = req.url;
        return Response.json({ value: "oidc.custom.token" });
      },
    });

    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `http://127.0.0.1:${server.port}`;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runner_token";

    try {
      const token = await fetchOidcToken({ audience: "my-service" });
      expect(token).toBe("oidc.custom.token");
      expect(capture.url).toContain("audience=my-service");
      expect(capture.url).not.toContain("smithers-review");
    } finally {
      server.stop(true);
    }
  });

  test("throws when the HTTP response is not ok", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("forbidden", { status: 403 }),
    });

    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `http://127.0.0.1:${server.port}`;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runner_token";

    try {
      await expect(fetchOidcToken()).rejects.toThrow("HTTP 403");
    } finally {
      server.stop(true);
    }
  });

  test("throws when value is absent from the response body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ token: "wrong_field" }),
    });

    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `http://127.0.0.1:${server.port}`;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runner_token";

    try {
      await expect(fetchOidcToken()).rejects.toThrow("missing `value`");
    } finally {
      server.stop(true);
    }
  });

  test("custom fetchImpl is used instead of global fetch", async () => {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "http://unreachable.invalid";
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runner_token";

    const fakeImpl = async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ value: "injected-token" });

    const token = await fetchOidcToken({ fetchImpl: fakeImpl as typeof fetch });
    expect(token).toBe("injected-token");
  });

  test("appends audience with & when URL already has a query string", async () => {
    const capture: { url?: string } = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        capture.url = req.url;
        return Response.json({ value: "tok" });
      },
    });

    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `http://127.0.0.1:${server.port}?existing=1`;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runner_token";

    try {
      await fetchOidcToken();
      expect(capture.url).toContain("existing=1");
      expect(capture.url).toContain("audience=smithers-review");
      // Should use & not ? since there is already a query string
      expect(capture.url).toContain("existing=1&audience=smithers-review");
    } finally {
      server.stop(true);
    }
  });
});
