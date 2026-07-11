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

`.github/workflows/pr-review.yml` deliberately splits policy, analysis, and
publication. Analysis has `contents: read`, `pull-requests: read`, and
`id-token: write`; every checkout uses `persist-credentials: false`. The CLI
sees an offline `gh` replay/capture shim rather than a GitHub token. Publication
runs in a fresh job with `pull-requests: write`, never checks out the PR, and
strictly validates the untrusted artifact against the event's repository, PR,
head SHA, changed files, size, and schema.

Every CI review uses metered OIDC inference. This is deliberately unconditional:
a same-repository PR can alter an ordinary `pull_request` workflow before an
in-workflow trust gate runs, so repository-level personal subscription secrets
cannot be made safe by actor or branch checks inside it. The canonical
`pull_request_target` workflow definition comes from the base branch, gives the
analysis job read-only authority, and reserves PR write access for the isolated
publisher. Agents use non-yolo read-only policies and an explicit environment
allowlist. On hosted Linux runners the CLI crosses a real OS boundary into a
dedicated unprivileged UID; it receives only a random local broker key while
the session credential remains in the trusted parent process. The Claude CLI
runs in bare mode so project hooks, settings, plugins, and MCP configuration in
the PR checkout cannot expand its tool surface.

## Self-hosted CI (your own credentials)

Start from the canonical three-job workflow even on a self-hosted runner. Do
not run `--pr` with a writable token or personal subscription credential in the
same process that analyzes PR content. Keep subscription credentials out of
PR-triggered CI entirely; local terminal use remains supported.

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
URL. The live endpoint is `https://review.jjhub.tech`; set
`SMITHERS_REVIEW_PUBLISH_URL` to the publish service endpoint before using
`--publish` (see the spec's "Publishing" section). Credentials come from
`SMITHERS_REVIEW_PUBLISH_URL` / `SMITHERS_REVIEW_PUBLISH_TOKEN` or
`~/.smithers-review.json`.

```sh
REVIEW_PUBLISH_TOKEN=... pnpm -C apps/review deploy   # alchemy deploy
SMITHERS_REVIEW_E2E=1 pnpm -C apps/review test        # includes live publish e2e
```

## Models

When Codex is installed and authenticated, agents default to Codex: Sol reviews
and verifies, while Luna narrates and writes quizzes. If Codex is unavailable,
the workflow falls back to Claude Code (Fable primary, Opus failover). Override
the engine with `SMITHERS_REVIEW_ENGINE`, the primary model with
`SMITHERS_REVIEW_MODEL`, the Codex cheap model with
`SMITHERS_REVIEW_CHEAP_MODEL`, or the Claude fallback with
`SMITHERS_REVIEW_FALLBACK_MODEL`.

## Tests

```sh
pnpm -C apps/review test        # bun test: real git fixtures + agentless engine e2e
pnpm -C apps/review typecheck
```

## smithers review

This repo dogfoods `apps/review` on every PR via `.github/workflows/pr-review.yml`, using the metered OIDC path described in `apps/review/README.md`.
