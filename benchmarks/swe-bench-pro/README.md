# SWE-Bench Pro on Smithers

Run [SWE-Bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os) (ScaleAI) end to
end with a Smithers workflow authoring the patches and ScaleAI's own Docker
environments scoring them.

SWE-Bench Pro is harder and more realistic than SWE-bench Verified: 731 public
tasks across 11 professional repos (Go, Python, JS, TS), each a multi-file change
that a professional engineer would spend hours on, with per-instance reproducible
Docker images and hidden test suites. That makes it a good stress test for the
things Smithers is built for: plan → implement → review → repair loops, multi-file
edits, reproducible environments, retries, run resumption, and cost-per-resolved.

## How it works

```
dataset (ScaleAI/SWE-bench_Pro)
   │
   ▼
prepareCheckout ── extract /app from the canonical image at base_commit,
   │               strip git history (the fix can't leak)
   ▼
smithers up workflow.tsx ── Opus 4.8 implements → Codex 5.5 reviews & repairs
   │                         (agents see only problem statement + requirements +
   │                          interface — never the tests or the gold patch)
   ▼
extractPatch ── git diff of everything the agents changed
   │
   ▼
scorePatch ── reproduces ScaleAI's create_entryscript verbatim inside the
              canonical image: apply patch → check out the hidden tests from the
              fix commit → run ScaleAI's run_script.sh → parse with ScaleAI's
              parser.py → resolved = (fail_to_pass ∪ pass_to_pass) ⊆ passed
```

The agent and the scorer are completely separated. The agent edits a host
checkout; the scorer runs hermetically in Docker using ScaleAI's run script and
parser. Nothing the agent does can influence how it is graded.

## Fairness — why the numbers are real

This benchmark is built so the score cannot be faked, and so you can prove it on
every run:

- **Canonical scoring, not ours.** The run script, parser, dockerfiles, and the
  scoring criterion are ScaleAI's, vendored unmodified from
  `scaleapi/SWE-bench_Pro-os`. `src/createEntryScript.js` is a line-for-line port
  of their `create_entryscript`; we validated it produces identical verdicts to
  their `swe_bench_pro_eval.py --use_local_docker`.
- **The agent never sees the answer.** It gets the problem statement,
  requirements, and interface — the canonical "no ambiguity" prompt. The gold
  patch and the hidden tests are never on disk during patch generation; the tests
  are checked out of the fix commit *inside* the scoring container. Git history is
  stripped from the checkout so the fix can't be recovered with `git log`.
- **Per-instance integrity controls.** Every instance is scored three ways: the
  agent's patch, the **gold** patch, and the **empty** patch. A pass is credited
  only when the agent patch resolves **and** gold resolves **and** empty fails. If
  the harness isn't sound for an instance (flaky tests, broken image), that
  instance is **excluded and reported** — never silently counted.
- **No silent truncation.** Excluded and errored instances are listed explicitly
  in the report; Pass@1 is over *counted* instances and the denominator is shown.

Run the controls alone, without any agent, to convince yourself:

```bash
node scripts/cli.js verify --ids instance_flipt-io__flipt-518ec324b66a07fdd95464a5e9ca5fe7681ad8f9
# → gold=true empty=false  ⇒  SOUND
```

### Honest limitations

- **Network during patch generation.** Like the canonical SWE-agent/mini-swe-agent
  setups, the implementer keeps a shell (for dependency installs) but is denied
  WebFetch/WebSearch; the reviewer runs in Codex's workspace-write sandbox with
  network disabled. Both are instructed not to consult external solutions. The
  meaningful cheat vector — overfitting to the hidden tests — is impossible: those
  tests are never on disk during generation and are introduced only inside the
  scoring container, so there is nothing to overfit to.
- **Curated subset.** Pulling and emulating all 731 amd64 images is infeasible on
  one laptop, so reported runs use an explicitly listed subset (tractable
  single-required-test tasks). This is disclosed, not hidden: the report lists
  every attempted instance and its verdict, and failures inside the chosen set
  are counted. Point `--repos`/`--languages`/`--limit` at any slice to widen it.
- **`--skip-integrity`.** Skipping the gold/empty controls makes a run faster but
  unproven; such reports are stamped with a `warning` and are not canonical.

## Setup

Requires Docker (running), Node 20+, `bun`, an authenticated `claude` CLI (Opus
4.8) and `codex` CLI (GPT-5.5). The canonical images are amd64; on Apple Silicon
they run under emulation (≈1 min/scoring).

```bash
node scripts/setup.js          # vendor scaleapi/SWE-bench_Pro-os into vendor/
node scripts/fetch-dataset.js  # download the 731-row test split → data/
```

## Usage

```bash
# List tractable Go instances
node scripts/cli.js list --languages go --limit 10

# Prove the harness is sound for a set (no agent, just gold/empty)
node scripts/cli.js verify --repos flipt-io/flipt --limit 3

# Run the benchmark: Smithers authors patches, canonical harness scores them
node scripts/cli.js run \
  --ids instance_flipt-io__flipt-518ec324b66a07fdd95464a5e9ca5fe7681ad8f9 \
  --report .work/reports/flipt.json

# A small mixed-model sweep
node scripts/cli.js run --languages go --limit 5 \
  --implementer claude-opus-4-8 --reviewer gpt-5.5-codex
```

Selection flags: `--ids`, `--repos`, `--languages`, `--limit`. Model flags:
`--implementer`, `--reviewer`. `--skip-integrity` runs faster but drops the
gold/empty controls (not recommended for reported numbers).

## Layout

| Path | Role |
| --- | --- |
| `workflow.tsx` | Patch-generation workflow (Opus implement → Codex review/repair) |
| `components/agents.js` | Opus 4.8 + Codex 5.5 agent factories |
| `src/loadInstances.js` | Dataset loader (faithful field decoding) |
| `src/prepareCheckout.js` | Extract repo at base_commit, strip history |
| `src/createEntryScript.js` | Port of ScaleAI's `create_entryscript` |
| `src/scorePatch.js` | Hermetic Docker scoring + resolved criterion |
| `src/validateHarness.js` | Gold/empty integrity controls |
| `src/runInstance.js` / `src/runBenchmark.js` | Orchestration + report |
| `scripts/cli.js` | `run` / `verify` / `list` CLI |

## Provenance

- Dataset: `ScaleAI/SWE-bench_Pro`, split `test` (731 rows).
- Harness: `github.com/scaleapi/SWE-bench_Pro-os` (run scripts, parsers, dockerfiles).
- Images: `jefzda/sweap-images:{dockerhub_tag}` (one prebuilt image per instance).
- Paper: arXiv 2509.16941.
