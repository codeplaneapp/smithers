# Post-failure autopsy: auto-investigate failed runs, `smithers bug`, bug.smithers.sh

## Problem

When a smithers run fails today, nothing happens. The `RunFailed` event is
emitted (`packages/engine/src/engine.js` ~5451 and ~5987) but has zero
subscribers; the CLI prints `✗ Run failed:` and exits. The purpose-built
`triage-run` workflow exists but must be launched by hand, and there is no way
to report a suspected smithers bug short of opening GitHub manually.

## Goals

1. **Automatic post-failure investigation.** Any time a workflow run fails, a
   `post-failure` system workflow launches automatically (detached) against
   that run, investigates why it failed, and produces a failure report plus a
   concrete suggestion (retry / resume, rewind, edit the workflow script and
   reset, fix the environment, or escalate).
2. **Bug detection with a human gate.** When the investigation concludes the
   failure looks like a bug in smithers itself (not the workflow or the
   environment), the workflow pauses on an Approval gate explaining what it
   thinks the bug is and asking the user whether to report it.
3. **`smithers bug` command.** A new CLI command that files a bug report to
   `https://bug.smithers.sh/api/bugs`. Usable standalone by humans and by the
   post-failure workflow after approval.
4. **bug.smithers.sh worker.** A small Cloudflare Worker that receives bug
   reports and stores them (KV), following the `apps/review` /
   ui-preview-worker precedent.

## Design

### Auto-trigger (CLI-level, opt-out)

No engine change. The trigger lives where run completion is already observed:

- `apps/cli/src/index.js` run-completion paths (`smithers up` / `workflow run`,
  both attached and post-detach reporting, ~lines 2257 and 2291): when
  `result.status === "failed"`, auto-launch the `post-failure` workflow
  detached with `--input '{"targetRunId":"<id>","workflowPath":"<path>"}'`.
- Guards:
  - Recursion: never trigger when the failing workflow is itself
    `post-failure`, `triage-run`, `monitor`, or `monitor-smithers` (ops
    workflows), and never when the run was launched with the env marker
    `SMITHERS_POST_FAILURE=0` set (the auto-launch sets `SMITHERS_POST_FAILURE=0`
    in the child env so a failing autopsy can't spawn another).
  - Opt-out: `SMITHERS_POST_FAILURE=0` env or `--no-post-failure` flag on
    `up`/`workflow run` disables the trigger. Default is ON.
  - Availability: if the `post-failure` workflow id is not installed, fall
    back to printing the manual CTA
    (`smithers workflow run post-failure --input '{"targetRunId":...}'`).
- The trigger prints one line telling the user the autopsy run id and how to
  watch it.

### `post-failure` workflow (`.smithers/workflows/post-failure.tsx`)

System workflow (`// smithers-system: true`), input
`{ targetRunId: string, workflowPath: string|null }`. Shape:

1. `gather` (compute, deterministic): `smithers inspect`, `smithers events`,
   `smithers output` for the target run; smithers version; recent engine log
   tail if present. Degrades gracefully.
2. `investigate` (smart agent WITH tools): read the evidence, re-run
   read-only CLI commands as needed, read the workflow source. Output:
   root-cause narrative, failure class
   (`workflow-bug | environment | agent-flake | smithers-bug | unknown`),
   confidence, and a `suggestion` — one of
   `retry` (re-run / `smithers retry-task`), `resume`, `rewind`,
   `edit-workflow-and-reset` (with the concrete edit), `fix-environment`
   (with the fix), `escalate` — plus the exact command(s) to run.
3. If `failureClass === "smithers-bug"`: `Approval` gate
   ("Post-failure autopsy thinks this is a smithers bug: <summary>. Report it
   to bug.smithers.sh?"). On approve → `report-bug` task runs
   `smithers bug --run <targetRunId> --title ... --body ...` and records the
   returned bug id/URL.
4. `verdict` (compute): stable final output row — failure class, root cause,
   suggestion + commands, bug id when filed — so `smithers output` prints a
   useful autopsy and the auto-trigger CTA line has something to point at.

The workflow only ever *suggests* restart/reset actions; it does not mutate
the failed run without a gate.

### `smithers bug` (apps/cli)

`smithers bug [--run <runId>] [--title <t>] [--body <b>] [--json] [--endpoint <url>]`

- Gathers: smithers version, platform/arch/bun version, and (when `--run` is
  given and readable) the run's workflow name, status, error, and the last ~50
  events, secrets-scrubbed (drop env-looking values, bearer tokens, keys).
- POSTs JSON to `SMITHERS_BUG_ENDPOINT` || `--endpoint` ||
  `https://bug.smithers.sh/api/bugs`. Prints the returned bug id + URL.
- Non-interactive-safe: with no `--title`, derives one from the run error;
  refuses politely when it has neither a run nor a title/body.
- Exit codes: 0 on filed, non-zero on network/endpoint failure with a clear
  message (and prints the payload path it saved to
  `.smithers/bug-reports/<ts>.json` so nothing is lost).

### bug.smithers.sh worker (`apps/bug-worker`)

- Cloudflare Worker, alchemy config like `apps/review` / the ui-preview
  worker. Routes:
  - `POST /api/bugs` — validate payload (zod), cap size (256KB), store in KV
    under `bug:<id>` (id = ulid-ish), return `{ id, url }`.
  - `GET /api/bugs/:id` — fetch one report (for maintainers; behind a shared
    secret header `x-bug-admin` for now).
  - `GET /healthz`.
- Abuse guards: per-IP rate limit (KV counter, 20/hour), payload cap, no
  auth required to POST (reporting must be zero-friction).
- Deploy: `pnpm -C apps/bug-worker deploy` (documented, not run by CI).

## Testing (no mocks)

- CLI: e2e test drives `smithers bug` against a real local `Bun.serve`
  fixture implementing the worker contract; asserts payload shape, scrubbing,
  offline fallback file.
- Worker: `bun test` against the worker's fetch handler with Miniflare-style
  real KV bindings (wrangler `unstable_dev` or alchemy local) — real handler,
  real storage, no route mocking.
- Trigger: e2e — run a deliberately-failing workflow with a fake agent, assert
  the CLI reports the auto-launched autopsy run id and that a `post-failure`
  run exists; assert `--no-post-failure` and the recursion guard suppress it.
- CI has no agent CLIs: all e2e must seed the fake agent.

## Docs

- `docs/guide/post-failure.mdx` (new): the autopsy loop, opting out, reading
  the verdict.
- `docs/reference/cli.mdx` (or equivalent): `smithers bug`, `--no-post-failure`.
- Regenerate llms bundles (`pnpm docs:llms`).

## Out of scope (follow-ups)

- Engine-level `RunFailed` subscriber / generic event-trigger surface for
  crons (the "proper" trigger system).
- Auto-executing the suggestion (auto-retry) without a gate.
- GitHub issue creation from the worker (bug triage stays manual for now).
