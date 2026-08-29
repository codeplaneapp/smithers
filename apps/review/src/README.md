# @smthrs/review — src

Source for `smithers-review`: a CLI (the package `bin` is `../bin/smithers-review.mjs`)
that reviews a change set with model-backed steps and renders a self-contained
HTML walkthrough, optionally posting the result as a GitHub PR review, plus the
Cloudflare Worker behind review.smithers.sh (sharing, session minting, metered
Anthropic proxy; deployed via `../alchemy.run.ts`).

Directory map:

- `cli/` — arg parsing, live progress, publishing, and the entry point.
- `workflow/` — the four-round review flow, its seats, and finding verification.
- `quiz/` — change-impact assessment and the reviewer comprehension quiz.
- `walkthrough/` — story normalization and the walkthrough HTML renderer.
- `diffs/` — Pierre + fallback diff-to-HTML rendering; the package's only
  export map entry (`smithers-review/diffs`).
- `github/` — PR integration via the `gh` CLI.
- `text/` — small shared text helpers (fences, pluralize, diff trimming).
- `server/` — the Cloudflare Worker (never runs in the CLI process).

Data flow: the flow's success value IS the answer. `Review.execute` resolves to
a `ReviewResult` carrying the target, the review, the story, the quiz, and the
walkthrough, and `cli/main.ts` reads that value directly to print summaries,
publish, and post to GitHub. Run state lives in a per-run SQLite file so a run
that dies mid-review resumes into the batches it had already settled.

Tests live in `../tests`, mirroring these directories.
