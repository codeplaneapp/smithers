import { dynamicTool, jsonSchema } from "ai";

/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */
/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchResult} GroundedWebSearchResult */
/** @typedef {import("./GroundedWebSearchToolset.ts").GroundedWebSearchToolset} GroundedWebSearchToolset */

/**
 * @param {{ providers: GroundedWebSearchProvider[]; maxResultsPerProvider?: number }} options
 * @returns {GroundedWebSearchToolset}
 */
export function createGroundedWebSearchToolset(options) {
  const providers = options.providers ?? [];
  if (!providers.some((provider) => provider.name === "exa" && provider.kind === "semantic")) {
    throw new Error("grounded_web_search requires Exa as the semantic provider");
  }
  if (!providers.some((provider) => provider.kind === "fresh")) {
    throw new Error("grounded_web_search requires at least one fresh/SERP provider: Tavily, Brave, or Serper");
  }

  return {
    tools: {
      grounded_web_search: dynamicTool({
        description: "Search the web with both Exa semantic retrieval and a fresh/SERP provider, returning grounded citations.",
        inputSchema: jsonSchema({
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1 },
            maxResults: { type: "number", minimum: 1, maximum: 20 },
            freshness: { type: "string", enum: ["day", "week", "month", "year"] },
          },
          required: ["query"],
        }),
        execute: async (input) => searchAll(providers, input, options.maxResultsPerProvider ?? 5),
      }),
    },
    toolNames: ["grounded_web_search"],
  };
}

/**
 * @param {GroundedWebSearchProvider[]} providers
 * @param {unknown} input
 * @param {number} maxResultsPerProvider
 * @returns {Promise<{ query: string; providers: string[]; results: Array<GroundedWebSearchResult & { provider: string; citation: number }> }>}
 */
async function searchAll(providers, input, maxResultsPerProvider) {
  const args = normalizeInput(input, maxResultsPerProvider);
  const settled = await Promise.allSettled(providers.map(async (provider) => ({
    provider,
    results: await provider.search(args),
  })));
  const deduped = new Map();
  const succeededProviders = [];
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    const entry = outcome.value;
    succeededProviders.push(entry.provider.name);
    for (const result of entry.results) {
      const key = normalizeUrl(result.url);
      if (!key || deduped.has(key)) continue;
      deduped.set(key, {
        ...result,
        provider: entry.provider.name,
        citation: deduped.size + 1,
      });
    }
  }
  return {
    query: args.query,
    providers: succeededProviders,
    results: [...deduped.values()],
  };
}

/**
 * @param {unknown} input
 * @param {number} defaultMaxResults
 */
function normalizeInput(input, defaultMaxResults) {
  const value = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : {};
  const query = typeof value.query === "string" ? value.query.trim() : "";
  if (!query) {
    throw new Error("grounded_web_search requires a non-empty query");
  }
  const requestedMax = typeof value.maxResults === "number" ? value.maxResults : defaultMaxResults;
  const cappedMax = Math.min(requestedMax, defaultMaxResults);
  return {
    query,
    maxResults: Math.min(Math.max(Math.trunc(cappedMax), 1), 20),
    freshness: isFreshness(value.freshness) ? value.freshness : undefined,
  };
}

/** @param {unknown} value */
function isFreshness(value) {
  return value === "day" || value === "week" || value === "month" || value === "year";
}

/** @param {string | undefined} url */
function normalizeUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
