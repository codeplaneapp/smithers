# Smithers Agent-Fluency Evals

> Can a **weak model**, given only Smithers' docs + skills + CLI, **one-shot** a real
> Smithers task? Every eval here answers that question for one feature, and when the
> answer is "no," it tells us *exactly which doc to fix*.

## Why this exists

Smithers is driven by an AI agent, not a GUI. The product's real surface is its
**docs, skills, and CLI** — the context an agent reads before it acts. If a capable
model can fumble through anyway, a weak one (Haiku, Sonnet, Gemini Flash, Kimi) will
fail, and that failure is a precise signal that a doc or an API is unclear.

These evals turn that into a **repeatable regression gate**:

1. Each eval is a Smithers **workflow** (`suites/<area>/eval.tsx`).
2. A **candidate** `<Task>` — run on a deliberately weak model — attempts one real
   Smithers task (author a workflow, find the right CLI verb, query the run DB, add an
   approval gate, …) using only the shipped docs/skills.
3. The candidate emits a **typed self-report**: `oneShot` (did I get it first-try with
   no dead-ends?), plus structured `friction` (what was missing / ambiguous / wrong in
   the docs) — see `lib/report-schema.ts`.
4. A **verify** step (deterministic where possible, judge otherwise) independently sets
   `passed`. Assertions gate on the *verifier's* `passed`, never the candidate's claim.
5. **Scorers** grade non-binary quality (schema adherence, friction severity, docs-gap
   likelihood) so trends improve over time even before a case flips green.

The payoff: a red eval or a low one-shot rate points straight at a doc/skill/API to
improve. The harness aggregates every run into a **scorecard** ranking the feature
areas and friction themes most worth fixing.

## Model policy

Weak models are the point — they stress the docs. SOTA models are reserved for the one
job weak models legitimately can't do: authoring genuinely complex workflows.

| Tier   | Models                                              | Used for |
| ------ | --------------------------------------------------- | -------- |
| `weak` | Haiku, Sonnet, Gemini Flash, Kimi                   | Comprehension, authoring simple/medium workflows, CLI ops, DB queries, observability — **the vast majority of evals** |
| `sota` | Opus, Codex (GPT-5.x), Gemini Pro                   | Only "build a complex multi-feature workflow" evals |

The model is chosen per-case (`input.model`); the harness can fan one logical task
across the whole weak matrix, which is how coverage × models scales toward ~1000 evals.

## Layout

```
evals/
  README.md            # this file
  PROGRESS.md          # living plan + wave checklist + counts (durable across sessions)
  COVERAGE.md          # generated feature → eval-task map (the backbone for waves)
  agents.ts            # the eval model matrix (weak + sota pools, selectable by name)
  tsconfig.json        # mirrors examples/ module resolution
  lib/
    report-schema.ts   # CandidateReport + EvalResult schemas (oneShot, friction, blockers)
    model-matrix.ts    # name -> agent resolution + tier metadata
    scorers.ts         # oneShotScorer, frictionScorer, docsGapScorer (+ builtins)
    verify.ts          # deterministic verifiers (graph-renders, contains, jsonl-valid, …)
    eval-kit.ts        # createFluencyEval(): candidate -> verify -> report scaffold
  suites/<area>/       # one feature area per wave
    eval.tsx           # the parametric eval workflow
    cases.jsonl        # the individual evals (the corpus)
    NOTES.md           # which docs/skill/feature this exercises
  harness/
    run-suite.ts       # run one suite across the model matrix
    run-all.ts         # run every suite x matrix -> scorecard
    scorecard.ts       # aggregate: per-feature one-shot rate, ranked friction -> docs-to-fix
  new-eval.tsx         # "issue -> eval" generator workflow (turn any friction report into a case)
  _inventory/          # raw exploration outputs (coverage slices, mined real usage)
```

## Running

```bash
# One suite across the weak matrix (writes .smithers/evals/<suite>.json, exits non-zero on fail)
bun evals/harness/run-suite.ts authoring-workflows

# Everything, then print the scorecard
bun evals/harness/run-all.ts
bun evals/harness/scorecard.ts

# A single case, one model (cheap shape check first)
bunx smithers-orchestrator eval evals/suites/authoring-workflows/eval.tsx \
  --cases evals/suites/authoring-workflows/cases.jsonl --suite authoring-workflows --dry-run
```

## Adding an eval from a real failure

When an agent struggles with Smithers, capture it as an eval in one command:

```bash
bunx smithers-orchestrator up evals/new-eval.tsx \
  --input '{"friction":"Agent could not figure out how to add a human approval gate; guessed <Human> which does not exist.","area":"approvals-humans"}'
```

It distills the friction into a task + verify + a `cases.jsonl` line, then prints the
`smithers eval` command. See `PROGRESS.md` for the wave plan and current coverage.

## Verify kinds (the hard gate)

Each case's `input.verify.kind` selects how `passed` is decided. Deterministic kinds
spend **no model**:

| kind | how it gates | used by |
| --- | --- | --- |
| `equals` | normalized answer == canonical (JSX brackets stripped, word-boundary) | "which CLI verb / component" knowledge |
| `contains` | artifact contains all `must` tokens, none of `mustNot` | short keyword knowledge |
| `graph` | candidate's workflow renders via `smithers graph` + uses required `<Component>` tags | authoring workflows |
| `query` | runs the candidate's **SQL** against a seeded run-history fixture, checks the scalar | `db-query` |
| `build` | transpiles the candidate's UI bundle (Bun) + checks it uses the gateway-react API | `ui-authoring` |
| `judge` | a SOTA judge grades correctness against a rubric (the only model-spending gate) | concepts, non-workflow code |

**UI evals** additionally attach the `ui-quality` llmJudge scorer, which scores a
candidate's `gateway-react` bundle 0-1 on hook usage, loading/empty/error states, UX, and
accessibility — "did it one-shot a UI, and how good is it?"

## Closing the loop: docs fixes + library issues

The point of a red eval is to fix the thing it found. The `eval-gap-triage` workflow takes
the surfaced friction and, per gap, decides:

- **docs fix** → a precise patch to a `docs/*.mdx` source file (then `pnpm docs:llms`), which
  raises one-shot odds directly. 8 such fixes shipped on this branch.
- **library fix** → a GitHub issue **citing the eval + a source-grounded suggested solution**
  (issues #295–#298 on this branch: run-status masking, `z.number()`→INTEGER, `<Worktree>`
  path anchoring, `waiting-event` overload). Filed when the robust fix is code, not docs.

