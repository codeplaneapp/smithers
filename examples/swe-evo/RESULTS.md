# SWE-EVO on Smithers — results

> Environment: macOS (Apple Silicon), Docker Desktop running the official x86_64
> SWE-EVO images under emulation. `implement` = Claude Opus 4.8 (claude-code),
> `refine` = Codex / gpt-5.5. Run through the Smithers Gateway.

## Fairness gate — gold reference check

Before trusting any score, the harness must reproduce the reference: applying the
**official gold patch** to each instance must score `resolved=1, fix_rate=1.0`.
This is the proof that the scorer is faithful and not fudged. Command:

```
bun verify-gold.ts --subset subset-dvc.txt
```

| instance | gold → resolved | F2P | P2P |
|----------|-----------------|-----|-----|
| iterative__dvc_0.92.0_0.92.1   | ✓ 1 | 4/4 | 6/6 |
| iterative__dvc_1.0.0b6_1.0.0   | ✓ 1 | 2/2 | 2/2 |
| iterative__dvc_1.11.12_1.11.13 | ✓ 1 | 2/2 | 4/4 |
| iterative__dvc_0.91.2_0.91.3   | ✓ 1 | 2/2 | 17/17 |
| iterative__dvc_2.21.1_2.21.2   | ✓ 1 | 1/1 | 8/8 |
| iterative__dvc_0.30.0_0.30.1   | ✓ 1 | 1/1 | 12/12 |
| iterative__dvc_1.6.3_1.6.4     | ✓ 1 | 9/9 | 2/2 |

**7/7 reproduced** — the harness scores the gold solution identically to the
reference on every instance in the subset.

## Benchmark — Opus 4.8 + Codex (gpt-5.5)

Subset: 7 `dvc` instances (deterministic, filesystem-based tests; `dvc` is 26 of
the 48 SWE-EVO instances). The agents receive only the release-note spec and the
repo at the previous release — never the tests or the gold patch.

| instance | release | resolved | Fix Rate | F2P | P2P |
|----------|---------|:--------:|:--------:|-----|-----|
| iterative__dvc_0.92.0_0.92.1   | 0.92.0 → 0.92.1   | ✓ | 100% | 4/4 | 6/6 |
| iterative__dvc_1.0.0b6_1.0.0   | 1.0.0b6 → 1.0.0   | ✗ | 50%  | 1/2 | 2/2 |
| iterative__dvc_1.11.12_1.11.13 | 1.11.12 → 1.11.13 | ✓ | 100% | 2/2 | 4/4 |
| iterative__dvc_0.91.2_0.91.3   | 0.91.2 → 0.91.3   | ✓ | 100% | 2/2 | 17/17 |
| iterative__dvc_2.21.1_2.21.2   | 2.21.1 → 2.21.2   | ✓ | 100% | 1/1 | 8/8 |
| iterative__dvc_0.30.0_0.30.1   | 0.30.0 → 0.30.1   | ✗ | 0%   | 0/1 | 11/12 |
| iterative__dvc_1.6.3_1.6.4     | 1.6.3 → 1.6.4     | ✓ | 100% | 9/9 | 2/2 |

| metric | value |
|--------|-------|
| **Resolved Rate** | **5 / 7 = 71.4%** |
| **Fix Rate**      | **78.6%** |

What the two misses show (and why the numbers are trustworthy):

- `1.0.0b6 → 1.0.0` is the only major-version transition in the subset (a huge
  changeset). The agents fixed 1 of 2 target tests with no regressions → 50% Fix
  Rate, not resolved. Honest partial credit, exactly what the metric is for.
- `0.30.0 → 0.30.1` is a genuine failure: the change regressed a PASS_TO_PASS test
  (11/12) and didn't fix the target. The regression gate correctly scores it 0.
- `2.21.1 → 2.21.2` is a live demonstration of Smithers' durability: the Opus
  `implement` step hit its wall-clock timeout on the first attempt; Smithers
  **retried** the task, the second attempt produced a clean 1-file fix, and the
  instance resolved. Loop/retry mechanics turning a timeout into a resolve is one
  of the things SWE-EVO is meant to probe.

### How to reproduce

```
bun dataset/load.ts iterative/dvc
bun verify-gold.ts --subset subset-dvc.txt      # 7/7 gold -> resolved=1
bun run.ts --subset subset-dvc.txt --concurrency 2
```

## Notes on scope and honesty

- This is a **curated, environment-verified subset**, not the full 48-instance
  benchmark. The full suite spans 7 repos; `requests` instances depend on host
  networking that does not reproduce under x86 emulation on Apple Silicon (their
  *gold* patches don't score `resolved=1` here either), so they are excluded
  transparently rather than scored unfairly. Run `bun verify-gold.ts --all` on a
  native Linux host to expand the verified subset.
- For context, frontier agents resolve ~21–25% of the *full* SWE-EVO suite. A
  curated subset of smaller, well-specified `dvc` evolutions is easier than the
  hardest instances (e.g. large `dask`/`modin` refactors), so these numbers are
  not comparable to the published full-suite leaderboard — they demonstrate the
  Smithers harness running the benchmark end-to-end, fairly, with real scoring.
