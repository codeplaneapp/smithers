---
name: daily-ceo-intel
description: Fetch the prior 24h of AI-agent/orchestration news, dedupe/cluster/rank it deterministically, and compose, verify, render, and publish The Smithers Signal — a daily CEO intelligence issue.
workflow: daily-ceo-intel
---

Use this manual-only workflow to produce **The Smithers Signal**, a daily
magazine-voice intelligence brief on AI-agent orchestration. It takes zero
required inputs: it fetches RSS/Atom blogs, GitHub release feeds, HN Algolia,
Lobsters, Reddit, and Bluesky for the last 24 hours, runs a fully
deterministic normalize → filter → dedupe → seen-state → cluster → rank
chain, uses tool-less agents only for relevance scoring, Lighter Side
curation, and the final composition, then deterministically verifies and
renders md/html/json and archives (or publishes to Cloudflare KV/R2, when
`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_KV_NAMESPACE_ID`
/ `CLOUDFLARE_R2_BUCKET` are set in env).

Start it with:

```sh
smithers up .smithers/workflows/daily-ceo-intel.tsx -d
```

Inputs are all optional and nullable: `windowEnd` (ISO-8601 UTC override,
defaults to run start), `publishMode` (`auto` | `archive-only` | `publish`,
defaults to `auto`), and `configPath` (defaults to `config/ceo-intel.json`).
For example, to force a local-only archive of a specific day:

```sh
smithers up .smithers/workflows/daily-ceo-intel.tsx --input '{"publishMode":"archive-only","windowEnd":"2026-07-17T12:00:00.000Z"}'
```

Watch it with `smithers ps`, `smithers logs <runId> -f`, and
`smithers inspect <runId>`. The custom UI lives at
`.smithers/ui/daily-ceo-intel.tsx` — open a run with `smithers ui <runId>` to
see the pipeline funnel, per-stage status board, the latest issue preview
(Brief / Top Stories / Lighter Side / Raw tabs), and the source coverage
table. The run has no human approval gates, so `smithers approve <runId>`
never applies here; if a run looks stuck, use `smithers why <runId>` to see
what it's waiting on, and `smithers cancel <runId>` to stop it.

Visualize the graph with `smithers graph .smithers/workflows/daily-ceo-intel.tsx`.

Editorial composition gets exactly one bounded repair pass: if the composed
issue fails deterministic verification (invented `SRC-###` ids, out-of-window
dates, duplicate clusters, missing sections, over the story/action/word-count
caps, or Lighter Side not last), the editorial agent gets one re-synthesis
attempt with the verifier's error list appended to its prompt. A second
failure still archives the report locally (or to R2, if configured) but never
publishes, and the run ends failed via `assert-verified`.

Source and scoring config lives in `config/ceo-intel.json` (pool names,
weights, thresholds, paths) and `config/sources.json` (the actual RSS/GitHub
releases/HN/Lobsters/Reddit/Bluesky source list) — both versioned and
editable directly. Runtime state — fingerprints for the 30-day dedupe window,
fetch history, and delivery records — lives in the app-owned sqlite database
at `data/ceo-intel.sqlite` (gitignored). Rendered issues land under
`reports/YYYY-MM-DD.{md,html,json}` (also gitignored) when not publishing to
R2.

Suggest next: run it once with `publishMode: "archive-only"` to see a full
issue without touching Cloudflare, review the output under `reports/`, then
wire up the Cloudflare env vars and a `smithers cron` schedule for the
7am ET daily cadence.
