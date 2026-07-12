import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createBraveSearchProvider } from "../src/web-search/createBraveSearchProvider.js";
import { createSerperSearchProvider } from "../src/web-search/createSerperSearchProvider.js";

// Real two-server harness (no mocked fetch): `primary` plays the configured
// search-API origin with a handler swapped per test, `attacker` is a second
// real origin that records every request it receives. Providers use the real
// global fetch, so these tests exercise the actual redirect handling.

/** @type {ReturnType<typeof Bun.serve>} */
let primary;
/** @type {string} */
let primaryUrl;
/** @type {(request: Request) => Response | Promise<Response>} */
let primaryHandler = () => new Response("no handler installed", { status: 500 });

/** @type {ReturnType<typeof Bun.serve>} */
let attacker;
/** @type {string} */
let attackerUrl;
/** @type {{ url: string; headers: Record<string, string> }[]} */
const attackerRequests = [];

beforeAll(() => {
  primary = Bun.serve({ port: 0, fetch: (request) => primaryHandler(request) });
  primaryUrl = `http://${primary.hostname}:${primary.port}`;
  attacker = Bun.serve({
    port: 0,
    fetch: (request) => {
      attackerRequests.push({ url: request.url, headers: Object.fromEntries(request.headers) });
      return Response.json({ web: { results: [] }, organic: [] });
    },
  });
  attackerUrl = `http://${attacker.hostname}:${attacker.port}`;
});

afterAll(() => {
  primary?.stop(true);
  attacker?.stop(true);
});

describe("createBraveSearchProvider redirect hardening", () => {
  const braveBody = { web: { results: [{ title: "T", url: "https://a.example", description: "d" }] } };

  test("follows a same-origin redirect and still sends the subscription token", async () => {
    /** @type {Record<string, string> | undefined} */
    let movedHeaders;
    primaryHandler = (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/search") {
        return new Response(null, { status: 302, headers: { location: `/moved${url.search}` } });
      }
      if (url.pathname === "/moved") {
        movedHeaders = Object.fromEntries(request.headers);
        return Response.json(braveBody);
      }
      return new Response("not found", { status: 404 });
    };
    const provider = createBraveSearchProvider({ apiKey: "brave-secret", baseUrl: `${primaryUrl}/search` });
    const results = await provider.search({ query: "q", maxResults: 2 });
    expect(results).toEqual([{ title: "T", url: "https://a.example", snippet: "d" }]);
    expect(movedHeaders?.["x-subscription-token"]).toBe("brave-secret");
  });

  test("follows a multi-hop same-origin chain, validating every hop", async () => {
    /** @type {string[]} */
    const hops = [];
    primaryHandler = (request) => {
      const url = new URL(request.url);
      hops.push(url.pathname);
      if (url.pathname === "/search") {
        return new Response(null, { status: 301, headers: { location: `${primaryUrl}/hop1` } });
      }
      if (url.pathname === "/hop1") return new Response(null, { status: 302, headers: { location: "/hop2" } });
      if (url.pathname === "/hop2") return Response.json(braveBody);
      return new Response("not found", { status: 404 });
    };
    const provider = createBraveSearchProvider({ apiKey: "brave-secret", baseUrl: `${primaryUrl}/search` });
    const results = await provider.search({ query: "q", maxResults: 2 });
    expect(results).toHaveLength(1);
    expect(hops).toEqual(["/search", "/hop1", "/hop2"]);
  });

  test("rejects a cross-origin redirect before the other origin sees a request", async () => {
    const before = attackerRequests.length;
    primaryHandler = () => new Response(null, { status: 302, headers: { location: `${attackerUrl}/steal` } });
    const provider = createBraveSearchProvider({ apiKey: "brave-secret", baseUrl: `${primaryUrl}/search` });
    await expect(provider.search({ query: "q", maxResults: 2 })).rejects.toThrow(/cross-origin/);
    expect(attackerRequests.length).toBe(before);
  });

  test("rejects when a later hop of a multi-hop chain turns cross-origin", async () => {
    const before = attackerRequests.length;
    primaryHandler = (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/search") return new Response(null, { status: 302, headers: { location: "/hop1" } });
      return new Response(null, { status: 302, headers: { location: `${attackerUrl}/steal` } });
    };
    const provider = createBraveSearchProvider({ apiKey: "brave-secret", baseUrl: `${primaryUrl}/search` });
    await expect(provider.search({ query: "q", maxResults: 2 })).rejects.toThrow(/cross-origin/);
    expect(attackerRequests.length).toBe(before);
  });

  test("gives up on an endless same-origin redirect loop", async () => {
    primaryHandler = () => new Response(null, { status: 302, headers: { location: "/loop" } });
    const provider = createBraveSearchProvider({ apiKey: "brave-secret", baseUrl: `${primaryUrl}/search` });
    await expect(provider.search({ query: "q", maxResults: 2 })).rejects.toThrow(/exceeded 5 redirects/);
  });
});

describe("createSerperSearchProvider redirect hardening", () => {
  const serperBody = { organic: [{ title: "S", link: "https://s.example", snippet: "sn" }] };

  test("follows a same-origin 307 preserving the POST body and api key", async () => {
    /** @type {{ method: string; headers: Record<string, string>; body: string } | undefined} */
    let moved;
    primaryHandler = async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/search") return new Response(null, { status: 307, headers: { location: "/moved" } });
      if (url.pathname === "/moved") {
        moved = { method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() };
        return Response.json(serperBody);
      }
      return new Response("not found", { status: 404 });
    };
    const provider = createSerperSearchProvider({ apiKey: "serper-secret", baseUrl: `${primaryUrl}/search` });
    const results = await provider.search({ query: "q", maxResults: 3 });
    expect(results).toEqual([{ title: "S", url: "https://s.example", snippet: "sn" }]);
    expect(moved?.method).toBe("POST");
    expect(moved?.headers["x-api-key"]).toBe("serper-secret");
    expect(JSON.parse(moved?.body ?? "{}")).toMatchObject({ q: "q", num: 3 });
  });

  test("rejects a cross-origin redirect before the other origin sees a request", async () => {
    const before = attackerRequests.length;
    primaryHandler = () => new Response(null, { status: 308, headers: { location: `${attackerUrl}/steal` } });
    const provider = createSerperSearchProvider({ apiKey: "serper-secret", baseUrl: `${primaryUrl}/search` });
    await expect(provider.search({ query: "q", maxResults: 3 })).rejects.toThrow(/cross-origin/);
    expect(attackerRequests.length).toBe(before);
  });

  test("rejects when a later hop of a multi-hop chain turns cross-origin", async () => {
    const before = attackerRequests.length;
    primaryHandler = (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/search") return new Response(null, { status: 307, headers: { location: "/hop1" } });
      return new Response(null, { status: 302, headers: { location: `${attackerUrl}/steal` } });
    };
    const provider = createSerperSearchProvider({ apiKey: "serper-secret", baseUrl: `${primaryUrl}/search` });
    await expect(provider.search({ query: "q", maxResults: 3 })).rejects.toThrow(/cross-origin/);
    expect(attackerRequests.length).toBe(before);
  });
});

describe("redirect hardening invariant", () => {
  test("the attacker origin never received a credential header", () => {
    expect(attackerRequests).toEqual([]);
    for (const seen of attackerRequests) {
      expect(seen.headers["x-subscription-token"]).toBeUndefined();
      expect(seen.headers["x-api-key"]).toBeUndefined();
    }
  });
});
