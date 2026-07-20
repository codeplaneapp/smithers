# repo-prospector

A self-throttling growth workflow. Each run finds one GitHub repo it has never
looked at, works out whether a Smithers workflow would help it, builds a real
demonstration on a fork, and drafts outreach for a human to approve before
anything is sent.

## Why

The strongest pitch for Smithers is a working diff against a maintainer's own
repo, especially when they already run some brittle automation (a hand-rolled CI
job, a flaky bot, an LLM glued together with shell) that a durable Smithers
workflow replaces. This workflow manufactures that pitch one repo at a time, on a
cadence, without ever pestering a maintainer until a human signs off.

## Throttle

Once every 15 minutes, two layers:

1. A `smithers cron` schedule (`*/15 * * * *`) drives the cadence.
2. The workflow throttles *itself*. The `gate` task reads a `lastRunAt` stamp
   from the ledger and refuses to proceed if less than 15 minutes have passed, so
   manual or stacked invocations can't run hot. `--input '{"force":true}'`
   bypasses the guard for testing.

## Seen ledger — never look twice

State lives at `.smithers/state/repo-prospector.json` (gitignored, local mutable
state). Shape:

```json
{ "lastRunAt": 1700000000000,
  "seen": [ { "repo": "owner/name", "at": 1700000000000 } ] }
```

`gate` loads the `seen` list and hands it to discovery as a denylist. The repo is
recorded the moment it is chosen (`record` task, before any heavy work), so a
crash or denial later never causes a re-pick.

## Stages

Sequential. Each stage is skipped if its precondition is not met, so a run can
stop cleanly at "nothing new", "no fit", or "denied".

| #  | id        | kind    | does |
|----|-----------|---------|------|
| 1  | gate      | compute | throttle guard; load `seen`; stamp `lastRunAt` on proceed |
| 2  | discover  | agent   | search GitHub via `gh` for one new strong candidate (bias: repos already running automation/CI/agent frameworks Smithers can improve); never picks a `seen` repo |
| 3  | record    | compute | append the chosen repo to the ledger immediately |
| 4  | assess    | agent   | shallow-clone + inspect; map the repo's pain to concrete Smithers workflows; decide fit `strong`/`weak`/`none`; find a maintainer contact |
| —  | (gate)    | —       | only `fit === "strong"` proceeds. `weak`/`none` stop here (already recorded as seen) so marginal pitches never reach a maintainer. |
| 5  | fork      | compute | **fork into `roninjin10`** + clone + cut branch `smithers-demo/…`, deterministically. Retries the `gh repo fork` create, then polls past GitHub's async replication so a transient race can't burn the target. |
| 5b | implement | agent   | build the demo change on the prepared branch, commit, push to the fork. A branch, never a PR. |
| 6  | diff      | compute | build the compare URL — the GitHub PR-creator UI for the hypothetical PR |
| 7  | draft     | agent   | draft outreach: a GitHub issue, an email, or a DM, including the compare link and value props |
| 8  | approval  | gate    | human approves or denies before anything goes out |
| 9  | send      | compute | **only after approval.** Issue → `gh issue create`. Email/DM → hand back the ready-to-send draft (the human sends it). |

The fork is deterministic compute (not the agent) on purpose: `gh repo fork` returns
before GitHub finishes replicating the fork, so an agent that immediately clones it
can hit "could not resolve <fork>". The compute step polls `gh repo view` until the
fork resolves, then clones and branches, so the flaky part is isolated and retried.

## Permissions

- Allowed without approval: forking into `roninjin10`, branching, committing,
  pushing to the fork.
- Forbidden without approval: creating an issue, sending an email or DM. The
  `approval` gate sits in front of `send`; on deny the run ends with the work
  preserved and nothing sent.

## The compare URL

The deliverable is a hypothetical PR, not a PR. The link is GitHub's cross-fork
compare page, which renders the diff and pre-fills the PR form without opening
one:

```
https://github.com/<owner>/<repo>/compare/<base>...roninjin10:<repo>:<branch>?expand=1
```

## Run

```sh
# one forced test run, watch it work
smithers up .smithers/workflows/repo-prospector.tsx --input '{"force":true}'

# arm the cadence
smithers cron add '*/15 * * * *' .smithers/workflows/repo-prospector.tsx

# review + clear the approval gate
smithers ps
smithers approve <run-id> --node approval --value true
```
