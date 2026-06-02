# SWE-EVO benchmark for Smithers

[SWE-EVO](https://arxiv.org/abs/2512.18470) (Fsoft-AIC, 2025) measures whether a
coding agent can carry a real Python project across a **release transition** —
not fix one issue, but implement an entire release's worth of evolution from its
release notes. It is 48 release-sized tasks over 7 repos (`dvc`, `dask`,
`requests`, `pydantic`, `modin`, `conan`, `scikit-learn`), averaging ~21 changed
files and ~874 tests per instance. Frontier agents resolve only ~21–25% of it
(vs ~65–73% on SWE-bench Verified), so it is a hard, long-horizon test.

This directory runs SWE-EVO **as a Smithers workflow**: a durable pipeline that
mixes two harnesses — **Claude Opus 4.8** (claude-code) drafts the change and
**Codex / gpt-5.5** reviews and completes it — then scores the result against the
real hidden test suite inside the task's official Docker image.

## How it maps to the paper

Every task instance carries the SWE-EVO schema verbatim (`repo`, `base_commit`,
`problem_statement` = the release notes, `test_patch`, `FAIL_TO_PASS`,
`PASS_TO_PASS`, per-instance `image` / `test_cmds` / `log_parser`, …). We compute
both paper metrics exactly:

- **Resolved Rate** — fraction of instances where *every* `FAIL_TO_PASS` **and**
  `PASS_TO_PASS` test passes (the binary SWE-bench "resolved" rule).
- **Fix Rate** — partial credit: `|FAIL_TO_PASS passed| / |FAIL_TO_PASS|`, but
  **gated by regressions** — if any `PASS_TO_PASS` test fails, the instance scores
  0. (Resolved Rate is the special case where that fraction is 1.0.)

The log parsers in `harness/parsers.py` are copied verbatim from the published
SWE-bench / SWE-EVO harnesses, so a given test log is classified identically to
the reference.

## Why the numbers are honest (no mocks, no fudging)

This benchmark is only meaningful if it can't be gamed. The guarantees:

1. **The agent never sees the answer.** The dataset loader strips the gold
   `patch` out of every run's input (`dataset/load.ts`). The agent is given only
   the release-note spec and the repository at the previous release — never the
   hidden tests, the `FAIL_TO_PASS`/`PASS_TO_PASS` lists, or the gold solution.
2. **The agent can't edit the tests.** Before applying the official `test_patch`,
   the scorer reverts every test file to its pristine base state
   (`harness/score_instance.py`), so any edit an agent makes to a test is
   discarded. Tests run from the real per-instance Docker image with the real
   dependency set.
3. **Scoring is the real test suite, not the model's word.** The score comes from
   `pytest` exit results parsed by the verbatim reference parser — the agents have
   no influence over it.
4. **The harness is verified against ground truth.** `verify-gold.ts` applies the
   *official gold patch* to each instance and confirms it scores
   `resolved=1, fix_rate=1.0`. If the harness didn't reproduce the reference, the
   benchmark would be invalid. Run it before trusting any score:

   ```
   bun verify-gold.ts iterative__dvc_1.6.3_1.6.4
   # -> OK resolved=1 fix=1 F2P=9/9 P2P=2/2
   ```

   Instances whose gold patch does **not** reproduce `resolved=1` in your
   environment (e.g. `requests` tests that depend on host networking behaving
   like Linux, which differs under x86 emulation on Apple Silicon) are reported
   as ENV-INCOMPATIBLE and should be excluded **transparently** — never silently
   dropped to flatter a score.

## The workflow

One run = one instance (`workflow/swe-evo.tsx`), a five-step `Sequence`:

| step | kind | what it does |
|------|------|--------------|
| `prepare`   | compute            | copy the repo at `base_commit` out of the image onto the host |
| `implement` | **Claude Opus 4.8**| draft the change from the release-note spec, editing the real checkout |
| `refine`    | **Codex / gpt-5.5**| review the draft against the spec and fix gaps / bugs |
| `diff`      | compute            | capture the combined edits as a unified patch |
| `score`     | compute            | run the hermetic Docker harness → Resolved + Fix Rate |

Because it's a Smithers workflow, every step is durable, observable, retryable,
and replayable — `prepare`/`diff`/`score` are deterministic compute nodes, so a
failed/long run can be resumed without re-paying for the agent steps.

## Running it

Prerequisites: Docker, `bun`, `python3`, and the `claude` and `codex` CLIs
authenticated (`claude` via subscription/API key, `codex` via `OPENAI_API_KEY`).

```bash
# 1. download the dataset (text only, ~7.75 MB — images are pulled at score time)
bun dataset/load.ts                         # all 48; or: bun dataset/load.ts iterative/dvc

# 2. (optional but recommended) verify the harness reproduces the gold reference
bun verify-gold.ts --subset subset-dvc.txt

# 3. run the benchmark through the Smithers Gateway
bun run.ts --subset subset-dvc.txt          # gateway mode (default)
bun run.ts iterative__dvc_1.6.3_1.6.4 --direct   # in-process, for quick iteration
```

Output is a per-instance table plus the aggregate Resolved Rate and Fix Rate, and
a JSON report under `.data/`. Docker images are large (1–4 GB each) and run under
emulation on Apple Silicon; pull them ahead of time for the instances you select.

### Knobs (env vars)

| var | default | meaning |
|-----|---------|---------|
| `SWEEVO_CLAUDE_MODEL` | `opus` (Opus 4.8) | claude-code model for `implement` |
| `SWEEVO_CODEX_MODEL`  | `gpt-5.5`         | codex model for `refine` |
| `SWEEVO_SCORE_TIMEOUT_S` | `1800`         | per-instance test timeout |
| `SWEEVO_AGENT_TIMEOUT_MS` | `1800000`     | per-agent wall-clock budget (30 min) |
| `SWEEVO_PLATFORM` | `linux/amd64`         | image platform (emulated on arm64) |

## Layout

```
dataset/load.ts          download SWE-EVO -> instances + eval cases (gold stripped)
harness/parsers.py       verbatim SWE-bench/SWE-EVO pytest log parsers
harness/score_instance.py hermetic Docker scorer (apply -> test -> parse -> metrics)
workflow/swe-evo.tsx     the Smithers workflow (Opus 4.8 + Codex mix)
workflow/harness.ts      node bridge: prepare repo, capture diff, score
workflow/prompts.ts      spec-only prompts (no test/answer leakage)
run.ts                   gateway/direct runner + Resolved/Fix Rate aggregation
verify-gold.ts           fairness gate: gold patch must score resolved=1
subset-dvc.txt           curated, environment-verified instance subset
```

## Results

See `RESULTS.md` for the latest run (models, subset, per-instance Resolved/Fix
Rate, and the gold-reference verification that backs the numbers).
