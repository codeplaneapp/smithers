import type { RedditSource } from "../config";
import { guardedFetch, withOneRetry } from "../fetchGuards";
import type { FetchSourceRow } from "../schemas";
import { makeItem } from "./itemFactory";

const USER_AGENT = "smithers-daily-ceo-intel/1.0 (by /u/smithers-signal; contact: it-team@tevm.tech)";

type RedditPost = {
  id: string;
  title: string;
  url: string;
  permalink: string;
  created_utc: number;
  author: string | null;
  selftext?: string | null;
};

async function fetchOneSubreddit(source: RedditSource, retrievedAt: string): Promise<FetchSourceRow> {
  const url = `https://www.reddit.com/r/${encodeURIComponent(source.subreddit)}/new.json?limit=50`;
  try {
    const { result, retried } = await withOneRetry(() =>
      guardedFetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        allowedContentType: /json/i,
      }),
    );
    const parsed = JSON.parse(result.text) as { data?: { children?: Array<{ data: RedditPost }> } };
    const posts = (parsed.data?.children ?? []).map((child) => child.data);
    const items = posts.map((post) =>
      makeItem({
        sourceId: source.id,
        sourceKind: "reddit",
        url: post.url && !post.url.startsWith("/r/") ? post.url : `https://www.reddit.com${post.permalink}`,
        title: post.title,
        body: post.selftext ?? "",
        author: post.author,
        publishedAt: new Date(post.created_utc * 1000).toISOString(),
        retrievedAt,
      }),
    );
    return { sourceId: source.id, kind: "reddit", ok: true, error: null, itemCount: items.length, retried, items };
  } catch (error) {
    return {
      sourceId: source.id,
      kind: "reddit",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      itemCount: 0,
      retried: false,
      items: [],
    };
  }
}

export async function fetchReddit(sources: RedditSource[]): Promise<FetchSourceRow[]> {
  const retrievedAt = new Date().toISOString();
  return Promise.all(sources.map((source) => fetchOneSubreddit(source, retrievedAt)));
}
