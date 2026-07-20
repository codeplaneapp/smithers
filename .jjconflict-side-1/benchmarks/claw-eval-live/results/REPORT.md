# Claw-Eval-Live × Smithers — Results & Fairness Report

**Agent under test:** Smithers orchestrating a mixture of **Claude Opus 4.8 + GPT‑5.5**
("Codex 5.5"), exposed to the benchmark as an OpenAI-compatible endpoint.
**Benchmark:** [Claw-Eval-Live](https://github.com/Claw-Eval-Live/Claw-Eval-Live)
(105 tasks, 17 families) — grading, services, and judge are the benchmark's own,
unmodified. **Date:** 2026-06-01.

---

## 1. Headline result

<!-- FILLED FROM results/summary.json after the full run + aggregate.py -->
> **Overall Completion Score: _<pending full batch>_ / 100**
> (public leaderboard reference: Claude Opus 4.6 = 83.6, GPT‑5.4 = 81.7; no model > 70% on the paper's pass bar)
>
> **Pass rate (completion ≥ 0.75): _<pending>_**

100 non-terminal tasks were run in `--sandbox-mode local`; the 5 terminal
(`CTB_W*`) tasks were run in `--sandbox-mode docker` (the upstream-intended mode —
their hidden verifiers hardcode `/workspace`). The same Smithers mixture brain
drove both.

See `summary.json` for the per-task / per-family table.

---

## 2. How Smithers is plugged in

The benchmark drives a standard OpenAI agent loop, POSTing the conversation + the
task's tool schemas to a `/v1/chat/completions` endpoint each turn. We back that
endpoint with a Smithers mixture-of-agents "brain" (`gateway/src/`), changing
**only who produces each assistant turn**:

- **Gather** — `gpt-5.5` (Smithers `OpenAIAgent`, OpenAI API) drives multi-turn
  tool use; its native `tool_calls` pass straight through, so the benchmark
  executes mock-service / sandbox tools exactly as for any model.
- **Synthesis** — when `gpt-5.5` is ready to answer, **both Claude Opus 4.8**
  (Smithers `ClaudeCodeAgent`, subscription) **and `gpt-5.5`** draft the final
  answer from the same gathered context, and a **neutral `gemini-2.5-flash`
  arbiter** picks the stronger. This lands the mixture on the turn the graders
  measure.

Nothing else about the benchmark changes. The full architecture and run
instructions are in [`../README.md`](../README.md).

---

## 3. Fairness audit

An independent adversarial audit (3 auditors) checked the three ways this kind of
integration could cheat. **All three returned `fair`.**

### 3.1 The benchmark's grading is byte-for-byte upstream
- `git status` in the vendored benchmark shows **only** `config.smithers.yaml`
  added; `git diff --stat HEAD` is empty (zero tracked-file edits).
- Vendored `HEAD` (`eba9224`) matches a fresh clone of the official repo.
- `models/scoring.py` is byte-identical (sha256
  `c35cad73…f8f1214` on both copies); **all 105** `tasks/*/grader.py`, the entire
  `graders/` dir, and all of `mock_services/` are byte-identical to upstream
  (recursive `diff` + per-file `cmp` = zero differences).
- ⇒ `compute_task_score = round(completion, 4)` and the `0.75` pass threshold are
  the benchmark's own. We do not compute the score; the benchmark does.

### 3.2 No answer leakage, no per-task logic
- The brain reads **zero files** — `grep` for `readFile`/`fs.`/`Bun.file`/`open(`
  across `gateway/src` returns **0 hits**. Its only I/O is `fetch()` to the three
  model endpoints + the `claude` CLI subprocess.
- Every model prompt is built **solely** from the incoming request's `messages` +
  tool schemas (`gather()` forwards `req.messages`; `renderTranscript()` iterates
  only `req.messages`). Task fixtures, `fixtures/oracle.json`, `grader.py`,
  `sandbox_grader_files`, `reference_solution`, and `judge_rubric` **never** reach
  the models. (The benchmark also injects grader files only *after* the agent loop
  ends, so they can't leak even in principle.)
- **No** task-id branching, hardcoded answers, or keyword stuffing — same
  gather→synthesis→arbiter path for all 105 tasks.

### 3.3 Neutral judge & arbiter; no answer key
- Both the benchmark's communication judge and the synthesis arbiter are
  `gemini-2.5-flash` — **neither contestant** (Opus 4.8 / gpt-5.5) — so neither
  can self-grade. (The arbiter only selects *which* genuinely-produced draft to
  submit, with A/B position randomized and an explicit "you have no answer key"
  instruction. And per the benchmark's own scoring, the judge's communication
  dimension does not even enter `task_score`.)

### 3.4 Evidence is real
Scores derive from real mock-service `/audit` side-effect logs, real post-run
`/workspace` files, real tool-dispatch HTTP statuses, and the real final text.
A text-only answer that skips the required tool calls is capped by each grader's
tool gate — the agent must actually perform the work.

**Conclusion:** the numbers are produced by the benchmark's own grading over the
real agent transcript, with no leakage, no tampering, and a neutral judge.

---

## 4. Validated examples (spot checks)

| Task | Family | Mode | completion | Notes |
|---|---|---|---:|---|
| `CTB_HR_01_onboarding_checklist` | HR | local | **0.95** | gpt-5.5 gathered (gmail+crm), mixture synthesized the report |
| `CTB_W03_script_debug` | terminal | docker | **1.00** | fix passed all 3 visible **and** the hidden 4th anti-hardcoding input |

## 5. Terminal family (`CTB_W*`, Docker mode) — full result

| Task | completion | pass |
|---|---:|:--:|
| `CTB_W01_log_diagnosis` | 1.00 | ✅ |
| `CTB_W03_script_debug` | 1.00 | ✅ |
| `CTB_W04_devops_deploy_fix` | 0.00 | ❌ (genuine miss — verifier scored 0, no error) |
| `CTB_W05_backup_chain_repair` | 0.90 | ✅ |
| `CTB_W06_fullstack_dev_repair` | 1.00 | ✅ |
| **family avg** | **0.78** | **4/5** |

---

## 6. Reproducibility

`setup.sh` fetches the exact upstream benchmark; `start-gateway.sh` serves the
brain; `run-batch.sh` / `run-docker-w.sh` run the tasks. Models: `gpt-5.5`
(`OPENAI_API_KEY`), Claude Opus 4.8 (`claude` CLI subscription), `gemini-2.5-flash`
arbiter+judge (`GEMINI_API_KEY`). Single trial per task (matching the leaderboard
methodology). Raw traces are under `vendor/Claw-Eval-Live/traces_smithers/`.
