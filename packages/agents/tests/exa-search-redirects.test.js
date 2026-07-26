import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createExaSearchProvider } from "../src/web-search/createExaSearchProvider.js";

const API_KEY = "secret-exa-key";
const resultsBody = {
  results: [{ title: "E", url: "https://e.example", text: "body", score: 0.9 }],
};

/** @type {Array<{ pathname: string; method: string; apiKey: string | null; body: string }>} */
let exaRequests = [];
/** @type {Array<{ pathname: string; apiKey: string | null }>} */
let attackerRequests = [];

let exaServer;
let exaUrl;
let attackerServer;
let attackerUrl;

beforeAll(() => {
  // A second real server on a different origin: any request landing here is a leak.
  attackerServer = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      attackerRequests.push({ pathname: url.pathname, apiKey: request.headers.get("x-api-key") });
      return Response.json(resultsBody);
    },
  });
  attackerUrl = `http://${attackerServer.hostname}:${attackerServer.port}`;

  exaServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      exaRequests.push({
        pathname: url.pathname,
        method: request.method,
        apiKey: request.headers.get("x-api-key"),
        body: await request.text(),
      });
      switch (url.pathname) {
        case "/same/search":
          return new Response(null, { status: 307, headers: { location: "/same/search-v2" } });
        case "/same/search-v2":
          break;
        case "/multi/search":
          return new Response(null, { status: 307, headers: { location: "/multi/hop1" } });
        case "/multi/hop1":
          return new Response(null, { status: 308, headers: { location: "/multi/hop2" } });
        case "/multi/hop2":
          break;
        case "/cross/search":
          return new Response(null, { status: 302, headers: { location: `${attackerUrl}/steal` } });
        case "/multi-cross/search":
          return new Response(null, { status: 307, headers: { location: "/multi-cross/hop1" } });
        case "/multi-cross/hop1":
          return new Response(null, { status: 302, headers: { location: `${attackerUrl}/steal-later` } });
        case "/loop/search":
          return new Response(null, { status: 307, headers: { location: "/loop/search" } });
        default:
          return new Response("not found", { status: 404 });
      }
      return request.headers.get("x-api-key") === API_KEY
        ? Response.json(resultsBody)
        : new Response("missing key", { status: 401 });
    },
  });
  exaUrl = `http://${exaServer.hostname}:${exaServer.port}`;
});

afterAll(() => {
  exaServer?.stop(true);
  attackerServer?.stop(true);
});

beforeEach(() => {
  exaRequests = [];
  attackerRequests = [];
});

/** @param {string} prefix */
const provider = (prefix) => createExaSearchProvider({ apiKey: API_KEY, baseUrl: `${exaUrl}${prefix}` });

describe("createExaSearchProvider redirect hardening", () => {
  test("follows a same-origin redirect and keeps the API key and POST body", async () => {
    const results = await provider("/same").search({ query: "hello", maxResults: 3 });
    expect(results).toEqual([
      { title: "E", url: "https://e.example", snippet: "body", publishedDate: undefined, score: 0.9 },
    ]);
    expect(exaRequests.map((r) => r.pathname)).toEqual(["/same/search", "/same/search-v2"]);
    for (const request of exaRequests) {
      expect(request.apiKey).toBe(API_KEY);
      expect(request.method).toBe("POST");
      expect(JSON.parse(request.body)).toMatchObject({ query: "hello", numResults: 3 });
    }
  });

  test("follows a multi-hop same-origin chain, validating every Location hop", async () => {
    const results = await provider("/multi").search({ query: "hop", maxResults: 1 });
    expect(results).toHaveLength(1);
    expect(exaRequests.map((r) => r.pathname)).toEqual(["/multi/search", "/multi/hop1", "/multi/hop2"]);
    expect(exaRequests.every((r) => r.apiKey === API_KEY)).toBe(true);
  });

  test("refuses a cross-origin redirect and never contacts the other origin", async () => {
    await expect(provider("/cross").search({ query: "q", maxResults: 1 })).rejects.toThrow(
      /cross-origin.*refusing to forward the API key/,
    );
    expect(attackerRequests).toEqual([]);
  });

  test("refuses a multi-hop chain whose later hop turns cross-origin", async () => {
    await expect(provider("/multi-cross").search({ query: "q", maxResults: 1 })).rejects.toThrow(/cross-origin/);
    expect(exaRequests.map((r) => r.pathname)).toEqual(["/multi-cross/search", "/multi-cross/hop1"]);
    expect(attackerRequests).toEqual([]);
  });

  test("gives up on an unbounded same-origin redirect loop", async () => {
    await expect(provider("/loop").search({ query: "q", maxResults: 1 })).rejects.toThrow(/exceeded 5 redirects/);
  });
});
