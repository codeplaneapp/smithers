import { afterEach, describe, expect, test } from "bun:test";
import { createSession } from "../../action/src/createSession";

interface FixtureService {
  url: string;
  stop(): void;
}

function serveSession(handler: (req: Request) => Promise<Response> | Response): FixtureService {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => handler(req as unknown as Request),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      server.stop(true);
    },
  };
}

describe("createSession", () => {
  let svc: FixtureService | null = null;
  afterEach(() => {
    svc?.stop();
    svc = null;
  });

  test("200: returns the destructured session payload", async () => {
    svc = serveSession(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/api/sessions");
      expect(req.headers.get("content-type")).toBe("application/json");
      const body = (await req.json()) as { oidcToken: string; pr?: number };
      expect(body.oidcToken).toBe("fake.jwt.token");
      expect(body.pr).toBe(42);
      return Response.json({
        token: "srs_abc",
        expiresAt: 1700000000000,
        mode: "auto",
        plan: { prsPerMonth: 50, used: 3 },
        anthropicBaseUrl: "https://review.test/anthropic",
        publishUrl: "https://review.test",
      });
    });
    const outcome = await createSession({
      serviceUrl: svc.url,
      oidcToken: "fake.jwt.token",
      pr: 42,
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.token).toBe("srs_abc");
      expect(outcome.mode).toBe("auto");
      expect(outcome.plan).toEqual({ prsPerMonth: 50, used: 3 });
      expect(outcome.anthropicBaseUrl).toBe("https://review.test/anthropic");
      expect(outcome.publishUrl).toBe("https://review.test");
    }
  });

  test("402: maps to quota-exhausted", async () => {
    svc = serveSession(() => new Response("monthly PR quota exhausted", { status: 402 }));
    const outcome = await createSession({ serviceUrl: svc.url, oidcToken: "x" });
    expect(outcome.status).toBe("quota-exhausted");
    if (outcome.status === "quota-exhausted") {
      expect(outcome.message).toContain("quota");
    }
  });

  test("403: maps to not-registered", async () => {
    svc = serveSession(() => new Response("repo not registered", { status: 403 }));
    const outcome = await createSession({ serviceUrl: svc.url, oidcToken: "x" });
    expect(outcome.status).toBe("not-registered");
    if (outcome.status === "not-registered") {
      expect(outcome.message).toContain("registered");
    }
  });

  test("500: maps to a generic error", async () => {
    svc = serveSession(() => new Response("boom", { status: 500 }));
    const outcome = await createSession({ serviceUrl: svc.url, oidcToken: "x" });
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.message).toMatch(/500/);
    }
  });

  test("strips a trailing slash from serviceUrl", async () => {
    svc = serveSession(async (req) => {
      expect(new URL(req.url).pathname).toBe("/api/sessions");
      return Response.json({
        token: "srs_t",
        expiresAt: 0,
        mode: "comment",
        plan: { prsPerMonth: 1, used: 0 },
        anthropicBaseUrl: "https://review.test/anthropic",
        publishUrl: "https://review.test",
      });
    });
    const outcome = await createSession({ serviceUrl: `${svc.url}/`, oidcToken: "x" });
    expect(outcome.status).toBe("ok");
  });

  test("omits pr from the body when not provided", async () => {
    svc = serveSession(async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ oidcToken: "x" });
      return Response.json({
        token: "srs_t",
        expiresAt: 0,
        mode: "auto",
        plan: { prsPerMonth: 1, used: 0 },
        anthropicBaseUrl: "https://review.test/anthropic",
        publishUrl: "https://review.test",
      });
    });
    const outcome = await createSession({ serviceUrl: svc.url, oidcToken: "x" });
    expect(outcome.status).toBe("ok");
  });

  test("network error surfaces as error outcome", async () => {
    // Stand up + immediately stop a server to claim a port, then fail-fast.
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const url = `http://127.0.0.1:${server.port}`;
    server.stop(true);
    const outcome = await createSession({ serviceUrl: url, oidcToken: "x" });
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      expect(outcome.message).toMatch(/request failed/);
    }
  });

  test("rejects hostile endpoints, invalid schemas, invalid UTF-8, and oversized responses", async () => {
    expect((await createSession({
      serviceUrl: "https://user:secret@review.test", oidcToken: "x",
      fetchImpl: (async () => { throw new Error("must not run"); }) as unknown as typeof fetch,
    })).status).toBe("error");

    const invalidSchema = await createSession({
      serviceUrl: "https://review.test", oidcToken: "x",
      fetchImpl: (async () => Response.json({ token: "unbound" })) as unknown as typeof fetch,
    });
    expect(invalidSchema).toMatchObject({ status: "error" });

    const invalidUtf8 = await createSession({
      serviceUrl: "https://review.test", oidcToken: "x",
      fetchImpl: (async () => new Response(Uint8Array.from([0xff]))) as unknown as typeof fetch,
    });
    expect(invalidUtf8.status).toBe("error");

    const oversized = await createSession({
      serviceUrl: "https://review.test", oidcToken: "x",
      fetchImpl: (async () => new Response("x", { headers: { "content-length": "70000" } })) as unknown as typeof fetch,
    });
    expect(oversized.status).toBe("error");
  });

  test("enforces its deadline when an injected transport ignores AbortSignal", async () => {
    const started = Date.now();
    const outcome = await createSession({
      serviceUrl: "https://review.test", oidcToken: "x", deadlineMs: 10,
      fetchImpl: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ status: "error" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
