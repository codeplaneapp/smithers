import { describe, expect, test } from "bun:test";
import { createBraveSearchProvider } from "../src/web-search/createBraveSearchProvider.js";
import { createExaSearchProvider } from "../src/web-search/createExaSearchProvider.js";
import { createGroundedWebSearchToolset } from "../src/web-search/createGroundedWebSearchToolset.js";
import { createSerperSearchProvider } from "../src/web-search/createSerperSearchProvider.js";
import { createTavilySearchProvider } from "../src/web-search/createTavilySearchProvider.js";

const callOptions = { toolCallId: "test-call", messages: [] };

describe("createGroundedWebSearchToolset", () => {
  test("rejects a single semantic provider", () => {
    expect(() => createGroundedWebSearchToolset({
      providers: [provider("exa", "semantic", [])],
    })).toThrow("fresh/SERP provider");
  });

  test("fans out to Exa plus a fresh provider and returns grounded citations", async () => {
    const calls = [];
    const toolset = createGroundedWebSearchToolset({
      providers: [
        provider("exa", "semantic", [
          { title: "Semantic result", url: "https://example.com/semantic", snippet: "context" },
        ], calls),
        provider("tavily", "fresh", [
          { title: "Fresh result", url: "https://example.com/fresh", snippet: "news" },
        ], calls),
      ],
    });

    expect(toolset.toolNames).toEqual(["grounded_web_search"]);
    const result = await toolset.tools.grounded_web_search.execute({
      query: "latest smithers integrations",
      maxResults: 3,
      freshness: "week",
    }, callOptions);

    expect(calls).toEqual([
      { name: "exa", query: "latest smithers integrations", maxResults: 3, freshness: "week" },
      { name: "tavily", query: "latest smithers integrations", maxResults: 3, freshness: "week" },
    ]);
    expect(result.providers).toEqual(["exa", "tavily"]);
    expect(result.results).toEqual([
      { title: "Semantic result", url: "https://example.com/semantic", snippet: "context", provider: "exa", citation: 1 },
      { title: "Fresh result", url: "https://example.com/fresh", snippet: "news", provider: "tavily", citation: 2 },
    ]);
  });

  test("returns successful provider results when another provider fails", async () => {
    const toolset = createGroundedWebSearchToolset({
      providers: [
        provider("exa", "semantic", [
          { title: "Semantic result", url: "https://example.com/semantic", snippet: "context" },
        ]),
        {
          name: "tavily",
          kind: "fresh",
          async search() {
            throw new Error("Tavily unavailable");
          },
        },
      ],
    });

    const result = await toolset.tools.grounded_web_search.execute({
      query: "latest smithers integrations",
    }, callOptions);

    expect(result.providers).toEqual(["exa"]);
    expect(result.results).toEqual([
      { title: "Semantic result", url: "https://example.com/semantic", snippet: "context", provider: "exa", citation: 1 },
    ]);
  });

  test("caps requested maxResults by maxResultsPerProvider", async () => {
    const calls = [];
    const toolset = createGroundedWebSearchToolset({
      maxResultsPerProvider: 4,
      providers: [
        provider("exa", "semantic", [], calls),
        provider("brave", "fresh", [], calls),
      ],
    });

    await toolset.tools.grounded_web_search.execute({
      query: "latest smithers integrations",
      maxResults: 12,
    }, callOptions);

    expect(calls).toEqual([
      { name: "exa", query: "latest smithers integrations", maxResults: 4, freshness: undefined },
      { name: "brave", query: "latest smithers integrations", maxResults: 4, freshness: undefined },
    ]);
  });

  test("passes the AI SDK abort signal to every provider", async () => {
    const controller = new AbortController();
    const observedSignals = [];
    const toolset = createGroundedWebSearchToolset({
      providers: [
        providerWithSignal("exa", "semantic", observedSignals),
        providerWithSignal("tavily", "fresh", observedSignals),
      ],
    });

    await toolset.tools.grounded_web_search.execute(
      { query: "latest smithers integrations" },
      { ...callOptions, abortSignal: controller.signal },
    );

    expect(observedSignals).toEqual([controller.signal, controller.signal]);
  });

  test("returns the exact abort reason without waiting for an uncooperative provider", async () => {
    const controller = new AbortController();
    const reason = new Error("stop the pending search");
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const toolset = createGroundedWebSearchToolset({
      providers: [
        {
          name: "exa",
          kind: "semantic",
          async search() {
            markStarted();
            return new Promise(() => {});
          },
        },
        provider("brave", "fresh", []),
      ],
    });

    const pending = toolset.tools.grounded_web_search.execute(
      { query: "latest smithers integrations" },
      { ...callOptions, abortSignal: controller.signal },
    );
    await started;
    controller.abort(reason);

    expect(await rejectionWithin(pending)).toBe(reason);
  });

  test("does not start providers for a pre-aborted tool call", async () => {
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    let calls = 0;
    const neverCalled = (name, kind) => ({
      name,
      kind,
      async search() {
        calls += 1;
        return [];
      },
    });
    const toolset = createGroundedWebSearchToolset({
      providers: [neverCalled("exa", "semantic"), neverCalled("brave", "fresh")],
    });
    controller.abort(reason);

    const pending = toolset.tools.grounded_web_search.execute(
      { query: "latest smithers integrations" },
      { ...callOptions, abortSignal: controller.signal },
    );

    expect(await rejectionWithin(pending)).toBe(reason);
    expect(calls).toBe(0);
  });
});

describe("grounded web search HTTP providers", () => {
  test("passes freshness through Exa startPublishedDate", async () => {
    const requests = [];
    const provider = createExaSearchProvider({
      apiKey: "exa-key",
      baseUrl: "https://exa.test",
      fetch: okJsonFetch(requests, { results: [] }),
    });

    await provider.search({ query: "smithers", maxResults: 2, freshness: "week" });

    expect(requests[0].url).toBe("https://exa.test/search");
    expect(JSON.parse(requests[0].init.body)).toEqual({
      query: "smithers",
      numResults: 2,
      useAutoprompt: true,
      startPublishedDate: isoDateDaysAgo(7),
    });
  });

  test("uses Tavily general topic unless freshness requests news recency", async () => {
    const requests = [];
    const provider = createTavilySearchProvider({
      apiKey: "tavily-key",
      baseUrl: "https://tavily.test",
      fetch: okJsonFetch(requests, { results: [] }),
    });

    await provider.search({ query: "smithers", maxResults: 2 });
    await provider.search({ query: "smithers", maxResults: 2, freshness: "day" });

    expect(JSON.parse(requests[0].init.body)).toMatchObject({ topic: "general" });
    expect(JSON.parse(requests[1].init.body)).toMatchObject({ topic: "news", days: 1 });
  });

  test("passes freshness through Brave and maps web results", async () => {
    const requests = [];
    const provider = createBraveSearchProvider({
      apiKey: "brave-key",
      baseUrl: "https://brave.test/search",
      fetch: okJsonFetch(requests, {
        web: { results: [{ title: "Brave result", url: "https://example.com", description: "Snippet", age: "2 days ago" }] },
      }),
    });

    const results = await provider.search({ query: "smithers", maxResults: 2, freshness: "month" });

    expect(requests[0].url).toBe("https://brave.test/search?q=smithers&count=2&freshness=pm");
    expect(results).toEqual([{ title: "Brave result", url: "https://example.com", snippet: "Snippet" }]);
  });

  test("passes freshness through Serper tbs and maps organic results", async () => {
    const requests = [];
    const provider = createSerperSearchProvider({
      apiKey: "serper-key",
      baseUrl: "https://serper.test/search",
      fetch: okJsonFetch(requests, {
        organic: [{ title: "Serper result", link: "https://example.com", snippet: "Snippet", date: "Jun 1, 2026" }],
      }),
    });

    const results = await provider.search({ query: "smithers", maxResults: 2, freshness: "year" });

    expect(JSON.parse(requests[0].init.body)).toEqual({ q: "smithers", num: 2, tbs: "qdr:y" });
    expect(results).toEqual([{ title: "Serper result", url: "https://example.com", snippet: "Snippet", publishedDate: "Jun 1, 2026" }]);
  });

  const cancellableProviders = [
    ["Exa", createExaSearchProvider],
    ["Tavily", createTavilySearchProvider],
    ["Brave", createBraveSearchProvider],
    ["Serper", createSerperSearchProvider],
  ];

  for (const [name, createProvider] of cancellableProviders) {
    test(`${name} cancels a genuinely pending transport with the exact reason`, async () => {
      const controller = new AbortController();
      const reason = new Error(`cancel ${name}`);
      let transportSignal;
      let markStarted;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const searchProvider = createProvider({
        apiKey: "key",
        fetch: async (_url, init = {}) =>
          new Promise((_resolve, reject) => {
            transportSignal = init.signal;
            if (transportSignal?.aborted) {
              reject(transportSignal.reason);
            } else {
              transportSignal?.addEventListener(
                "abort",
                () => reject(transportSignal.reason),
                { once: true },
              );
            }
            markStarted();
          }),
      });

      const pending = searchProvider.search(
        { query: "smithers", maxResults: 1 },
        { signal: controller.signal },
      );
      await started;
      controller.abort(reason);

      expect(await rejectionWithin(pending)).toBe(reason);
      expect(transportSignal.aborted).toBe(true);
      expect(transportSignal.reason).toBe(reason);
    });
  }

  test("cancels a stalled response read with the exact reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel stalled search response");
    let cancelReason;
    let markReading;
    const reading = new Promise((resolve) => {
      markReading = resolve;
    });
    const searchProvider = createExaSearchProvider({
      apiKey: "key",
      fetch: async () =>
        new Response(new ReadableStream({
          pull() {
            markReading();
          },
          cancel(value) {
            cancelReason = value;
          },
        })),
    });

    const pending = searchProvider.search(
      { query: "smithers", maxResults: 1 },
      { signal: controller.signal },
    );
    await reading;
    controller.abort(reason);

    expect(await rejectionWithin(pending)).toBe(reason);
    expect(cancelReason).toBe(reason);
  });
});

function provider(name, kind, results, calls = []) {
  return {
    name,
    kind,
    async search(input) {
      calls.push({ name, ...input });
      return results;
    },
  };
}

function providerWithSignal(name, kind, observedSignals) {
  return {
    name,
    kind,
    async search(_input, options) {
      observedSignals.push(options?.signal);
      return [];
    },
  };
}

function okJsonFetch(requests, body) {
  return async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

async function rejectionWithin(promise, timeoutMs = 500) {
  let timer;
  try {
    return await Promise.race([
      promise.then(
        () => new Error("Expected the operation to reject"),
        (error) => error,
      ),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve(new Error(`Operation did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
