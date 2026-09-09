import type { PullRequestTarget } from "./resolvePullRequest.ts";
import { runGh as defaultRunGh, runGhJsonLines } from "./runGh.ts";

const MARKER = "<!-- smithers-review -->";
// Re-running the sweep is a no-op: a body that already starts with this
// prefix is skipped, so a retry after a partial failure adds nothing twice.
const SUPERSEDED_PREFIX = "Superseded by a newer smithers review.";
// GitHub caps review bodies at 65536 characters; leave room for the prefix.
const MAX_UPDATED_BODY = 64_000;

/**
 * Mark earlier smithers reviews on the PR as superseded once the replacement
 * has been posted: list the PR's reviews, find ones authored by the current gh
 * user whose body carries the smithers marker, and prefix their body with a
 * superseded note via `PUT /pulls/{n}/reviews/{id}` (the update-review
 * endpoint accepts a body update; dismissal is a different endpoint and needs
 * a dismissable state).
 *
 * `newReviewId` is the replacement's id and is required, not optional: taking
 * it forces the caller to have posted first, so a run that dies or fails on
 * the way to GitHub can never leave the PR carrying only superseded notes. It
 * is also excluded from the sweep, because the list read after the POST
 * already contains the new review and it must not supersede itself.
 *
 * Best-effort by design: any failure returns 0 and the posted review stands.
 */
export async function supersedePriorReviews(
  repoDir: string,
  pr: PullRequestTarget,
  newReviewId: number,
  runGh: typeof defaultRunGh = defaultRunGh,
): Promise<number> {
  try {
    const login = (await runGh(repoDir, ["api", "user", "--jq", ".login"])).trim();
    if (!login) return 0;
    const records = await runGhJsonLines(
      repoDir,
      [
        "api",
        "--paginate",
        `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
        "--jq",
        ".[] | {id, body, login: .user.login} | @json",
      ],
      runGh,
    );
    let superseded = 0;
    for (const parsed of records) {
      const review = parsed as { id?: unknown; body?: unknown; login?: unknown };
      if (typeof review.id !== "number" || typeof review.body !== "string") continue;
      if (review.id === newReviewId) continue;
      if (review.login !== login) continue;
      if (!review.body.includes(MARKER) || review.body.startsWith(SUPERSEDED_PREFIX)) continue;
      const updated = `${SUPERSEDED_PREFIX}\n\n${review.body}`.slice(0, MAX_UPDATED_BODY);
      try {
        await runGh(
          repoDir,
          [
            "api",
            "--method",
            "PUT",
            `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews/${review.id}`,
            "--input",
            "-",
          ],
          JSON.stringify({ body: updated }),
        );
        superseded += 1;
      } catch (error) {
        console.error(
          `smithers-review: could not mark prior review ${review.id} superseded: ${(error as Error).message.slice(0, 200)}`,
        );
      }
    }
    return superseded;
  } catch (error) {
    console.error(`smithers-review: supersede check failed (non-fatal): ${(error as Error).message.slice(0, 200)}`);
    return 0;
  }
}
