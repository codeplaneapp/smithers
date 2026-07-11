import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createBraveSearchProvider } from "../src/web-search/createBraveSearchProvider.js";
import { createExaSearchProvider } from "../src/web-search/createExaSearchProvider.js";
import { createSerperSearchProvider } from "../src/web-search/createSerperSearchProvider.js";
import { createTavilySearchProvider } from "../src/web-search/createTavilySearchProvider.js";

let api;
let receiver;
let apiUrl;
let receiverUrl;
let receiverHits = 0;

const providerCases = [
  {
    name: "Exa",
    header: "x-api-key",
    create: (baseUrl, allowedOrigins) =>
      createExaSearchProvider({ apiKey: "exa-secret", baseUrl, allowedOrigins }),
    secret: "exa-secret",
  },
  {
    name: "Brave",
    header: "x-subscription-token",
    create: (baseUrl, allowedOrigins) =>
      createBraveSearchProvider({ apiKey: "brave-secret", baseUrl, allowedOrigins }),
    secret: "brave-secret",
  },
  {
    name: "Serper",
    header: "x-api-key",
    create: (baseUrl, allowedOrigins) =>
      createSerperSearchProvider({ apiKey: "serper-secret", baseUrl, allowedOrigins }),
    secret: "serper-secret",
  },
];

function providerBody(name, headerValue) {
  const item = { title: name, url: "https://result.example", text: headerValue, description: headerValue, snippet: headerValue };
  if (name === "Exa") return { results: [item] };
  if (name === "Brave") return { web: { results: [item] } };
  return { organic: [{ ...item, link: item.url }] };
}

beforeAll(() => {
  receiver = Bun.serve({
    port: 0,
    fetch: (request) => {
      receiverHits += 1;
      const url = new URL(request.url);
      const name = url.searchParams.get("provider");
      const header = url.searchParams.get("header");
      return Response.json(providerBody(name, request.headers.get(header)));
    },
  });
  receiverUrl = `http://127.0.0.1:${receiver.port}`;

  api = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      const [mode, name, hop] = parts;
      const spec = providerCases.find((entry) => entry.name.toLowerCase() === name);
      if (!spec) return new Response("not found", { status: 404 });
      if (mode === "same" && hop !== "target") {
        return new Response(null, { status: 302, headers: { location: `/same/${name}/target` } });
      }
      if (mode === "cross") {
        const target = new URL("/target", receiverUrl);
        target.searchParams.set("provider", spec.name);
        target.searchParams.set("header", spec.header);
        return new Response(null, { status: 302, headers: { location: target } });
      }
      if (mode === "multi" && hop !== "hop") {
        return new Response(null, { status: 302, headers: { location: `/multi/${name}/hop` } });
      }
      if (mode === "multi") {
        const target = new URL("/target", receiverUrl);
        target.searchParams.set("provider", spec.name);
        target.searchParams.set("header", spec.header);
        return new Response(null, { status: 307, headers: { location: target } });
      }
      return Response.json(providerBody(spec.name, request.headers.get(spec.header)));
    },
  });
  apiUrl = `http://127.0.0.1:${api.port}`;
});

afterAll(() => {
  api?.stop(true);
  receiver?.stop(true);
});

describe("credential-safe web search redirects", () => {
  for (const entry of providerCases) {
    test(`${entry.name} keeps its key on same-origin redirects`, async () => {
      const provider = entry.create(`${apiUrl}/same/${entry.name.toLowerCase()}`);
      const results = await provider.search({ query: "redirect", maxResults: 1 });
      expect(results[0].snippet).toBe(entry.secret);
    });

    test(`${entry.name} blocks private destinations across every unauthorized redirect hop`, async () => {
      for (const mode of ["cross", "multi"]) {
        receiverHits = 0;
        const provider = entry.create(`${apiUrl}/${mode}/${entry.name.toLowerCase()}`);
        await expect(provider.search({ query: "redirect", maxResults: 1 })).rejects.toMatchObject({
          code: "INVALID_URL",
          details: { reason: "non-public-destination" },
        });
        expect(receiverHits).toBe(0);
      }
    });

    test(`${entry.name} retains its key only for an explicitly allowed origin`, async () => {
      const provider = entry.create(
        `${apiUrl}/cross/${entry.name.toLowerCase()}`,
        [receiverUrl],
      );
      const results = await provider.search({ query: "redirect", maxResults: 1 });
      expect(results[0].snippet).toBe(entry.secret);
    });
  }

  test("redacts header and bearer API keys reflected by provider errors", async () => {
    for (const provider of [
      createExaSearchProvider({
        apiKey: "header-secret",
        fetch: async () => new Response("reflected header-secret", { status: 500 }),
      }),
      createTavilySearchProvider({
        apiKey: "bearer-secret",
        fetch: async () => new Response("reflected Bearer bearer-secret", { status: 500 }),
      }),
    ]) {
      let caught;
      try {
        await provider.search({ query: "redirect", maxResults: 1 });
      } catch (error) {
        caught = error;
      }
      expect(caught?.message).toContain("[REDACTED]");
      expect(caught?.message).not.toContain("header-secret");
      expect(caught?.message).not.toContain("bearer-secret");
    }
  });
});
