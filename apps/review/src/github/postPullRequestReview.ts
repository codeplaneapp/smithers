import type { PullRequestReviewPayload } from "./buildPullRequestReview";
import type { PullRequestFile } from "./listPullRequestFiles";
import type { PullRequestTarget } from "./resolvePullRequest";
import { runGh as defaultRunGh } from "./runGh";
import { publishReviewCore, validateReviewPayload, type ValidatedReviewPayload } from "../../action/src/publishReview";

/**
 * CLI authentication remains `gh`, but publication policy lives exclusively
 * in publishReviewCore.  This deliberately tiny transport bridge has no
 * retries or fallback of its own: the core owns GET→POST→422→GET→POST.
 */
function ghTransport(repoDir: string, runGh: typeof defaultRunGh, result: { url: string }) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const apiBase = new URL(process.env.GITHUB_API_URL ?? "https://api.github.com");
    const basePath = apiBase.pathname.replace(/\/+$/, "");
    if (url.origin !== apiBase.origin
      || (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))) {
      throw new Error("gh transport URL escaped the configured GitHub API base");
    }
    const relativePath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!relativePath) throw new Error("gh transport endpoint is empty");
    const endpoint = `${relativePath}${url.search}`;
    const method = init?.method ?? "GET";
    if (method !== "GET" && method !== "POST" && method !== "PUT") throw new Error("gh transport method is not allowed");
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error("gh transport request was aborted");
    const isWrite = method === "POST" || method === "PUT";
    if (isWrite && typeof init?.body !== "string") throw new Error("gh transport write body is invalid");
    try {
      const raw = await runGh(
        repoDir,
        isWrite ? ["api", "--method", method, endpoint, "--input", "-"] : ["api", endpoint],
        typeof init?.body === "string" ? init.body : undefined,
        { signal: init?.signal ?? undefined },
      );
      if (method === "POST") {
        try {
          const parsed = JSON.parse(raw) as { html_url?: unknown };
          if (typeof parsed.html_url === "string" && parsed.html_url.length <= 2_048) {
            const reviewUrl = new URL(parsed.html_url);
            if (reviewUrl.protocol === "https:" && !reviewUrl.username && !reviewUrl.password) result.url = reviewUrl.toString();
          }
        } catch { /* core will only need the bounded body */ }
      }
      return new Response(raw, { status: 200 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status = /\bHTTP (4\d\d|5\d\d)\b/.exec(detail)?.[1];
      // A HTTP response is not a transport rejection. In particular 422 must
      // reach the core's single guarded fallback path, while POST failures
      // never acquire an adapter retry.
      if (status) return new Response(detail, { status: Number(status) });
      throw error;
    }
  };
}

function canonicalPayload(
  payload: PullRequestReviewPayload,
  headSha: string,
  prFiles: ReadonlyMap<string, PullRequestFile>,
): ValidatedReviewPayload {
  const paths = new Set<string>();
  const capabilities = new Map<string, ReadonlySet<number>>();
  for (const [path, file] of prFiles) {
    if (path !== file.filename || paths.has(path) || !(file.commentableLines instanceof Set)) {
      throw new Error("PR publication file capabilities are inconsistent");
    }
    paths.add(path);
    capabilities.set(path, file.commentableLines);
  }
  return validateReviewPayload(payload, headSha, paths, capabilities);
}

export async function postPullRequestReview(
  repoDir: string,
  pr: PullRequestTarget,
  payload: PullRequestReviewPayload,
  runGh: typeof defaultRunGh = defaultRunGh,
  options: { expectedBaseSha: string; prFiles: ReadonlyMap<string, PullRequestFile> },
): Promise<{ url: string; inline: number; reviewId?: number; superseded: number }> {
  if (!options.expectedBaseSha || options.prFiles.size < 1 || options.prFiles.size > 3_000) {
    throw new Error("PR publication requires an immutable base SHA and exact changed-file count");
  }
  const result = { url: pr.url };
  const publication = await publishReviewCore({
    repository: `${pr.owner}/${pr.repo}`,
    prNumber: pr.number,
    // gh owns credentials; the bridge does not inspect this sentinel.
    token: "gh-cli-transport",
    expectedHead: pr.headSha,
    expectedBase: options.expectedBaseSha,
    expectedCount: options.prFiles.size,
    payload: canonicalPayload(payload, pr.headSha, options.prFiles),
    fetchImpl: ghTransport(repoDir, runGh, result) as typeof fetch,
  });
  return {
    url: result.url,
    inline: publication.folded ? 0 : payload.comments.length,
    ...(publication.reviewId === undefined ? {} : { reviewId: publication.reviewId }),
    superseded: publication.superseded,
  };
}
