# The re-run: fullbench 45 on the post-program harness (r91)

Measured 2026-08-22, 02:33Z to 06:35Z. Baseline: the r90 full benchmark,
re-graded by `./regrade.sh`.

`fullbench/analysis/PROGRAM.md` reads 45 instances' traces, names eleven harness
changes, and gives each a falsifiable prediction about what the same 45
instances would then cost. This is the measurement those predictions are settled
against.

**The program did not work. Every one of its six success criteria failed, and it
failed in the same direction on all of them: fewer resolves, more money, more
wall clock.**

| | r90 baseline | r91 re-run | delta |
| --- | ---: | ---: | ---: |
| **resolved** | **35/45** | **30/45** | **−5** |
| resolved, against the pre-regrade r90 number | 29/45 | 30/45 | +1 |
| **total agent cost** | **$37.84** | **$60.24** | **+$22.40 (+59 %)** |
| **total agent wall** | **15,877 s** | **29,799 s** | **+13,922 s (+88 %)** |
| instance wall | 17,106 s | 31,603 s | +14,497 s |
| frames | 452 | 527 | +75 |
| output tokens | 961,461 | 1,618,230 | +656,769 (+68 %) |
| cache rate | 59.3 % | 69.8 % | +10.5 pp |

Cost is every attempt, which is what the invoice says; the per-instance fold of
final attempts is $59.38. Wall clock is the journal's own span across the
agent's frames, summed per instance — not the wall clock of the run as a whole,
which depends on concurrency.

31 of 45 instances got dearer, 13 cheaper, 1 unchanged. 37 of 45 got slower.
Instances that exhausted the 1200 s budget went from 2 to 9.

## The program's success criteria

| criterion | target | actual | met |
| --- | ---: | ---: | :---: |
| resolved | ≥ 33 | 30 | NO |
| total cost | ≤ $15.00 | $60.24 | NO |
| instance wall | ≤ 120 min | 526.7 min | NO |
| no instance over $1.00 | 0 | 27 | NO |
| no instance over 20 frames | 0 | 6 | NO |
| no verdict lost | 0 | 7 | NO |

## Preconditions

| | |
| --- | --- |
| subject stamp | `sha256:0a947226ef134c964441082361f653384e11739c7a9d72b5b51b502c50a52ed0` |
| git HEAD | `af2509b4a00cf885ca87fbfa236008d31fa3d59a` |
| HEAD subject | 🔧 fix(harness,agent,std,swebench): teach the tools the lanes actually shipped |
| `CellTurn.ts` | `sha256:9ede759dd3389cfe1f5b46faad73a1fce8248ccef4c7b0e28613ac8615b6ad23` |
| `packages/cli/dist/esm` | `sha256:1d53b7de47aab2ec5b66d57e0210f4afe723936e60f5d31b44531892781a0e40` |
| `@smthrs/harness` src | `sha256:cfacc41d158b3c8c7f6539a92048a634bec7c0b8c67f72e6d2f5ab808c060fe2` |
| `@smthrs/std` src | `sha256:ea5b3c7aa99bc06fd8602d2dedf05f0face94145017213369acd9982f6b17653` |
| preflight refusals | none |
| node | v24.18.0 darwin-arm64 |
| seat | `openai:gpt-5.6-sol`, both sides |
| attempts | one per instance |
| per-instance budget | 1200 s, both sides |
| in flight | 3 |
| disk gate | 8192 MiB; never blocked, no wait rows (lowest reading 28.3 GiB free) |
| grading | official evaluator, x86_64 images, run id `rerun-r91` |
| agreement | every instance ran the pinned subject |

`./preflight.sh` deletes `packages/cli/dist`, rebuilds it, and hashes the
`@smthrs/*` closure the CLI actually loads. Every `flows.sh` invocation
re-derives that stamp and refuses to run when it moves, so all 45 instances
measured one tree.

One repair was needed before the pin could be taken. A sibling lane's index had
dropped 23 paths that were still on disk byte-identical to `HEAD`, and
`lib/subject.mjs` reads `git diff --name-only HEAD` plus
`git ls-files --others`, which reports an untracked-but-in-`HEAD` path as a
deletion. Each of the 23 was compared against its `HEAD` blob, found identical,
and its index entry restored. No file content changed.

## Disclosures

- **Two instances crashed on the model transport** —
  `ERR_HTTP2_INVALID_SESSION: The session has been destroyed` from
  `POST https://api.openai.com/v1/responses`, which fails the cell frame and
  ends the run. `pydata__xarray-7393` and `matplotlib__matplotlib-20859`. Both
  were re-run once, as infrastructure crashes rather than measurements.
  `matplotlib-20859` then resolved; `xarray-7393` then exhausted its budget with
  an empty patch, so its lost verdict is a real harness outcome that the crash
  had masked. Both attempts' dollars are counted in the totals above.
- **The budget gate was never reached.** Cumulative spend finished at $60.24
  against a $60 ceiling, but the gate is read before each *launch*, and the last
  launch happened at $54.61. Nothing was skipped or paused.
- One rig fix landed mid-wave, in `run-45.sh` only: the ledger header read the
  pin's fingerprint under `fingerprint`/`subject`, and `preflight.sh` writes it
  under `stamp`, so the first header recorded `subject: "unknown"`. `evals/` is
  not part of the pinned subject, so this did not move the measurement.
- Four instances recorded `empty patch` after exhausting the 1200 s budget
  (`exit 124`) rather than after a crash: `django-11299`, `django-13343`,
  `django-15987`, `sympy-13878`, plus `xarray-7393` on its re-run. These are
  measurements, not faults, and are counted as losses.

## What actually happened

### Five instances never wrote a single byte

In r91, **five instances issued zero mutation calls across 14 to 22 frames each
and spent their whole 1200 s budget without editing the tree.** In r90, every
one of the 45 instances edited. All five were resolved by the baseline.

| instance | baseline | r91 | r91 frames | r91 mutation calls |
| --- | --- | --- | ---: | ---: |
| django__django-11299 | resolved, $0.94, 11f | empty patch | 14 | 0 |
| django__django-13343 | resolved, $0.13, 2f | empty patch | 18 | 0 |
| django__django-15987 | resolved, $0.45, 4f | empty patch | 19 | 0 |
| pydata__xarray-7393 | resolved, $0.59, 9f | empty patch | 22 | 0 |
| sympy__sympy-13878 | resolved, $2.22, 24f | empty patch | 21 | 0 |

`django-13343` is the clearest case: the baseline resolved it in 2 frames, 48 s
and $0.13. In r91 it spent 18 frames and $2.08 trying to build a reproduction
that fails for the right reason, hit a Django bootstrap error on nearly every
attempt, and ran out of budget with the fix never written.

The mechanism is `cellPrompt.ts` rule 8 — change #2's evidence rule — which
makes a valid pre-edit reproduction a precondition of writing: *"Before the
first write, run the one targeted command that reproduces the report that way …
repair such a probe, by listing the real names first, before you edit
anything."* The doctrine is sound. It is only affordable if the agent can
actually bootstrap a probe, and in this subject it could not.

### The probe bootstrap got worse, not better

| | r90 | r91 |
| --- | ---: | ---: |
| `bash` calls | 587 | 596 |
| exiting non-zero | 185 (32 %) | 308 (52 %) |
| flagged `invalidProbe` by the flow itself | 5 | 163 |
| instances whose cells hunted for the project interpreter | **0** | **30** |
| cells spent on that hunt | **0** | **138** |

Change #4 shipped its first half — `bash` takes `script`/`interpreter`/`stdin`
and the harness delivers the payload as data (314 of 596 calls used it, up from
zero) — and it did remove the quoting class. It did not ship its second half:
the *"per-image execution recipe computed once at setup and stated in the
preamble"*. The preamble names the test runner and shows
`{ interpreter: "python3", script: "…" }`, but never names the interpreter that
has the project's dependencies.

That omission is the single largest regression mechanism in this wave. In r90
the agent typed `docker exec … bash -lc '…'`, and `bash -lc` is a login shell,
so the image's conda environment was activated for free. `interpreter: "python3"`
bypasses the login shell, resolves to a python without the project on its path,
and the traces fill with `ModuleNotFoundError: No module named 'numpy'`,
`ImproperlyConfigured`, and
`exec: "/usr/local/bin/python": no such file or directory`. Thirty of 45
instances then spent frames scanning `/opt` for
`/opt/miniconda3/envs/testbed/bin/python3.10` — work the harness knows the
answer to and could state once.

### Change #6 never reached the run

The structured `test` flow and its `against: "base"` pristine-baseline
comparison were built in `@smthrs/std` and a binder added as
`StandardFlows.tests`, but **no composition binds it.**
`packages/cli/src/NodeControl.ts` composes `filesystem`, `shell` and `memory`
and nothing else, so `test` is not in `ctx.flows` for any benchmark run.

The evidence is exact: **0 `test` calls across all 45 r91 journals.** Change
#6's own changelog states the rule it broke — *"A tool no production composition
offers is a tool that does not exist."* Change #2's doctrine, which tells the
agent to baseline a suite against the pristine base, shipped without the one
call that would have made that cheap.

### The contract grew, and the cells grew with it

| | r90 | r91 |
| --- | ---: | ---: |
| mean cell size | 2,971 bytes | 3,686 bytes |
| output tokens per frame | 2,127 | 3,071 |
| cells rejected in-frame for a parse error | n/a (feature absent) | **85** |
| frames that applied no transition | 30 | 21 |
| read-only demands fired | 6 | 14 |

Change #5 works exactly as designed: 85 unparseable cells were caught at the
boundary and re-asked inside their own frame instead of settling as dead frames,
and dead frames fell from 30 to 21. But the *rate* of unparseable cells rose
sharply — roughly 30 events became roughly 106 — because change #10's
transactional-cell teaching asks for one long cell doing
locate → read → probe → edit → verify, and longer cells fail to parse more
often. Change #5 is paying for change #10, at full output price, 85 times.

Read-only demands more than doubled, which is the same spiral seen from the
controller's side.

## Which program changes demonstrably acted

Read off the 90 journals by `lib/program-evidence.mjs`, which counts
`control.agent.*` events and nothing else.

| # | change | shipped | acted | the number that says so |
| --- | --- | :---: | :---: | --- |
| 1 | honest, addressable context | yes | **partly** | `recall` went 0 → **121 ordinals over 47 transitions**; but **zero-call frames rose 75 → 81** against a predicted < 5 |
| 2 | verification-doctrine rewrite | yes | **yes — and it is the regression** | read-only demands 6 → 14; **5 instances never edited**; `django-13821` flipped to resolved exactly as predicted |
| 3 | edit-mechanics overhaul | yes | **yes** | failed mutations **11 → 4**; `django-13346` −19 frames and −$1.36; `sphinx-7590` no longer ships an empty patch; 0 patches carry mode hunks |
| 4 | script-as-data execution | half | **yes, and it backfired** | **314 of 596** `bash` calls pass a payload as data (was 0), but probe validity fell 68 % → 48 % and 30 instances hunted the interpreter |
| 5 | cell validation at the boundary | yes | **yes** | **85** in-frame re-asks; dead frames 30 → 21 |
| 6 | pristine baseline + structured `test` | **not bound** | **no** | **0 `test` calls in 45 journals**; `NodeControl.ts` binds filesystem, shell, memory only |
| 7 | symbol spans and honest grep | yes | **partly** | grep hits carry their own `before`/`after` context and enclosing definition; `xarray-7233` still burned 25 frames re-reading wrong windows of one file |
| 8 | fail-soft structured call errors | yes | **yes, cleanly** | frames holding a failed call **21 → 8**; of those, **recovered in-cell 4/21 (19 %) → 7/8 (88 %)** |
| 9 | environment brief, hidden harness refs | yes | **yes** | `django-13346`, whose r90 run applied its own harness snapshots as upstream history, spent **5 of 29 cells mining local history in r90 and 0 of 10 in r91**, finishing at −$1.36 |
| 10 | transactional-cell teaching pack | yes | **yes, and it inflates output** | output per frame **2,127 → 3,071 (+44 %)**; mean frames per instance 10.0 → 11.7 against a predicted ≤ 4 |
| 11 | grader parity and eval-error recovery | yes (rig) | **yes** | the re-grade moved the baseline 29 → 35; `psf-1766` and `psf-2317` resolve on both sides |

Cache rate rose 59.3 % → 69.8 %, which is change #1's prefix-stability work
landing. It is the one unambiguous efficiency win, and it is swamped: input
tokens rose 3.86 M → 5.83 M, so a better cache rate on far more input is still
more money.

## The six former codex-only instances

`PROGRAM.md` §4 listed six instances codex resolved and flows did not, and
predicted the set would shrink by at least three. **It shrank by one.**

| instance | baseline | re-run | $ before → after | frames | agent s | predicted by |
| --- | --- | --- | ---: | ---: | ---: | --- |
| django__django-12273 | unresolved | **unresolved** | $0.77 → $0.98 | 8 → 7 | 338 → 487 | #2, #9 |
| django__django-12741 | resolved | **resolved** | $0.82 → $0.44 | 9 → 3 | 372 → 213 | #11 (held) |
| django__django-13821 | unresolved | **resolved** | $1.03 → $1.53 | 11 → 12 | 433 → 875 | **#2 — met** |
| pydata__xarray-7229 | unresolved | **unresolved** | $2.01 → $1.19 | 20 → 9 | 839 → 562 | #2, #1 |
| sphinx-doc__sphinx-7590 | empty patch | **unresolved** | $2.93 → $2.45 | 39 → 23 | 1128 → 1131 | #3, #1 |
| sympy__sympy-19495 | unresolved | **unresolved** | $0.54 → $1.33 | 9 → 15 | 226 → 587 | #2 |

- **13821 is the program's one clean verdict win.** Change #2(b) — a recorded
  probe is a revisable premise, not a completion demand — did exactly what the
  analysis said it would: the run no longer reverts its correct gate raise.
- **7590 is a partial win.** The predicted failure mode is gone: the correct
  direct edit is no longer abandoned by self-written anchor guards, the run is
  16 frames shorter and $0.49 cheaper, and it now ships a patch instead of
  nothing. The patch is still wrong. Note that codex's 7590 resolve rests on
  fetching the project's later 3.x history, which §6-R2 rejects, so this
  instance is not a like-for-like scoreboard row.
- **7229 got much cheaper and no more correct** (−11 frames, −$0.82). The run
  still ships the heuristic attrs-preserving patch family after its own evidence
  disproves it.
- **19495 got worse**: +6 frames and +$0.79 for the same unresolved verdict.
  Change #2's stale-test rule is stated in rule 9 of the contract and the run did
  not act on it.
- **12273 is unmoved**, at +$0.21 for one fewer frame.

**The standing superset goal still fails on this sample: codex-only remains 5,
flows-only remains 0 on the graded subset.**

## The two ex-grading-fault instances

Both hold. Their r90 `unresolved` verdicts were rig faults — the grading
container had no route to httpbin — and `./regrade.sh` had already corrected
them in the baseline. The re-run confirms the agent's patches are genuinely
correct against a grader with the network, on both sides of the comparison.

| instance | baseline | re-run | $ before → after | frames | agent s |
| --- | --- | --- | ---: | ---: | ---: |
| psf__requests-1766 | resolved | **resolved** | $0.14 → $0.41 | 3 → 4 | 52 → 212 |
| psf__requests-2317 | resolved | **resolved** | $0.33 → $0.66 | 4 → 5 | 118 → 555 |

Both got dearer and slower — 1766 by 3×, 2317 by 4.7× on wall clock — which is
the wave's general pattern showing up on two of its easiest instances.

`PROGRAM.md` §11 also predicted `matplotlib-22865` would stay failed because its
r90 run never completed. The re-grade resolved it instead, and the re-run
resolves it again at −26 frames and −$1.22 — the largest frame saving in the
wave, second only to `django-13346` on dollars. That prediction was wrong in the
program's favour.

## Verdicts that moved

**Gained (2):** `astropy__astropy-14369`, `django__django-13821`.

`14369` is the more interesting of the two: `PROGRAM.md` §5 records the two
analysts disagreeing about whether the over-broad edit shape was required, and
change #2(f)'s minimal-edit discipline settled it — the run resolved in 5 frames
where the baseline failed in 8.

**Lost (7):**

| instance | baseline | re-run | why |
| --- | --- | --- | --- |
| django__django-11299 | resolved | empty patch | budget exhausted; 0 mutation calls in 14 frames |
| django__django-13343 | resolved | empty patch | budget exhausted; 0 mutation calls in 18 frames |
| django__django-15987 | resolved | empty patch | budget exhausted; 0 mutation calls in 19 frames |
| pydata__xarray-7393 | resolved | empty patch | budget exhausted on the re-run; 0 mutation calls in 22 frames |
| sympy__sympy-13878 | resolved | empty patch | budget exhausted; 0 mutation calls in 21 frames |
| django__django-14351 | resolved | unresolved | budget exhausted; 25 frames, patch wrong |
| sympy__sympy-20154 | resolved | unresolved | completed in 4 frames on a wrong patch |

Six of the seven are the probe-bootstrap spiral. `20154` is not: it is the one
instance change #5 was written for (a 53 KB multi-return dead cell in r90), the
dead cell is gone, and the run now completes quickly on a wrong fix.

## Per instance

| instance | baseline | re-run | $ before | $ after | Δ$ | frames | Δf | agent s | Δagent s |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| astropy__astropy-14365 | unresolved | unresolved | $0.43 | $1.01 | +$0.58 | 4 → 8 | +4 | 334 → 470 | +136 |
| astropy__astropy-14369 **gained** | unresolved | resolved | $0.64 | $0.52 | −$0.12 | 8 → 5 | −3 | 245 → 354 | +109 |
| astropy__astropy-7166 | resolved | resolved | $0.33 | $0.33 | +$0.00 | 5 → 2 | −3 | 118 → 130 | +12 |
| astropy__astropy-8707 | resolved | resolved | $1.12 | $0.99 | −$0.12 | 15 → 14 | −1 | 428 → 421 | −7 |
| django__django-10914 | resolved | resolved | $0.97 | $0.41 | −$0.56 | 15 → 6 | −9 | 449 → 216 | −233 |
| django__django-11299 **lost** | resolved | empty patch | $0.94 | $1.96 | +$1.02 | 11 → 14 | +3 | 376 → 1155 | +779 |
| django__django-11490 | resolved | resolved | $1.00 | $1.96 | +$0.96 | 13 → 17 | +4 | 408 → 1174 | +766 |
| django__django-11815 | resolved | resolved | $0.24 | $1.92 | +$1.68 | 3 → 21 | +18 | 90 → 829 | +739 |
| django__django-12273 | unresolved | unresolved | $0.77 | $0.98 | +$0.21 | 8 → 7 | −1 | 338 → 487 | +149 |
| django__django-12741 | resolved | resolved | $0.82 | $0.44 | −$0.38 | 9 → 3 | −6 | 372 → 213 | −159 |
| django__django-13128 | resolved | resolved | $0.75 | $1.77 | +$1.02 | 8 → 13 | +5 | 323 → 970 | +647 |
| django__django-13212 | unresolved | unresolved | $0.71 | $1.45 | +$0.74 | 6 → 10 | +4 | 260 → 917 | +657 |
| django__django-13343 **lost** | resolved | empty patch | $0.13 | $2.08 | +$1.95 | 2 → 18 | +16 | 48 → 1156 | +1108 |
| django__django-13346 | resolved | resolved | $2.36 | $1.00 | −$1.36 | 29 → 10 | −19 | 934 → 431 | −503 |
| django__django-13406 | resolved | resolved | $0.30 | $0.54 | +$0.24 | 3 → 4 | +1 | 116 → 314 | +198 |
| django__django-13821 **gained** | unresolved | resolved | $1.03 | $1.53 | +$0.50 | 11 → 12 | +1 | 433 → 875 | +442 |
| django__django-14351 **lost** | resolved | unresolved | $2.77 | $2.54 | −$0.23 | 34 → 25 | −9 | 1086 → 1141 | +55 |
| django__django-15380 | resolved | resolved | $0.60 | $0.99 | +$0.39 | 9 → 11 | +2 | 232 → 528 | +296 |
| django__django-15569 | resolved | resolved | $0.25 | $0.54 | +$0.28 | 3 → 5 | +2 | 88 → 244 | +156 |
| django__django-15732 | resolved | resolved | $0.58 | $2.06 | +$1.49 | 9 → 20 | +11 | 214 → 1158 | +944 |
| django__django-15987 **lost** | resolved | empty patch | $0.45 | $1.99 | +$1.54 | 4 → 19 | +15 | 175 → 1119 | +944 |
| django__django-16612 | resolved | resolved | $0.25 | $0.29 | +$0.03 | 3 → 2 | −1 | 93 → 107 | +14 |
| django__django-16662 | resolved | resolved | $0.57 | $1.06 | +$0.49 | 7 → 8 | +1 | 234 → 466 | +232 |
| django__django-16899 | resolved | resolved | $1.83 | $2.58 | +$0.74 | 20 → 20 | +0 | 888 → 1195 | +307 |
| django__django-16901 | resolved | resolved | $0.90 | $1.18 | +$0.28 | 6 → 11 | +5 | 390 → 516 | +126 |
| matplotlib__matplotlib-20826 | resolved | resolved | $0.52 | $0.93 | +$0.41 | 5 → 9 | +4 | 241 → 387 | +146 |
| matplotlib__matplotlib-20859 | resolved | resolved | $0.17 | $0.89 | +$0.73 | 2 → 5 | +3 | 56 → 461 | +405 |
| matplotlib__matplotlib-22865 | resolved | resolved | $2.65 | $1.43 | −$1.22 | 36 → 10 | −26 | 1164 → 742 | −422 |
| matplotlib__matplotlib-24970 | resolved | resolved | $0.48 | $0.45 | −$0.03 | 8 → 3 | −5 | 282 → 237 | −45 |
| psf__requests-1766 | resolved | resolved | $0.14 | $0.41 | +$0.27 | 3 → 4 | +1 | 52 → 212 | +160 |
| psf__requests-2317 | resolved | resolved | $0.33 | $0.66 | +$0.33 | 4 → 5 | +1 | 118 → 555 | +437 |
| pydata__xarray-7229 | unresolved | unresolved | $2.01 | $1.19 | −$0.82 | 20 → 9 | −11 | 839 → 562 | −277 |
| pydata__xarray-7233 | unresolved | unresolved | $0.12 | $2.68 | +$2.57 | 3 → 25 | +22 | 29 → 1192 | +1163 |
| pydata__xarray-7393 **lost** | resolved | empty patch | $0.59 | $2.56 | +$1.97 | 9 → 22 | +13 | 224 → 1191 | +967 |
| pytest-dev__pytest-6197 | resolved | resolved | $0.54 | $2.35 | +$1.81 | 5 → 20 | +15 | 242 → 1030 | +788 |
| sphinx-doc__sphinx-11445 | resolved | resolved | $0.16 | $0.97 | +$0.80 | 3 → 8 | +5 | 56 → 410 | +354 |
| sphinx-doc__sphinx-7590 | empty patch | unresolved | $2.93 | $2.45 | −$0.49 | 39 → 23 | −16 | 1128 → 1131 | +3 |
| sphinx-doc__sphinx-7757 | resolved | resolved | $0.30 | $1.51 | +$1.21 | 5 → 12 | +7 | 109 → 624 | +515 |
| sphinx-doc__sphinx-8721 | resolved | resolved | $1.66 | $1.46 | −$0.20 | 19 → 15 | −4 | 692 → 662 | −30 |
| sympy__sympy-13372 | resolved | resolved | $0.16 | $1.21 | +$1.05 | 3 → 11 | +8 | 45 → 614 | +569 |
| sympy__sympy-13878 **lost** | resolved | empty patch | $2.22 | $2.17 | −$0.05 | 24 → 21 | −3 | 1131 → 1155 | +24 |
| sympy__sympy-16450 | resolved | resolved | $0.17 | $0.45 | +$0.28 | 3 → 5 | +2 | 58 → 317 | +259 |
| sympy__sympy-18763 | unresolved | unresolved | $0.45 | $1.45 | +$1.01 | 5 → 16 | +11 | 182 → 730 | +548 |
| sympy__sympy-19495 | unresolved | unresolved | $0.54 | $1.33 | +$0.79 | 9 → 15 | +6 | 226 → 587 | +361 |
| sympy__sympy-20154 **lost** | resolved | unresolved | $0.95 | $0.72 | −$0.23 | 2 → 4 | +2 | 331 → 414 | +83 |

Frames and dollars are this re-run's own ledger; the baseline column is
`fullbench/manifest.jsonl` after `./regrade.sh`.

## The shape of the regression

The changes split cleanly into two groups, and the split is the finding.

**Tool changes paid.** Every instance whose r90 diagnosis was a tool failure got
cheaper and shorter: `13346` −19 frames (raw reads, hidden harness refs),
`22865` −26 frames (exact-or-loud edits), `7229` −11 frames, `24970` −5,
`10914` −9, `12741` −6, `8721` −4, `7590` −16. Failed mutations fell 11 → 4.
Fail-soft calls recovered 88 % of the frames that held a failure, against 19 %.
Not one of these needed the agent to be told anything.

**Doctrine changes cost.** Every instance that was cheap in r90 got expensive in
r91: `13343` 2 → 18 frames, `11815` 3 → 21, `13372` 3 → 11, `16450` 3 → 5,
`11445` 3 → 8, `7757` 5 → 12, `6197` 5 → 20. These runs were not failing at
anything in r90 — they found the fix and made it. In r91 they are made to
reproduce first, and reproduction in these images is expensive because the
harness never tells them how to run the project's Python.

That asymmetry is the whole result. The waste ledger in `PROGRAM.md` attributed
37 % of r90's waste to a "teaching gap", and the remedy was more teaching: the
cell contract grew from 6,409 to 8,197 bytes and gained four new numbered rules
about probes, oracles, revisable premises and minimal edits. The measurement
says the teaching was not the gap. Adding it cost $22 and five verdicts, and the
one place it demonstrably won a verdict — `13821` — is the one place the rule
removes a demand rather than adding one.

## What to do next, in order

1. **Bind `StandardFlows.tests` in `NodeControl.ts`, or delete change #6.**
   A flow no composition offers is a flow that does not exist, and half of
   change #2's doctrine assumes it. This is the cheapest fix on the list.
2. **State the project interpreter in the preamble, computed once at setup.**
   Change #4's second half. `lib/write-flow.mjs` already computes the test
   command per image; the interpreter is the same kind of fact, and 138 cells
   across 30 instances were spent rediscovering it. Alternatively, make
   `Container`'s exec route the payload through a login shell so the image's own
   environment activation still happens — which is what `bash -lc` gave r90 for
   free.
3. **Make rule 8's pre-edit reproduction conditional, not mandatory.** Five
   instances died holding a correct diagnosis they were not allowed to act on.
   `PROGRAM.md` §5.5 already adopted fable's *conditional* version — keep a
   failing baseline "whenever it gates a same-cell complete", drop it otherwise —
   and what shipped in rule 8 is the unconditional one.
4. **Re-measure changes #3, #7, #8 and #9 alone**, with #2 and #10 reverted to
   their r90 text. The tool half of this program looks like a real win and this
   wave cannot price it, because the doctrine half moved every number at the
   same time.
5. **Retry the transport.** Two instances were lost outright to one dropped
   HTTP/2 session on `POST /v1/responses`. A cell frame should not die because a
   socket did.

## Reproducing this

```sh
./preflight.sh                                   # pins the subject
./run-45.sh                                      # the wave itself
node compare-runs.mjs --rerun fullbench/rerun-r91/manifest.jsonl \
  --out fullbench/rerun-r91                      # the comparison
node lib/program-evidence.mjs fullbench/rerun-r91/journals
node lib/program-evidence.mjs fullbench/journals  # the baseline's own counts
```

`lib/program-evidence.mjs` reads `control.agent.*` events out of each journal and
nothing else — no clock, no network, no re-derivation. It is checked by
`fixtures/check-program-evidence.mjs`, which runs inside `./verify.sh`.

Artifacts: `fullbench/rerun-r91/manifest.jsonl` (the ledger),
`fullbench/rerun-r91/compare.{md,json}` (the comparison),
`fullbench/rerun-r91/journals/` (45 journals),
`fullbench/rerun-r91/patches/` (45 patches),
`fullbench/rerun-r91/logs/` (per-instance run and grade logs),
`fullbench/rerun-r91/driver.log`.
