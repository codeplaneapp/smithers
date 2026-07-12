# github/

PR integration via the `gh` CLI.

- `runGh.ts` — spawns `gh` (honors `SMITHERS_GH_BIN`); `runGhJsonLines`
  handles `--paginate` with per-item `@json` output.
- `resolvePullRequest.ts` — resolves PR coordinates (repo, number, base/head).
- `listPullRequestFiles.ts` + `parsePatchCommentableLines.ts` — read the
  protected immutable manifest and determine which new-side lines can hold
  inline comments; the capped live files endpoint is not a capability source.
- `buildPullRequestReview.ts` — builds one review payload: narrative body plus
  anchored inline findings, with a 60k-char truncation that closes any open
  `<details>` blocks.
- `postPullRequestReview.ts` — routes CLI-backed publication through the same
  guarded GET → POST → 422 fallback lifecycle as the isolated publisher.
  The shared lifecycle also marks only lower-ID reviews by the same author as
  superseded, which remains race-safe when publishers overlap.

Invariant: GitHub rejects the whole review batch when any single comment fails
to anchor, so anchor checks (`anchorFor` + commentable-lines) gate every inline
comment.
