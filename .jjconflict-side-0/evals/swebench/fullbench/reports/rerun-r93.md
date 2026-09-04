# The third re-run: fullbench 45 on the post-review harness (r93)

Measured 2026-08-22, 12:03Z to 14:08Z. The same 45 instances, the same seeded
draw order, read out of the r90 baseline ledger.

`fullbench/reports/rerun-r92.md` ended in a ranked list of five next-steps. Four
of them shipped, as commits `c3a5e2970`, `9f357f51e`, `22bf30632`, `b4f255b6a`,
`46abbe405` and `59e9f013e`. This is the measurement those four are settled
against.

**Three of the four acted, and the wave is worse.** The one unexplained
regression the list opened with is fixed: `django__django-14351` resolves, and
it is now the only instance in the population that flows resolves and codex does
not. Everything else moved the wrong way. Against r92 this wave loses three
verdicts, adds $9.48 and adds 3,718 seconds; against the baseline it is two
verdicts down for a 15 % saving. The mechanism is the same one r91 measured and
r92 removed: **two rules of doctrine went back into the contract, and the agent
spent the difference.**

| | r90 baseline | r91 | r92 | **r93** | r93 vs r90 | r93 vs r92 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **resolved (scored, 43)** | **33/43** | **28/43** | **34/43** | **31/43** | **−2** | **−3** |
| resolved (raw, 45) | 35/45 | 30/45 | 34/45 | 31/45 | −4 | −3 |
| **total cost (scored)** | **$37.37** | **$59.17** | **$22.11** | **$31.59** | **−$5.77 (−15 %)** | **+$9.48 (+43 %)** |
| total cost (raw) | $37.84 | $60.24 | $22.78 | $32.25 | −$5.59 | +$9.47 |
| **total agent wall (scored)** | **15,707 s** | **29,032 s** | **10,114 s** | **13,832 s** | **−1,875 s (−12 %)** | **+3,718 s (+37 %)** |
| instance wall (scored) | 16,860 s | 30,817 s | 10,949 s | 14,726 s | −2,134 s | +3,777 s |
| frames (scored) | 445 | 518 | 280 | 397 | −48 | +117 (+42 %) |
| frames (raw) | 452 | 527 | 291 | 406 | −46 | +115 |
| output tokens (raw) | 961,461 | 1,618,230 | 510,962 | 763,417 | −198,044 | +252,455 (+49 %) |
| input tokens (raw) | 3,859,603 | 5,828,750 | 2,899,858 | 4,240,394 | +380,791 | +1,340,536 (+46 %) |
| cache rate | 59.3 % | 69.8 % | 60.6 % | 62.1 % | +2.8 pp | +1.5 pp |

Both denominators are printed on every row a name can reach, because
`lib/excluded.mjs` names two: `psf__requests-1766` and `psf__requests-2317` are
outside every rate, for **both arms**, with the cause on record. That is r92's
next-step 3, and it is the one change in this round that cost nothing and
settled something — see "The exclusion" below.

Cost is every attempt, which is what the invoice says. Wall clock is the
journal's own span across the agent's frames, summed per instance — not the wall
clock of the run as a whole, which was 2 h 5 m at three in flight and depends on
concurrency rather than on a harness.

17 of 45 instances got cheaper than r92, 28 dearer. 16 got faster, 29 slower.
Against the baseline it is closer: 25 cheaper, 20 dearer; 23 faster, 22 slower.

## The program's success criteria

`analysis/PROGRAM.md` §3's targets, unchanged, answered over the scored 43.

| criterion | target | r90 | r91 | r92 | r93 | met |
| --- | ---: | ---: | ---: | ---: | ---: | :---: |
| resolved | ≥ 33 | 33 | 28 | **34** | 31 | NO |
| total cost | ≤ $15.00 | $37.37 | $59.17 | $22.11 | $31.59 | NO |
| instance wall | ≤ 120 min | 281.0 min | 513.6 min | 182.5 min | 245.4 min | NO |
| no instance over $1.00 | 0 | 11 | 27 | 5 | 7 | NO |
| no instance over 20 frames | 0 | 5 | 6 | 1 | 4 | NO |
| no verdict lost | 0 | — | 7 | 3 | 4 | NO |

Every criterion r92 improved, this wave gave back part of. The resolved
criterion was met once, in r92, and is not met here.

## Preconditions

| | |
| --- | --- |
| subject stamp | `sha256:8b72998dfa82754fa1cfe264d039b7d0e832808098578b711a16d42bc0f71c36` |
| git HEAD at the pin | `59e9f013e1e7fc6ce70beb94f9f084c9aef15037` |
| HEAD subject | 🔧 fix(swebench): make the fourth scoreboard obey the exclusion it was written for |
| `CellTurn.ts` | `sha256:768c3c0d000a2d9defbeb8d08a492ab2b5326acf35f874291911441e554cd767` |
| `packages/cli/dist/esm` | `sha256:c7fcfcecc2376bfeb866063ae7c1002fb89472145951bb63b3cea35638b3eee4` |
| `packages/cli/src` | `sha256:c1571b2e2909f7c30bb07239aed41dcf0fa9218d9df7dcb6580256b092caa533` |
| `@smthrs/harness` src | `sha256:778f3f317cf5fd721dddfc65f4b756b9e8a8300c6e24199891731c389eaa8b8c` |
| `@smthrs/std` src | `sha256:7d8cadd8b693ca7e959a8dea97f2fd4701be73ebd31350fedb0fadc39dc8be53` |
| `@smthrs/agent` src | `sha256:07d3db53e28237b068fa889d7115552ed964b27c87f7cbd2326483a1892ff809` |
| `@smthrs/model` src | `sha256:5c45d25000804ada48a822f60d43c9d08e3fb7688db4bc2d688b15825c96fc95` |
| preflight refusals | none |
| node | v24.18.0 darwin-arm64 |
| seat | `openai:gpt-5.6-sol` |
| attempts | one per instance |
| per-instance budget | 1200 s |
| in flight | 3 |
| disk gate | 8192 MiB; never blocked — the ledger carries no `note` row and the driver log no wait line |
| grading | official evaluator, x86_64 images, run id `rerun-r93` |
| budget gate | $75; never reached, the wave finished at $32.25 |
| agreement | every instance ran the pinned subject |
| infrastructure crashes | none; **zero model retries of any class** |

`CellTurn.ts` moved against r92's hash, which is correct: `9f357f51e` and
`c3a5e2970` both touch it. `@smthrs/std` hashes identically to r92's, which is
also correct: nothing in this round changed a tool.

## Disclosures

- **`packages/std/test/ScratchGrepTiming.test.ts` was already gone.** The lane
  was told to delete it as a dead scratch benchmark holding `packages/std`'s
  gate red. It is not in `HEAD`, not in `HEAD`'s history, and not on disk; the
  only commits that ever carried it are on unrelated branches. Nothing was
  deleted. `packages/std`'s suite was run to check the claim rather than assume
  it, and exits 0.
- **The rig changed during the wave, and the subject did not.** Two evidence
  readers — `lib/round3-evidence.mjs` and `n-way.mjs`, with their fixtures —
  landed as commit `198ad622b` at 12:1xZ while instances were in flight.
  `evals/` is not part of the pinned subject: `lib/subject.mjs` fingerprints the
  `@smthrs/*` closure the CLI loads, and the pin was re-checked after the commit
  and reports the same stamp. No instance measured a different harness. The
  ledger header names `59e9f013e`, the commit the subject was pinned at. This is
  the same class of disclosure r92 made for its own mid-wave rig commit.
- **The `psf/requests` pair is excluded by name, and both denominators are
  printed everywhere.** This is r92's next-step 3, shipped as `46abbe405` and
  `59e9f013e`. The exclusion removes the two rows for flows and for codex
  identically, the documented cause names the grading container rather than any
  harness, and every rate in this report says 43 scored of 45 run. It is not
  tuning: no reading of either row has ever said anything about a harness, and
  removing a row from one arm only would be.
- **The budget gate stayed at $75**, where r92 set it so it could not truncate a
  wave. It was never reached.
- **No instance was re-run.** Zero transport retries, zero retries of any class,
  no crashed journals, no `journals-crashed/` directory. r92 lost two instances
  to a dead socket and re-ran them; nothing of that shape happened here.
- **One instance recorded an empty patch**, `django__django-15732`, against 0 in
  r92 and 1 in r90. It is not a capture fault — see §1 below, which quotes the
  two edits that cancel.

## What the four shipped changes did

Read off the 45 journals by `lib/round3-evidence.mjs` (the two new signals) and
`lib/program-evidence.mjs` / `lib/surgery-evidence.mjs` (the shape of the wave),
which count `control.agent.*` events and nothing else. The r90/r91/r92 columns
are the same readers over those waves' own journals, so each row is one rule
applied three or four times rather than one report quoting another.

| # | next-step | shipped | acted | the number that says so |
| --- | --- | :---: | :---: | --- |
| 1 | diagnose `django__django-14351` | yes | **yes, and it resolved** | the instance moves `unresolved → resolved`, 14 → 21 frames, $1.13 → $1.68 |
| 2 | give the transport ladder a last rung | yes | **not exercised** | **0 transport retries in 45 journals**; the incident class did not recur |
| 3 | pin or exclude the `psf/requests` grading | yes | **yes** | every rate in this report carries **43 scored of 45 run** |
| 4 | re-measure change 2(f) alone | yes | **yes, and it failed** | `astropy__astropy-14369`: 8 → **41 frames**, $0.67 → **$3.06**, still unresolved |

Next-step 5 — take the cost win to the rest of the sample — is not attempted:
there was no cost win to take.

### 1. `django__django-14351` is diagnosed, and the diagnosis is not what fixed it

r92 named this instance as the wave's only unexplained regression. The diagnosis
landed as `VacuousVerification`: the run had stored as `state.verification` a
check it had already watched pass over the tree it was handed, so its
before-and-after established nothing. The control says so on the `invalidProbe`
channel, once per distinct verification input, and refuses nothing.

**In r93 the instance resolved, and the control did not fire on it.** Its journal
carries no `vacuous-verification-observed` row at all. The run took a different
path — 21 frames instead of 14, ten more than r92 — and completed on a proof the
controller had no objection to. The contract also gained two rules in the same
round, so the instance's recovery cannot be attributed to the control; what can
be said is that the row every future report was going to have to repeat is
closed, and that this report cannot say which of three changes closed it.

The control fired **twice in 45 journals**, on two instances neither the
diagnosis nor the replay predicted:

| instance | frame | frames after | stored a different proof after | watched that check fail after | how the run ended |
| --- | ---: | ---: | :---: | :---: | --- |
| `sympy__sympy-13878` | 1 | 17 | **yes** | no | **resolved** |
| `django__django-15732` | 7 | 3 | no | no | **empty patch** |

`sympy__sympy-13878` is the control working as designed: told at frame 1 that
its stored check was already green, the run replaced it and spent seventeen more
frames on a different proof, and resolved — cheaper than any earlier wave
($1.87 against $2.22 / $2.17 / $1.98) and in fewer frames (18 against 24 / 21 /
24).

`django__django-15732` is the control landing on a run that then undid its own
correct work. The observation fired on frame 7 — the frame that made the edit.
On frame 8 the run made a second edit, and the two cancel exactly:

```
edit 1  ->  self._delete_composed_index(
                model,
                fields,
                {"primary_key": False, "unique": True},
                self.sql_delete_unique,
            )

edit 2  ->  self._delete_composed_index(
                model, fields, {"unique": True}, self.sql_delete_unique
            )
```

Edit 2 rewrites the enclosing block and restores edit 1's text byte for byte.
Both edits succeeded, both frames report `mutated: true` on an `observed` basis,
and the captured diff is zero bytes because the final tree equals the base. The
instance had resolved in r90, r91 and r92. It is the wave's only empty patch.

Nothing in the control's contract asks a run to revert. The pairing is one
instance and is not proof of a mechanism; it is the reason the next round has to
price this control on its own rather than shipping it alongside two prompt
rules, and it is the first evidence that a fact delivered on the `invalidProbe`
channel can be read by a run as an instruction to retreat.

The refusal `9f357f51e` added — never call a proof vacuous that the run watched
fail first — is not exercised by either firing: both are checks with no pre-edit
failure on record, which is exactly the population the refusal leaves alone.

### 2. The transport ladder was not exercised

`22bf30632` did two things: bounded the ladder by a 45-second wall clock as well
as by five rungs, and gave `RequestExecutor` a `Transport` it can rebuild after
three consecutive transport failures.

**Neither was reached. The wave recorded zero model retries of any class.**

| | r90 | r91 | r92 | r93 |
| --- | ---: | ---: | ---: | ---: |
| model retries | 1 | 0 | 11 | **0** |
| of those, `transport` | 0 | 0 | 10 | **0** |
| ladders | 1 | 0 | 3 | **0** |
| ladders exhausted at five rungs | 0 | 0 | 2 | **0** |
| instances lost to a dead socket | 0 | 2 | 0 (re-run) | **0** |

So the change is unfalsified rather than confirmed. Two things can still be said
from r92's own preserved ladders, read by the same reader:

- `django__django-13128`'s ladder spanned **37,469 ms** from its frame's
  `turn-opened` to the rungs' own timestamp, and `pydata__xarray-7229`'s spanned
  **41,551 ms**. Both are inside the 45,000 ms window, so on those two incidents
  the new bound would have changed nothing — every rung would still have run.
  The window is written for a slower ladder than either of the two that
  motivated it.
- A rebuild produces no journal event, because it is a process-internal exchange
  of one HTTP client for another. The observable the reader looks for is a
  ladder followed by a settled model call in the same frame. r92 has zero of
  those; r93 has zero ladders. Nothing in this wave says whether a rebuilt pool
  survives a dead session.

### 3. The exclusion, and what it changed

`lib/excluded.mjs` names `psf__requests-1766` and `psf__requests-2317`, with the
grading-environment cause on record and the rule that an exclusion applies to
both arms or to neither. Four scoreboards obey it — `compare-runs.mjs`,
`three-way.mjs`, `compare-arms.mjs` and `fullbench-report.mjs` — and every rate
they print carries the scored count and the raw count together.

What it changes is that three waves of a byte-identical patch producing three
different verdicts is no longer a number anybody has to argue about. The
baseline reads **33/43** rather than 35/45, and it reads the same way in every
column of every table in this report. The two rows keep their per-instance
entries and are marked.

The r93 verdicts for the pair are `unresolved` and `unresolved`, the same as
r92's, and they are still statements about `httpbin`.

### 4. Change 2(f) alone, and the same-shape sweep

`b4f255b6a` added exactly two lines to the contract, each with one instance
behind it.

**Rule 9 — the minimal-edit rule** — is r91's change 2(f) in r91's own wording,
put back alone. Its control is `astropy__astropy-14369`: the only row in the 45
whose verdict that rule alone has ever moved, resolved under r91 in 5 frames and
failed under r90 and r92 in 8.

| astropy__astropy-14369 | r90 | r91 | r92 | **r93** |
| --- | --- | --- | --- | --- |
| verdict | unresolved | **resolved** | unresolved | **unresolved** |
| frames | 8 | 5 | 8 | **41** |
| cost | $0.64 | $0.52 | $0.67 | **$3.06** |
| agent seconds | 245 | 354 | 285 | **1,163** |

**The A/B fails.** The rule that won this instance inside r91's four-rule
doctrine does not win it alone. It produced the most expensive instance of the
wave: 41 frames, 10 edits, 11 frames that issued no call at all, and two
read-only demands (frames 27 and 40) before the run hit its budget. r91's win
was not this rule acting by itself.

**Rule 10 — the same-shape sweep** — was written for `django__django-13212`,
which fixed 14 of 14 sites in the file it was reading and 0 in the gold patch's
second file, `django/forms/fields.py`.

| | r90 | r91 | r92 | **r93** |
| --- | ---: | ---: | ---: | ---: |
| `13212` files in the captured patch | 1 | 1 | 1 | **1** |
| `13212` verdict | unresolved | unresolved | unresolved | **unresolved** |
| `13212` frames / cost | 6 / $0.71 | 10 / $1.45 | 13 / $1.24 | **6 / $0.62** |
| whole wave: files touched across 45 patches | 49 | 43 | 55 | **47** |
| whole wave: patches touching more than one file | 4 | 3 | 6 | **3** |

The instance got cheaper and the sweep did not happen. Its journal shows the run
searching for validator symbols with `glob`s scoped to `tests` and to
`django/core/validators.py`, never to the repository, and the patch still names
one file. Across the whole wave the rule made patches **less** multi-file than
r92's, not more.

**What the two rules cost.** They are 522 characters of contract, and the wave
shape moved the way r91's four rules moved it, at a fifth of the size.

| | r90 | r91 | r92 | **r93** |
| --- | ---: | ---: | ---: | ---: |
| frames | 452 | 527 | 291 | **406** |
| calls | 1,276 | 1,366 | 915 | **1,259** |
| zero-call frames | 75 | 81 | 42 | **66** |
| dead frames (no transition applied) | 30 | 21 | 4 | **4** |
| read-only demands fired | 6 | 14 | 0 | **5** |
| edit calls | 113 | 86 | 100 | **143** |
| of those, failed | 11 | 4 | 3 | **12** |
| frames holding a failed call | 21 | 8 | 7 | **20** |
| of those, recovered in-cell | 4 (19 %) | 7 (88 %) | 7 (100 %) | **20 (100 %)** |
| `bash` calls passing a payload as data | 0 | 314 | 155 | **205** |
| `bash` calls composing a shell string | 587 | 282 | 194 | **357** |
| instances at the 1,200 s budget | 1 | 11 | 0 | **1** |
| empty patches | 1 | 5 | 0 | **1** |
| mean cell size | 2,971 B | 3,687 B | 2,631 B | **2,638 B** |
| output tokens per frame | 2,127 | 3,071 | 1,756 | **1,880** |

The cells did not get longer — 2,638 bytes against r92's 2,631 — so this is not
r91's transactional-cell failure returning. There are simply **40 % more of
them**, and 143 edits against 100 for three fewer resolved instances. The lane
mechanics all held: dead frames stayed at 4, every frame that held a failed call
recovered inside the same cell, and the interpreter fact is still used by all 45
instances with **zero interpreter hunting** in the whole wave.

The one tool signal that moved the wrong way is `bash` shape: 357 calls composed
a shell command string against r92's 194, and 205 passed a payload as data
against 155. Nothing in this round touched `@smthrs/std` — its hash is identical
to r92's — so that is the contract's doing, not a tool's.

## Prompt bytes in the wild

The taught prefix is one segment, rendered into every frame's request and paid
once at full price and then at cache rates.

| | r90 | r91 | r92 | **r93** |
| --- | ---: | ---: | ---: | ---: |
| cell contract | 8,197 chars / 2,105 est tokens | 11,312 chars | 9,193 chars / 2,352 est tokens | **9,715 chars / 2,483 est tokens** |
| environment section | — | — | 902 chars / 230 est tokens | 902 chars / 230 est tokens |
| flow catalog (this run's shape) | — | — | 83 chars / 21 est tokens | 83 chars / 21 est tokens |
| all rendered sections | — | — | 10,178 chars / 2,604 est tokens | **10,700 chars / 2,735 est tokens** |

r93's row is rendered from the pinned subject by `CellPrompt.make`. The delta
against r92 is **+522 characters, +131 estimated tokens**, and it is entirely the
two new rules: rule 9 is 319 characters / 81 estimated tokens, rule 10 is 203 /
52. The unit test's ceiling moved from 2,400 to 2,500 to admit them.

Against that: +115 frames, +$9.47 and −3 verdicts. **131 estimated tokens of
teaching bought a 43 % larger bill.**

The task prompt did not change this round, and the numbers say so exactly.

| | r92 | r93 |
| --- | ---: | ---: |
| instances told a project interpreter | 45 of 45 | **45 of 45** |
| mean task prompt | 4,887 bytes | **4,887 bytes** |
| total across the wave | 219,933 bytes | **219,933 bytes** |

Every one of the 45 images answered
`/opt/miniconda3/envs/testbed/bin/python`, and 45 of 45 instances used the path
they were told — 360 calls naming it, against 8 passing a bare interpreter and
**zero calls hunting for one**.

What the wire actually saw, summed over the wave: 4,240,394 input tokens at
62.1 % cached, 763,417 output tokens, 1,880 output tokens per frame across 406
frames.

## Verdicts that moved

**Recovered (7)** — the baseline resolved it, some wave since did not, and this
one does: `django__django-11299`, `django__django-13343`,
**`django__django-14351`**, `django__django-15987`, `pydata__xarray-7393`,
`sympy__sympy-13878`, `sympy__sympy-20154`.

`14351` is the row this report was asked to answer for, and it is answered.

**Gained over the baseline (2):** `django__django-13821` and
`pydata__xarray-7233`. Both were r92 gains and both hold.

**Still lost against the baseline (4):**

| instance | r90 | r91 | r92 | r93 | why |
| --- | --- | --- | --- | --- | --- |
| django__django-11815 | resolved | resolved | resolved | unresolved | 3 → 9 frames, $0.19 → $0.74; four edits to the file r92 fixed in one |
| django__django-15732 | resolved | resolved | resolved | empty patch | the run edited correctly at frame 7 and reverted at frame 8; see §1 |
| matplotlib__matplotlib-22865 | resolved | resolved | resolved | unresolved | a wrong patch reached in 4 frames and $0.32 — cheaper than r90's 36 frames and wrong |
| pytest-dev__pytest-6197 | resolved | resolved | resolved | unresolved | 6 → 25 frames, $0.41 → $2.25; **14 of its 25 frames issued no call at all** |

All four are new losses this round: r92 lost none of them.

`pytest-dev__pytest-6197` is the clearest single failure in the wave and the one
worth reading. Frames 7 through 20 are consecutive zero-call frames — the cell
returns `{ intent: "continue", state: ctx.state, render: [...], context: [...] }`
and calls nothing, fourteen times. The read-only cap caught it at frame 17 and
demanded a justification, which is the control doing its job, but twelve frames
and roughly $1 had already gone. The instance then spent five more frames and
ended unresolved. r92 resolved it in 6 frames for $0.41.

`django__django-15732`'s revert and `pytest-6197`'s stall are different shapes of
the same thing: a run that has a correct diagnosis and spends the run
deliberating about it instead of committing to it. That is what rule 9's second
clause — *the rules beside it are not yours to restructure* — reads like when it
lands on a run that was about to be right.

## The superset goal

`compare-arms.mjs` over this ledger and the codex backfill's, on the scored 43:

| | count |
| --- | ---: |
| both resolved | 30 |
| **flows only** | **1** |
| **codex only** | **8** |
| neither | 4 |

flows 31/43 (72 %), codex 38/43 (88 %); raw, over all 45, flows 31 and codex 40.

**The standing superset goal still fails, and by more than it did.** But the
flows-only column is non-empty for the first time in the program:
`django__django-14351` is resolved by flows and not by codex. That is one row,
and it is the row this round was written for.

The codex-only eight are `pytest-dev__pytest-6197`, `pydata__xarray-7229`,
`django__django-11815`, `sphinx-doc__sphinx-7590`, `django__django-12273`,
`sympy__sympy-19495`, `matplotlib__matplotlib-22865` and
`django__django-15732`. Four of them — `7229`, `7590`, `12273`, `19495` — are the
same four r91 and r92 also missed. The other four are this wave's own new
losses.

`sphinx-7590`'s codex resolve still rests on fetching the project's later 3.x
history, which §6-R2 rejects, so that instance is not a scoreboard row in either
direction.

## Per instance

Frames and dollars are each wave's own ledger. `frames` and `agent s` read
r90 → r91 → r92 → r93. The full table, including both excluded rows, is
`fullbench/rerun-r93/vs/n-way.md`.

| instance | r90 | r91 | r92 | r93 | $ r90 | $ r91 | $ r92 | $ r93 | Δ$ vs r90 | frames | agent s |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| astropy__astropy-14365 | unresolved | unresolved | unresolved | unresolved | $0.43 | $1.01 | $1.00 | $0.59 | +0.16 | 4 → 8 → 11 → 10 | 334 → 470 → 448 → 244 |
| astropy__astropy-14369 | unresolved | resolved | unresolved | unresolved | $0.64 | $0.52 | $0.67 | $3.06 | +2.42 | 8 → 5 → 8 → 41 | 245 → 354 → 285 → 1163 |
| astropy__astropy-7166 | resolved | resolved | resolved | resolved | $0.33 | $0.33 | $0.13 | $0.16 | −0.16 | 5 → 2 → 2 → 3 | 118 → 130 → 58 → 62 |
| astropy__astropy-8707 | resolved | resolved | resolved | resolved | $1.12 | $0.99 | $0.29 | $0.93 | −0.19 | 15 → 14 → 6 → 12 | 428 → 421 → 99 → 409 |
| django__django-10914 | resolved | resolved | resolved | resolved | $0.97 | $0.41 | $0.22 | $0.43 | −0.54 | 15 → 6 → 4 → 9 | 449 → 216 → 92 → 197 |
| django__django-11299 **recovered** | resolved | empty patch | resolved | resolved | $0.94 | $1.96 | $0.73 | $0.74 | −0.20 | 11 → 14 → 10 → 9 | 376 → 1155 → 312 → 299 |
| django__django-11490 | resolved | resolved | resolved | resolved | $1.00 | $1.96 | $0.20 | $0.44 | −0.56 | 13 → 17 → 3 → 6 | 408 → 1174 → 73 → 202 |
| django__django-11815 **lost** | resolved | resolved | resolved | unresolved | $0.24 | $1.92 | $0.19 | $0.74 | +0.50 | 3 → 21 → 3 → 9 | 90 → 829 → 62 → 350 |
| django__django-12273 | unresolved | unresolved | unresolved | unresolved | $0.77 | $0.98 | $0.48 | $0.27 | −0.51 | 8 → 7 → 6 → 3 | 338 → 487 → 242 → 109 |
| django__django-12741 | resolved | resolved | resolved | resolved | $0.82 | $0.44 | $0.21 | $0.95 | +0.13 | 9 → 3 → 3 → 12 | 372 → 213 → 83 → 422 |
| django__django-13128 | resolved | resolved | resolved | resolved | $0.75 | $1.77 | $0.38 | $0.84 | +0.09 | 8 → 13 → 3 → 11 | 323 → 970 → 99 → 384 |
| django__django-13212 | unresolved | unresolved | unresolved | unresolved | $0.71 | $1.45 | $1.24 | $0.62 | −0.09 | 6 → 10 → 13 → 6 | 260 → 917 → 619 → 302 |
| django__django-13343 **recovered** | resolved | empty patch | resolved | resolved | $0.13 | $2.08 | $0.13 | $0.30 | +0.16 | 2 → 18 → 2 → 3 | 48 → 1156 → 40 → 111 |
| django__django-13346 | resolved | resolved | resolved | resolved | $2.36 | $1.00 | $0.79 | $0.48 | −1.88 | 29 → 10 → 11 → 6 | 934 → 431 → 324 → 193 |
| django__django-13406 | resolved | resolved | resolved | resolved | $0.30 | $0.54 | $0.26 | $0.24 | −0.06 | 3 → 4 → 3 → 3 | 116 → 314 → 114 → 94 |
| django__django-13821 **gained** | unresolved | resolved | resolved | resolved | $1.03 | $1.53 | $1.47 | $0.33 | −0.70 | 11 → 12 → 16 → 5 | 433 → 875 → 957 → 145 |
| django__django-14351 **recovered** | resolved | unresolved | unresolved | **resolved** | $2.77 | $2.54 | $1.13 | $1.68 | −1.09 | 34 → 25 → 14 → 21 | 1086 → 1141 → 448 → 655 |
| django__django-15380 | resolved | resolved | resolved | resolved | $0.60 | $0.99 | $0.30 | $1.49 | +0.89 | 9 → 11 → 3 → 17 | 232 → 528 → 134 → 684 |
| django__django-15569 | resolved | resolved | resolved | resolved | $0.25 | $0.54 | $0.35 | $0.39 | +0.14 | 3 → 5 → 4 → 5 | 88 → 244 → 139 → 179 |
| django__django-15732 **lost** | resolved | resolved | resolved | empty patch | $0.58 | $2.06 | $0.83 | $0.83 | +0.25 | 9 → 20 → 9 → 10 | 214 → 1158 → 371 → 394 |
| django__django-15987 **recovered** | resolved | empty patch | resolved | resolved | $0.45 | $1.99 | $0.16 | $0.27 | −0.18 | 4 → 19 → 3 → 3 | 175 → 1119 → 67 → 130 |
| django__django-16612 | resolved | resolved | resolved | resolved | $0.25 | $0.29 | $0.39 | $0.30 | +0.05 | 3 → 2 → 5 → 3 | 93 → 107 → 147 → 112 |
| django__django-16662 | resolved | resolved | resolved | resolved | $0.57 | $1.06 | $0.30 | $0.27 | −0.30 | 7 → 8 → 6 → 3 | 234 → 466 → 160 → 117 |
| django__django-16899 | resolved | resolved | resolved | resolved | $1.83 | $2.58 | $0.21 | $0.41 | −1.42 | 20 → 20 → 3 → 6 | 888 → 1195 → 73 → 189 |
| django__django-16901 | resolved | resolved | resolved | resolved | $0.90 | $1.18 | $0.48 | $0.28 | −0.62 | 6 → 11 → 7 → 4 | 390 → 516 → 317 → 110 |
| matplotlib__matplotlib-20826 | resolved | resolved | resolved | resolved | $0.52 | $0.93 | $0.48 | $0.83 | +0.31 | 5 → 9 → 4 → 7 | 241 → 387 → 214 → 395 |
| matplotlib__matplotlib-20859 | resolved | resolved | resolved | resolved | $0.17 | $1.18 | $0.27 | $0.16 | −0.01 | 2 → 5 → 3 → 2 | 56 → 461 → 105 → 52 |
| matplotlib__matplotlib-22865 **lost** | resolved | resolved | resolved | unresolved | $2.65 | $1.43 | $0.20 | $0.32 | −2.33 | 36 → 10 → 4 → 4 | 1164 → 742 → 70 → 136 |
| matplotlib__matplotlib-24970 | resolved | resolved | resolved | resolved | $0.48 | $0.45 | $0.30 | $0.40 | −0.08 | 8 → 3 → 4 → 7 | 282 → 237 → 153 → 168 |
| psf__requests-1766 **excluded** | resolved | resolved | unresolved | unresolved | $0.14 | $0.41 | $0.24 | $0.34 | +0.21 | 3 → 4 → 4 → 5 | 52 → 212 → 133 → 143 |
| psf__requests-2317 **excluded** | resolved | resolved | unresolved | unresolved | $0.33 | $0.66 | $0.42 | $0.31 | −0.02 | 4 → 5 → 7 → 4 | 118 → 555 → 321 → 136 |
| pydata__xarray-7229 | unresolved | unresolved | unresolved | unresolved | $2.01 | $1.19 | $1.47 | $0.55 | −1.46 | 20 → 9 → 9 → 6 | 839 → 562 → 323 → 241 |
| pydata__xarray-7233 **gained** | unresolved | unresolved | resolved | resolved | $0.12 | $2.68 | $0.24 | $0.32 | +0.20 | 3 → 25 → 5 → 5 | 29 → 1192 → 79 → 120 |
| pydata__xarray-7393 **recovered** | resolved | empty patch | resolved | resolved | $0.59 | $3.13 | $0.80 | $1.36 | +0.77 | 9 → 22 → 12 → 16 | 224 → 1191 → 285 → 563 |
| pytest-dev__pytest-6197 **lost** | resolved | resolved | resolved | unresolved | $0.54 | $2.35 | $0.41 | $2.25 | +1.71 | 5 → 20 → 6 → 25 | 242 → 1030 → 148 → 1072 |
| sphinx-doc__sphinx-11445 | resolved | resolved | resolved | resolved | $0.16 | $0.97 | $0.45 | $0.42 | +0.26 | 3 → 8 → 7 → 6 | 56 → 410 → 158 → 165 |
| sphinx-doc__sphinx-7590 | empty patch | unresolved | unresolved | unresolved | $2.93 | $2.45 | $0.88 | $0.82 | −2.11 | 39 → 23 → 11 → 12 | 1128 → 1131 → 886 → 312 |
| sphinx-doc__sphinx-7757 | resolved | resolved | resolved | resolved | $0.30 | $1.51 | $0.20 | $0.33 | +0.03 | 5 → 12 → 4 → 5 | 109 → 624 → 64 → 126 |
| sphinx-doc__sphinx-8721 | resolved | resolved | resolved | resolved | $1.66 | $1.46 | $0.70 | $2.72 | +1.06 | 19 → 15 → 9 → 34 | 692 → 662 → 283 → 1097 |
| sympy__sympy-13372 | resolved | resolved | resolved | resolved | $0.16 | $1.21 | $0.12 | $0.16 | −0.00 | 3 → 11 → 2 → 2 | 45 → 614 → 39 → 59 |
| sympy__sympy-13878 **recovered** | resolved | empty patch | resolved | resolved | $2.22 | $2.17 | $1.98 | $1.87 | −0.35 | 24 → 21 → 24 → 18 | 1131 → 1155 → 1113 → 1080 |
| sympy__sympy-16450 | resolved | resolved | resolved | resolved | $0.17 | $0.45 | $0.12 | $0.33 | +0.15 | 3 → 5 → 2 → 4 | 58 → 317 → 41 → 272 |
| sympy__sympy-18763 | unresolved | unresolved | unresolved | unresolved | $0.45 | $1.45 | $0.33 | $0.18 | −0.27 | 5 → 16 → 6 → 3 | 182 → 730 → 143 → 63 |
| sympy__sympy-19495 | unresolved | unresolved | unresolved | unresolved | $0.54 | $1.33 | $0.43 | $0.91 | +0.37 | 9 → 15 → 7 → 13 | 226 → 587 → 184 → 379 |
| sympy__sympy-20154 **recovered** | resolved | unresolved | resolved | resolved | $0.95 | $0.72 | $0.18 | $0.62 | −0.33 | 2 → 4 → 3 → 8 | 331 → 414 → 63 → 276 |

## What this settles, and what it does not

**Settled: `django__django-14351`.** It resolves, it is the first instance in the
program that flows resolves and codex does not, and the row every report since
r91 has had to repeat is closed. What is *not* settled is which change closed it:
three landed together and the control written for it did not fire on it.

**Settled, again, and now at a fifth of the size: doctrine costs.** r91 added
3,115 characters of contract across four rules and lost five verdicts and $22.
r93 added **522 characters across two rules** and lost three verdicts and $9.47.
The ratio is worse per character, not better. The two waves that cut the
contract — r90's text and r92's revert to it — are the two cheapest waves on
record.

**Settled: the exclusion is honest and it is cheap.** Two instances by name,
both arms, a documented environmental cause, and both denominators printed
everywhere. It cost nothing to run and it removed an argument three waves old.

**Not settled: change 2(f) on its own.** The A/B ran and the answer is negative:
`astropy__astropy-14369` went to 41 frames and $3.06 and still failed, so r91's
one verdict was not this rule acting alone. The rule has now been priced twice
and has never been worth its cost outside the wave it was born in.

**Not settled: the same-shape sweep.** `django__django-13212` still edits one
file, the wave's patches got *less* multi-file, and the instance's verdict did
not move. The rule was written generally, as it had to be, and generality is
what made it unreachable: the run swept `tests/`, not the repository.

**Not settled: the transport ladder.** Zero retries in 45 journals. The window
and the rebuild are untested by measurement, and the two r92 ladders they were
written for both fall *inside* the new window, so on that evidence the bound
would have changed nothing.

**Not settled: the superset goal.** flows-only is 1 for the first time and
codex-only is 8, up from 4. Four of the eight are this wave's own new losses.

### What to do next, in order

1. **Revert rules 9 and 10.** They are 522 characters, they are the only change
   to the model-facing contract this round, and the wave they produced is three
   verdicts and $9.47 worse than the one before it. The A/B they were shipped to
   settle is settled and it is negative. r92's contract text is the cheapest and
   the highest-scoring measured, and it should be the text the next wave runs.
2. **Re-measure `VacuousVerification` alone, on r92's contract.** It fired twice
   in 45 journals: once on a run that replaced its proof and resolved, once on a
   run that reverted its own correct edit into the wave's only empty patch. Two
   firings is not a rate, and this wave cannot separate the control from the two
   prompt rules it shipped beside. It is one control, it costs no tokens, and it
   deserves its own column.
3. **Find out why 14 frames of `pytest-dev__pytest-6197` issued no call.** The
   read-only cap caught the stall at frame 17 and cost a justification; twelve
   frames and about a dollar went first. A cap that fires after twelve wasted
   frames is a cap set for a failure mode that no longer exists — r92 had zero
   read-only demands and 42 zero-call frames in the whole wave, and r93 has 66.
4. **Leave the transport ladder alone until an incident recurs.** It is
   unfalsified, not confirmed, and the honest next step for an untriggered
   change is to wait for the trigger rather than to tune it further.
5. **Grow the sample.** Four waves have now been decided by three or four
   instances out of 43, and two of the four "losses" this round —
   `matplotlib-22865` at 4 frames and `django-15732`'s self-revert — are the kind
   of single-run variance a 45-instance population cannot distinguish from a
   harness change. The program's conclusions are getting finer than its
   measurement.

## Reproducing this

```sh
./preflight.sh                                          # pins the subject
SWB_RERUN_BUDGET_USD=75 ./run-45.sh --lane r93          # the wave itself

node compare-runs.mjs --rerun fullbench/rerun-r93/manifest.jsonl \
  --out fullbench/rerun-r93                             # against the baseline
mkdir -p fullbench/rerun-r93/vs-r92
node compare-runs.mjs --baseline fullbench/rerun-r92/manifest.jsonl \
  --rerun fullbench/rerun-r93/manifest.jsonl \
  --out fullbench/rerun-r93/vs-r92                      # against r92
mkdir -p fullbench/rerun-r93/vs
node n-way.mjs --wave r90=fullbench/manifest.jsonl \
  --wave r91=fullbench/rerun-r91/manifest.jsonl \
  --wave r92=fullbench/rerun-r92/manifest.jsonl \
  --wave r93=fullbench/rerun-r93/manifest.jsonl \
  --out fullbench/rerun-r93/vs                          # all four

node lib/round3-evidence.mjs fullbench/rerun-r93/journals
node lib/round3-evidence.mjs fullbench/rerun-r92/journals-crashed   # the two r92 ladders
node lib/program-evidence.mjs fullbench/rerun-r93/journals
node lib/surgery-evidence.mjs fullbench/rerun-r93/journals \
  --interpreters fullbench/rerun-r93/driver.log
lib/prompt-bytes.sh fullbench/rerun-r93/driver.log
node compare-arms.mjs --manifest fullbench/rerun-r93/manifest.jsonl \
  --codex-manifest fullbench/codex-manifest.jsonl --out fullbench/rerun-r93
```

Every reader takes its numbers off `control.agent.*` events or off a ledger — no
clock, no network, no re-derivation. `n-way.mjs`, `lib/round3-evidence.mjs`,
`three-way.mjs`, `lib/surgery-evidence.mjs`, `lib/program-evidence.mjs` and
`lib/prompt-bytes.sh` are each pinned against synthesised inputs by
`fixtures/check-n-way.mjs`, `fixtures/check-round3-evidence.mjs`,
`fixtures/check-three-way.mjs`, `fixtures/check-surgery-evidence.mjs`,
`fixtures/check-program-evidence.mjs` and `fixtures/check-prompt-bytes.mjs`, all
inside `./verify.sh`.

Artifacts: `fullbench/rerun-r93/manifest.jsonl` (the ledger),
`fullbench/rerun-r93/compare.{md,json}` (against the baseline),
`fullbench/rerun-r93/vs-r92/compare.{md,json}` (against r92),
`fullbench/rerun-r93/vs/n-way.{md,json}` (all four waves),
`fullbench/rerun-r93/arms.{md,json}` (against codex),
`fullbench/rerun-r93/journals/` (45 journals),
`fullbench/rerun-r93/patches/` (45 patches),
`fullbench/rerun-r93/logs/` (per-instance run and grade logs),
`fullbench/rerun-r93/driver.log`.
