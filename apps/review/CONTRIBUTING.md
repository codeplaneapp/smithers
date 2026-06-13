# Contributing to smithers review

Internals, architecture, and development workflow for `apps/review`. For
what the tool does and how to set it up, read the [README](README.md).

Specs: `.smithers/specs/smithers-review-walkthrough.md` (review + walkthrough
pipeline) and `.smithers/specs/smithers-review-cloud.md` (hosted service:
OIDC repo auth, metered inference proxy, quota, metrics).

## How it works

One durable smithers workflow, run in-process through the engine:

1. The review side reuses `.smithers/lib/open-code-review.ts` (the
   OpenCodeReview-derived flow): target resolution, file filtering, one
   parallel review agent per file with the OpenCodeReview prompt, then comment
   normalization and line anchoring.
2. `collect-changes` loads the full diff for every changed file, including
   files the review filters skip (tests, docs, configs). The walkthrough shows
   everything.
3. `narrate` (an agent) writes the story as block streams: prose explanation
   (markdown), diff blocks that embed each file's diff at the right point in
   the narrative, and Mermaid diagrams wherever structure or flow changed.
   Chapters open with the central change and follow dependency order; prose
   between diffs carries the thread. `normalizeStory` enforces that every
   changed file appears in exactly one diff block; a deterministic fallback
   story covers agent failure and `--no-narrate`.
4. `walkthrough` renders self-contained HTML (inline CSS, no external assets)
   and writes it to `--out`. Diffs are rendered with `@pierre/diffs` (syntax
   highlighting, word-level diffs, line numbers, unified or `--split` view);
   diagrams render via an inlined Mermaid runtime (only included when the
   story has diagrams); the header shows a deterministic change-overview SVG
   chart of additions/deletions by area.

Review findings never change the exit code; smithers review reports, humans
decide.

## Reviewing GitHub PRs

`--pr <number|url>` resolves the PR via the `gh` CLI, defaults the review
range to `origin/<base>..<headSha>`, and after the run posts one PR review:
the narrative summary (headline, synopsis, reading order, walkthrough link
when `--publish` ran) as the body, and every anchorable finding as an inline
comment with a ` ```suggestion ` fence when replacement code exists. If
GitHub rejects the inline batch, the findings are folded into the body and
the review still posts. The PR's head must exist locally (check out the
branch or fetch it first).

## CI

`.github/workflows/pr-review.yml` runs `--pr <number> --publish` on every
non-draft PR from a branch in this repo and posts the review onto it. The job
is scoped to `contents: read` + `pull-requests: write` and stays on the
`pull_request` event (never `pull_request_target`), so fork PRs run without
secrets and are skipped. Repo secrets: `CLAUDE_CODE_OAUTH_TOKEN` (from
`claude setup-token`; `ANTHROPIC_API_KEY` also works) for the agents, and
`SMITHERS_REVIEW_PUBLISH_TOKEN` for the hosted walkthrough link. Missing agent
credentials skip the job; a missing publish token posts the review without the
link. The walkthrough HTML is also uploaded as a run artifact.

## Self-hosted CI (your own credentials)

To run reviews in another repo's CI without the hosted service, bring your
own Claude credentials and check out smithers next to the repo:

```yaml
name: PR review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions: {}

jobs:
  review:
    # Fork PRs have no secrets and a read-only token; drafts are not ready.
    if: github.event.pull_request.head.repo.full_name == github.repository && !github.event.pull_request.draft
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v6.0.2
        with:
          fetch-depth: 0 # the review diffs origin/<base>..<head>; merge-base needs history
      - uses: actions/checkout@v6.0.2
        with:
          repository: smithersai/smithers
          path: .smithers-review-tool
      - uses: pnpm/action-setup@v6.0.8
        with:
          version: 10.10.0
          run_install: false
      - uses: actions/setup-node@v6.4.0
        with:
          node-version: 22
      - uses: oven-sh/setup-bun@v2.2.0
        with:
          bun-version: 1.3.13
      - run: pnpm -C .smithers-review-tool install --frozen-lockfile
      - run: npm install -g @anthropic-ai/claude-code
      - name: Review the PR
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: >
          bun .smithers-review-tool/apps/review/src/cli/main.ts .
          --pr ${{ github.event.pull_request.number }}
```

`CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token`
(`ANTHROPIC_API_KEY` also works). Never use `pull_request_target` here.

## Rendering diffs anywhere else

The diff renderer is exported as `@smithers-orchestrator/review/diffs` so
humans and agents can embed the same diffs in any artifact (reports, custom
workflow UIs, dashboards):

```ts
import { renderPierreFileDiff, extractDiffAssets } from "@smithers-orchestrator/review/diffs";

const html = await renderPierreFileDiff({ diff: gitPatchForOneFile });
// embedding many diffs in one page? hoist the shared assets once:
const { sprite, styles, body } = extractDiffAssets(html);
```

The Pierre reference clone lives at `reference/pierre/` (gitignored).

## Publish service

`--publish` uploads the walkthrough to a Cloudflare Worker (R2-backed,
deployed with Alchemy from `alchemy.run.ts`) and prints an unlisted share
URL. Live at `https://review.jjhub.tech`; the target domain
`review.smithers.sh` is pre-wired but blocked on credentials (see the spec's
"Publishing" section). Credentials come from `SMITHERS_REVIEW_PUBLISH_URL` /
`SMITHERS_REVIEW_PUBLISH_TOKEN` or `~/.smithers-review.json`.

```sh
REVIEW_PUBLISH_TOKEN=... pnpm -C apps/review deploy   # alchemy deploy
SMITHERS_REVIEW_E2E=1 pnpm -C apps/review test        # includes live publish e2e
```

## Models

Agents default to ClaudeCode subscription providers (opus primary, sonnet
failover). Override with `SMITHERS_REVIEW_MODEL` /
`SMITHERS_REVIEW_FALLBACK_MODEL`.

## Tests

```sh
pnpm -C apps/review test        # bun test: real git fixtures + agentless engine e2e
pnpm -C apps/review typecheck
```

## smithers review

This repo dogfoods `apps/review` on every PR via `.github/workflows/pr-review.yml`, running the agents on a ChatGPT (Codex) subscription. See `apps/review/README.md`.
