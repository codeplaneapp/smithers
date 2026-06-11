# smithers review

Our CodeRabbit. One command reviews a change set with agents and writes a
single-file HTML walkthrough that presents the change as a story: chapters in
logical reading order, each explaining why a group of files changed, with
diffs and review findings inline. You read it top to bottom instead of
decoding an alphabetical file list.

Spec: `.smithers/specs/smithers-review-walkthrough.md`.

## Usage

```sh
# review the working tree of the current repo, write .smithers-review/walkthrough.html
bun apps/review/src/cli/main.ts

# review a branch against main, open the walkthrough when done
bun apps/review/src/cli/main.ts --from main --to HEAD --open

# publish the walkthrough to the share service and print the URL
bun apps/review/src/cli/main.ts --from main --to HEAD --publish

# review a GitHub PR and post the review onto it (summary + inline findings)
bun apps/review/src/cli/main.ts --pr 123 --publish

# review one commit
bun apps/review/src/cli/main.ts --commit abc1234

# no agents: deterministic story, no review findings (works offline)
bun apps/review/src/cli/main.ts --no-review --no-narrate
```

Run `--help` for all options.

## How it works

One durable smithers workflow, run in-process through the engine:

1. The review side reuses `.smithers/lib/open-code-review.ts` (the
   OpenCodeReview-derived flow): target resolution, file filtering, one
   parallel review agent per file with the OpenCodeReview prompt, then comment
   normalization and line anchoring.
2. `collect-changes` loads the full diff for every changed file, including
   files the review filters skip (tests, docs, configs). The walkthrough shows
   everything.
3. `narrate` (an agent) organizes the change set into chapters: the central
   change first, supporting code in dependency order, tests with what they
   prove, chores last. Every file also gets a narrative paragraph the reader
   sees right before its diff, walking through what the diff does.
   `normalizeStory` enforces that every changed file appears in exactly one
   chapter; a deterministic fallback story covers agent failure and
   `--no-narrate`.
4. `walkthrough` renders self-contained HTML (inline CSS, no external assets)
   and writes it to `--out`. Diffs are rendered with `@pierre/diffs`: syntax
   highlighting, word-level diffs, line numbers, unified or `--split` view.

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

Agents default to ClaudeCode subscription providers (opus primary, sonnet
failover). Override with `SMITHERS_REVIEW_MODEL` /
`SMITHERS_REVIEW_FALLBACK_MODEL`.

## Tests

```sh
pnpm -C apps/review test        # bun test: real git fixtures + agentless engine e2e
pnpm -C apps/review typecheck
```
