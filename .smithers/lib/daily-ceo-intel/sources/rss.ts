import type { RssSource } from "../config";
import { guardedFetch, withOneRetry } from "../fetchGuards";
import type { FetchSourceRow } from "../schemas";
import { parseFeedEntries } from "./feedParser";
import { makeItem } from "./itemFactory";

const USER_AGENT = "smithers-daily-ceo-intel/1.0 (+https://smithers.sh; contact: it-team@tevm.tech)";

async function fetchOneFeed(source: RssSource, retrievedAt: string): Promise<FetchSourceRow> {
  try {
    const { result, retried } = await withOneRetry(() =>
      guardedFetch(source.url, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        },
        allowedContentType: /xml|rss|atom/i,
      }),
    );
    const entries = parseFeedEntries(result.text);
    const items = entries.map((entry) =>
      makeItem({
        sourceId: source.id,
        sourceKind: "rss",
        url: entry.url,
        title: entry.title,
        body: entry.body,
        author: entry.author,
        publishedAt: entry.publishedAt,
        retrievedAt,
      }),
    );
    return { sourceId: source.id, kind: "rss", ok: true, error: null, itemCount: items.length, retried, items };
  } catch (error) {
    return {
      sourceId: source.id,
      kind: "rss",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      itemCount: 0,
      retried: false,
      items: [],
    };
  }
}

export async function fetchRss(sources: RssSource[]): Promise<FetchSourceRow[]> {
  const retrievedAt = new Date().toISOString();
  return Promise.all(sources.map((source) => fetchOneFeed(source, retrievedAt)));
}
