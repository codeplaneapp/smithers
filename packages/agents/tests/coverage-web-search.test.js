import { describe, expect, test } from "bun:test";
import { createBraveSearchProvider } from "../src/web-search/createBraveSearchProvider.js";
import { createExaSearchProvider } from "../src/web-search/createExaSearchProvider.js";
import { createSerperSearchProvider } from "../src/web-search/createSerperSearchProvider.js";
import { createTavilySearchProvider } from "../src/web-search/createTavilySearchProvider.js";
import { createGroundedWebSearchToolset } from "../src/web-search/createGroundedWebSearchToolset.js";

const callOptions = { toolCallId: "test-call", messages: [] };
const FRESH = ["day", "week", "month", "year", undefined];

describe("createBraveSearchProvider", () => {
  test("maps results, drops url-less entries, and encodes every freshness value", async () => {
    /** @type {string[]} */
    const urls = [];
    const provider = createBraveSearchProvider({
      apiKey: "k",
      fetch: async (url) => {
        urls.push(String(url));
        return Response.json({
          web: { results: [{ title: "T", url: "https://a.example", description: "d" }, { title: "no-url" }] },
        });
      },
    });
    for (const freshness of FRESH) {
      const results = await provider.search({ query: "q", maxResults: 3, freshness });
      expect(results).toEqual([{ title: "T", url: "https://a.example", snippet: "d" }]);
    }
    expect(urls.some((u) => u.includes("freshness=pd"))).toBe(true);
    expect(urls.some((u) => u.includes("freshness=py"))).toBe(true);
  });

  test("throws on a non-ok response", async () => {
    const provider = createBraveSearchProvider({
      apiKey: "k",
      fetch: async () => new Response("nope", { status: 500 }),
    });
    await expect(provider.search({ query: "q", maxResults: 1 })).rejects.toThrow(/Brave search failed \(500\)/);
  });

  test("tolerates an empty response body", async () => {
    const provider = createBraveSearchProvider({
      apiKey: "k",
      baseUrl: "https://brave.test/search",
      fetch: async () => new Response("", { status: 200 }),
    });
    expect(await provider.search({ query: "q", maxResults: 1 })).toEqual([]);
  });
});

describe("createExaSearchProvider", () => {
  test("maps semantic results with score and freshness windows", async () => {
    for (const freshness of FRESH) {
      const provider = createExaSearchProvider({
        apiKey: "k",
        fetch: async () =>
          Response.json({
            results: [
              { title: "E", url: "https://e.example", text: "body", score: 0.9, publishedDate: "2026-01-01" },
              { url: "https://e2.example", summary: "sum" },
              { title: "x" },
            ],
          }),
      });
      const results = await provider.search({ query: "q", maxResults: 5, freshness });
      expect(results[0]).toMatchObject({ title: "E", url: "https://e.example", snippet: "body", score: 0.9 });
      expect(results[1].snippet).toBe("sum");
      expect(results).toHaveLength(2);
    }
  });
  test("throws on non-ok", async () => {
    const provider = createExaSearchProvider({ apiKey: "k", fetch: async () => new Response("e", { status: 403 }) });
    await expect(provider.search({ query: "q", maxResults: 1 })).rejects.toThrow(/Exa search failed \(403\)/);
  });
});

describe("createSerperSearchProvider", () => {
  test("maps organic results across freshness values", async () => {
    for (const freshness of FRESH) {
      const provider = createSerperSearchProvider({
        apiKey: "k",
        baseUrl: "https://serper.test/search",
        fetch: async () =>
          Response.json({
            organic: [{ title: "S", link: "https://s.example", snippet: "snip", date: "2026" }, { snippet: "no-link" }],
          }),
      });
      const results = await provider.search({ query: "q", maxResults: 4, freshness });
      expect(results).toEqual([{ title: "S", url: "https://s.example", snippet: "snip", publishedDate: "2026" }]);
    }
  });
  test("throws on non-ok", async () => {
    const provider = createSerperSearchProvider({ apiKey: "k", fetch: async () => new Response("s", { status: 429 }) });
    await expect(provider.search({ query: "q", maxResults: 1 })).rejects.toThrow(/Serper search failed \(429\)/);
  });
});

describe("createTavilySearchProvider", () => {
  test("maps results with score across freshness values", async () => {
    for (const freshness of FRESH) {
      const provider = createTavilySearchProvider({
        apiKey: "k",
        fetch: async () =>
          Response.json({
            results: [
              { title: "T", url: "https://t.example", content: "c", score: 0.5, published_date: "2026-02-02" },
              { url: "https://t2.example" },
              { title: "no-url" },
            ],
          }),
      });
      const results = await provider.search({ query: "q", maxResults: 3, freshness });
      expect(results[0]).toMatchObject({ title: "T", url: "https://t.example", snippet: "c", score: 0.5 });
      expect(results).toHaveLength(2);
    }
  });
  test("throws on non-ok", async () => {
    const provider = createTavilySearchProvider({ apiKey: "k", fetch: async () => new Response("t", { status: 401 }) });
    await expect(provider.search({ query: "q", maxResults: 1 })).rejects.toThrow(/Tavily search failed \(401\)/);
  });
});

describe("createGroundedWebSearchToolset", () => {
  const exa = (results) => ({ name: "exa", kind: "semantic", search: async () => results });
  const fresh = (name, results, opts = {}) => ({
    name,
    kind: "fresh",
    search: async () => {
      if (opts.throws) throw new Error("provider down");
      return results;
    },
  });

  test("requires an Exa semantic provider and a fresh provider", () => {
    expect(() => createGroundedWebSearchToolset({ providers: [] })).toThrow(/requires Exa/);
    expect(() => createGroundedWebSearchToolset({ providers: [exa([])] })).toThrow(/at least one fresh/);
  });

  test("merges + dedupes citations and skips a failing provider", async () => {
    const toolset = createGroundedWebSearchToolset({
      providers: [
        exa([
          { title: "A", url: "https://a.example/x#frag" },
          { title: "bad", url: "" },
        ]),
        fresh("brave", [
          { title: "A-dup", url: "https://a.example/x" },
          { title: "B", url: "https://b.example" },
        ]),
        fresh("serper", [], { throws: true }),
      ],
    });
    const result = await toolset.tools.grounded_web_search.execute(
      { query: "  hello  ", maxResults: 50, freshness: "week" },
      callOptions,
    );
    expect(result.providers).toEqual(["exa", "brave"]);
    // Dedup keys are hash-normalized, but the stored url is the provider's original.
    expect(result.results.map((r) => r.url)).toEqual(["https://a.example/x#frag", "https://b.example"]);
    expect(result.results[0].citation).toBe(1);
    expect(result.query).toBe("hello");
  });

  test("keeps an unparseable url verbatim and rejects an empty query", async () => {
    const toolset = createGroundedWebSearchToolset({
      providers: [exa([{ title: "weird", url: "not a url" }]), fresh("brave", [])],
    });
    const result = await toolset.tools.grounded_web_search.execute({ query: "q", freshness: "bogus" }, callOptions);
    expect(result.results[0].url).toBe("not a url");
    await expect(toolset.tools.grounded_web_search.execute({ query: "   " }, callOptions)).rejects.toThrow(
      /non-empty query/,
    );
  });
});
