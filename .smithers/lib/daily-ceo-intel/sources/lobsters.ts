import type { LobstersSource } from "../config";
import { guardedFetch, withOneRetry } from "../fetchGuards";
import type { FetchSourceRow } from "../schemas";
import { makeItem } from "./itemFactory";

const USER_AGENT = "smithers-daily-ceo-intel/1.0 (+https://smithers.sh; contact: it-team@tevm.tech)";

type LobstersStory = {
  short_id: string;
  title: string;
  url: string;
  short_id_url: string;
  created_at: string;
  submitter_user: string | null;
  description_plain?: string | null;
};

async function fetchOneTag(source: LobstersSource, retrievedAt: string): Promise<FetchSourceRow> {
  const url = `https://lobste.rs/t/${encodeURIComponent(source.tag)}.json`;
  try {
    const { result, retried } = await withOneRetry(() =>
      guardedFetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        allowedContentType: /json/i,
      }),
    );
    const stories = JSON.parse(result.text) as LobstersStory[];
    const items = stories.map((story) =>
      makeItem({
        sourceId: source.id,
        sourceKind: "lobsters",
        url: story.url || story.short_id_url,
        title: story.title,
        body: story.description_plain ?? "",
        author: story.submitter_user,
        publishedAt: story.created_at ? new Date(story.created_at).toISOString() : null,
        retrievedAt,
      }),
    );
    return { sourceId: source.id, kind: "lobsters", ok: true, error: null, itemCount: items.length, retried, items };
  } catch (error) {
    return {
      sourceId: source.id,
      kind: "lobsters",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      itemCount: 0,
      retried: false,
      items: [],
    };
  }
}

export async function fetchLobsters(sources: LobstersSource[]): Promise<FetchSourceRow[]> {
  const retrievedAt = new Date().toISOString();
  return Promise.all(sources.map((source) => fetchOneTag(source, retrievedAt)));
}
