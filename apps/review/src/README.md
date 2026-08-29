# @smthrs/review — src

Source for `smithers-review`: a CLI (the package `bin` points at `cli/main.ts`)
that reviews a change set with agents and renders a self-contained HTML
walkthrough, optionally posting the result as a GitHub PR review — plus the
Cloudflare Worker behind review.smithers.sh (sharing, session minting, metered
Anthropic proxy; deployed via `../alchemy.run.ts`).

Directory map:

- `cli/` — arg parsing, live progress, publishing, and the entry point.
- `workflow/` — the smithers workflow, agent selection, and finding verification.
- `quiz/` — change-impact assessment and the reviewer comprehension quiz.
- `walkthrough/` — story normalization and the walkthrough HTML renderer.
- `diffs/` — Pierre + fallback diff-to-HTML rendering; the package's only
  export map entry (`smithers-review/diffs`).
- `github/` — PR integration via the `gh` CLI.
- `text/` — small shared text helpers (fences, pluralize, diff trimming).
- `server/` — the Cloudflare Worker (never runs in the CLI process).

Data flow: workflow tasks write rows (`review`, `final`, `story`, `quiz`,
`walkthrough`) into a per-run sqlite db; `cli/main.ts` reads them back via
`loadOutputs` to print summaries, publish, and post to GitHub.

Tests live in `../tests`, mirroring these directories.
