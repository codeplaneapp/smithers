# The second re-run: fullbench 45 on the post-review harness (r92)

Measured 2026-08-22, 08:05Z to 10:19Z. The same 45 instances, the same seeded
draw order, read out of the r90 baseline ledger.

`fullbench/reports/rerun-r91.md` settled eleven harness changes against that
baseline and reported that every success criterion failed in the same direction:
30/45 against 35/45, $60.24 against $37.84, 29,799 s against 15,877 s. Its
finding was a split — **tool changes paid, doctrine changes cost** — and it ended
in five numbered next-steps. Four of them shipped, as commits `d4bad4ff` and
`de1de1a8`. This is the measurement those four are settled against.

**The surgery worked.** Against the wave it answers it recovers four verdicts and
removes two thirds of the bill and two thirds of the clock. Against the baseline
it is 40 % cheaper and 33 % faster for one verdict fewer, and the one verdict is
not a patch the harness got wrong.

| | r90 baseline | r91 | **r92** | r92 vs r90 | r92 vs r91 |
| --- | ---: | ---: | ---: | ---: | ---: |
| **resolved** | **35/45** | **30/45** | **34/45** | **−1** | **+4** |
| **total agent cost** | **$37.84** | **$60.24** | **$22.78** | **−$15.06 (−40 %)** | **−$37.46 (−62 %)** |
| **total agent wall** | **15,877 s** | **29,799 s** | **10,568 s** | **−5,309 s (−33 %)** | **−19,231 s (−65 %)** |
| instance wall | 17,106 s | 31,603 s | 11,423 s | −5,683 s | −20,180 s |
| frames | 452 | 527 | 291 | −161 (−36 %) | −236 (−45 %) |
| output tokens | 961,461 | 1,618,230 | 510,962 | −450,499 (−47 %) | −1,107,268 (−68 %) |
| input tokens | 3,859,603 | 5,828,750 | 2,899,858 | −959,745 (−25 %) | −2,928,892 (−50 %) |
| cache rate | 59.3 % | 69.8 % | 60.6 % | +1.3 pp | −9.2 pp |

Cost is every attempt, which is what the invoice says. Wall clock is the
journal's own span across the agent's frames, summed per instance — not the wall
clock of the run as a whole, which was 1 h 47 m at three in flight and depends on
concurrency rather than on a harness.

31 of 45 instances got cheaper than the baseline, 13 dearer, 1 unchanged. 32 of
45 got faster. Against r91 the numbers are not close: **42 of 45 cheaper, 43 of
45 faster.**

## The program's success criteria

`analysis/PROGRAM.md` §3's targets, unchanged.

| criterion | target | r90 | r91 | r92 | met |
| --- | ---: | ---: | ---: | ---: | :---: |
| resolved | ≥ 33 | 35 | 30 | **34** | **yes** |
| total cost | ≤ $15.00 | $37.84 | $60.24 | $22.78 | NO |
| instance wall | ≤ 120 min | 285.1 min | 526.7 min | 190.4 min | NO |
| no instance over $1.00 | 0 | 11 | 27 | 5 | NO |
| no instance over 20 frames | 0 | 5 | 6 | 1 | NO |
| no verdict lost | 0 | — | 7 | 3 | NO |

The resolved criterion is met for the first time. The other five are missed by
less than any previous wave missed them, and every one of them moved the right
way.

## Preconditions

| | |
| --- | --- |
| subject stamp | `sha256:c9e4166913e167ee6cd76ac293d621e02843833c1736d62b5ed770e1a1e7e45c` |
| git HEAD at the pin | `de1de1a82d5850c385f282a858cc4360ca1f233c` |
| HEAD subject | 🔧 fix(harness,cli,std,swebench): make the revert surgical, and test the paths the surgery could have broken |
| `CellTurn.ts` | `sha256:9ede759dd3389cfe1f5b46faad73a1fce8248ccef4c7b0e28613ac8615b6ad23` |
| `packages/cli/dist/esm` | `sha256:5174c88e26e02fc09332d08c92b63ec0009399379e9bd2a7048543b527a24cbb` |
| `packages/cli/src` | `sha256:492f7de692d811840d24c82a745f9100adde1982a0c1aa0a498f510f48a0b612` |
| `@smthrs/harness` src | `sha256:9dd2fed58dac3ba03276148ead43bcac712feb8954d6bce31ad60d25c7d5e328` |
| `@smthrs/std` src | `sha256:7d8cadd8b693ca7e959a8dea97f2fd4701be73ebd31350fedb0fadc39dc8be53` |
| `@smthrs/agent` src | `sha256:22115e56b39e8baa10f5b95f332aa50c0e4b4f452867da2cc9d205a0e77295d5` |
| `@smthrs/model` src | `sha256:1c49c1ea0d8024b9aa5f446c69dabc00cf15a43633d096e92f01b0fbb4552d38` |
| preflight refusals | none |
| node | v24.18.0 darwin-arm64 |
| seat | `openai:gpt-5.6-sol` |
| attempts | one per instance |
| per-instance budget | 1200 s |
| in flight | 3 |
| disk gate | 8192 MiB; never blocked, no wait rows (lowest reading 26.6 GiB free) |
| grading | official evaluator, x86_64 images, run id `rerun-r92` |
| budget gate | $75; never reached, the wave finished at $22.78 |
| agreement | every instance ran the pinned subject |

`CellTurn.ts` hashes the same as r91's, which is correct: the surgery is in
`cellPrompt.ts`, `Bash.ts`, `NodeControl.ts` and `FlowEngineLike.ts`, and the
loop itself did not move.

## Disclosures

- **`run-45.sh` hard-coded `r91`.** It spelled the lane into its ledger
  directory, its artifact index and its evaluator run id as three separate
  defaults, so a second measurement of the same population would have appended
  to the first ledger. It now takes `--lane`, which derives all three together
  and refuses a name a path component and an evaluator run id cannot both hold;
  the default stays `r91`, so an unnamed invocation resumes the first re-run
  rather than starting a nameless sixth. The header row records the lane. This
  wave ran `./run-45.sh --lane r92`.
- **The rig changed during the wave, and the subject did not.** The lane flag and
  three new evidence readers landed as commit `1dd96b12` at 08:2xZ, while
  instances were in flight. `evals/` is not part of the pinned subject —
  `lib/subject.mjs` fingerprints the `@smthrs/*` closure the CLI loads — and the
  pin check was re-run after the commit and passed. No instance measured a
  different harness. The ledger header names `de1de1a8`, the commit the subject
  was pinned at.
- **One index repair before the pin could be taken**, the same class r91
  disclosed. Two paths — `fullbench/reports/rerun-r91.md` and
  `packages/std/test/TestRunFixture.test.ts` — had been dropped from the shared
  jj-colocated index while still on disk byte-identical to `HEAD`, and
  `lib/subject.mjs` reads such a path as a modification. Each was compared
  against its `HEAD` blob, found identical, and its index entry restored. No file
  content changed.
- **The budget gate was raised from $60 to $75.** r91 finished at $60.24 against
  a $60 ceiling and was not truncated only because the gate is read before each
  launch. The gate is an operator control and not a measurement parameter, so it
  was set where it could not truncate this wave. It was never reached.
- **Two instances exhausted their transport retry ladder and were re-run once**,
  as infrastructure crashes rather than measurements. `django__django-13128` and
  `pydata__xarray-7229` each took five `transport` retries — backing off
  1,135 / 2,033 / 4,467 / 6,684 / 14,337 ms and 819 / 2,062 / 3,977 / 8,755 /
  17,069 ms — and then failed the cell frame. The crashed journals and patches
  are preserved under `fullbench/rerun-r92/journals-crashed/`; both attempts'
  dollars are counted in the totals above. On the re-run `13128` resolved and
  `7229` finished unresolved, which is the verdict both earlier waves also gave
  it. This is the same failure class r91 lost two instances to outright — the
  difference is that a ladder now runs before the run ends, and this time the
  socket stayed dead through all five rungs.
- **The two `psf/requests` verdicts are statements about the grading
  environment.** `httpbin.org` was unhealthy when the wave graded them, so
  `lib/httpbin.sh` served the documented local fallback, which cannot answer
  `test_mixed_case_scheme_acceptable` over https — the file says so in those
  words. `psf__requests-1766` failed exactly that one `PASS_TO_PASS` test and
  every one of its six `FAIL_TO_PASS` tests passed; its patch is **byte-identical
  to r90's and r91's**, both of which graded `resolved`. A re-grade against the
  public service found that service degraded too (22 of 133 `PASS_TO_PASS` and 5
  of 8 `FAIL_TO_PASS` refused on `2317`), so both verdicts stand as `unresolved`
  and both carry a `regrade` row naming the reason. A `note` row in the ledger
  records the whole finding.
- One `call_timeout` retry fired, on `django__django-13821`. It cost a backoff
  and no verdict.
- **No instance recorded an empty patch**, against 1 in r90 and 5 in r91.

## What the four surgical changes did

Read off the 45 journals by `lib/surgery-evidence.mjs`, which counts
`control.agent.*` events and nothing else. The r90 and r91 columns are the same
reader over those waves' own journals, so the three columns are one rule applied
three times rather than three reports quoted at each other.

| # | next-step | shipped | acted | the number that says so |
| --- | --- | :---: | :---: | --- |
| 1 | bind `StandardFlows.tests` | yes | **yes** | **2 `test` calls, both `against: "base"`**, against **0 in 45 journals** in r91 |
| 2 | state the project interpreter | yes | **yes, decisively** | the taught path used in **45 of 45** instances; interpreter hunting **27 instances → 1**; `ModuleNotFoundError`-class results **172 → 19** |
| 3 | make rule 8's reproduction conditional | yes | **yes, decisively** | empty patches **5 → 0**; instances at the 1200 s budget **11 → 1**; the four doctrine-taxed instances all back at or below r90 |
| 5 | retry the transport | yes | **yes, and it was not enough** | **10 `transport` retries** on two instances, against **0** in both earlier waves; both ladders were exhausted anyway |

Next-step 4 — re-measure the tool changes alone with the doctrine reverted — is
what this wave is.

### 1. The `test` flow exists now

r91's finding was not that the flow was wrong; it was that no composition offered
it, so its own changelog rule applied: *a tool no production composition offers
is a tool that does not exist.* `packages/cli/src/NodeControl.ts` now declares a
runner from `FLOWS_TEST_COMMAND` and its companions and binds `test` exactly when
it can say how the repository runs its tests, and `run-instance.sh` exports the
declaration it already computed.

Two calls landed, in `pytest-dev__pytest-6197` and `sphinx-doc__sphinx-8721`, and
both asked for the pristine-base comparison. Two is a small number, and it is the
honest one: the doctrine that made a baseline mandatory went back to r90's text
in the same commit, so nothing now compels the call. What two proves is the thing
r91 could not distinguish — the flow is bound, reachable and answers. The binding
itself is proved separately and without a wave, by
`packages/cli/test/NodeComposition.test.ts`, which resolves the composition's
bindings and reads the name back.

### 2. The interpreter fact is used, and the hunt is gone

r91's single largest regression mechanism was that `interpreter: "python3"`
bypassed the image's login shell and reached a Python the repository's
dependencies are not installed against. Two things shipped: `bash` routes every
containerised invocation through a login shell, and `lib/interpreter.sh` reads
`sys.executable` off the container at setup so both prompt writers can state the
same fact, byte for byte.

| | r90 | r91 | r92 |
| --- | ---: | ---: | ---: |
| `bash` calls | 587 | 596 | **349** |
| passing an absolute interpreter path | 0 | 130 | **218** |
| passing the path the harness stated | n/a | n/a | **229 calls, 45 of 45 instances** |
| passing a bare `python`/`python3` | 0 | 227 | **8** |
| calls hunting for an interpreter | 0 | 47 | **1** |
| frames spent hunting | 0 | 46 | **1** |
| instances that hunted | 0 | 27 | **1** |
| results carrying `ModuleNotFoundError` or its family | 25 | 172 | **19** |
| probes the flow itself refused (`invalidProbe`) | 5 | 163 | **3** |

r90 shows zero hunting because it typed `docker exec … bash -lc`, and a login
shell activated the image's environment for free. r92 shows near-zero hunting for
a different reason: the fact is in the preamble of all 45 prompts, and the shell
is a login shell again. The one remaining hunt is a single call in
`sphinx-doc__sphinx-7590`.

`invalidProbe` falling from 163 to 3 is the same mechanism seen from the flow's
side. A probe that cannot import the project is a probe about the environment,
and there is almost no such probe left to flag.

### 3. The doctrine tax is gone

r91's rule 8 made a valid pre-edit reproduction a precondition of writing, and
five instances spent a whole 1200 s budget holding a correct diagnosis they were
not allowed to act on. The doctrine went back to r90's text with one deliberate
deviation: rule 8 now carries `PROGRAM.md` §5.5's conditional form, where a
failing baseline is what buys a same-cell complete rather than what permits an
edit.

The four instances the r91 report named as doctrine-taxed:

| instance | frames r90 → r91 → r92 | $ r90 → r91 → r92 | agent s r90 → r91 → r92 |
| --- | --- | --- | --- |
| django__django-13343 | 2 → 18 → **2** | $0.13 → $2.08 → **$0.13** | 48 → 1156 → **40** |
| django__django-11815 | 3 → 21 → **3** | $0.24 → $1.92 → **$0.19** | 90 → 829 → **62** |
| sympy__sympy-13372 | 3 → 11 → **2** | $0.16 → $1.21 → **$0.12** | 45 → 614 → **39** |
| pytest-dev__pytest-6197 | 5 → 20 → **6** | $0.54 → $2.35 → **$0.41** | 242 → 1030 → **148** |

All four are back at or below their baseline on every column. `13343` is exact:
two frames, forty seconds, thirteen cents.

The whole-wave shape moved with them.

| | r90 | r91 | r92 |
| --- | ---: | ---: | ---: |
| instances whose instance wall reached 1,150 s of the 1,200 s budget | 2 | 11 | **1** |
| empty patches | 1 | 5 | **0** |
| dead frames (no transition applied) | 30 | 21 | **4** |
| zero-call frames | 75 | 81 | **42** |
| read-only demands fired | 6 | 14 | **0** |
| cells rejected in-frame for a parse error | n/a | 85 | **0** |
| mean cell size | 2,972 B | 3,687 B | **2,631 B** |
| output tokens per frame | 2,127 | 3,071 | **1,756** |

The in-frame re-ask is still in the harness and fired zero times. r91 paid for it
85 times because change #10 asked for one long cell doing
locate → read → probe → edit → verify, and long cells fail to parse. Shorter
cells parse, so the mechanism that was catching the failures has nothing to
catch. That is what a mechanism looks like when the thing it was compensating for
is removed rather than compensated harder.

### The tool half held

r91's other finding was that every instance whose r90 diagnosis was a tool
failure got cheaper. Those instances did not regress when the doctrine was
reverted; most got cheaper again.

| | r90 | r91 | r92 |
| --- | ---: | ---: | ---: |
| failed mutations | 11 | 4 | **3** |
| frames holding a failed call | 21 | 8 | **7** |
| of those, recovered in-cell | 4 (19 %) | 7 (88 %) | **7 (100 %)** |

`matplotlib-22865` is the clearest single case: 36 → 10 → **4** frames and
$2.65 → $1.43 → **$0.20**. `django-16899` went 20 → 20 → **3** frames and
$1.83 → $2.58 → **$0.21**. `sphinx-7590` went 39 → 23 → **11** frames and
$2.93 → $2.45 → **$0.88**, still on a wrong patch.

`recall` is the one lane mechanic that did not carry over: 121 ordinals over 47
transitions in r91, 23 over 12 here. The teaching that drove it went back to r90
with the rest of change #10. `render` did carry: 678 keys over 228 transitions against r90's 1,103 over
372 and r91's 914 over 451, which is the state manifest doing its job in a wave
that is a third shorter than either.

### 5. The transport ladder fired, and was not enough

`Stream.runCollect` succeeds on a truncated body: the deltas that arrived are
returned and only the settlement is missing, so the controller used to raise a
`HarnessError` no retry classification ever saw. r91 lost two instances to one
dropped HTTP/2 session with no backoff at all.

The class is now `transport` and rides the same jittered ladder every other
socket failure does. It fired: **10 `transport` retries**, against zero in both
earlier waves, where the count is zero by construction because the classification
did not exist. Both instances that hit it exhausted all five rungs and failed
anyway — roughly 28 s and 32 s of backoff against a socket that stayed dead. So
the change is real and it is not sufficient: it converts an instant loss into a
half-minute of retrying and then the same loss.

## Prompt bytes in the wild

The taught prefix is one segment, rendered into every frame's request and paid
once at full price and then at cache rates.

| | r90 | r91 | r92 |
| --- | ---: | ---: | ---: |
| cell contract | 8,197 chars / 2,105 est tokens | 11,312 chars | **9,193 chars / 2,352 est tokens** |
| environment section | — | — | 902 chars / 230 est tokens |
| flow catalog (this run's shape) | — | — | 83 chars / 21 est tokens |
| all rendered sections | — | — | **10,178 chars / 2,604 est tokens** |

r92's row is rendered from the pinned subject by `CellPrompt.make`. The r90 and
r91 rows are the sizes `packages/harness/test/CellPrompt.test.ts` records for
those texts; rendering them here would mean checking an older `cellPrompt.ts`
into `packages/`, which would move the pinned subject and stop the wave.

The contract's ceiling is a unit test, set at 2,400 estimated tokens: r90's own
budget plus the lane mechanics measured to pay — the `.ok` failure envelope,
`render`/`recall` and the state manifest, raw read content, the hunk an `edit`
answers with, and the in-frame re-ask. Not one token of the doctrine that was
priced and rejected.

The task prompt is not a constant, so the only honest measurement of it is to
render what each instance was actually given. `lib/prompt-bytes.sh` does that,
reading each instance's interpreter back out of this wave's own driver log rather
than re-measuring it today.

| | r92 |
| --- | ---: |
| instances told a project interpreter | **45 of 45** |
| mean task prompt | 4,887 bytes |
| smallest / largest | 3,594 B (`astropy__astropy-7166`) / 11,985 B (`django__django-14351`) |
| total across the wave | 219,933 bytes |
| what the interpreter bullet costs | 260 bytes |

Every one of the 45 images answered
`/opt/miniconda3/envs/testbed/bin/python`. The fact the whole of §2 turns on is
260 bytes, stated once per run, and it replaced 138 cells across 30 instances in
r91.

What the wire actually saw, summed over the wave: 2,899,858 input tokens at
60.6 % cached, 510,962 output tokens, 1,756 output tokens per frame across 291
frames. r91 spent 5.83 M input and 1.62 M output on the same 45 instances at a
better cache rate, which is the whole lesson about cache rates: a better rate on
twice the input is still twice the money.

## Verdicts that moved

**Recovered (6)** — the baseline resolved it, r91 did not, r92 does:
`django__django-11299`, `django__django-13343`, `django__django-15987`,
`pydata__xarray-7393`, `sympy__sympy-13878`, `sympy__sympy-20154`.

Five of those six were r91's probe-bootstrap spiral, and all five now finish. The
sixth, `20154`, is the instance change #5 was written for; it completes in 3
frames and $0.18 against r90's 2 frames and $0.95.

**Gained over the baseline (2):** `django__django-13821` and
`pydata__xarray-7233`.

`13821` is r91's one clean verdict win and it holds. `7233` is new: unresolved in
r90 at 3 frames, unresolved in r91 after 25 frames and $2.68, resolved here in 5
frames and $0.24.

**Still lost against the baseline (3):**

| instance | r90 | r91 | r92 | why |
| --- | --- | --- | --- | --- |
| django__django-14351 | resolved | unresolved | unresolved | a real regression, and much cheaper than it was: 34 → 25 → 14 frames, $2.77 → $2.54 → $1.13 |
| psf__requests-1766 | resolved | resolved | unresolved | grading environment; the patch is byte-identical to both earlier waves' |
| psf__requests-2317 | resolved | resolved | unresolved | grading environment; see the disclosure |

**One instance is lost against r91 but not against the baseline:**
`astropy__astropy-14369`, which r90 also failed. r91's minimal-edit discipline
won it in 5 frames; reverting that doctrine gave it back, at 8 frames and $0.67.
It is the one place in this wave where a doctrine change is worth its price, and
it is worth exactly one verdict for the $22 and five verdicts the same doctrine
cost elsewhere.

`django__django-14351` is the wave's only unexplained loss, and it is the row the
next report has to answer for.

## The superset goal

`compare-arms.mjs` over this ledger and the codex backfill's:

| | count |
| --- | ---: |
| both resolved | 34 |
| **flows only** | **0** |
| **codex only** | **6** |
| neither | 5 |

flows 34/45 (76 %), codex 40/45 (89 %), both arms graded on all 45.

**The standing superset goal still fails.** The codex-only six are
`pydata__xarray-7229`, `sphinx-doc__sphinx-7590`, `django__django-12273`,
`sympy__sympy-19495`, `psf__requests-1766` and `psf__requests-2317`.

Two of those six are the `psf/requests` pair, whose flows verdicts this wave
records as grading-environment statements and whose codex verdicts were produced
by a backfill graded when `httpbin.org` was healthy. Those two rows are not
like-for-like today and should not be read as harness differences in either
direction. On the four that are — `7229`, `7590`, `12273`, `19495` — the set is
unchanged from r91, and every one of them is now markedly cheaper: `7229`
$2.01 → $1.47, `7590` $2.93 → $0.88, `12273` $0.77 → $0.48, `19495`
$0.54 → $0.43. They are the same four wrong answers, arrived at faster.

Also unchanged: `sphinx-7590`'s codex resolve rests on fetching the project's
later 3.x history, which §6-R2 rejects, so that instance is not a scoreboard row
either.

## Per instance

Frames and dollars are each wave's own ledger. `frames` and `agent s` read
r90 → r91 → r92.

| instance | r90 | r91 | r92 | $ r90 | $ r91 | $ r92 | Δ$ vs r90 | frames | agent s |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| astropy__astropy-14365 | unresolved | unresolved | unresolved | $0.43 | $1.01 | $1.00 | +0.57 | 4 → 8 → 11 | 334 → 470 → 448 |
| astropy__astropy-14369 | unresolved | resolved | unresolved | $0.64 | $0.52 | $0.67 | +0.03 | 8 → 5 → 8 | 245 → 354 → 285 |
| astropy__astropy-7166 | resolved | resolved | resolved | $0.33 | $0.33 | $0.13 | −0.19 | 5 → 2 → 2 | 118 → 130 → 58 |
| astropy__astropy-8707 | resolved | resolved | resolved | $1.12 | $0.99 | $0.29 | −0.82 | 15 → 14 → 6 | 428 → 421 → 99 |
| django__django-10914 | resolved | resolved | resolved | $0.97 | $0.41 | $0.22 | −0.75 | 15 → 6 → 4 | 449 → 216 → 92 |
| django__django-11299 **recovered** | resolved | empty patch | resolved | $0.94 | $1.96 | $0.73 | −0.21 | 11 → 14 → 10 | 376 → 1155 → 312 |
| django__django-11490 | resolved | resolved | resolved | $1.00 | $1.96 | $0.20 | −0.80 | 13 → 17 → 3 | 408 → 1174 → 73 |
| django__django-11815 | resolved | resolved | resolved | $0.24 | $1.92 | $0.19 | −0.05 | 3 → 21 → 3 | 90 → 829 → 62 |
| django__django-12273 | unresolved | unresolved | unresolved | $0.77 | $0.98 | $0.48 | −0.29 | 8 → 7 → 6 | 338 → 487 → 242 |
| django__django-12741 | resolved | resolved | resolved | $0.82 | $0.44 | $0.21 | −0.61 | 9 → 3 → 3 | 372 → 213 → 83 |
| django__django-13128 | resolved | resolved | resolved | $0.75 | $1.77 | $0.38 | −0.37 | 8 → 13 → 3 | 323 → 970 → 99 |
| django__django-13212 | unresolved | unresolved | unresolved | $0.71 | $1.45 | $1.24 | +0.53 | 6 → 10 → 13 | 260 → 917 → 619 |
| django__django-13343 **recovered** | resolved | empty patch | resolved | $0.13 | $2.08 | $0.13 | −0.00 | 2 → 18 → 2 | 48 → 1156 → 40 |
| django__django-13346 | resolved | resolved | resolved | $2.36 | $1.00 | $0.79 | −1.57 | 29 → 10 → 11 | 934 → 431 → 324 |
| django__django-13406 | resolved | resolved | resolved | $0.30 | $0.54 | $0.26 | −0.04 | 3 → 4 → 3 | 116 → 314 → 114 |
| django__django-13821 **gained** | unresolved | resolved | resolved | $1.03 | $1.53 | $1.47 | +0.44 | 11 → 12 → 16 | 433 → 875 → 957 |
| django__django-14351 **lost** | resolved | unresolved | unresolved | $2.77 | $2.54 | $1.13 | −1.64 | 34 → 25 → 14 | 1086 → 1141 → 448 |
| django__django-15380 | resolved | resolved | resolved | $0.60 | $0.99 | $0.30 | −0.30 | 9 → 11 → 3 | 232 → 528 → 134 |
| django__django-15569 | resolved | resolved | resolved | $0.25 | $0.54 | $0.35 | +0.10 | 3 → 5 → 4 | 88 → 244 → 139 |
| django__django-15732 | resolved | resolved | resolved | $0.58 | $2.06 | $0.83 | +0.26 | 9 → 20 → 9 | 214 → 1158 → 371 |
| django__django-15987 **recovered** | resolved | empty patch | resolved | $0.45 | $1.99 | $0.16 | −0.29 | 4 → 19 → 3 | 175 → 1119 → 67 |
| django__django-16612 | resolved | resolved | resolved | $0.25 | $0.29 | $0.39 | +0.14 | 3 → 2 → 5 | 93 → 107 → 147 |
| django__django-16662 | resolved | resolved | resolved | $0.57 | $1.06 | $0.30 | −0.27 | 7 → 8 → 6 | 234 → 466 → 160 |
| django__django-16899 | resolved | resolved | resolved | $1.83 | $2.58 | $0.21 | −1.63 | 20 → 20 → 3 | 888 → 1195 → 73 |
| django__django-16901 | resolved | resolved | resolved | $0.90 | $1.18 | $0.48 | −0.42 | 6 → 11 → 7 | 390 → 516 → 317 |
| matplotlib__matplotlib-20826 | resolved | resolved | resolved | $0.52 | $0.93 | $0.48 | −0.04 | 5 → 9 → 4 | 241 → 387 → 214 |
| matplotlib__matplotlib-20859 | resolved | resolved | resolved | $0.17 | $1.18 | $0.27 | +0.10 | 2 → 5 → 3 | 56 → 461 → 105 |
| matplotlib__matplotlib-22865 | resolved | resolved | resolved | $2.65 | $1.43 | $0.20 | −2.45 | 36 → 10 → 4 | 1164 → 742 → 70 |
| matplotlib__matplotlib-24970 | resolved | resolved | resolved | $0.48 | $0.45 | $0.30 | −0.18 | 8 → 3 → 4 | 282 → 237 → 153 |
| psf__requests-1766 **lost** | resolved | resolved | unresolved | $0.14 | $0.41 | $0.24 | +0.11 | 3 → 4 → 4 | 52 → 212 → 133 |
| psf__requests-2317 **lost** | resolved | resolved | unresolved | $0.33 | $0.66 | $0.42 | +0.09 | 4 → 5 → 7 | 118 → 555 → 321 |
| pydata__xarray-7229 | unresolved | unresolved | unresolved | $2.01 | $1.19 | $1.47 | −0.54 | 20 → 9 → 9 | 839 → 562 → 323 |
| pydata__xarray-7233 **gained** | unresolved | unresolved | resolved | $0.12 | $2.68 | $0.24 | +0.13 | 3 → 25 → 5 | 29 → 1192 → 79 |
| pydata__xarray-7393 **recovered** | resolved | empty patch | resolved | $0.59 | $3.13 | $0.80 | +0.20 | 9 → 22 → 12 | 224 → 1191 → 285 |
| pytest-dev__pytest-6197 | resolved | resolved | resolved | $0.54 | $2.35 | $0.41 | −0.13 | 5 → 20 → 6 | 242 → 1030 → 148 |
| sphinx-doc__sphinx-11445 | resolved | resolved | resolved | $0.16 | $0.97 | $0.45 | +0.29 | 3 → 8 → 7 | 56 → 410 → 158 |
| sphinx-doc__sphinx-7590 | empty patch | unresolved | unresolved | $2.93 | $2.45 | $0.88 | −2.05 | 39 → 23 → 11 | 1128 → 1131 → 886 |
| sphinx-doc__sphinx-7757 | resolved | resolved | resolved | $0.30 | $1.51 | $0.20 | −0.10 | 5 → 12 → 4 | 109 → 624 → 64 |
| sphinx-doc__sphinx-8721 | resolved | resolved | resolved | $1.66 | $1.46 | $0.70 | −0.96 | 19 → 15 → 9 | 692 → 662 → 283 |
| sympy__sympy-13372 | resolved | resolved | resolved | $0.16 | $1.21 | $0.12 | −0.04 | 3 → 11 → 2 | 45 → 614 → 39 |
| sympy__sympy-13878 **recovered** | resolved | empty patch | resolved | $2.22 | $2.17 | $1.98 | −0.24 | 24 → 21 → 24 | 1131 → 1155 → 1113 |
| sympy__sympy-16450 | resolved | resolved | resolved | $0.17 | $0.45 | $0.12 | −0.05 | 3 → 5 → 2 | 58 → 317 → 41 |
| sympy__sympy-18763 | unresolved | unresolved | unresolved | $0.45 | $1.45 | $0.33 | −0.11 | 5 → 16 → 6 | 182 → 730 → 143 |
| sympy__sympy-19495 | unresolved | unresolved | unresolved | $0.54 | $1.33 | $0.43 | −0.11 | 9 → 15 → 7 | 226 → 587 → 184 |
| sympy__sympy-20154 **recovered** | resolved | unresolved | resolved | $0.95 | $0.72 | $0.18 | −0.77 | 2 → 4 → 3 | 331 → 414 → 63 |

## What this settles, and what it does not

**Settled: the r91 split was real, and it was the doctrine.** Reverting the
verification doctrine and the transactional-cell teaching to the text that scored
35/45, while keeping every lane mechanic r91 measured to pay, recovers four of
the five verdicts and returns $37 and 19,000 seconds. Nothing about that required
telling the agent anything.

**Settled: a fact the harness knows is worth more than a rule about finding it.**
The interpreter is 260 bytes stated once. It removed 45 hunting frames, 153
`ModuleNotFoundError` results and 160 refused probes, and it is the single
largest contributor to this wave's shape. r91 spent 3,115 characters of contract
growth on teaching and lost five verdicts; r92 spent 260 bytes of fact and got
four back.

**Not settled: whether the doctrine is worth anything at all.**
`astropy__astropy-14369` says one rule of it was worth one verdict. This wave
cannot price that rule on its own, because it was reverted with the rest.

**Not settled: `django__django-14351`.** It is the one baseline verdict lost to
something other than the grading environment, and neither r91 nor this wave has
diagnosed it. It is now 14 frames and $1.13 instead of 34 and $2.77, so it is a
cheaper wrong answer, which is not the same as progress.

**Not settled: the superset goal.** Codex-only is 6 and flows-only is 0. Two of
the six are grading artefacts and four are the same four wrong answers r91 had,
reached at roughly half the cost.

### What to do next, in order

1. **Diagnose `django__django-14351`.** It is the only unexplained regression
   against the baseline, it has survived two waves, and it is the row every
   future report will have to keep repeating until somebody reads its trace.
2. **Give the transport ladder somewhere to go after its last rung.** It fired
   ten times, was exhausted twice, and both runs died. A frame that has already
   produced calls should be resumable across a dead socket rather than losing the
   run; failing that, the ladder's ceiling is the wrong shape for a socket that
   stays dead for half a minute.
3. **Pin the `psf/requests` grading, or stop counting those two instances.**
   Three waves have now produced three different verdicts for one byte-identical
   patch, decided entirely by whether `httpbin.org` was answering. That is not a
   measurement. Either the fallback grows an https listener the graded container
   trusts, or the two instances are excluded from the scoreboard by name and the
   denominator says 43.
4. **Re-measure change #2(f) alone**, the minimal-edit rule, against this wave.
   It is the only piece of the reverted doctrine with a verdict to its name, and
   it is one rule rather than four.
5. **Take the cost win to the rest of the sample.** $22.78 for 45 instances is
   40 % under the baseline and 62 % under r91, at one fewer verdict than the
   baseline and four more than r91. The standing goal is cheaper *and* faster at
   the same or more resolved; this is cheaper and faster at one fewer, and the
   gap is a single instance and two grading rows.

## Reproducing this

```sh
./preflight.sh                                          # pins the subject
./run-45.sh --lane r92                                  # the wave itself

node compare-runs.mjs --rerun fullbench/rerun-r92/manifest.jsonl \
  --out fullbench/rerun-r92                             # against the baseline
node compare-runs.mjs --baseline fullbench/rerun-r91/manifest.jsonl \
  --rerun fullbench/rerun-r92/manifest.jsonl \
  --out fullbench/rerun-r92/vs-r91                      # against r91
node three-way.mjs --baseline fullbench/manifest.jsonl \
  --first fullbench/rerun-r91/manifest.jsonl \
  --second fullbench/rerun-r92/manifest.jsonl \
  --out fullbench/rerun-r92/vs \
  --baseline-name r90 --first-name r91 --second-name r92

node lib/program-evidence.mjs fullbench/rerun-r92/journals
node lib/surgery-evidence.mjs fullbench/rerun-r92/journals \
  --interpreters fullbench/rerun-r92/driver.log
node lib/surgery-evidence.mjs fullbench/rerun-r92/journals-crashed \
  --interpreters fullbench/rerun-r92/driver.log       # the two transport crashes
lib/prompt-bytes.sh fullbench/rerun-r92/driver.log
node compare-arms.mjs --manifest fullbench/rerun-r92/manifest.jsonl \
  --codex-manifest fullbench/codex-manifest.jsonl --out fullbench/rerun-r92
```

Every reader takes its numbers off `control.agent.*` events or off a ledger — no
clock, no network, no re-derivation. `three-way.mjs`, `lib/surgery-evidence.mjs`
and `lib/prompt-bytes.sh` are each pinned against synthesised inputs by
`fixtures/check-three-way.mjs`, `fixtures/check-surgery-evidence.mjs` and
`fixtures/check-prompt-bytes.mjs`, all inside `./verify.sh`.

Artifacts: `fullbench/rerun-r92/manifest.jsonl` (the ledger),
`fullbench/rerun-r92/compare.{md,json}` (against the baseline),
`fullbench/rerun-r92/vs-r91/compare.{md,json}` (against r91),
`fullbench/rerun-r92/vs/three-way.{md,json}` (all three),
`fullbench/rerun-r92/arms.{md,json}` (against codex),
`fullbench/rerun-r92/journals/` (45 journals),
`fullbench/rerun-r92/journals-crashed/` (the two transport crashes, preserved),
`fullbench/rerun-r92/patches/` (45 patches),
`fullbench/rerun-r92/logs/` (per-instance run and grade logs),
`fullbench/rerun-r92/driver.log`.
