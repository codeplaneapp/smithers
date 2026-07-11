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
        execute: async (input, execution) =>
          searchAll(
            providers,
            input,
            options.maxResultsPerProvider ?? 5,
            execution?.abortSignal,
          ),
      }),
    },
    toolNames: ["grounded_web_search"],
  };
}

/**
 * @param {GroundedWebSearchProvider[]} providers
 * @param {unknown} input
 * @param {number} maxResultsPerProvider
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ query: string; providers: string[]; results: Array<GroundedWebSearchResult & { provider: string; citation: number }> }>}
 */
async function searchAll(providers, input, maxResultsPerProvider, signal) {
  throwIfAborted(signal);
  const args = normalizeInput(input, maxResultsPerProvider);
  const providerResults = Promise.allSettled(providers.map(async (provider) => ({
    provider,
    results: signal
      ? await provider.search(args, { signal })
      : await provider.search(args),
  })));
  // A third-party provider may not observe its signal. The tool invocation must
  // still settle promptly rather than letting one permanently pending provider
  // hold the whole fan-out open.
  const settled = await raceWithAbort(providerResults, signal);
  throwIfAborted(signal);
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
 * @param {AbortSignal | undefined} signal
 */
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw abortReason(signal);
}

/**
 * @param {AbortSignal} signal
 * @returns {unknown}
 */
function abortReason(signal) {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/**
 * @template T
 * @param {Promise<T>} operation
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
async function raceWithAbort(operation, signal) {
  if (!signal) return operation;
  throwIfAborted(signal);
  /** @type {(() => void) | undefined} */
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
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
