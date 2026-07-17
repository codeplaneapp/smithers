import type { GithubReleasesSource } from "../config";
import { guardedFetch, withOneRetry } from "../fetchGuards";
import type { FetchSourceRow } from "../schemas";
import { parseFeedEntries } from "./feedParser";
import { makeItem } from "./itemFactory";

const USER_AGENT = "smithers-daily-ceo-intel/1.0 (+https://smithers.sh; contact: it-team@tevm.tech)";

async function fetchOneRepo(source: GithubReleasesSource, retrievedAt: string): Promise<FetchSourceRow> {
  const url = `https://github.com/${source.owner}/${source.repo}/releases.atom`;
  try {
    const { result, retried } = await withOneRetry(() =>
      guardedFetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/atom+xml, application/xml, text/xml" },
        allowedContentType: /xml|atom/i,
      }),
    );
    const entries = parseFeedEntries(result.text);
    const items = entries.map((entry) =>
      makeItem({
        sourceId: source.id,
        sourceKind: "githubReleases",
        url: entry.url,
        title: `${source.owner}/${source.repo}: ${entry.title}`,
        body: entry.body,
        author: entry.author,
        publishedAt: entry.publishedAt,
        retrievedAt,
      }),
    );
    return { sourceId: source.id, kind: "githubReleases", ok: true, error: null, itemCount: items.length, retried, items };
  } catch (error) {
    return {
      sourceId: source.id,
      kind: "githubReleases",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      itemCount: 0,
      retried: false,
      items: [],
    };
  }
}

export async function fetchGithubReleases(sources: GithubReleasesSource[]): Promise<FetchSourceRow[]> {
  const retrievedAt = new Date().toISOString();
  return Promise.all(sources.map((source) => fetchOneRepo(source, retrievedAt)));
}
