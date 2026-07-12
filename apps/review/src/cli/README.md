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
  atomically bound config from `SMITHERS_REVIEW_PUBLISH_URL`/`_TOKEN` env vars
  or a private `~/.smithers-review.json`; returned share URLs are origin-bound.
- `reviewSummary.ts` — emits a bounded canonical scalar summary of at most 4
  KiB through a mode-0600, no-follow private temporary file and atomic
  replacement of a regular destination,
  without persisting paths, response URLs, or errors.

Behaviors worth knowing:

- `--pr` derives `--from`/`--to` from the PR base and uses the PR title/body
  as review background.
- Publishing failures may leave the local review available, but an explicitly
  requested summary is part of the command contract: each write atomically
  replaces the previous regular file after durable flush, and replacement or
  write failures produce a nonzero result. Summary destinations must not be
  symlinks or non-regular files.
- A failed review never posts a "0 findings" PR review.
