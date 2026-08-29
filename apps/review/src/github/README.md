# github/

PR integration via the `gh` CLI.

- `runGh.ts` — `ghBin()` resolves which `gh` to spawn (`SMITHERS_GH_BIN`
  overrides it) and is the only place that reads the override, so a preflight
  check and the call it guards cannot disagree; `runGh` spawns it;
  `runGhJsonLines` handles `--paginate` with per-item `@json` output.
- `resolvePullRequest.ts` — resolves PR coordinates (repo, number, base/head).
- `listPullRequestFiles.ts` + `parsePatchCommentableLines.ts` — determine
  which new-side lines can hold inline comments.
- `buildPullRequestReview.ts` — builds one review payload: narrative body plus
  anchored inline findings, with a 60k-char truncation that closes any open
  `<details>` blocks.
- `postPullRequestReview.ts` — posts the review; on any failure it folds the
  inline comments into the body so a review is never lost.
- `supersedePriorReviews.ts` — best-effort prefixing of older smithers reviews
  as superseded.

Invariant: GitHub rejects the whole review batch when any single comment fails
to anchor, so anchor checks (`anchorFor` + commentable-lines) gate every inline
comment.
