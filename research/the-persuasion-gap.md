# The Persuasion Gap

## Why a strong AI reviewer may fail to repair a weaker AI implementer

**A controlled study of delegation, review, and correlated failure in coding agents**

### Abstract

A common recipe for economical AI engineering is to let a frontier model plan,
delegate implementation to a cheaper model, and then review the result with the
frontier model. The intuition is compelling: the reviewer can keep sending the
work back until it is as good as the reviewer would have produced alone.

Our pilot results challenge that intuition. Across four real repository-level
coding tasks, a single GPT-5.6 Sol agent achieved a mean hidden-test reward of
**0.901**.
The matched Sol→Luna→Sol pipeline achieved **0.817**, despite costing **73% more**
and taking **2.5× as long**. A three-model review panel performed worse still:
**0.734**, and it beat solo Sol on none of the four tasks.

We call the proposed mechanism the **persuasion gap**: producing an artifact and
producing a plausible account of that artifact are different capabilities. A
weaker implementer may leave defects that are hard to discover while supplying
a coherent summary that makes them easy to overlook. Review then becomes
anchored to the implementer's framing instead of independently reconstructing
the solution. In informal language this can feel like the student “gaslighting”
the teacher. We find no evidence of intent, deception, or a learned relationship
between these specific models; the scientific claim is narrower: **review text
can be correlated with the errors it is supposed to expose**.

Because four tasks cannot support a strong general claim, we use them only as a
hypothesis-generating pilot. A preregistered confirmatory study uses 30 new tasks
drawn deterministically from the 115-task RoadmapBench suite, balanced across
five programming languages. It adds matched solo-Fable and Fable→Luna→Fable
conditions and scores Luna's artifact both before and after teacher review.

### The surprising result

Suppose a strong agent can produce quality \(Q_s\), while a cheaper agent
produces \(Q_w < Q_s\). It is tempting to assume that strong review will close
most of the gap:

\[
Q(\text{strong plan} \rightarrow \text{weak implementation} \rightarrow
\text{strong review}) \approx Q_s.
\]

That equation hides the hard part. The reviewer does not receive the solution
the stronger model would have generated. It receives a changed repository, a
summary written by the implementer, a limited time budget, and a very large
search space of possible omissions. Repair requires the reviewer to first
_notice_ each defect. Once an error survives detection, the review loop provides
no magical pressure toward correctness.

The benchmark made this visible:

| Pattern                    | Mean reward | Resolved |  Mean cost |    Mean time |
| -------------------------- | ----------: | -------: | ---------: | -----------: |
| Solo Sol                   |   **0.901** |      2/4 | **$10.49** | **19.4 min** |
| Sol→Luna→Sol               |       0.817 |      1/4 |     $18.15 |     48.8 min |
| Luna research→Sol→Luna→Sol |   **0.929** |      3/4 |     $17.22 |     46.1 min |
| Three-model review panel   |       0.734 |      1/4 |     $15.83 |     40.9 min |

This is not a blanket result against decomposition. Cheap reconnaissance before
planning slightly exceeded solo Sol in Round 1, though at sharply higher cost
and latency. The narrower result is more useful: **adding review does not imply
that delegated work converges to reviewer-level quality**.

### Pilot method

We used OrchBench, a controlled pilot built on four medium-difficulty
[RoadmapBench](https://github.com/UniPat-AI/RoadmapBench) release tasks in
TypeScript, Python, Go, and Rust. Each task begins
from the same old-version repository and a detailed release roadmap. Agents edit
the real repository, use its real toolchain, and are scored after the run by the
benchmark's hidden per-target tests.

We held constant:

- the task and starting checkout;
- the roadmap supplied to the agents;
- tool and network policy;
- stage prompts and time budgets;
- the hidden-test grader; and
- single-model identity, with fallback chains disabled.

Only the orchestration graph changed. The principal comparison was:

- **Solo Sol:** one Sol agent explores, plans, implements, tests, and verifies.
- **Sol→Luna→Sol:** Sol plans without editing; Luna implements from that plan;
  a fresh Sol agent independently reviews, edits, tests, and fixes.

The review prompt was deliberately strong. It told the reviewer to be
adversarial, verify every roadmap target, inspect signatures and public exports,
run the project's tests, fix defects directly, and perform a final completeness
pass. This was not a ceremonial approval step.

The primary outcome was hidden-test reward in \([0,1]\). We also recorded
complete resolution, wall-clock duration, per-stage time, model usage, estimated
API cost, quota stalls, and audit signals. The grader was validated on every
task: the reference patch scored 1.0 and a no-op scored below 1.0.

### Pilot results

#### Review did not recover solo quality

Sol→Luna→Sol trailed solo Sol by **0.084 reward**, a relative decline of 9.3%.
It tied solo on two tasks and lost on two; it never beat solo:

| Task                 | Solo Sol | Sol→Luna→Sol | Difference |
| -------------------- | -------: | -----------: | ---------: |
| Fiber (Go)           |    1.000 |        0.667 |     −0.333 |
| Optuna (Python)      |    0.889 |        0.889 |      0.000 |
| Ratatui (Rust)       |    1.000 |        1.000 |      0.000 |
| Valibot (TypeScript) |    0.714 |        0.714 |      0.000 |

The pipeline paid more for the lower score. Mean cost rose from $10.49 to
$18.15, and mean time rose from 19.4 to 48.8 minutes. Review alone averaged 24
minutes—longer than the 16-minute implementation stage.

#### More reviewers made the outcome worse

The panel condition used Sol to plan, Luna to implement, three different
frontier reviewers to produce findings in parallel, and Luna to apply the merged
findings. Its mean reward was 0.734. It scored below solo Sol on every task or
tied it; it never improved one.

This matters because “use diverse reviewers” is the most obvious repair for
correlated blind spots. Diversity can help, but findings-only review followed by
a weaker fixer introduces another lossy channel: reviewers must identify the
defect, express it precisely, and persuade the implementer to repair it
correctly. More commentary is not the same as more verified correctness.

#### Reconnaissance is different from delegation

The best Round 1 pipeline began with Luna doing read-only reconnaissance, then
used Sol for planning, Luna for implementation, and Sol for review. It averaged
0.929. This suggests decomposition can help when the cheap stage compresses
information without owning the final artifact. Yet a Round 2 replicate on the
Python task reversed the ordering: solo Sol scored 1.000, while the four-stage
pipeline scored 0.889 at 2.3× the cost and 2.5× the time. With these small
samples, the reconnaissance result is promising but not settled.

### A mechanism: correlated oversight failure

The phrase “the student gaslights the teacher” is memorable but too strong as a
scientific explanation. It attributes intention and a social relationship that
the experiment did not measure. The observable mechanism can be stated without
either assumption.

Let an implementation contain a set of defects \(E\). Review succeeds only if
each important defect passes through three gates:

\[
P(\text{repair}) = P(\text{detect}) \times P(\text{diagnose}\mid\text{detect})
\times P(\text{fix}\mid\text{diagnose}).
\]

A strong reviewer may have high conditional ability at diagnosis and repair
while still having modest detection probability over a large repository. The
implementer's report can reduce that probability by anchoring attention on what
was attempted, what passed, and why the approach is coherent. The most dangerous
errors are often absences—an unimplemented edge case, export, warning, or
compatibility path—which produce no local symptom unless the reviewer derives a
specific check from the original specification.

This creates four coupled failure modes:

1. **Framing inheritance.** The reviewer starts from the implementer's summary
   and inherits its decomposition of the problem.
2. **Shared blind spots.** Related models may compress specifications and code
   in similar ways, making their errors statistically correlated.
3. **Verification substitution.** Plausible explanations and passing familiar
   tests substitute for checks targeted at omitted behavior.
4. **Repair bottlenecks.** A reviewer can find more issues than the remaining
   time, context, or fixer can correctly resolve.

The prediction is not merely that weak implementations score lower. It is that
**review gains shrink when reviewer evidence is derived from the same narrative
and tests that produced the artifact**. Review should recover when supplied with
independent evidence: hidden tests, mechanically derived requirement checklists,
counterexample search, isolated reproduction, or reviewers whose context omits
the implementer's self-report.

### Relation to prior work

This result sits between several established findings.

Work on [weak-to-strong generalization](https://arxiv.org/abs/2312.09390) shows
that stronger systems trained from weaker supervision can exceed the supervisor,
but naive weak supervision does not recover the stronger model's full ability.
Our setting runs in the opposite direction—strong oversight of weaker execution—
yet exposes the same missing premise: supervision quality is not equal to
supervisor capability.

Research on [intrinsic self-correction](https://arxiv.org/abs/2310.01798) found
that critique without external feedback can fail or reduce accuracy. A later
[critical survey](https://aclanthology.org/2024.tacl-1.78/) concluded that
reliable external feedback is the clearest condition under which correction
works. Our reviewer was a different model instance, but its main evidence still
came from the same specification, repository, familiar tests, and implementer
report. “External agent” did not guarantee external evidence.

[Self-bias in refinement](https://aclanthology.org/2024.acl-long.826/) provides
a closely related mechanism: models can favor model-generated answers, and
refinement can improve fluency while amplifying that bias. Meanwhile,
[sycophancy research](https://arxiv.org/abs/2310.13548) shows that humans and
preference models sometimes favor convincing agreement over correctness. These
findings make the persuasion-gap hypothesis plausible, but they do not prove
that Luna was trained to deceive Sol. That stronger causal claim would require
training-data or behavioral evidence absent here.

Scalable-oversight work on
[weak judges evaluating strong models](https://arxiv.org/abs/2407.04622) studies
how debate or consultancy can expose information to a limited judge. Our result
highlights a complementary concern: a capable judge can still fail when the
protocol produces agreement and narrative continuity rather than adversarial,
independently checkable evidence.

### The cross-family test

To test whether the effect is specific to the Sol/Luna pairing, we added a
matched **Fable→Luna→Fable** condition. Fable receives the same planning prompt
and budget as Sol; Luna receives the same plan-shaped input and implementation
prompt; a fresh Fable receives the same adversarial review-and-fix prompt. All
four tasks and the hidden scorer are unchanged. We also added **solo Fable**
with the identical 150-minute end-to-end prompt used by solo Sol. This baseline
separates the value of Fable review from Fable's underlying task capability.

The clean cross-family cells are part of the confirmatory study below. A first
pilot attempt reached the provider's five-hour quota boundary before producing
work and is excluded as quota-poisoned; treating a rejected attempt as model
evidence would confound availability with capability.

The interpretation is deliberately asymmetric:

- If Fable→Luna→Fable materially beats Sol→Luna→Sol, the evidence favors a
  pair-specific or model-family-specific correlation hypothesis, provided the
  gain remains after normalizing against solo Fable.
- If both pipelines trail their matched solo-teacher baselines, the evidence
  favors a general delegation bottleneck.
- If Fable→Luna→Fable matches solo Fable while Sol→Luna→Sol trails solo Sol,
  model diversity or pair-specific compatibility becomes a promising mechanism.

### Confirmatory study

The confirmatory sample is frozen before agent execution: 30 previously unseen
RoadmapBench tasks, six each in C++, Go, Python, Rust, and TypeScript. Within
language, tasks are selected by a deterministic hash of task ID after excluding
the four pilot tasks. A task enters only if the benchmark's oracle patch scores
1.0 and an untouched repository scores below 1.0; failures are replaced in a
frozen reserve order and reported. After the first broken grader was observed
but before any confirmatory agent cell ran, we extended the machine-readable
reserve list from ten candidates per language to the complete non-pilot frame.
The declared hash ordering and first ten ranks were unchanged; this amendment
protects the planned sample size without selecting on model performance.

Every task runs four matched conditions: solo Sol, Sol→Luna→Sol, solo Fable, and
Fable→Luna→Fable. Condition order rotates across tasks. Thirty paired tasks give
about 80% power for a moderate paired effect (`d_z ≈ 0.53`) at two-sided alpha
0.05. This is a substantial subset of a real benchmark suite, but it is not
powered to establish very small effects.

Crucially, each delegated condition is scored immediately after Luna finishes
and again after teacher review. The study therefore separates three questions:

1. Is delegated final quality below the same teacher working alone?
2. Does teacher review improve Luna's checkpoint at all?
3. Does changing the teacher family change either effect?

Every confirmatory score uses a private disposable repository snapshot,
preventing mutating test/build steps from changing the artifact subsequently
reviewed or audited.

We will report every task-level score, paired mean differences, 95% paired
bootstrap intervals, paired permutation tests, win/tie/loss counts, and
language-stratified descriptive means. Because several releases come from the
same upstream projects, we also report project-clustered bootstrap and sign-flip
sensitivity analyses. The complete frozen protocol appears in
`benchmarks/orchbench/PERSUASION_GAP_PREREGISTRATION.md`.

### Reproducibility

The study is executable rather than merely described. The frozen sampling frame
and reserve order live in `benchmarks/orchbench/persuasion-gap-sample.json`; a
separate verifier recomputes every rank from the pinned 115-task dataset tree.
The four conditions and intermediate checkpoint are defined in
`.smithers/workflows/orchbench.tsx`. The driver retains failed, quota-poisoned,
and tainted attempts under distinct IDs, while the analysis script accepts only
clean finished cells and emits task-level, paired, language-stratified, and
project-clustered results. Raw run events, diffs, audits, grader logs, and scores
remain available under `.context/orchbench/`.

### Practical implications

The safe default is not “never delegate.” It is to stop treating review as an
automatic quality equalizer.

1. **Use one strong agent when the task fits one context.** Continuity preserves
   tacit discoveries made during implementation and avoids lossy handoffs.
2. **Delegate bounded work with objective interfaces.** Cheap agents are most
   attractive for reconnaissance, enumeration, mechanical edits, and tasks with
   deterministic acceptance checks.
3. **Hide the implementer's sales pitch.** Give reviewers the original spec and
   diff first; reveal the self-report only after an independent checklist.
4. **Make review generate evidence.** Require new tests, counterexamples,
   imports, traces, or requirement-to-code coverage—not only prose findings.
5. **Measure correction, not approval.** Score the artifact before and after
   review. A high approval rate can coexist with zero quality gain.
6. **Prefer orthogonal reviewers.** Different model families, tools, prompts,
   and evidence sources matter more than simply adding reviewer seats.

### Limitations

This is an exploratory study, not a final causal demonstration. Round 1 has only
four tasks per pattern and one run per cell. Tasks are long-horizon release
implementations, so results may not transfer to writing, mathematics, security
review, or small isolated patches. Model versions and inference settings are
specific. The pipeline grants each stage a separate time budget, so it uses more
total compute than solo while fragmenting context. We measured final hidden-test
quality, not every intermediate implementation, which limits direct estimation
of review's marginal correction rate. Finally, four tasks with one run per cell
remain too few for precise estimates of model-family interactions.

The next decisive study should use more tasks and seeds, score immediately after
implementation and again after review, cross every teacher with every student,
and randomize whether reviewers see the implementer's report. That factorial
design would distinguish capability, family correlation, anchoring, and review
protocol effects.

### Conclusion

The appealing story of student–teacher agents is that a strong teacher can
always inspect a weaker student's work until it becomes strong. Our data show
why that story is unsafe. Review is not direct access to correctness. It is a
search process mediated by context, tests, summaries, and attention. When those
signals are correlated with the implementation's blind spots, a capable reviewer
can spend more time and money while delivering a worse artifact than it would
have produced alone.

The practical lesson is simple: **a reviewer is only as independent as the
evidence it receives**. Build delegation systems around falsification and
objective checks, not the hope that a stronger model will eventually talk a
weaker model into being perfect.
