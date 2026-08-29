# The Persuasion Gap

> **Written for Smithers 0.x.** This note is research from before the 1.0
> rewrite. It describes the JSX workflow runtime, its CLI, or its gateway, none
> of which exist in 1.0.0-rc.0. It is kept as history, not as guidance; see
> `docs/pages/migration/1.0.md` for what replaced each surface it names.

## Why a strong AI reviewer may fail to repair a weaker AI implementer

**A four-task pilot and a preregistered 330-cell study of delegation and review
in coding agents. Pilot: complete. Confirmatory study: frozen and launched
2026-08-08; results will replace this draft's pilot-only tables.**

### Abstract

A common recipe for economical AI engineering: a frontier model plans, a cheaper
model implements, the frontier model reviews. The hope is that review converges
the work to reviewer-level quality.

In our four-task pilot it did not. A single GPT-5.6 Sol agent scored a mean
hidden-test reward of **0.901** at $10.49 and 19.4 minutes. The task-matched
Sol→Luna→Sol pipeline scored **0.817** at 73% more cost and 2.5× the wall
clock. A three-model review panel scored **0.734** and beat solo Sol on none of
the four tasks.

We call the proposed mechanism the **persuasion gap**: producing an artifact
and producing a plausible account of that artifact are different capabilities.
A weaker implementer can leave defects that are hard to discover while
supplying a coherent summary that makes them easy to overlook, so review
anchors to the implementer's framing instead of independently reconstructing
the solution. Informally, the student "gaslights" the teacher — but we find no
evidence of intent or deception; the narrow hypothesis is that **review text
can be correlated with the errors it is supposed to expose**.

Four tasks cannot support a general claim, and the pilot comparison changed the
execution graph as well as the implementer. It is a hypothesis-generating
pilot, nothing more. A preregistered 30-task, eleven-condition confirmatory
study (330 cells) is frozen and running; see below.

### The pilot result

| Pattern                    | Mean reward | Resolved | Est. API-equiv. cost |    Mean time |
| -------------------------- | ----------: | -------: | -------------------: | -----------: |
| Solo Sol                   |   **0.901** |      2/4 |           **$10.49** | **19.4 min** |
| Sol→Luna→Sol               |       0.817 |      1/4 |               $18.15 |     48.8 min |
| Luna research→Sol→Luna→Sol |   **0.929** |      3/4 |               $17.22 |     46.1 min |
| Three-model review panel   |       0.734 |      1/4 |               $15.83 |     40.9 min |

Why this surprises: the reviewer never receives the solution the stronger model
would have generated. It receives a changed repository, the implementer's
summary, a limited budget, and a huge search space of possible omissions.
Repair requires detection first — `P(repair) = P(detect) ×
P(diagnose|detect) × P(fix|diagnose)` — and once a defect survives detection,
the review loop supplies no pressure toward correctness.

### Pilot method, in brief

OrchBench: four medium-difficulty
[RoadmapBench](https://arxiv.org/abs/2605.15846) release tasks (TypeScript,
Python, Go, Rust). Each starts from a real old-version repository plus a
detailed release roadmap; agents edit the real repo with its real toolchain and
are scored by the benchmark's hidden per-target tests. Task, checkout, roadmap,
tool/network policy, and grader were held constant; the orchestration graph
varied. Fallback chains disabled. The grader was validated per task (oracle
patch = 1.0, no-op < 1.0). The review prompt was deliberately adversarial —
verify every roadmap target, run the tests, fix defects directly — not a
ceremonial approval step. Review is a **single review-and-fix session**: the
reviewer edits the code itself, nothing is sent back to the implementer, and
there is no iterate-until-LGTM gate (the reviewer may test/fix/re-verify
internally within its one budget).

### Pilot findings

**1. The delegated pipeline did not recover solo quality.** Sol→Luna→Sol
trailed solo Sol by 0.083 mean reward (tied on three tasks, lost 0.667 vs
1.000 on Fiber/Go, never won) while costing $18.15 vs $10.49 and taking 48.8 vs
19.4 minutes. Review alone averaged 24 minutes — longer than the 16-minute
implementation stage. With one nonzero paired difference the sign-flip test is
uninformative (`p=1.0`); this is an observation, not a demonstrated effect.
Solo also preserves one continuous context while the pipeline uses three
sessions, so the confirmatory Sol→Sol→Sol control — same graph, only the
middle model replaced — is what isolates the student.

**2. The panel scored worse.** Three frontier reviewers producing parallel
findings, applied by Luna: 0.734, below the single-reviewer pipeline. The
condition also changed the review/fix graph, so it is not a clean reviewer-count
test — but findings-only review followed by a weaker fixer adds another lossy
channel: reviewers must detect, express, and successfully transmit each repair.
More commentary is not more verified correctness.

**3. Reconnaissance is different from delegation.** The best round-1 pipeline
put Luna on read-only reconnaissance before Sol planned (0.929). A round-2
replicate reversed the ordering (solo 1.000 vs pipeline 0.889 at 2.3× cost).
Promising, unsettled. Cheap stages seem most useful when they compress
information without owning the final artifact.

### The proposed mechanism

Four coupled failure modes, none requiring intent:

1. **Framing inheritance** — the reviewer starts from the implementer's summary
   and inherits its decomposition of the problem.
2. **Shared blind spots** — related models compress specs and code similarly,
   so their errors correlate.
3. **Verification substitution** — plausible explanations and passing familiar
   tests substitute for checks targeted at omitted behavior. The most dangerous
   defects are absences, which produce no local symptom.
4. **Repair bottlenecks** — a reviewer can find more than the remaining budget
   or fixer can correctly resolve.

The testable prediction: **review gains shrink when reviewer evidence derives
from the same narrative and tests that produced the artifact**, and recover
when the reviewer gets independent evidence (hidden tests, derived checklists,
or a context that omits the implementer's self-report).

This sits between known results: weak-to-strong generalization
([Burns et al.](https://arxiv.org/abs/2312.09390)) shows supervision quality ≠
supervisor capability; self-correction fails without external feedback
([Huang et al.](https://arxiv.org/abs/2310.01798),
[Kamoi et al.](https://aclanthology.org/2024.tacl-1.78/)); models favor
model-generated answers ([Xu et al.](https://aclanthology.org/2024.acl-long.826/))
and convincing agreement over correctness
([Sharma et al.](https://arxiv.org/abs/2310.13548)); and a capable judge can
fail when the protocol produces narrative continuity rather than adversarial
evidence ([Kenton et al.](https://arxiv.org/abs/2407.04622)). Our reviewer was
a separate model instance, but its evidence still came from the same spec,
repo, tests, and implementer report — an external agent is not external
evidence.

### The confirmatory study (frozen, running since 2026-08-08)

Thirty tasks (7 C++, 6 Go, 6 Python, 5 Rust, 6 TypeScript) drawn
deterministically from the 115-task RoadmapBench train split, oracle-validated,
with a frozen reserve order. Eleven conditions per task, 330 cells, condition
order rotated:

| Condition          | Plan + implement                    | Review                      |
| ------------------ | ----------------------------------- | --------------------------- |
| Solo Sol           | one continuous Sol session          | none                        |
| Sol→Sol→Sol        | Sol planner, Sol implementer        | fresh Sol, report visible   |
| Sol→Terra→Sol      | Sol planner, Terra implementer      | fresh Sol, report visible   |
| Sol→Luna→Sol       | Sol planner, Luna implementer       | fresh Sol, report visible   |
| Sol→Luna→Sol blind | Sol planner, Luna implementer       | fresh Sol, report hidden    |
| Sol(work)→Sol      | one continuous Sol work session     | fresh Sol, report visible   |
| Sol(work)→Fable    | one continuous Sol work session     | fresh Fable, report visible |
| Solo Fable         | one continuous Fable session        | none                        |
| Fable→Fable→Fable  | Fable planner, Fable implementer    | fresh Fable, report visible |
| Fable→Luna→Fable   | Fable planner, Luna implementer     | fresh Fable, report visible |
| Fable→Luna→Fable blind | Fable planner, Luna implementer | fresh Fable, report hidden  |

Models: Sol=`gpt-5.6-sol` (xhigh), Terra=`gpt-5.6-terra` (high),
Luna=`gpt-5.6-luna` (medium), Fable=`claude-fable-5`. Every reviewed condition
is scored **before and after review**, so the study separates: the
Luna-substitution effect (H1), whether review helps at all (H3), a
Sol→Terra→Luna tier gradient, teacher-family differences (H2), continuous vs
split context, Sol vs Fable review of the same-shaped work, and whether hiding
the self-report changes the outcome (H4 — the persuasion-gap mechanism test).
The blinded arm exists for **both** teacher families (a 2026-08-08 pre-launch
amendment added the blinded Fable arm), so the {Sol, Fable} × {visible, blind}
factorial separates "which teacher is more swayed by the implementer's
narrative" from "which teacher repairs better" (H4-Fable, secondary).
Primary family: H1-Sol and H4, Holm-adjusted at 0.025; 30 paired tasks give
~80% power for a moderate paired effect (`d_z ≈ 0.57`). Full protocol:
`benchmarks/orchbench/PERSUASION_GAP_PREREGISTRATION.md`; frozen sample and
receipts: `persuasion-gap-selected.json`; conditions:
`.smithers/workflows/orchbench.tsx`.

### Open design gaps

Named here so nobody mistakes the running design for the last word. The
protocol locked when the first confirmatory cell launched (2026-08-08); these
are for the study after this one.

1. **One run per cell.** The design estimates across-task variation, not
   within-task stochastic variation. Repeated seeds on a task subset would
   separate the two.
2. **No shared-artifact fork.** Blind vs visible review uses independent
   implementation runs matched by task, so the contrast includes artifact
   variance. Forking one frozen implementation across reviewer conditions would
   isolate the report effect directly.
3. **No iterated-review condition.** The folk version of the recipe — "the
   reviewer keeps sending it back until LGTM" — is untested: every reviewed
   condition reviews once and fixes directly. A bounded loop (Luna fixes,
   fresh-context Sol re-reviews, until LGTM or round cap) would test the
   convergence claim in its strongest form.
4. **One task family.** Long-horizon release implementation only; transfer to
   small patches, security review, or non-code work is untested.

### Provisional practical implications

The safe default is not "never delegate" — it is to stop treating review as an
automatic quality equalizer.

1. **Use one strong agent when the task fits one context.**
2. **Delegate bounded work with objective interfaces** — reconnaissance,
   enumeration, mechanical edits, deterministic acceptance checks.
3. **Hide the implementer's sales pitch** — spec and diff first, self-report
   only after an independent checklist.
4. **Make review generate evidence** — new tests, counterexamples, traces —
   not prose findings.
5. **Measure correction, not approval** — score before and after review; high
   approval can coexist with zero gain.
6. **Test orthogonal reviewers** rather than assuming more seats help; our
   panel was net-negative.

### Conclusion

Review is not direct access to correctness. It is a search process mediated by
context, tests, summaries, and attention — and when those signals correlate
with the implementation's blind spots, a capable reviewer spends more time and
money without closing the gap. **A reviewer is only as independent as the
evidence it receives.** Build delegation around falsification and objective
checks, not the hope that a stronger model will talk a weaker one into being
perfect.

### References

- Burns et al. (2023), [Weak-to-Strong Generalization](https://arxiv.org/abs/2312.09390)
- Huang et al. (2023), [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798)
- Kamoi et al. (2024), [When Can LLMs Actually Correct Their Own Mistakes?](https://aclanthology.org/2024.tacl-1.78/)
- Xu et al. (2024), [Pride and Prejudice: LLM Amplifies Self-Bias in Self-Refinement](https://aclanthology.org/2024.acl-long.826/)
- Sharma et al. (2023), [Towards Understanding Sycophancy in Language Models](https://arxiv.org/abs/2310.13548)
- Kenton et al. (2024), [On Scalable Oversight with Weak LLMs Judging Strong LLMs](https://arxiv.org/abs/2407.04622)
- Xu et al. (2026), [RoadmapBench](https://arxiv.org/abs/2605.15846)
