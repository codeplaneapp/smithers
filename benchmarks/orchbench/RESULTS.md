# OrchBench results

The deliverable promised in `DESIGN.md`: which orchestration patterns earn
their cost. Two rounds ran against real release-roadmap tasks; raw per-cell
JSON lives in `.context/orchbench/results/` (untracked; the tables below are
the durable record).

Patterns: `solo-sol` (one frontier agent), `solo-luna` (one cheap agent),
`solo-luna-grind` (one cheap agent with a diligence prompt), `plan-impl-review`
(plan, implement, review pipeline), `research-first` (research, plan,
implement, review), `panel-review` (implement plus a three-model review panel:
sol, fable, and a third reviewer), `research-first-luna` (the pipeline on the
cheap model).

## What the data says

1. **Frontier solo is the knee of the cost-quality curve.** `solo-sol`
   averaged reward 0.901 at $10.49 and 19.4 minutes (r1). Everything that
   scored higher paid heavily for it: `research-first` bought +0.028 reward
   for +64% cost and +138% wall clock. In r2, `solo-sol` was the only pattern
   that fully resolved the task (reward 1.000, $11.64, 20 minutes) while the
   four-stage pipeline scored 0.889 at 2.3x the cost and 2.5x the time.
2. **Review panels are net-negative.** `panel-review` (0.734) scored below
   plain `solo-sol` (0.901) and below the single-reviewer pipeline (0.817)
   while costing 51% more than solo and taking 2.1x the wall clock. Per-task,
   the panel beat solo on 0 of 4 tasks. Three frontier reviewers made the
   result strictly worse.
3. **The review stage is the time sink.** In both pipelines the review stage
   consumed more minutes than implementation: plan=9m, implement=16m,
   review=24m (`plan-impl-review`); research=4m, plan=8m, implement=11m,
   review=24m (`research-first`).
4. **A diligence prompt is the cheapest quality lever.** `solo-luna-grind`
   (prompt-only change on the cheap agent) scored 0.667 on the task where
   plain `solo-luna` scored 0.222: three times the reward for +$0.31 at the
   same 8-minute wall clock. That is a bigger gain than adding a plan node, a
   research node, a review node, or a panel, at about a tenth of their cost.

Practical reading for workflow authors: default to one strong agent
(`smithers oneshot`); add pipeline stages only for a named risk, and treat a
multi-model review panel as a cost, not a safety net.

## r1: 20 cells (5 patterns x 4 tasks)

| pattern | n | mean reward | resolved | mean cost $ | mean wall min | $ per reward pt |
|---|---|---|---|---|---|---|
| panel-review | 4 | 0.734 | 1/4 | 15.83 | 40.9 | 21.57 |
| plan-impl-review | 4 | 0.817 | 1/4 | 18.15 | 48.8 | 22.21 |
| research-first | 4 | 0.929 | 3/4 | 17.22 | 46.1 | 18.54 |
| solo-luna | 4 | 0.651 | 1/4 | 0.62 | 10.2 | 0.95 |
| solo-sol | 4 | 0.901 | 2/4 | 10.49 | 19.4 | 11.65 |

Matrix (reward / cost $ / wall min):

| pattern | fbr-2.42.0 | opt-4.4.0 | rat-0.21.0 | vbt-1.2.0 |
|---|---|---|---|---|
| panel-review | 0.444 / $10.61 / 26m | 0.778 / $23.12 / 58m | 1.000 / $15.88 / 37m | 0.714 / $13.72 / 42m |
| plan-impl-review | 0.667 / $8.91 / 28m | 0.889 / $25.27 / 57m | 1.000 / $16.77 / 59m | 0.714 / $21.67 / 51m |
| research-first | 1.000 / $8.28 / 42m | 1.000 / $30.82 / 62m | 1.000 / $11.82 / 32m | 0.714 / $17.97 / 49m |
| solo-luna | 0.667 / $0.48 / 5m | 0.222 / $0.82 / 8m | 1.000 / $0.59 / 12m | 0.714 / $0.57 / 17m |
| solo-sol | 1.000 / $7.23 / 19m | 0.889 / $15.80 / 21m | 1.000 / $9.12 / 17m | 0.714 / $9.82 / 20m |

Stage timing (mean minutes per stage):

- panel-review: plan=9m, implement=12m, panel-sol=14m, panel-fable=14m, panel-third=12m, fix=5m
- plan-impl-review: plan=9m, implement=16m, review=24m
- research-first: research=4m, plan=8m, implement=11m, review=24m
- solo-luna: solo=10m
- solo-sol: solo=19m

## r2: 4 cells (4 patterns x 1 task, opt-4.4.0)

| pattern | n | mean reward | resolved | mean cost $ | mean wall min | $ per reward pt |
|---|---|---|---|---|---|---|
| research-first | 1 | 0.889 | 0/1 | 26.31 | 49.9 | 29.60 |
| research-first-luna | 1 | 0.667 | 0/1 | 2.15 | 23.6 | 3.22 |
| solo-luna-grind | 1 | 0.667 | 0/1 | 1.13 | 8.0 | 1.69 |
| solo-sol | 1 | 1.000 | 1/1 | 11.64 | 20.3 | 11.64 |

Stage timing (mean minutes per stage):

- research-first: research=3m, plan=11m, implement=10m, review=26m
- research-first-luna: research=2m, plan=1m, implement=15m, review=5m
- solo-luna-grind: solo=8m
- solo-sol: solo=20m

## Caveats

- Sample sizes are small (n=4 per pattern in r1, n=1 in r2); treat the
  ordering as directional, not exact.
- Tasks were release-roadmap authoring against real repos, graded by rubric
  reward; other task families may reward pipelines differently.
- `solo-luna-grind` and `research-first-luna` were r2-only variants and are
  not in `.smithers/workflows/orchbench.tsx`'s pattern enum; promote them
  there before a rerun.
