# cli/

The `smithers-review` bin's implementation. `../../bin/smithers-review.mjs` is
the entry point and `main.ts` starts nothing on import, so a test imports its
exported helpers (`buildRunSummaryLine`, `parseQuizColumn`) without running a
review.

- `parseReviewArgs.ts` — flag parsing with mutually exclusive review targets
  (`--commit` / `--from`+`--to` / `--pr`).
- `createProgressReporter.ts` — live stderr progress fed by the
  `@smthrs/agent/EventSink` seam, which hands a host every `AgentEvent` on its
  way past. 0.x polled the engine's output tables for this.
- `parseJsonColumn.ts` — tolerant reader for a stored JSON array column, which
  arrives as an array or a JSON string.
- `whichBinary.ts` — `PATH` lookup for the `gh` binary. 0.x called `Bun.which`,
  which tied the command to one runtime.
- `publishWalkthrough.ts` — uploads the walkthrough HTML to the share service;
  config from `SMITHERS_REVIEW_PUBLISH_URL`/`_TOKEN` env vars or
  `~/.smithers-review.json`.

Behaviors worth knowing:

- `--pr` derives `--from`/`--to` from the PR base and uses the PR title/body
  as review background.
- Publishing and the summary file are best-effort: their failures never fail
  the review.
- A failed review never posts a "0 findings" PR review.
