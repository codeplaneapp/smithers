# Kanban workflow speed benchmark

Date: 2026-07-07 (round 2 same day: fixes S1/S5/S6/S7 landed, re-measured below). Harness: `benchmarks/kanban-bench/` (run with
`bun benchmarks/kanban-bench/bench.ts --label <name> --tickets 12 --concurrency 4 [--global-concurrency N] [--delays JSON]`).

Motivation: users complain smithers is slow. This benchmark runs the REAL
seeded kanban workflow (12 tickets, worktree per ticket, ValidationLoop of
implement -> validate -> 3 parallel reviews, then an agent merge step) through
the real `smithers up` CLI in a hermetic sandbox repo with a local bare origin.
Agents are deterministic in-process fixtures that perform real git side effects
(commit in worktree, real merges) and sleep a configurable per-kind delay to
simulate LLM latency, logging exact enter/exit timestamps. The analyzer joins
agent timestamps with the engine event log to attribute every millisecond to
boot, queue wait, pre-agent overhead, agent time, post-agent overhead, or idle.

## Results

12 tickets, workflow `<Parallel maxConcurrency=4>`, 3 reviewers per ticket,
61 agent calls per clean run. "ideal" = agent delays only at 4 tickets/wave
(3 waves x (8s + 4s + 4s) + 6s merge = 54s). All runs finish `exit 0` with the
ticket branches genuinely merged into sandbox main.

| run          | delays                    | global cap | wall  | vs ideal | notes |
|--------------|---------------------------|-----------:|------:|---------:|-------|
| zero         | none                      | 4 (default)| 7.1s  | -        | pure orchestrator overhead, 61 calls |
| scale24      | none, 24 tickets          | 4          | 12.2s | -        | overhead scales ~linearly (121 calls) |
| realistic    | impl 8s, val 4s, rev 4s, merge 6s | 4  | 91.4s | 1.69x    | the default-config experience |
| wide         | same                      | 16         | 56.1s | 1.04x    | only change: `--max-concurrency 16` |
| onereviewer  | same, 1 reviewer          | 16         | 51.7s | 0.96x*   | reviews off critical path (*single reviewer beats the 3-reviewer ideal) |
| retry        | same, 3 tickets fail first validate | 16 | 63.3s | +7.2s vs wide | 2nd round runs implement+validate only |

Reproduced concurrency ceilings (max simultaneous in-progress nodes):

| run       | all | implement+validate | review |
|-----------|----:|-------------------:|-------:|
| realistic | 4   | 4                  | 4      |
| wide      | 16  | 4                  | 12     |

## Where the time goes

1. **The engine global `maxConcurrency` default of 4 is the dominant cause of
   the "slow" experience.** `smithers up` defaults to 4
   (`DEFAULT_MAX_CONCURRENCY`, `packages/engine/src/engine.js:859`, enforced in
   `withTaskSlot` `engine.js:5091` and `applyConcurrencyLimits`
   `engine.js:2564`). Each kanban ticket wants up to 3 review slots at once, so
   with 4 tickets in flight the run needs ~12 slots during review phases but
   gets 4. Raising ONLY the global cap took the identical run from 91.4s to
   56.1s (1.69x -> 1.04x of ideal). Nothing else in the orchestrator matters
   until this is fixed.

2. **Review fan-out is 59% of all agent calls.** 36 of 61 calls are reviews
   (3 per ticket per round). In real runs these are 3 full agent sessions per
   ticket per round. Cutting to 1 reviewer at cap 16 saved another 8% wall and
   two thirds of review tokens.

3. **Reviews run even when validation already failed.** In the retry run the
   iteration-0 Sequence ran all 3 reviews on code that validate had already
   rejected: 3 wasted agent calls per failed round per ticket
   (`ValidationLoop.tsx` runs implement -> validate -> review unconditionally
   inside the loop body).

4. **Converged loops skip re-review.** When iteration 1 fixed the tickets, the
   loop's `done` flipped true as soon as iteration-1 validate passed, because
   `buildFeedback` in `kanban.tsx` counts ANY prior iteration's review approval
   (`ticketReviews` filters by node-id prefix across all iterations). Iteration
   1 re-ran implement+validate only; the merged code's final version was never
   reviewed. Cheaper, but it silently weakens the review gate.

5. **Per-task orchestrator overhead is small and flat: ~60-75ms serialized dead
   time per node completion** (zero-delay run: 4.6s idle across 73 completions;
   24-ticket run: 8.2s across 145, so no visible O(n^2) at this scale). It is
   dominated by the per-completion full re-render + `persistDriverFrame`
   (`engine.js:5451`), which does `listNodes` + `listRalph` + `loadInput` +
   `loadOutputs` full-table scans, canonicalizes and hashes the full workflow
   XML, and commits a frame + snapshot per task completion
   (`requireRerenderOnOutputChange` defaults true, `engine.js:5975`). ~1.03
   frames per node finish measured. This grows with run size and will bite on
   much larger runs, but it is NOT why a 12-ticket kanban feels slow.

6. **Worktree sync costs pre-agent time on EVERY task, and it hides a network
   fetch.** Pre-agent overhead measured 75-510ms per call (median ~90-380ms).
   `ensureWorktree` (`engine.js:751`) runs `git fetch origin` + `git rebase`
   (or `jj git fetch` + `jj rebase`) before every task that reuses an existing
   worktree, i.e. before every validate, every review, and every loop-round
   implement. In the sandbox the origin is a local bare repo so a fetch is
   ~20ms; against a real GitHub remote each is a network round trip, so a
   12-ticket run pays ~49 extra remote fetches (61 tasks minus the 12 worktree
   creations). At 0.5-1.5s per fetch that is 25-75s of hidden wall time in real
   projects, concurrency-capped like everything else.

7. **Boot is ~0.9s** (module-graph parse; matches the known gateway boot
   floor). Merge queued promptly after the last ticket (14-252ms gap), and the
   merge agent step itself is serial by design: one agent merging 12 branches.
   In real usage that step does 12 sequential merges plus conflict resolution
   inside a single agent session, so it scales linearly with ticket count and
   cannot overlap anything.

8. **Two seeded-workflow input bugs compound the concurrency problem.**
   `kanban.tsx:117` reads `ctx.input.maxConcurrency` without coalescing; zod
   `.default(3)` never applies at runtime (known engine gotcha), and
   `Number(null)` -> 0 -> "unlimited" in `pushGroup`
   (`packages/graph/src/extract.js:282`). So a bare `smithers up kanban.tsx`
   silently runs the outer Parallel UNLIMITED and the global default of 4
   becomes the only limiter: worktree churn across all 12 tickets at once, 4
   tasks at a time. Also the outer cap counts LEAF tasks (innermost enclosing
   group wins, `extract.js:406`), so "maxConcurrency 4" does not mean "4
   tickets": the inner review `<Parallel>` (no cap, `Review.tsx:59`) escapes
   the outer group entirely, confirmed by the ceiling table above.

## Suggestions

Engine (fix at the source):

- **S1. Derive the run-level concurrency default from demand instead of a flat
  4, or at minimum warn.** Options: default `maxConcurrency` to
  `max(4, sum of workflow Parallel caps)` when the graph declares them; or log
  a visible "N runnable tasks waiting on --max-concurrency=4" hint when the
  slot queue stays saturated. The 1.69x -> 1.04x delta is the single biggest
  user-visible win available.
- **S2. Make nested Parallel groups count against ancestor caps (or give
  `<Worktree>`/ticket subtrees a subtree-level cap).** Today `maxConcurrency`
  on the outer Parallel neither means "N tickets" nor bounds reviews. A
  `subtreeConcurrency` semantic matching user intuition would make tuning
  predictable.
- **S3. Skip or throttle the per-task worktree re-sync.** Cache "fetched
  origin at T" per repo and skip re-fetch within a TTL (or fetch once per
  frame, not per task); the rebase can also be skipped when the base ref hash
  is unchanged since the last task in that worktree. This removes ~49 network
  round trips per 12-ticket run in real projects.
- **S4. Reduce frame-persist work on completion-triggered re-renders.**
  `persistDriverFrame` full-scans nodes/outputs and re-serializes the whole XML
  every completion. Incremental snapshots (reuse previous frame data for
  unchanged tables) or persisting frames off the critical path would cut the
  fixed ~60-75ms per completion and defuse the O(n * outputs) growth for large
  runs.

Seeded kanban workflow (also fix at the source):

- **S5. Coalesce input:** `const maxConcurrency = ctx.input.maxConcurrency ?? 3;`
  so the workflow-level cap actually exists on bare runs.
- **S6. Gate reviews on validation:** inside ValidationLoop, only mount the
  review step when the current iteration's validate passed (saves 3 agent
  calls per failed round per ticket), or intentionally run validate+review in
  parallel and document the tradeoff.
- **S7. Require re-review after re-implementation:** in `buildFeedback`, count
  only reviews from the latest iteration (compare row iteration to the loop
  iteration) so approval of iteration-0 code cannot green-light iteration-1
  code.

User guidance (until the engine changes land):

- Pass `--max-concurrency` >= `tickets-in-flight x (1 + reviewers)` (for the
  seeded kanban at 4 tickets: 16). This alone is the difference between 1.69x
  and 1.04x of ideal.
- Trim `agents.review` to 1 entry (or use `synthesizeReview` with a small
  panel) when review depth is not needed; reviews are ~59% of agent calls.
- Always pass `--input '{"maxConcurrency":N}'` to kanban; the zod default does
  not apply.

## Round 2 (same day): S1/S5/S6/S7 landed and re-measured

Commits: `7af334cf` (kanban gate + input default), `ee19d0c4` (engine
starvation hint). Everything below measured with the fixes in.

### S1 (warn form) proves out

With demand 8+ against cap 4 the engine now logs once:
`8 tasks want to run concurrently but maxConcurrency is 4; 4 are queued
waiting for a free slot ... (CLI: smithers up --max-concurrency 8)` — visible
in plain `smithers up` output (results/cap4/cli-stdout.log:196).

### Concurrency sweep: the wall-vs-cap curve (12 tickets, realistic delays)

| global cap | wall  | engine | avg in-flight |
|-----------:|------:|-------:|--------------:|
| 4 (default)| 87.6s | 86.4s  | 3.4 |
| 8          | 62.6s | 61.5s  | 4.8 |
| 12         | 55.8s | 54.2s  | 5.5 |
| 16         | 58.4s | 56.2s  | 6.0 |
| 24         | 57.3s | 55.6s  | 5.5 |

Ideal 54.0s. The curve flattens at cap 12 = tickets-in-flight x 3 (the review
fan-out); the 16/24 points sit ~2s above 12 within run-to-run noise. Guidance
confirmed: cap >= in-flight tickets x (1 + reviewers) buys the whole win;
beyond the knee there is nothing left to take.

### S5 proof

`smithers up kanban.tsx` with NO input (`--no-input` bench mode, delays on):
max simultaneous implement+validate = 3, exactly the coalesced default. Before
the fix the outer Parallel was unlimited and only the global cap throttled.

### S6+S7 proof: the retry round now reviews the right code

12 tickets, 3 forced first-round validation failures, cap 16 (agent calls by
kind#iteration):

| round          | before (63.3s)      | after (64.1s) |
|----------------|---------------------|---------------|
| review round 0 | 36 (9 on REJECTED code) | 27 (S6 skips failed tickets) |
| review round 1 | 0 (fixes merged UNREVIEWED) | 9 (S7 forces re-review) |

Same wall clock, same 67 total calls; the 9 wasted review sessions moved from
rejected round-0 code to the re-implemented round-1 code that actually merges.

### Scale sweep: S4 becomes measurable at 48 tickets (zero-delay)

| tickets | engine | idle (no agent busy) | idle per completion | frames |
|--------:|-------:|---------------------:|--------------------:|-------:|
| 12      | 5.9s   | 4.6s                 | 62ms                | 75  |
| 24      | 10.9s  | 8.2s                 | 56ms                | 147 |
| 48      | 55.6s  | 38.0s                | 131ms               | 291 |

Per-completion orchestrator dead time is flat to 24 tickets, then doubles by
48: the per-frame `persistDriverFrame` full-table scans (S4) grow with
accumulated nodes/outputs and are on the superlinear path. At 48 tickets the
pure-orchestrator run spends 68% of its wall fully idle.

## Remaining engine work (recommended order)

1. **S2** — nested `<Parallel>` should count against ancestor caps (or add a
   subtree-level concurrency semantic). Until then "maxConcurrency 4" neither
   means 4 tickets nor bounds reviews, and users cannot reason about caps.
2. **S3** — cache/TTL the per-task worktree `git fetch origin` + rebase
   (~49 remote fetches per 12-ticket run against real remotes; 25-75s hidden).
3. **S4** — incremental frame snapshots (skip unchanged tables, reuse the
   previous frame's XML hash when the tree is unchanged) to flatten the 131ms
   per-completion cost at 48+ tickets.
4. **S1 (auto form)** — beyond the warning: default the cap to
   `max(4, sum of declared Parallel caps)` so stock runs stop starving.

## Follow-ups

- The retry-round re-review gap (finding 4) is FIXED (S7, `7af334cf`).
- The 48-ticket superlinear frame persist is CONFIRMED (table above); S4 is
  the fix.
