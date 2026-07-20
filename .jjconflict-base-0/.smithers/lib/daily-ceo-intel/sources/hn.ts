import type { HnSource } from "../config";
import { guardedFetch, withOneRetry } from "../fetchGuards";
import type { FetchSourceRow } from "../schemas";
import type { FeedEntry } from "./feedParser";
import { makeItem } from "./itemFactory";

const USER_AGENT = "smithers-daily-ceo-intel/1.0 (+https://smithers.sh; contact: it-team@tevm.tech)";

/** Provider-neutral interface so a non-Algolia news search backend can be swapped in later. */
export interface NewsSearchProvider {
  search(query: string, sinceIso: string): Promise<FeedEntry[]>;
}

type AlgoliaHit = {
  objectID: string;
  title: string | null;
  url: string | null;
  created_at: string;
  author: string | null;
  story_text: string | null;
};

export class HnAlgoliaProvider implements NewsSearchProvider {
  async search(query: string, sinceIso: string): Promise<FeedEntry[]> {
    const sinceUnix = Math.floor(Date.parse(sinceIso) / 1000);
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&numericFilters=created_at_i%3E${sinceUnix}`;
    const { text } = await guardedFetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      allowedContentType: /json/i,
    });
    const parsed = JSON.parse(text) as { hits?: AlgoliaHit[] };
    return (parsed.hits ?? [])
      .filter((hit) => hit.title)
      .map((hit) => ({
        title: hit.title as string,
        url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
        publishedAt: new Date(hit.created_at).toISOString(),
        body: hit.story_text ?? "",
        author: hit.author,
      }));
  }
}

async function fetchOneQuery(
  provider: NewsSearchProvider,
  source: HnSource,
  sinceIso: string,
  retrievedAt: string,
): Promise<FetchSourceRow> {
  try {
    const { result: entries, retried } = await withOneRetry(() => provider.search(source.query, sinceIso));
    const items = entries.map((entry) =>
      makeItem({
        sourceId: source.id,
        sourceKind: "hn",
        url: entry.url,
        title: entry.title,
        body: entry.body,
        author: entry.author,
        publishedAt: entry.publishedAt,
        retrievedAt,
      }),
    );
    return { sourceId: source.id, kind: "hn", ok: true, error: null, itemCount: items.length, retried, items };
  } catch (error) {
    return {
      sourceId: source.id,
      kind: "hn",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      itemCount: 0,
      retried: false,
      items: [],
    };
  }
}

export async function fetchHn(sources: HnSource[], sinceIso: string, provider: NewsSearchProvider = new HnAlgoliaProvider()): Promise<FetchSourceRow[]> {
  const retrievedAt = new Date().toISOString();
  return Promise.all(sources.map((source) => fetchOneQuery(provider, source, sinceIso, retrievedAt)));
}
