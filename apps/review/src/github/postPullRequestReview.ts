import type { PullRequestReviewPayload } from "./buildPullRequestReview";
import type { PullRequestTarget } from "./resolvePullRequest";
import { runGh } from "./runGh";

/**
 * Post a review to the PR via `gh api`. GitHub rejects the whole batch (422)
 * when any inline comment fails to anchor in the diff, so on failure the
 * inline comments are folded into the body and posted once more — a review is
 * always posted.
 */
export async function postPullRequestReview(
  repoDir: string,
  pr: PullRequestTarget,
  payload: PullRequestReviewPayload,
): Promise<{ url: string; inline: number }> {
  const endpoint = `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`;
  const post = async (body: PullRequestReviewPayload) => {
    const raw = await runGh(repoDir, ["api", "--method", "POST", endpoint, "--input", "-"], JSON.stringify(body));
    return JSON.parse(raw) as { html_url?: string };
  };

  try {
    const result = await post(payload);
    return { url: result.html_url ?? pr.url, inline: payload.comments.length };
  } catch (error) {
    if (payload.comments.length === 0) throw error;
    // Surface why the inline batch failed before falling back, or the reason
    // (rate limit, bad anchor, transient 5xx) is unrecoverable afterwards.
    console.error(
      `smithers-review: inline comment batch failed, folding ${payload.comments.length} finding(s) into the body: ${(error as Error).message.slice(0, 300)}`,
    );
    const folded = payload.comments
      .map((comment) => `- \`${comment.path}:${comment.start_line ?? comment.line}\`\n\n${comment.body}`)
      .join("\n\n");
    const fallback: PullRequestReviewPayload = {
      ...payload,
      comments: [],
      body: `${payload.body}\n\n### Inline findings (could not anchor in the diff)\n\n${folded}`.slice(0, 64_000),
    };
    const result = await post(fallback);
    return { url: result.html_url ?? pr.url, inline: 0 };
  }
}
