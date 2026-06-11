# Smithers review: code review + story-form HTML walkthrough

`apps/review` ("smithers review") is our CodeRabbit. It does two things in one run:

1. Reviews changed code with the OpenCodeReview-derived per-file review flow
   already in `.smithers/lib/open-code-review.ts` (the same prompts, filters,
   and comment-anchoring logic the `open-code-review` workflow uses).
2. Writes a single-file HTML walkthrough that presents the change as a story:
   chapters in logical reading order, each explaining why a group of files
   changed, with the diffs and review findings inline. A reviewer reads it top
   to bottom instead of decoding an alphabetical file list.

## CLI

```
smithers review [repo] [options]

  --from <ref> --to <ref>   review a ref range (merge-base diff)
  --commit <sha>            review a single commit
                            (default: workspace changes, tracked + untracked)
  --background <text>       requirement background passed to review + narrator
  --title <text>            walkthrough title (default: narrator headline)
  --out <file>              output HTML path (default: <repo>/.smithers review/walkthrough.html)
  --db <file>               smithers db path (default: <repo>/.smithers review/smithers review.db)
  --no-review               skip review agents; walkthrough only
  --no-narrate              skip the narrator agent; deterministic story order
  --concurrency <n>         parallel file reviews (default 8)
  --timeout <min>           per-agent-task timeout in minutes (default 10)
  --open                    open the HTML in the default browser when done
```

Run it with bun: `bun apps/smithers review/src/cli/main.ts` or via the `smithers review` bin.
Exit code 0 when the walkthrough is written, 1 on failure. Review findings do
not affect the exit code; smithers review reports, humans decide.

## Pipeline

One durable smithers workflow (`createReviewWorkflow`), programmatic engine run
(`runWorkflow` from `@smithers-orchestrator/engine`), own sqlite db. Tasks:

| id                | kind    | what it does |
|-------------------|---------|--------------|
| `resolve-target`  | compute | `resolveReviewTarget` from the review lib |
| `preview`         | compute | `previewOpenCodeReview`: file list, stats, review filters |
| `collect-changes` | compute | `loadDiffs`: full diff text for every changed file, including files the review filters exclude (tests, docs); the walkthrough shows everything |
| `prepare-review`  | compute | `buildNativeReviewPrompt`: per-file review prompts |
| `review-file-*`   | agent   | one per reviewable file, in parallel, OpenCodeReview prompt verbatim |
| `review`          | compute | `finalizeNativeReview`: comment normalization, line anchoring, scoping |
| `narrate`         | agent   | turns the change set + findings into a story (schema below) |
| `walkthrough`     | compute | normalize the story, render HTML, write the file |

Review reuse is at the lib level: smithers review imports the lib functions, it does not
fork their logic. New lib exports added for smithers review: `loadDiffs`,
`effectivePath`, `diffStatus`, `type DiffRecord` (all existed as internals).

`--no-review` (or no review agents configured) sets `runReview: false` before
`prepare-review`, so the review finalizer reports `skipped` instead of failing.
`narrate` runs with `continueOnFail`; if it fails or is disabled the
walkthrough falls back to the deterministic story.

## Story schema

The narrator returns structured output:

```ts
story = {
  headline: string,    // one sentence: what this change does
  synopsis: string,    // short paragraph: the arc of the change
  chapters: [{
    title: string,
    narrative: string, // why this chapter exists, what to look for
    files: [{
      path: string,
      role: string,      // one-line label for the chapter listing
      narrative: string, // 2-4 sentences read right before the diff: what
                         // the diff actually does, walking the reader
                         // through the change (new functions, behavior
                         // shifts, what to check)
    }],
  }],
}
```

Narrator ordering contract: open with the motivating or central change, follow
it through supporting code in dependency order, keep related files together,
put tests next to what they prove, end with chores. Every changed file appears
in exactly one chapter.

`normalizeStory` repairs agent output before rendering: drops paths that are
not in the change set, dedupes files across chapters (first chapter wins),
drops empty chapters, and appends an "Everything else" chapter for any changed
file the story missed. The invariant after normalization: every changed file
appears in exactly one chapter. If nothing survives, the fallback story is
used.

`fallbackStory` is deterministic: code files grouped by workspace area
(`apps/x`, `packages/y`, top-level dir otherwise), ordered by churn descending,
then configuration, then tests, then docs. It needs no agent, so the
walkthrough works offline and in tests.

## Walkthrough HTML

Self-contained single file, inline CSS, one small inline script
(expand/collapse all). No external assets, works from `file://`. Content, in
order:

- header: title/headline, synopsis, repo + ref + mode + date, change totals
- findings index: review comment count, links to each finding's file section
- table of contents: numbered chapters
- chapters: narrative prose, then per file: path, status badge, +/- counts,
  the file's role line, review findings as callout cards (comment, line range,
  existing/suggested code), and the rendered diff in a `<details>` block
- binary files get a note instead of a diff; very long diffs are truncated
  with a line count notice

All dynamic text is HTML-escaped. Diff rendering is display-only and lives in
the app, not the review lib.

## Diff rendering (@pierre/diffs)

Diffs are rendered with `@pierre/diffs` (Pierre's open-source diff renderer,
Apache-2.0) through its SSR entry: syntax highlighting via light/dark token
variables, word-level intra-line diffs, line numbers, unified or split view
(`--split`). The reference clone lives at `reference/pierre/` (gitignored).

The integration is the `src/diffs/` domain in `apps/review`, exported as
`@smithers-orchestrator/review/diffs` so any workspace code, workflow compute
node, or agent-authored artifact can render the same diffs:

- `renderPierreFileDiff({ diff, diffStyle, themeType })`: one file's git
  patch to self-contained HTML (`preloadPatchDiff` under the hood, file
  header disabled because the walkthrough draws its own).
- `extractDiffAssets(html)`: splits the SVG sprite sheet and `<style>` blocks
  from the body. Every Pierre block ships identical assets, so a page with
  many diffs hoists them once; the walkthrough carries exactly one sprite and
  two Pierre styles regardless of file count.
- `renderFallbackDiffHtml(diff)`: the plain truncating renderer, used for
  binary files, diffs over 5000 changed lines, and Pierre parse failures.

Pierre line annotations render as empty hydration slots in SSR, so review
findings stay as callout cards above each diff instead of inline rows.

## Outputs

CLI-read output rows (`walkthrough`, via `loadOutputs`) use single-word
column names (`path`, `bytes`, `chapters`, `files`, `findings`, `message`)
because output rows come back snake_cased; single words round-trip unchanged.

## Agents

Default agents are the two reliable ClaudeCode subscription providers (see
`.smithers/agents.ts` and issue #236): opus primary, sonnet fallback, `cwd` set
to the target repo. Override models with `SMITHERS_REVIEW_MODEL` and
`SMITHERS_REVIEW_FALLBACK_MODEL`.

## Testing

- Unit tests on real git fixtures (temp repos, real `git`), no mocks: fallback
  story grouping/ordering, story normalization invariants, HTML rendering and
  escaping.
- An agentless end-to-end test runs the real workflow through the real engine
  (`runWorkflow`, real sqlite, real git): `--no-review --no-narrate` on a temp
  repo, then asserts the HTML exists and contains every changed file.
- Agent-driven runs are exercised manually (`smithers review` on this repo); they need
  ClaudeCode credentials.

## Publishing

Walkthroughs are static HTML, so "deploying" smithers review means giving the
artifacts a home. A Cloudflare Worker (deployed with Alchemy IaC from
`apps/review/alchemy.run.ts`, R2-backed) serves published walkthroughs. It is
live at `https://review.jjhub.tech` (plus a workers.dev fallback URL):

- `POST /api/walkthroughs` with `Authorization: Bearer <token>` and an HTML
  body stores the walkthrough in R2 under a random id and returns
  `{ id, url }`. The token is the `REVIEW_PUBLISH_TOKEN` Worker secret.
- `GET /w/<id>` serves the stored walkthrough (unlisted capability links,
  `x-robots-tag: noindex`).
- `GET /` is a usage landing page.

CLI: `--publish` uploads the generated walkthrough and prints the share URL.
The endpoint and token come from `SMITHERS_REVIEW_PUBLISH_URL` /
`SMITHERS_REVIEW_PUBLISH_TOKEN`, falling back to `~/.smithers-review.json`
(`{ "publishUrl": ..., "publishToken": ... }`).

Domain status: the target hostname is `review.smithers.sh`, but the
`smithers.sh` zone lives on Vercel DNS (registrar Name.com), not Cloudflare,
so the Worker cannot take it as a plain custom domain. The plan is Cloudflare
for SaaS on the `jjhub.tech` zone (custom hostname + fallback origin + Worker
route + a CNAME at Vercel). Both credential paths are currently blocked: the
`CLOUDFLARE_API_TOKEN` lacks the Zone SSL-and-Certificates permission that
the custom-hostnames API requires, and `VERCEL_API_TOKEN` is expired. The
route is pre-wired in `alchemy.run.ts` behind
`REVIEW_ENABLE_SMITHERS_SH_ROUTE=1`; once fresh tokens exist, provision the
custom hostname, add the Vercel CNAME, redeploy with the flag and
`REVIEW_PUBLIC_BASE_URL=https://review.smithers.sh`.

Agents still run locally; the service stores and serves artifacts only. It
never sees repo contents beyond the HTML you choose to publish.

## GitHub PR reviews (--pr)

`--pr <number|url>` reviews a GitHub pull request and posts the result onto
the PR as one review (event `COMMENT`), CodeRabbit-style:

- The review body is the narrative summary: headline, synopsis, the reading
  order (chapter titles, chapter narratives, per-file role lines), a link to
  the published walkthrough when `--publish` ran, and any findings that could
  not be anchored inline. Bodies are capped under GitHub's 64KB limit.
- Each anchorable finding becomes an inline review comment: `path` +
  `line`/`start_line` in new-file numbering (side `RIGHT`), with a
  ` ```suggestion ` fence when the finding carries replacement code.
  Anchorable means the finding has resolved line numbers and its path is in
  the PR's changed-file list.
- Posting goes through the `gh` CLI (`gh api`), so auth is whatever `gh` is
  logged in as. If GitHub rejects the batch (422 — e.g. a line fell outside
  the PR diff), the poster retries once with all findings folded into the
  body, so a review is always posted.

When `--pr` is given and no explicit target, the review range defaults to
`origin/<baseRef>`..`<headSha>` (falling back to `<baseRef>` if the remote
ref is absent). Posting happens CLI-side after the run, like `--publish`;
the workflow itself stays GitHub-free. The PR's head must be checked out or
fetched locally, since review runs against the local repo.

The walkthrough output row gains a `story` column (JSON of the normalized
story) so the CLI can compose the PR body without re-deriving the story.

## Non-goals (for now)

- No GitHub App or webhooks; PR posting is CLI-side via `gh`.
- No incremental re-review state or in-place summary updates. Each run posts
  a fresh review.
- No chat replies on findings.
- No walkthrough listing/index endpoint; URLs are unlisted capability links.
