---
name: report-maker
description: Turn a run's persisted state into a self-contained HTML slideshow report — objective, decisions, graph, gates, evals, artifacts, failures, and the recommended next run. Use when a long or important run needs a legible, shareable summary instead of scrolling raw logs.
---

# Report Maker

This skill is about **the reporting layer**: turning what a run actually did into
something a human can read in two minutes and forward. The output is a single,
self-contained HTML slideshow — no server, no build, one file you can open or
attach. The hard rule is that it is built from **structured run state, not from
your prose memory of the run.** You read the persisted frames, outputs, scores,
and events back out of Smithers and render *those*. Anything you can't pull from
run state doesn't belong on a slide.

This matters because the agent's recollection drifts and omits exactly the
failures that matter. The persisted state doesn't. A report sourced from
`inspect` / `events` / `scores` is reproducible; a report typed from memory is a
vibe.

## When to reach for it

- A run took minutes-to-days, or is important enough that someone other than you
  needs to know what happened — review it, sign off on it, or hand it off.
- A run finished (or failed) and you're about to summarize it in chat. Render the
  slideshow instead and link it; chat scrollback is not a report.
- You want a durable artifact of a decision-heavy run: what was decided, what
  gated, what was tested, what's still open.

Skip it for a single-task run nothing downstream depends on — `smithers inspect`
is enough there.

## What goes on the slides

One coherent deck, sourced field-by-field from run state. Cover, in order:

- **Title / objective** — the run's name and the goal it was given (`ctx.input`).
- **Decisions** — choices made and why; assumptions vs. open questions.
- **Workflow graph** — the executed shape (`smithers tree <run>`, `smithers graph`).
- **Tools / skills / sources** — what the agents used and what they read.
- **Backpressure gates** — approvals, signals, eval gates: which passed, which paused, who cleared them.
- **Tests / evals & results** — `smithers scores <run>` and any `smithers eval` report; pass/fail per case, not "looks good".
- **Artifacts** — diffs (`smithers diff <run> <node>`), files written, outputs (`smithers output`).
- **Failures / retries** — `NodeFailed` events, retry counts, what finally worked.
- **Remaining issues** — what's unverified, deferred, or still red.
- **Recommended next run** — the concrete follow-up command, not "keep iterating".

## Pull the state, then render

Source every slide from the CLI rather than memory:

```bash
bunx smithers-orchestrator inspect <run-id> --json    # full run state (runState field): nodes, outputs, approvals
bunx smithers-orchestrator events <run-id> --json     # ordered event history (failures, retries, gates)
bunx smithers-orchestrator scores <run-id>            # scorer results per task
bunx smithers-orchestrator tree <run-id>              # executed graph shape
bunx smithers-orchestrator diff <run-id> <node-id>    # a node's DiffBundle for the artifacts slide
```

## The automated path: the `report-slideshow` workflow

You don't have to hand-build the deck. The seeded **`report-slideshow`** workflow
takes a run, reads its persisted state, and emits the self-contained HTML
slideshow for you:

```bash
bunx smithers-orchestrator workflow run report-slideshow --input '{"targetRunId":"<run-id>"}'
```

Reach for it to bootstrap the report, then hand-tighten the decisions and
next-run slides. The workflow has its own deterministic `gather` step and
agent-backed `render` step; `targetRunId` is the input name because `runId` is
reserved for the report workflow's own run. For ongoing monitoring with an HTML
report, use the separate `monitor` workflow. `monitor-smithers` is a fleet
watchdog that emits a triage digest rather than attaching a slideshow.

## Progress is events, not "working on it"

The same principle drives status while a run is *in flight*: report **specific
events** — "node `review` paused on approval", "case `lists-breaking-changes`
went red", "retry 2/3 on `fix` succeeded" — never a content-free "still working
on it". If you can't name the event, query it (`smithers events <run> --watch`,
`smithers ps`, `smithers why <run>`) before you report. The slideshow is just
that same event stream, made legible and shareable at the end.

See `skills/smithers/SKILL.md` for the run/observe surface and
`docs/llms-core.txt` (`smithers inspect`, `events`, `scores`, `timeline`) for the
exact JSON shapes each slide reads from.
