# cli/

Entry point for the `smithers-review` bin. `main.ts` is guarded by
`import.meta.main`, so tests can import its exported helpers (e.g.
`parseQuizColumn`) without running the CLI.

- `parseReviewArgs.ts` — flag parsing with mutually exclusive review targets
  (`--commit` / `--from`+`--to` / `--pr`).
- `createProgressReporter.ts` — live stderr progress fed by the engine's
  `onProgress` hook; reads per-node row detail via an injected `loadRows`.
- `parseJsonColumn.ts` — tolerant reader for json-mode output columns, which
  arrive as arrays or JSON strings depending on the agent.
- `publishWalkthrough.ts` — uploads the walkthrough HTML to the share service;
  config from `SMITHERS_REVIEW_PUBLISH_URL`/`_TOKEN` env vars or
  `~/.smithers-review.json`.

Behaviors worth knowing:

- `--pr` derives `--from`/`--to` from the PR base and uses the PR title/body
  as review background.
- Publishing and the summary file are best-effort: their failures never fail
  the review.
- A failed review never posts a "0 findings" PR review.
