# Claw-Eval-Live × Smithers

Run the [Claw-Eval-Live](https://github.com/Claw-Eval-Live/Claw-Eval-Live) agent
benchmark ([arXiv:2604.28139](https://arxiv.org/abs/2604.28139)) with **Smithers
orchestrating a mixture of Claude Fable + GPT-5.5** as the agent.

Claw-Eval-Live evaluates agents on 105 real enterprise workflows across 17
families — they interact with controlled mock services, edit workspace files,
and produce structured deliverables. Scoring is grounded in *observable
execution evidence* (tool calls, service-side audit logs, post-run files, final
text), not plausible-sounding answers. Its public leaderboard tops out at
**Claude Opus 4.6 = 83.6** and **GPT‑5.4 = 81.7**, with no model above the paper's
70% pass bar.

This integration plugs Smithers in **without touching a single line of the
benchmark's grading, services, tool dispatch, or tracing** — the only thing that
changes is *who decides each assistant turn*.

---

## How it works

Claw-Eval-Live talks to any OpenAI-compatible `/v1/chat/completions` endpoint
(its `OpenAICompatProvider`). We expose Smithers as exactly that endpoint, so the
benchmark drives its normal Think→Act→Observe loop and grades the result as it
would for any model. The benchmark cannot tell — and does not care — that the
"model" is actually a Smithers workflow.

```
 ┌────────────────────────┐   POST /v1/chat/completions    ┌──────────────────────────────┐
 │  liveclaw-500 harness   │  (messages + tool schemas)     │  Smithers mixture gateway      │
 │  • mock services        │ ─────────────────────────────▶ │  (gateway/src/server.ts)       │
 │  • tool dispatch        │                                │                                │
 │  • JSONL trace          │ ◀───────────────────────────── │  decideTurn():                 │
 │  • grader.py + Gemini    │   assistant turn (tool_calls    │   GATHER → gpt-5.5 (native      │
 │    judge (UNCHANGED)     │   or final text)               │     tool calls, passthrough)   │
 └────────────────────────┘                                │   SYNTHESIS → Fable writes      │
                                                            │     the final deliverable from  │
                                                            │     the gathered context        │
                                                            └──────────────────────────────┘
```

**Two phases, decided per turn:**

- **Gather.** `gpt-5.5` (via Smithers `OpenAIAgent`, OpenAI API) drives the
  multi-turn tool use. Its native OpenAI `tool_calls` are passed straight
  through, so the benchmark executes the mock-service / sandbox tools exactly as
  it would for a raw model.
- **Synthesis.** The moment `gpt-5.5` is ready to answer (returns no tool calls),
  **Claude Fable** (via Smithers `ClaudeCodeAgent`, subscription auth) — the
  stronger synthesizer — composes the final deliverable from the gathered
  context. This is the role-split "mixture of Fable + GPT-5.5" (gpt-5.5
  gathers, Fable synthesizes), and it lands Fable on the turn the graders
  actually measure (the benchmark loop ends, and final text is the dominant
  scored signal for most families). If Fable is unavailable, the turn falls back
  to gpt-5.5's own final answer.

This split plays to each model's strengths (gpt-5.5's fast native function
calling for tool loops; Fable's synthesis quality on the graded deliverable)
while keeping Fable cost/latency bounded (≈ one Fable call per task, not per turn).
The brain contains **no** LLM judge of its own — the only LLM-as-judge anywhere
in the pipeline is the benchmark's own (neutral) grader judge.

### Models

| Role | Model | Auth |
|---|---|---|
| Multi-turn tool gathering | `gpt-5.5` | `OPENAI_API_KEY` |
| Final synthesis (the graded turn) | Claude Fable (`claude-fable-5`) | `claude` CLI subscription |
| Benchmark judge (semantic grading) | `gemini-2.5-flash-lite` (neutral, not a contestant) | `GEMINI_API_KEY` |

> "Codex 5.5" → `gpt-5.5`: there is no `gpt-5.5-codex` model in the listings
> checked here; `gpt-5.5` is the flagship 5.5.

---

## Fairness — why this isn't cheating

The whole point of Claw-Eval-Live is that you can't fake the numbers, and this
integration preserves that. Concretely:

1. **The benchmark's grading is 100% unmodified.** We only set `model.base_url`
   / `model_id` / `judge` in a config file (`config.smithers.yaml`). `grader.py`
   for every task, `compute_task_score` (`= round(completion, 4)`), the `0.75`
   pass threshold, mock services, tool dispatch, and trace capture are the
   upstream code, untouched. The benchmark is **fetched** from upstream by
   `setup.sh`, not vendored/edited.
2. **No answer leakage to the brain.** The Smithers gateway only ever receives
   what the benchmark sends it: the task prompt and *real* tool results. Task
   fixtures, `fixtures/oracle.json`, and `sandbox_grader_files` (verify scripts)
   are never sent — and the benchmark itself injects grader files *after* the
   agent loop ends, so they can't leak even in principle.
3. **No per-task logic.** `mixture.ts` is entirely task-agnostic: same gather /
   synthesis path for all 105 tasks. There is no task-id branching, no
   hardcoded outputs, no keyword stuffing.
4. **Neutral judge; the brain has no judge of its own.** The brain just routes
   work between the two contestants (gpt-5.5 gathers, Fable synthesizes) — it
   contains no LLM-as-judge, so there is nothing for a contestant to self-grade.
   The only LLM judge anywhere is the **benchmark's own** semantic grader, which
   we point at **Gemini** (`gemini-2.5-flash-lite`) — neither contestant. (Per the
   benchmark's scoring, `task_score == completion` only, so that judge affects a
   subset of tasks' completion sub-scores and never the pass threshold directly.)
5. **Evidence is real.** Scores come from real mock-service audit logs, real
   post-run workspace files, real tool-dispatch HTTP statuses, and the real final
   text. The brain must actually perform the work to score.

See `results/REPORT.md` for the per-task fairness audit.

### Local vs Docker mode

Most tasks (services + report/document families) are graded entirely host-side
and run in `--sandbox-mode local`. The 5 **terminal** tasks (`CTB_W*`) ship a
hidden verifier (`fixtures/verify_outputs.py`) that hardcodes absolute
`/workspace/...` paths — those only exist inside the benchmark's Docker sandbox,
so those 5 tasks are run with `--sandbox-mode docker` (the upstream-intended mode
for terminal tasks) for correct grading. This is a harness-mode requirement, not
a Smithers difference; the same agent brain drives both modes.

---

## Run it

Prereqs: `uv`, `bun`, Docker (for the 5 `CTB_W*` tasks), an authenticated
`claude` CLI (Fable subscription access), and:

```bash
export OPENAI_API_KEY=sk-...      # gpt-5.5
export GEMINI_API_KEY=...         # arbiter + benchmark judge
```

```bash
cd benchmarks/claw-eval-live
./setup.sh                        # fetch + install upstream benchmark into vendor/

# shell 1 — the Smithers mixture gateway (auto-restarts on crash):
./start-gateway.sh

# shell 2 — run tasks (real grader + neutral judge):
./run-one.sh CTB_HR_01_onboarding_checklist        # one task
./run-batch.sh                                     # all 105, 3 workers
./run-batch.sh CTB_FIN 2                            # only CTB_FIN*, 2 workers

# the 5 terminal tasks, in Docker:
docker build -f Dockerfile.sandbox -t liveclaw-500-agent:latest vendor/Claw-Eval-Live
./run-docker-w.sh
```

Traces + `batch_summary.json` land in `vendor/Claw-Eval-Live/traces_smithers/`.

## Files

| File | Purpose |
|---|---|
| `gateway/src/server.ts` | OpenAI-compatible HTTP server (`/v1/chat/completions`, `/v1/models`, `/health`) |
| `gateway/src/mixture.ts` | The mixture brain: gather (gpt-5.5) → synthesis (Fable, with gpt-5.5 fallback) |
| `config.smithers.yaml` | Points the benchmark's agent at the gateway; sets the neutral judge |
| `Dockerfile.sandbox` | Slim sandbox image for the 5 terminal tasks |
| `setup.sh` / `start-gateway.sh` / `run-one.sh` / `run-batch.sh` / `run-docker-w.sh` | Fetch, serve, run |
| `results/REPORT.md` | Methodology, fairness audit, and scores |
