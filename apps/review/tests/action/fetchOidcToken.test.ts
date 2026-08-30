import { afterEach, describe, expect, test } from "bun:test";
import { fetchOidcToken } from "../../action/src/fetchOidcToken.ts";

const missingEnv = {};
const runnerEnv = (url: string) => ({
  ACTIONS_ID_TOKEN_REQUEST_URL: url,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner_token",
});

afterEach(() => {
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
});

describe("fetchOidcToken", () => {
  test("throws when env vars are missing", async () => {
    await expect(fetchOidcToken({ env: missingEnv })).rejects.toThrow("ACTIONS_ID_TOKEN_REQUEST_URL");
  });

  test("throws when only REQUEST_URL is set", async () => {
    await expect(fetchOidcToken({ env: { ACTIONS_ID_TOKEN_REQUEST_URL: "http://example.invalid" } })).rejects.toThrow(
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    );
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

    const env = runnerEnv(`http://127.0.0.1:${server.port}`);

    try {
      const token = await fetchOidcToken({ env });
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

    const env = runnerEnv(`http://127.0.0.1:${server.port}`);

    try {
      const token = await fetchOidcToken({ audience: "my-service", env });
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

    const env = runnerEnv(`http://127.0.0.1:${server.port}`);

    try {
      await expect(fetchOidcToken({ env })).rejects.toThrow("HTTP 403");
    } finally {
      server.stop(true);
    }
  });

  test("throws when value is absent from the response body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ token: "wrong_field" }),
    });

    const env = runnerEnv(`http://127.0.0.1:${server.port}`);

    try {
      await expect(fetchOidcToken({ env })).rejects.toThrow("missing `value`");
    } finally {
      server.stop(true);
    }
  });

  test("custom fetchImpl is used instead of global fetch", async () => {
    const fakeImpl = async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ value: "injected-token" });

    const token = await fetchOidcToken({
      env: runnerEnv("http://unreachable.invalid"),
      fetchImpl: fakeImpl as typeof fetch,
    });
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

    const env = runnerEnv(`http://127.0.0.1:${server.port}?existing=1`);

    try {
      await fetchOidcToken({ env });
      expect(capture.url).toContain("existing=1");
      expect(capture.url).toContain("audience=smithers-review");
      // Should use & not ? since there is already a query string
      expect(capture.url).toContain("existing=1&audience=smithers-review");
    } finally {
      server.stop(true);
    }
  });
});
