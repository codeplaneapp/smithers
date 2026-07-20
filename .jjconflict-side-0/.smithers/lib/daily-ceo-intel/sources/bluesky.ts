import type { BlueskySource } from "../config";
import { guardedFetch, withOneRetry } from "../fetchGuards";
import type { FetchSourceRow } from "../schemas";
import { makeItem } from "./itemFactory";

const USER_AGENT = "smithers-daily-ceo-intel/1.0 (+https://smithers.sh; contact: it-team@tevm.tech)";

type BlueskyPost = {
  uri: string;
  author: { handle: string; displayName?: string };
  record: { text: string; createdAt: string };
};

function postWebUrl(post: BlueskyPost): string {
  const rkey = post.uri.split("/").pop() ?? "";
  return `https://bsky.app/profile/${post.author.handle}/post/${rkey}`;
}

async function fetchOneQuery(source: BlueskySource, retrievedAt: string): Promise<FetchSourceRow> {
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(source.query)}&sort=latest&limit=25`;
  try {
    const { result, retried } = await withOneRetry(() =>
      guardedFetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        allowedContentType: /json/i,
      }),
    );
    const parsed = JSON.parse(result.text) as { posts?: BlueskyPost[] };
    const items = (parsed.posts ?? []).map((post) =>
      makeItem({
        sourceId: source.id,
        sourceKind: "bluesky",
        url: postWebUrl(post),
        title: post.record.text.slice(0, 140),
        body: post.record.text,
        author: post.author.displayName ?? post.author.handle,
        publishedAt: post.record.createdAt ? new Date(post.record.createdAt).toISOString() : null,
        retrievedAt,
      }),
    );
    return { sourceId: source.id, kind: "bluesky", ok: true, error: null, itemCount: items.length, retried, items };
  } catch (error) {
    return {
      sourceId: source.id,
      kind: "bluesky",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      itemCount: 0,
      retried: false,
      items: [],
    };
  }
}

export async function fetchBluesky(sources: BlueskySource[]): Promise<FetchSourceRow[]> {
  const retrievedAt = new Date().toISOString();
  return Promise.all(sources.map((source) => fetchOneQuery(source, retrievedAt)));
}
