import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHttpTool } from "../src/http/createHttpTool.js";

/** AI SDK passes these to `execute`; the HTTP tool ignores them. */
const callOptions = { toolCallId: "test-call", messages: [] };

/** Two REAL servers: the authorized API and an attacker redirect target. */
let apiServer;
let apiUrl;
let attackerServer;
let attackerUrl;

/**
 * Every request either server receives, in arrival order, so tests can
 * assert exactly which secret headers rode each hop of a redirect chain.
 * @type {{ server: "api" | "attacker"; pathname: string; method: string; authorization: string | null; apiKey: string | null; defaultSecret: string | null; body: string }[]}
 */
let requests = [];

/**
 * @param {"api" | "attacker"} server
 * @param {Request} request
 */
async function record(server, request) {
  const entry = {
    server,
    pathname: new URL(request.url).pathname,
    method: request.method,
    authorization: request.headers.get("authorization"),
    apiKey: request.headers.get("x-api-key"),
    defaultSecret: request.headers.get("x-default-secret"),
    body: await request.text(),
  };
  requests.push(entry);
  return entry;
}

/**
 * @param {number} status
 * @param {string} location
 */
function redirect(status, location) {
  return new Response(null, { status, headers: { location } });
}

/** @param {Request} request */
async function apiHandler(request) {
  const entry = await record("api", request);
  switch (entry.pathname) {
    case "/same/hop1":
      return redirect(302, `${apiUrl}/final`);
    case "/cross/hop1":
      return redirect(302, `${attackerUrl}/steal`);
    case "/multi/hop1":
      return redirect(302, `${apiUrl}/multi/hop2`);
    case "/multi/hop2":
      return redirect(302, `${attackerUrl}/steal`);
    case "/bounce/out":
      return redirect(302, `${attackerUrl}/bounce/relay`);
    case "/post/hop303":
      return redirect(303, `${apiUrl}/final`);
    case "/post/hop307":
      return redirect(307, `${apiUrl}/final`);
    case "/loop":
      return redirect(302, `${apiUrl}/loop`);
    case "/final":
      return Response.json(entry);
    default:
      return new Response("not found", { status: 404 });
  }
}

/** @param {Request} request */
async function attackerHandler(request) {
  const entry = await record("attacker", request);
  switch (entry.pathname) {
    case "/steal":
      return Response.json(entry);
    case "/bounce/relay":
      return redirect(302, `${apiUrl}/final`);
    default:
      return new Response("not found", { status: 404 });
  }
}

beforeAll(() => {
  apiServer = Bun.serve({ port: 0, fetch: apiHandler });
  apiUrl = `http://${apiServer.hostname}:${apiServer.port}`;
  attackerServer = Bun.serve({ port: 0, fetch: attackerHandler });
  attackerUrl = `http://${attackerServer.hostname}:${attackerServer.port}`;
});

afterAll(() => {
  apiServer?.stop(true);
  attackerServer?.stop(true);
});

beforeEach(() => {
  requests = [];
});

/** The tool under test, configured like an integration holding secrets. */
function secretTool(extra = {}) {
  return createHttpTool({
    baseUrl: apiUrl,
    defaultHeaders: { "x-default-secret": "configured-secret" },
    ...extra,
  });
}

/** Caller-side secrets the model attaches to the request. */
const callerSecrets = {
  headers: { "x-api-key": "caller-secret" },
  auth: /** @type {const} */ ({ type: "bearer", token: "tok-123" }),
};

describe("createHttpTool redirects", () => {
  test("same-origin redirect preserves caller headers, auth, and default headers", async () => {
    const result = await secretTool().execute({ url: `${apiUrl}/same/hop1`, ...callerSecrets }, callOptions);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      pathname: "/final",
      authorization: "Bearer tok-123",
      apiKey: "caller-secret",
      defaultSecret: "configured-secret",
    });
    expect(requests.map((r) => r.server)).toEqual(["api", "api"]);
  });

  test("cross-origin redirect strips every secret header before the attacker hop", async () => {
    const result = await secretTool().execute({ url: `${apiUrl}/cross/hop1`, ...callerSecrets }, callOptions);

    // The first (authorized) hop carried the secrets…
    expect(requests[0]).toMatchObject({
      server: "api",
      authorization: "Bearer tok-123",
      apiKey: "caller-secret",
      defaultSecret: "configured-secret",
    });
    // …the attacker hop got none of them.
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      pathname: "/steal",
      authorization: null,
      apiKey: null,
      defaultSecret: null,
    });
  });

  test("cross-origin hops are stripped even when no allowlist is configured", async () => {
    const http = createHttpTool({ defaultHeaders: { "x-default-secret": "configured-secret" } });
    const result = await http.execute({ url: `${apiUrl}/cross/hop1`, ...callerSecrets }, callOptions);

    // With no allowlist the DIRECT request still gets the defaults (unchanged
    // behavior), but the redirect hop to another origin never does.
    expect(requests[0].defaultSecret).toBe("configured-secret");
    expect(result.body).toMatchObject({ authorization: null, apiKey: null, defaultSecret: null });
  });

  test("multi-hop chain keeps secrets on same-origin hops and bares the cross-origin tail", async () => {
    const result = await secretTool().execute({ url: `${apiUrl}/multi/hop1`, ...callerSecrets }, callOptions);

    expect(requests.map((r) => `${r.server}${r.pathname}`)).toEqual([
      "api/multi/hop1",
      "api/multi/hop2",
      "attacker/steal",
    ]);
    expect(requests[0].authorization).toBe("Bearer tok-123");
    expect(requests[1].authorization).toBe("Bearer tok-123");
    expect(requests[1].defaultSecret).toBe("configured-secret");
    expect(result.body).toMatchObject({ authorization: null, apiKey: null, defaultSecret: null });
  });

  test("allowlisted cross-origin redirect target still receives the secrets", async () => {
    const http = secretTool({ allowedHosts: [new URL(attackerUrl).host] });
    const result = await http.execute({ url: `${apiUrl}/cross/hop1`, ...callerSecrets }, callOptions);

    expect(result.body).toMatchObject({
      pathname: "/steal",
      authorization: "Bearer tok-123",
      apiKey: "caller-secret",
      defaultSecret: "configured-secret",
    });
  });

  test("bouncing through an attacker re-attaches secrets only back on the original origin", async () => {
    const result = await secretTool().execute({ url: `${apiUrl}/bounce/out`, ...callerSecrets }, callOptions);

    const relay = requests.find((r) => r.pathname === "/bounce/relay");
    expect(relay).toMatchObject({ server: "attacker", authorization: null, apiKey: null, defaultSecret: null });
    expect(result.body).toMatchObject({
      pathname: "/final",
      authorization: "Bearer tok-123",
      apiKey: "caller-secret",
      defaultSecret: "configured-secret",
    });
  });

  test("303 converts a POST into a body-less GET across the redirect", async () => {
    const result = await secretTool().execute(
      { url: `${apiUrl}/post/hop303`, method: "POST", body: { hello: "world" }, ...callerSecrets },
      callOptions,
    );

    expect(requests[0]).toMatchObject({ method: "POST", body: JSON.stringify({ hello: "world" }) });
    expect(result.body).toMatchObject({ pathname: "/final", method: "GET", body: "" });
  });

  test("307 preserves method and body on a same-origin redirect", async () => {
    const result = await secretTool().execute(
      { url: `${apiUrl}/post/hop307`, method: "POST", body: { hello: "world" }, ...callerSecrets },
      callOptions,
    );

    expect(result.body).toMatchObject({
      pathname: "/final",
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      authorization: "Bearer tok-123",
    });
  });

  test("caps runaway redirect chains at the fetch spec's 20-hop limit", async () => {
    await expect(secretTool().execute({ url: `${apiUrl}/loop` }, callOptions)).rejects.toThrow(/exceeded 20 redirects/);
    // 1 original request + 20 followed hops, then the budget trips.
    expect(requests.length).toBe(21);
  });
});
