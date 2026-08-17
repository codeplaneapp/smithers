# Terminal-Bench single-session versus Smithers orchestration study

Status: proposal for issue #1419. Date: 2026-08-17.

## Recommendation and decision

Approve a 12-task paired pilot, then authorize the 241-task study only if the
fairness audit passes and the projected combined spend remains under $5,100.
The decision required to close #1419 is whether Smithers will fund and publish
this preregistered, resource-matched comparison. If not, close the issue as
declined rather than landing an unrun benchmark skeleton.

## Scope and pinned inputs

The proposed harness source is `elizaOS/benchmarks` pinned to commit
`7eb18762cb6b6d2c0f2d32eee0ab41e3bfc9e428`, inspected on 2026-08-17. Its
`suites/terminal-bench/corpus-manifest.json` declares 241 tasks, source revision
`d28711d0da2675d0bb1d56de45ae5df6082438a3`, and corpus hash
`cd8cfdf30b07851b0c75e5dcf7fbfb07a4532bb0a46efea30c1875ceadfb1fcc`.
The manifest also says the vendored snapshot is not byte-for-byte equivalent
to that source revision. Publication must therefore say "elizaOS 241-task
Terminal-Bench snapshot" unless an upstream equivalence audit permits the
official version name.

The current upstream tree has advanced since #1419 was filed. It now contains
a Smithers Terminal-Bench adapter, but that adapter is still a Python-owned
decision loop invoking `smithers_turn.mjs` for stateless model turns. It is not
a durable Smithers workflow. `code_agent_matrix.py` still defaults to only
`elizaos` and `opencode`, so Smithers is not yet a matrix arm.

## The two arms

Both arms use `gpt-5.6-sol` at `xhigh` reasoning and current repository pricing
of $5 per million input tokens and $30 per million output tokens. Both
receive the same task text, container, starting filesystem, bash tool, network
policy, model-step limit, native per-task agent timeout, and $10
API-equivalent cap. Each gets a fresh container. Hidden tests run once, after
the agent stops, and their output is never returned to either arm.

### Arm A: Smithers single-session adapter

Use the pinned elizaOS Smithers adapter as the unorchestrated baseline after
the fairness patches below. It may take up to 20 model and terminal steps in
one accumulated conversation, but it has one problem-solving role, one context,
and no Smithers graph, durable run state, delegation, or fresh reviewer. Label
it `Smithers (single session)`, not `Smithers orchestrated` and not literally
one model request.

The pinned adapter is not usable as Arm A unmodified, and the required patch is
not only the eliza-side one. `harnesses/smithers/smithers_adapter/terminal_bench.py`
runs the hidden test script every time the model signals completion, and on
failure feeds the grader's own output back into the conversation as
`Task verification FAILED ... Test output: ... Please fix the issue and try
again`, looping up to `max_iterations` of 20. That is oracle feedback: it turns
Arm A into repeated attempts against the hidden tests rather than one graded
attempt, and it violates this study's own rule that hidden tests run once after
the agent stops. Arm A must be patched to stop on the model's completion signal
without consulting the grader, and to run the test script exactly once at the
end. Reporting the pinned adapter's score as a single-session baseline would
inflate the baseline and make any Arm B improvement look smaller than it is.

### Arm B: Smithers orchestrated

Run one durable Smithers workflow per task against the same container:

1. `plan`, a fresh Sol task limited to 15% of the task's remaining time and
   cost, inspects the workspace and emits a concise action plan;
2. `implement`, a fresh Sol task receives the task and plan, owns all edits,
   and receives 65% of the budget; and
3. `review-fix`, a fresh Sol task receives the task, plan, command transcript,
   and current workspace, then reviews and fixes within the final 20%.

The three stages share only explicit artifacts and the container filesystem.
Their combined model steps cannot exceed Arm A's 20, their combined active time
cannot exceed the task's native limit, and their combined API-equivalent cost
cannot exceed $10. Smithers may resume an interrupted stage from durable state.
Provider or infrastructure retries remain inside the same limits and are
reported; a failed hidden test never triggers a retry. This definition tests
role separation, explicit handoff, fresh context, and durability without also
buying more model, time, test feedback, or attempts.

## Fairness and integrity gates

No paid pilot starts until an upstream branch satisfies these checks:

- replace the runner's global `timeout_per_task_seconds` wrapper with each
  task's `max_agent_timeout_sec`, or prove the effective deadline is identical
  for both arms; the pinned runner still wraps `solve_task` at 300 seconds by
  default even when task metadata allows 900 seconds or more;
- remove all evaluator-answer extraction, mid-run grader consultation, and
  automatic repair from both adapters. The pinned eliza adapter reads an
  expected answer out of failing test output and writes it straight into
  `/app/answer.txt`; the pinned Smithers adapter re-runs the hidden test script
  mid-loop and returns its output to the model as repair feedback. Both leak
  the grader, and neither arm may see hidden test output before final grade;
- run exactly one final grader invocation per cell and equalize model-step,
  repair, timeout, network, and retry rules;
- verify the corpus count and hash, build every Docker task, and prove oracle
  success plus no-op failure where the task supports those controls;
- include Smithers in the result and provenance contracts, with exact Smithers,
  elizaOS, model, image, task, and prompt revisions;
- record all model calls, tokens, cache tokens, API-equivalent cost, commands,
  stage identity, attempts, wall time, grader output, final filesystem digest,
  and infrastructure failures; and
- randomize which arm runs first per task using a committed seed. Never run the
  two arms in the same container, and do not replace failed benchmark cells
  silently.

The 12-task pilot is stratified by timeout and category using a selection rule
committed before model calls. It validates container parity, telemetry, cost
enforcement, and scorer reproducibility. Pilot tasks are excluded from any
claim of confirmatory significance unless the full selection and analysis are
preregistered before the pilot.

## Measurement and decision threshold

The primary outcome is paired pass@1 across all 241 tasks. Report Arm B minus
Arm A in percentage points with a paired bootstrap 95% interval and the full
discordant-pair table. Secondary outcomes are API-equivalent dollars, input and
output tokens, model calls, active wall time, commands, infrastructure failure
rate, and results by task category and timeout band. Do not use an LLM judge for
the primary outcome.

The result changes the default recommendation only if Arm B improves pass@1 by
at least 5 percentage points, the lower bound of the paired 95% interval is
above zero, and median cost and active wall time are each no more than 25%
higher. If the upper confidence bound is below a 2-point improvement, or Arm B
is worse, the result strengthens the frontier-solo default. Anything between
those thresholds is inconclusive and does not justify another sweep without a
new hypothesis.

## Cost and wall-clock

The resource-matched design has a transparent ceiling:

| Scope | Cells | Model spend ceiling | Agent-time ceiling |
| --- | ---: | ---: | ---: |
| One 241-task arm | 241 | $2,410 | about 126 hours |
| Both arms | 482 | $4,820 | about 252 hours |
| Both arms plus 5% reruns | up to 507 | $5,070 | about 265 hours |

The time ceiling comes from summing the pinned corpus's declared
`max_agent_timeout_sec` values, using the loader's 900-second default for the
one task without an explicit value. It excludes Docker build, final grading,
and queue overhead. With eight warm workers, the two-arm ceiling is about 32
hours of scheduled agent work. Budget 36 to 48 hours wall-clock after images are
warm, or up to three days for a cold run. Sequential execution would take about
10.5 days before grading overhead. Reserve $5,100 for model calls and $100 for
short-lived runner infrastructure. The pilot replaces these ceilings with an
observed forecast before full-run approval.

This is deliberately close to the existing OrchBench cost knee. OrchBench
found frontier solo at 0.901 reward, $10.49, and 19.4 minutes on its pilot.
More elaborate patterns bought little or negative quality: the review panel
scored 0.734 at $15.83 and 40.9 minutes, while `research-first` gained only
0.028 reward for 64% more cost and 138% more time. A Terminal-Bench study that
gives orchestration an uncapped second budget would repeat that confound rather
than test orchestration.

## Reuse and publication

Reuse the OrchBench experiment discipline rather than its RoadmapBench-specific
driver: paired cells, immutable task manifests, clean-run selection, token cost
from `estimateCostUsd`, stage identity checks, quota-stall accounting, command
and diff audit, and explicit invalid-cell reasons. Reuse `benchmarks/fleet` for
sharding and `benchmarks/results.json` plus `benchmarks/site` for a static public
result. The root `evals/` harness and `packages/scorers` are appropriate for
small regression cases and telemetry, but Terminal-Bench's own hidden tests are
the quality scorer. There is no `packages/evals` package in this checkout; the
published eval primitives live in `packages/scorers`, the CLI eval extension,
and the root `evals/` workflows.

After the primary study is frozen, add both labeled Smithers arms to elizaOS's
`code_agent_matrix.py` so its cost, token, cache, model-call, and trajectory
reports can ingest the same receipts. That matrix integration is secondary and
must not redefine either arm.

Publish the preregistration, pinned revisions and hashes, fairness patch,
12-task pilot, all 482 cell receipts, invalid and rerun cells, aggregation code,
and static result together. A harness without paid results is not a benchmark
deliverable.

## Groundwork decision

No Smithers code change is justified before the arms and spend are approved.
The reusable scorer, cost, fleet, audit, and static-site primitives already
exist. The missing work is specific to the external elizaOS harness: removing
test leakage, honoring native timeouts, implementing the durable arm, and
extending its provenance and matrix contracts. Implement those changes on the
pinned upstream branch only after the maintainer funds the pilot.
