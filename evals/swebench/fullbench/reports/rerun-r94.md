# The confirmation wave: fullbench 45 on r92's contract, measured twice (r94)

Measured 2026-08-22, 15:16Z to 17:06Z. The same 45 instances, the same seeded
draw order, read out of the r90 baseline ledger.

`fullbench/reports/rerun-r93.md` ended in a ranked list of five next-steps. The
first two shipped, as commits `377017cf0` and `d84aee31b`: rules 9 and 10 came
out of the cell contract, and `VacuousVerification` came off the live path so it
can be priced in a wave of its own. What that leaves is r92's contract text,
byte for byte, and this wave is the measurement of it.

**That is the point of this wave, and it is a different question from the three
before it.** r91, r92 and r93 each measured a change. This one measures the
*same* thing twice: the contract that produced the highest-scoring and cheapest
wave on record, run again on the same population, to find out how much of r92's
result was the contract and how much was a single draw.

**It replicates.** r94 resolves 34 of the scored 43 — exactly r92's count — and
lands on the same verdict as r92 on 41 of those 43 instances. It is the fastest
wave the program has measured. It costs $2.85 more than r92, and four instances
carry all of that and more.

| | r90 baseline | r91 | r92 | r93 | **r94** | r94 vs r90 | r94 vs r92 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **resolved (scored, 43)** | **33/43** | **28/43** | **34/43** | **31/43** | **34/43** | **+1** | **+0** |
| resolved (raw, 45) | 35/45 | 30/45 | 34/45 | 31/45 | 36/45 | +1 | +2 |
| **total cost (scored)** | **$37.37** | **$59.17** | **$22.11** | **$31.59** | **$24.96** | **−$12.41 (−33 %)** | **+$2.85 (+13 %)** |
| total cost (raw) | $37.84 | $60.24 | $22.78 | $32.25 | $25.31 | −$12.53 | +$2.53 |
| **total agent wall (scored)** | **15,707 s** | **29,032 s** | **10,114 s** | **13,832 s** | **9,981 s** | **−5,726 s (−36 %)** | **−133 s (−1 %)** |
| instance wall (scored) | 16,860 s | 30,817 s | 10,949 s | 14,726 s | 11,120 s | −5,740 s | +171 s |
| frames (scored) | 445 | 518 | 280 | 397 | 327 | −118 | +47 (+17 %) |
| frames (raw) | 452 | 527 | 291 | 406 | 333 | −119 | +42 |
| output tokens (raw) | 961,461 | 1,618,230 | 510,962 | 763,417 | 591,709 | −369,752 | +80,747 |
| input tokens (raw) | 3,859,603 | 5,828,750 | 2,899,858 | 4,240,394 | 3,392,916 | −466,687 | +493,058 |
| cache rate (raw) | 59.3 % | 69.8 % | 60.6 % | 62.1 % | 61.6 % | +2.3 pp | +1.0 pp |

Both denominators are printed on every row a name can reach, because
`lib/excluded.mjs` names two: `psf__requests-1766` and `psf__requests-2317` are
outside every rate, for **both arms**, with the cause on record.

Cost is every attempt, which is what the invoice says. Wall clock is the
journal's own span across the agent's frames, summed per instance — not the wall
clock of the run as a whole, which was 1 h 50 m at three in flight and depends on
concurrency rather than on a harness.

Against the baseline: 28 of 45 instances cheaper, 16 dearer, 1 unchanged; 32
faster, 13 slower. Against r92 it is an even split on money — 22 cheaper, 22
dearer, 1 unchanged — and 28 of 45 faster.

## The program's success criteria

`analysis/PROGRAM.md` §3's targets, unchanged, answered over the scored 43.

| criterion | target | r90 | r91 | r92 | r93 | **r94** | met |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| resolved | ≥ 33 | 33 | 28 | 34 | 31 | **34** | **yes** |
| total cost | ≤ $15.00 | $37.37 | $59.17 | $22.11 | $31.59 | $24.96 | NO |
| instance wall | ≤ 120 min | 281.0 min | 513.6 min | 182.5 min | 245.4 min | 185.3 min | NO |
| no instance over $1.00 | 0 | 11 | 27 | 5 | 7 | 6 | NO |
| no instance over 20 frames | 0 | 5 | 6 | 1 | 4 | 4 | NO |
| no verdict lost | 0 | — | 7 | 3 | 4 | **1** | NO |

Two rows are the wave's own: the resolved criterion is met for the second time
in the program, and one verdict lost against the baseline is the fewest any wave
has managed.

Over $1.00: `django__django-13821`, `django__django-14351`,
`django__django-15380`, `sphinx-doc__sphinx-7590`, `sympy__sympy-13878`,
`sympy__sympy-19495`. Over 20 frames: `django__django-13821`,
`django__django-14351`, `sphinx-doc__sphinx-7590`, `sympy__sympy-19495`.

**On the standing cheaper-faster goal**, measured against the re-graded r90
baseline: r94 resolves more (34 against 33 scored, 36 against 35 raw), costs less
(−33 %) and finishes faster (−36 %). That is the goal's shape, met on both
denominators. r92 met it too. This wave's contribution is that it is now met
twice by the same contract rather than once.

## Preconditions

| | |
| --- | --- |
| subject stamp | `sha256:33d86232acf7bc400cf1abb4fb818ed4fc7e7bb913c4c6bb3cfccbd8474cb8eb` |
| git HEAD at the pin | `7343c1947f4489ad31845a23756fb8d26eaacee6` |
| HEAD subject | 🔧 fix(harness,flows): give the sandbox's unreachable catch a directive per line |
| **rendered cell contract** | **`sha256:25a1c933ad18e979fe4282848edee5987b61783f939ac72ff45fee2b6655e8c5`, 9,193 chars / 2,352 est tokens — r92's, byte for byte** |
| `CellTurn.ts` | `sha256:c697b19e7e09f877f8573153751a683a1163083aa52a3c0f7f117d4b7fe0a2b7` |
| `packages/cli/dist/esm` | `sha256:c7fcfcecc2376bfeb866063ae7c1002fb89472145951bb63b3cea35638b3eee4` |
| `packages/cli/src` | `sha256:c1571b2e2909f7c30bb07239aed41dcf0fa9218d9df7dcb6580256b092caa533` |
| `@smthrs/harness` src | `sha256:7d99ea14eaebbb814059b50afb24f58638ae77507a62dc518382909f162cb916` |
| `@smthrs/std` src | `sha256:7d8cadd8b693ca7e959a8dea97f2fd4701be73ebd31350fedb0fadc39dc8be53` |
| `@smthrs/agent` src | `sha256:07d3db53e28237b068fa889d7115552ed964b27c87f7cbd2326483a1892ff809` |
| `@smthrs/model` src | `sha256:5c45d25000804ada48a822f60d43c9d08e3fb7688db4bc2d688b15825c96fc95` |
| preflight refusals | none |
| node | v24.18.0 darwin-arm64 |
| seat | `openai:gpt-5.6-sol` |
| attempts | one per instance |
| per-instance budget | 1200 s |
| in flight | 3 |
| disk gate | 8192 MiB; never blocked — lowest reading 37,169 MiB free, no `note` row, no wait line |
| grading | official evaluator, x86_64 images, run id `rerun-r94` |
| budget gate | $75; never reached, the wave finished at $25.31 |
| agreement | every instance ran the pinned subject |
| infrastructure crashes | none; **no instance re-run, no `journals-crashed/`** |

`@smthrs/std` hashes identically to r92's and r93's: nothing in this round
touched a tool. `@smthrs/harness` moved against r92's because two files gained
comments and one module was added and left unwired — see the identity check
below, which is the check this wave was refused-or-run on.

## The identity check, which is what made this wave runnable

The brief was to refuse to run unless the contract digest matched r92's. It
matched, and three separate readings say so:

1. `packages/harness/src/internal/cellPrompt.ts` is **byte-identical** to its
   blob at `de1de1a82`, the commit r92 was pinned at
   (`git diff de1de1a82 HEAD -- packages/harness/src/internal/cellPrompt.ts` is
   empty).
2. The rendered `cell-contract` section digests to
   `25a1c933ad18e979fe4282848edee5987b61783f939ac72ff45fee2b6655e8c5` at 9,193
   characters, which is the number `377017cf0` pinned in
   `packages/harness/test/CellPrompt.test.ts`. That test passes, with the other
   39 in the file.
3. The whole `@smthrs/*` source delta against r92's subject is nine files, and
   only two of them change what a run does:

| file | what changed | live path |
| --- | --- | :---: |
| `packages/agent/src/FlowEngineLike.ts` | `defaultModelRetryWindowMillis = 45_000` bounds the ladder by elapsed time as well as by five rungs | **yes** |
| `packages/cli/src/NodeControl.ts` | `rebuildableTransport` — the production executor runs on an Undici agent the run may replace | **yes** |
| `packages/model/src/RequestExecutor.ts` | `Transport`, `rebuildAfter = 3`, the counter | **yes** |
| `packages/agent/src/AgentSession.ts` | traces an event nothing emits | no |
| `packages/harness/src/AgentEvent.ts` | declares that event | no |
| `packages/harness/src/VacuousVerification.ts` | the module, unwired | no |
| `packages/harness/src/index.ts` | exports it | no |
| `packages/harness/src/CellTurn.ts` | an eight-line comment where the arm was | no |
| `packages/harness/src/Sandbox.ts` | `v8 ignore` range replaced by per-line directives | no |

So r94 is r92's harness plus transport hardening, and nothing else that a run
can observe. That is what makes the comparison below a replication rather than
another A/B.

## Disclosures

- **The rig did not change during this wave.** Unlike r92 and r93, no commit
  landed while instances were in flight:
  `git log --all --since="2026-08-22 08:16:41" --until="2026-08-22 10:06:30"`
  (the wave's span in the committer's local zone, UTC−7) is empty. The commit
  before the wave is `7343c1947` at 08:11:47 local, five minutes before launch;
  the next is this report's. The working tree carries no modification under
  `evals/swebench`. There is no mid-wave disclosure to make.
- **No instance was re-run, and there were no retries of any class but one.**
  The wave recorded exactly one model retry, a `transport` rung on
  `django__django-15732`, and it recovered inside its own frame. No crashed
  journals, no `journals-crashed/` directory.
- **One instance reached the 1,200 s budget**: `sympy__sympy-13878`, which
  exited 124 at 1,209 s — and resolved anyway. r90 and r93 each had one; r91 had
  eleven; r92 had none.
- **No instance recorded an empty patch**, against 1 in r90, 5 in r91, 0 in r92
  and 1 in r93.
- **The `psf/requests` pair is excluded by name, and this wave is the strongest
  evidence yet that it should be.** `psf__requests-1766`'s captured patch is
  **byte-identical across r90, r92 and r94** — 451 bytes,
  `sha256:40e0a038e8530624…` — and graded `resolved`, `unresolved`, `resolved`.
  `psf__requests-2317`'s r94 patch is byte-identical to r90's (396 bytes) and
  graded the same way r90's did. One patch, three gradings, two answers: the
  variable is `httpbin`, not a harness. Both rows keep their per-instance entries
  and are marked, and both denominators are printed everywhere. Note that this is
  why the raw column reads 36/45 against the scored 34/43 — the two rows this
  wave happened to grade `resolved` are the two rows nobody is allowed to count.
- **The budget gate stayed at $75.** It was never reached.
- **`./verify.sh` exits 0** at this subject, so every reader quoted below is
  pinned against its synthesised fixture.

## The replication question

`compare-runs.mjs` with r92's ledger as the baseline and r94's as the re-run,
folded over the scored 43.

| | scored (43) | raw (45) |
| --- | ---: | ---: |
| both resolved | 33 | 33 |
| both unresolved | 8 | 8 |
| **r92 resolved, r94 not** | **1** | **1** |
| **r94 resolved, r92 not** | **1** | **3** |
| **agreement** | **41 of 43 (95 %)** | **41 of 45 (91 %)** |

The two extra rows in the raw column are the excluded `psf/requests` pair, whose
disagreement is the grading environment's and is the reason they are excluded.

**Two instances flip, one in each direction, and neither flip is a harness
fault.**

### `django__django-11815` — r92 resolved, r94 unresolved

3 → 6 frames, $0.19 → $0.45. Both runs found the same file and the same
function. r92 replaced the body outright; r94 guarded the same replacement
behind a type test:

```
r92  ->  return "%s.%s[%r]" % (module, enum_class.__name__, self.value.name), {'import %s' % module}

r94  ->  if isinstance(self.value.value, Promise):
             imports = {'import %s' % module}
             return "%s.%s[%r]" % (module, enum_class.__name__, self.value.name), imports
         v_string, v_imports = serializer_factory(self.value.value).serialize()
```

The gold behaviour is unconditional. r94's guard makes the fix apply only to
lazy values, so the `FAIL_TO_PASS` case for a plain enum still serialises by
value and still fails. This is a solution-quality draw, not a harness
regression: the run reached the right line and chose a narrower edit. It is the
one instance the baseline resolved that r94 does not, and it was also lost in
r93.

### `django__django-14351` — r92 unresolved, r94 resolved

14 → 27 frames, $1.13 → $2.34. This is the row every report since r91 has had to
answer for, and it resolves for the second wave running — under r93's two extra
rules, and again under r92's contract without them. Its r94 patch is the
smallest of the three: **620 bytes**, against r92's 2,300 and r93's 2,562. It
adds one method:

```
+    def get_group_by_cols(self, alias=None):
+        external_cols = self.get_external_cols()
+        if any(col.possibly_multivalued for col in external_cols):
+            return [self]
+        return external_cols
```

The instance is expensive — 27 frames and $2.34, the dearest row in the wave —
but it is no longer unexplained, and it no longer depends on a contract change
to reach.

### Where the +$2.85 went

Four instances account for **+$5.09**; the other 39 net **−$2.24**.

| instance | r92 | r94 | Δ$ | frames | verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| `sympy__sympy-19495` | $0.43 | $2.20 | +1.76 | 7 → 29 | unresolved both |
| `django__django-14351` | $1.13 | $2.34 | +1.21 | 14 → 27 | unresolved → **resolved** |
| `sphinx-doc__sphinx-7590` | $0.88 | $2.00 | +1.12 | 11 → 26 | unresolved both |
| `django__django-15380` | $0.30 | $1.30 | +1.00 | 3 → 17 | resolved both |

Three of the four are instances whose verdict did not move. On the same
contract, the same seat and the same population, four rows out of 43 swung
$5.09 between two draws. That is the size of the wave-to-wave noise this
programme has been reading three-verdict differences against, and it is the
number §"What to do next" leans on.

## What the revert did, on the two rows it was ranked for

r93 shipped two contract rules with one named control each, and both A/Bs came
back negative. The revert is settled against those same two rows.

| | r90 | r91 | r92 | r93 | **r94** |
| --- | --- | --- | --- | --- | --- |
| **`astropy__astropy-14369`** (rule 9's control) | | | | | |
| verdict | unresolved | resolved | unresolved | unresolved | unresolved |
| frames | 8 | 5 | 8 | **41** | **10** |
| cost | $0.64 | $0.52 | $0.67 | **$3.06** | **$0.67** |
| agent seconds | 245 | 354 | 285 | **1,163** | **252** |
| **`django__django-13212`** (rule 10's control) | | | | | |
| verdict | unresolved | unresolved | unresolved | unresolved | unresolved |
| files in the captured patch | 1 | 1 | 1 | 1 | 1 |
| frames / cost | 6 / $0.71 | 10 / $1.45 | 13 / $1.24 | 6 / $0.62 | 9 / $0.74 |

`astropy__astropy-14369` is back at r92's cost to the cent — $0.67 against
$0.67 — and at 10 frames against r93's 41. The instance that rule 9 alone took
to $3.06 costs what it cost before the rule existed. That is the revert doing
exactly what the ranked list said it would.

`django__django-13212` still edits one file and still does not resolve. Rule 10
never moved it and its removal does not move it either, which is the honest
reading of a rule that was measured as unreachable rather than harmful.

Across the whole wave the patches are slightly *more* multi-file without rule 10
than with it — 51 files across 45 patches and 4 patches touching more than one,
against r93's 47 and 3 — which is one more small piece of evidence that the rule
was not the thing producing multi-file patches.

**And the contract shrank back.** The taught prefix is one segment, rendered into
every frame's request and paid once at full price and then at cache rates.

| | r90 | r91 | r92 | r93 | **r94** |
| --- | --- | --- | --- | --- | --- |
| cell contract | 8,197 chars / 2,105 est tokens | 11,312 chars | 9,193 chars / 2,352 est tokens | 9,715 chars / 2,483 est tokens | **9,193 chars / 2,352 est tokens** |
| contract digest | — | — | `25a1c933…` | `82603dd2…` | **`25a1c933…`** |

−522 characters and −131 estimated tokens against r93, and against that: −70
frames, −$6.63 and +3 verdicts.

The task prompt did not change, and the numbers say so exactly: 45 of 45
instances told a project interpreter, mean 4,887 bytes, 219,933 bytes across the
wave — the same three numbers r92 and r93 report. Every one of the 45 images
answered `/opt/miniconda3/envs/testbed/bin/python`; 275 calls named the taught
path, **zero** passed a bare interpreter, and 2 calls in one instance went
hunting for one.

## The shape of the wave

Read off the 45 journals by `lib/program-evidence.mjs`,
`lib/surgery-evidence.mjs` and `lib/round3-evidence.mjs`, which count
`control.agent.*` events and nothing else. Every column is the same reader over
that wave's own journals, so each row is one rule applied five times rather than
one report quoting another.

| | r90 | r91 | r92 | r93 | **r94** |
| --- | ---: | ---: | ---: | ---: | ---: |
| frames (raw) | 452 | 527 | 291 | 406 | **333** |
| calls | 1,276 | 1,366 | 915 | 1,259 | **1,078** |
| zero-call frames | 75 | 81 | 42 | 66 | **40** |
| dead frames (no transition applied) | 30 | 21 | 4 | 4 | **4** |
| read-only demands fired | 6 | 14 | 0 | 5 | **3** |
| edit calls | 113 | 86 | 100 | 143 | **116** |
| of those, failed | 11 | 4 | 3 | 12 | **5** |
| frames holding a failed call | 21 | 8 | 7 | 20 | **13** |
| of those, recovered in-cell | 4 (19 %) | 7 (88 %) | 7 (100 %) | 20 (100 %) | **13 (100 %)** |
| `bash` calls passing a payload as data | 0 | 314 | 155 | 205 | **170** |
| `bash` calls composing a shell string | 587 | 282 | 194 | 357 | **245** |
| interpreter hunt (calls) | 0 | 47 | 1 | 0 | **2** |
| instances at the 1,200 s budget | 1 | 11 | 0 | 1 | **1** |
| empty patches | 1 | 5 | 0 | 1 | **0** |
| files touched across 45 patches | 49 | 43 | 55 | 47 | **51** |
| patches touching more than one file | 4 | 3 | 6 | 3 | **4** |
| mean cell size | 2,972 B | 3,687 B | 2,631 B | 2,638 B | **2,517 B** |
| output tokens per frame | 2,127 | 3,071 | 1,756 | 1,880 | **1,777** |

Three of these are the wave's own records: **the fewest zero-call frames** (40),
**the smallest mean cell** (2,517 B), and — with r92 — the fewest dead frames.
The mean-cell row is one fold over all five waves' journals, which reads r90's
cell at 2,972 B where r93's table printed 2,971 B; that one byte is a rounding
difference between two folds and nothing else.

Zero-call frames are the number worth watching. r93 had 66 of them and lost the
wave to deliberation; r94 has 40, fewer than r92's 42, and the read-only cap
fired 3 times rather than 5. Nothing in the harness changed to produce that. The
contract did.

## Transport hardening

`22bf30632` did two things: bounded the ladder by a 45-second wall clock as well
as by five rungs, and gave `RequestExecutor` a `Transport` it can rebuild after
three consecutive transport failures. r93 measured neither, because r93 had zero
retries of any class. **This wave had an incident.**

| | r90 | r91 | r92 (main) | r92 (crashed) | r93 | **r94** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| model retries | 1 | 0 | 1 | 10 | 0 | **1** |
| of those, `transport` | 0 | 0 | 0 | 10 | 0 | **1** |
| ladders | 1 | 0 | 1 | 2 | 0 | **1** |
| ladders that survived | 1 | 0 | 1 | **0** | 0 | **1** |
| ladders exhausted at five rungs | 0 | 0 | 0 | **2** | 0 | **0** |
| instances lost to a dead socket | 0 | 2 | 0 | 0 (re-run) | 0 | **0** |

The incident, read off `django__django-15732`'s journal:

| | |
| --- | --- |
| frame | 3 (`turn-opened` at `1787416857068`) |
| rungs | 1, `code: transport`, `attempt: 1`, `delayMillis: 1197` |
| span, `turn-opened` to the rung | **11,584 ms** |
| what followed | `control.agent.model-settled`, same frame, `+1 ms` |
| how the instance ended | **resolved**, 7 frames, $0.46 |

**This is the first transport-class ladder in the program that recovered.** r92's
two ran five rungs each, spanned 37,469 ms and 41,551 ms, never settled, and
killed their runs. r94's ran one rung and settled.

Three things have to be said honestly about what that does and does not
establish.

- **The rebuild is entailed but not observed.** A rebuild exchanges one HTTP
  client for another inside a process and produces no journal event, by design.
  What the journal shows is an outer rung carrying `code: transport`, which
  means the request's own bounded retry (`MAX_RETRIES = 2`, so three attempts)
  had already exhausted itself on the transport before the sealed step's ladder
  saw anything. `rebuildAfter` is 3 — chosen to be exactly one request's worth
  of attempts — so if all three of those inner attempts were transport-class,
  the counter was at its threshold and the rung's attempt ran on a fresh Undici
  agent. The journal records the class of the outer rung only, and the inner
  ladder retries any retryable error, so "all three were transport" is an
  inference from the outer code and not a record. The wave establishes the
  outcome; it does not photograph the swap.
- **One incident is not a rate.** r92's evidence for the failure mode was two
  ladders; r94's evidence for the repair is one. A single recovery is consistent
  with the rebuild working and equally consistent with a socket that came back
  on its own after one second.
- **The 45,000 ms window is still unexercised.** The one ladder spanned
  11,584 ms, well inside it, so nothing in this wave says whether the bound
  helps. It remains unfalsified, which is where r93 left it and where it should
  stay until a ladder actually exceeds it.

## Verdicts that moved, against the baseline

**Recovered (10)** — the baseline resolved it, some wave since did not, and this
one does: `django__django-11299`, `django__django-13343`,
`django__django-14351`, `django__django-15732`, `django__django-15987`,
`matplotlib__matplotlib-22865`, `pydata__xarray-7393`,
`pytest-dev__pytest-6197`, `sympy__sympy-13878`, `sympy__sympy-20154`.

Four of those ten are r93's own losses coming back, and one is worth reading.
`pytest-dev__pytest-6197` was r93's clearest failure — 25 frames, $2.25, and 14
consecutive frames that issued no call at all. In r94 it resolves in **4 frames
for $0.22**, cheaper and shorter than any wave including r92's 6 frames and
$0.41. r93's third next-step asked why those 14 frames issued no call; the
answer this wave gives is that they were the contract's doing, and that removing
522 characters removed the behaviour.

`django__django-15732`, r93's only empty patch — the run that edited correctly
at frame 7 and reverted at frame 8 — resolves in 7 frames for $0.46, and is also
the instance that absorbed the wave's one transport incident.

**Gained over the baseline (2):** `django__django-13821` and
`pydata__xarray-7233`. Both were r92 gains and both hold, for the third wave
running.

**Still lost against the baseline (1):** `django__django-11815`, analysed above.
It is the only one, against 7 in r91, 3 in r92 and 4 in r93.

## The honest codex comparison

`compare-arms.mjs` over this ledger and the codex backfill's. Both arms have a
grading on all 45; both arms lose the same two rows to the exclusion; the four
cells below are over the graded intersection, which here is the whole scored 43.

| | r90 | r91 | r92 | r93 | **r94** |
| --- | ---: | ---: | ---: | ---: | ---: |
| both resolved | 32 | 27 | 34 | 30 | **33** |
| **flows only** | 1 | 1 | 0 | 1 | **1** |
| **codex only** | 6 | 11 | 4 | 8 | **5** |
| neither | 4 | 4 | 5 | 4 | **4** |
| flows resolved | 33/43 (77 %) | 28/43 (65 %) | 34/43 (79 %) | 31/43 (72 %) | **34/43 (79 %)** |
| codex resolved | 38/43 (88 %) | 38/43 (88 %) | 38/43 (88 %) | 38/43 (88 %) | **38/43 (88 %)** |

Raw, over all 45: flows 36 and codex 40.

**The standing superset goal still fails.** codex-only is 5:
`pydata__xarray-7229`, `django__django-11815`, `sphinx-doc__sphinx-7590`,
`django__django-12273`, `sympy__sympy-19495`. flows-only is 1,
`django__django-14351`.

Four honest qualifications, in decreasing order of how much they matter.

1. **`sphinx-doc__sphinx-7590` is not a scoreboard row in either direction.**
   `analysis/PROGRAM.md` §6-R2 records that codex's resolve there rests on
   fetching the project's later 3.x history, which the standing no-cheating rule
   rejects, and that the consequence — the row stays in codex's scoreboard — is
   recorded rather than corrected. §6-R2 says the same of `24970`. Read without
   it, codex-only is 4 and the gap is `7229`, `11815`, `12273`, `19495`.
2. **r93's claim that flows-only was non-empty "for the first time in the
   program" was wrong, and this report corrects it.** `fullbench/arms.md` — the
   baseline's own scoreboard, committed before r91 ran — already shows
   flows-only = 1, on `django__django-14351`, the same instance. r91's shows
   flows-only = 1 on `astropy__astropy-14369`. The correct statement is that
   flows-only has been 1 in four of five waves and 0 in exactly one, r92.
3. **There is no dollar column on the codex side.** The codex ledger carries
   wall clock and tokens but no price, because the arm runs on a subscription.
   Every cost and speed claim in this report is flows against flows' own earlier
   waves. The codex comparison is verdicts only, and saying otherwise would be
   the same error as quoting a rate without its denominator.
4. **codex's 38/43 has not moved in five waves.** It is one backfill, graded
   once. The flows column has moved between 28 and 34 across five measurements
   of the same population; nothing here says the codex number would be as
   stable if it were measured five times.

## Per instance

Frames and dollars are each wave's own ledger. `frames` and `agent s` read
r90 → r91 → r92 → r93 → r94. The full table, including both excluded rows, is
`fullbench/rerun-r94/vs/n-way.md`.

| instance | r90 | r91 | r92 | r93 | r94 | $ r92 | $ r93 | $ r94 | frames | agent s (r92 → r94) |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| astropy__astropy-14365 | unresolved | unresolved | unresolved | unresolved | unresolved | $1.00 | $0.59 | $0.49 | 4 → 8 → 11 → 10 → 4 | 448 → 187 |
| astropy__astropy-14369 | unresolved | resolved | unresolved | unresolved | unresolved | $0.67 | $3.06 | $0.67 | 8 → 5 → 8 → 41 → 10 | 285 → 252 |
| astropy__astropy-7166 | resolved | resolved | resolved | resolved | resolved | $0.13 | $0.16 | $0.32 | 5 → 2 → 2 → 3 → 5 | 58 → 119 |
| astropy__astropy-8707 | resolved | resolved | resolved | resolved | resolved | $0.29 | $0.93 | $0.36 | 15 → 14 → 6 → 12 → 6 | 99 → 150 |
| django__django-10914 | resolved | resolved | resolved | resolved | resolved | $0.22 | $0.43 | $0.15 | 15 → 6 → 4 → 9 → 3 | 92 → 52 |
| django__django-11299 **recovered** | resolved | empty patch | resolved | resolved | resolved | $0.73 | $0.74 | $0.34 | 11 → 14 → 10 → 9 → 5 | 312 → 123 |
| django__django-11490 | resolved | resolved | resolved | resolved | resolved | $0.20 | $0.44 | $0.28 | 13 → 17 → 3 → 6 → 5 | 73 → 107 |
| django__django-11815 **lost** | resolved | resolved | resolved | unresolved | unresolved | $0.19 | $0.74 | $0.45 | 3 → 21 → 3 → 9 → 6 | 62 → 172 |
| django__django-12273 | unresolved | unresolved | unresolved | unresolved | unresolved | $0.48 | $0.27 | $0.79 | 8 → 7 → 6 → 3 → 8 | 242 → 310 |
| django__django-12741 | resolved | resolved | resolved | resolved | resolved | $0.21 | $0.95 | $0.31 | 9 → 3 → 3 → 12 → 5 | 83 → 122 |
| django__django-13128 | resolved | resolved | resolved | resolved | resolved | $0.38 | $0.84 | $0.47 | 8 → 13 → 3 → 11 → 6 | 99 → 193 |
| django__django-13212 | unresolved | unresolved | unresolved | unresolved | unresolved | $1.24 | $0.62 | $0.74 | 6 → 10 → 13 → 6 → 9 | 619 → 333 |
| django__django-13343 **recovered** | resolved | empty patch | resolved | resolved | resolved | $0.13 | $0.30 | $0.20 | 2 → 18 → 2 → 3 → 3 | 40 → 58 |
| django__django-13346 | resolved | resolved | resolved | resolved | resolved | $0.79 | $0.48 | $0.86 | 29 → 10 → 11 → 6 → 10 | 324 → 312 |
| django__django-13406 | resolved | resolved | resolved | resolved | resolved | $0.26 | $0.24 | $0.29 | 3 → 4 → 3 → 3 → 4 | 114 → 105 |
| django__django-13821 **gained** | unresolved | resolved | resolved | resolved | resolved | $1.47 | $0.33 | $1.94 | 11 → 12 → 16 → 5 → 24 | 957 → 803 |
| django__django-14351 **recovered** | resolved | unresolved | unresolved | resolved | **resolved** | $1.13 | $1.68 | $2.34 | 34 → 25 → 14 → 21 → 27 | 448 → 934 |
| django__django-15380 | resolved | resolved | resolved | resolved | resolved | $0.30 | $1.49 | $1.30 | 9 → 11 → 3 → 17 → 17 | 134 → 490 |
| django__django-15569 | resolved | resolved | resolved | resolved | resolved | $0.35 | $0.39 | $0.23 | 3 → 5 → 4 → 5 → 4 | 139 → 77 |
| django__django-15732 **recovered** | resolved | resolved | resolved | empty patch | resolved | $0.83 | $0.83 | $0.46 | 9 → 20 → 9 → 10 → 7 | 371 → 188 |
| django__django-15987 **recovered** | resolved | empty patch | resolved | resolved | resolved | $0.16 | $0.27 | $0.17 | 4 → 19 → 3 → 3 → 3 | 67 → 61 |
| django__django-16612 | resolved | resolved | resolved | resolved | resolved | $0.39 | $0.30 | $0.17 | 3 → 2 → 5 → 3 → 3 | 147 → 55 |
| django__django-16662 | resolved | resolved | resolved | resolved | resolved | $0.30 | $0.27 | $0.15 | 7 → 8 → 6 → 3 → 3 | 160 → 53 |
| django__django-16899 | resolved | resolved | resolved | resolved | resolved | $0.21 | $0.41 | $0.48 | 20 → 20 → 3 → 6 → 6 | 73 → 198 |
| django__django-16901 | resolved | resolved | resolved | resolved | resolved | $0.48 | $0.28 | $0.28 | 6 → 11 → 7 → 4 → 6 | 317 → 95 |
| matplotlib__matplotlib-20826 | resolved | resolved | resolved | resolved | resolved | $0.48 | $0.83 | $0.26 | 5 → 9 → 4 → 7 → 4 | 214 → 78 |
| matplotlib__matplotlib-20859 | resolved | resolved | resolved | resolved | resolved | $0.27 | $0.16 | $0.13 | 2 → 5 → 3 → 2 → 2 | 105 → 38 |
| matplotlib__matplotlib-22865 **recovered** | resolved | resolved | resolved | unresolved | resolved | $0.20 | $0.32 | $0.36 | 36 → 10 → 4 → 4 → 5 | 70 → 151 |
| matplotlib__matplotlib-24970 | resolved | resolved | resolved | resolved | resolved | $0.30 | $0.40 | $0.51 | 8 → 3 → 4 → 7 → 6 | 153 → 225 |
| psf__requests-1766 **excluded** | resolved | resolved | unresolved | unresolved | resolved | $0.24 | $0.34 | $0.16 | 3 → 4 → 4 → 5 → 3 | 133 → 56 |
| psf__requests-2317 **excluded** | resolved | resolved | unresolved | unresolved | resolved | $0.42 | $0.31 | $0.19 | 4 → 5 → 7 → 4 → 3 | 321 → 61 |
| pydata__xarray-7229 | unresolved | unresolved | unresolved | unresolved | unresolved | $1.47 | $0.55 | $0.44 | 20 → 9 → 9 → 6 → 6 | 323 → 129 |
| pydata__xarray-7233 **gained** | unresolved | unresolved | resolved | resolved | resolved | $0.24 | $0.32 | $0.20 | 3 → 25 → 5 → 5 → 4 | 79 → 67 |
| pydata__xarray-7393 **recovered** | resolved | empty patch | resolved | resolved | resolved | $0.80 | $1.36 | $0.60 | 9 → 22 → 12 → 16 → 8 | 285 → 222 |
| pytest-dev__pytest-6197 **recovered** | resolved | resolved | resolved | unresolved | resolved | $0.41 | $2.25 | $0.22 | 5 → 20 → 6 → 25 → 4 | 148 → 70 |
| sphinx-doc__sphinx-11445 | resolved | resolved | resolved | resolved | resolved | $0.45 | $0.42 | $0.38 | 3 → 8 → 7 → 6 → 5 | 158 → 130 |
| sphinx-doc__sphinx-7590 | empty patch | unresolved | unresolved | unresolved | unresolved | $0.88 | $0.82 | $2.00 | 39 → 23 → 11 → 12 → 26 | 886 → 737 |
| sphinx-doc__sphinx-7757 | resolved | resolved | resolved | resolved | resolved | $0.20 | $0.33 | $0.51 | 5 → 12 → 4 → 5 → 5 | 64 → 201 |
| sphinx-doc__sphinx-8721 | resolved | resolved | resolved | resolved | resolved | $0.70 | $2.72 | $0.27 | 19 → 15 → 9 → 34 → 5 | 283 → 95 |
| sympy__sympy-13372 | resolved | resolved | resolved | resolved | resolved | $0.12 | $0.16 | $0.10 | 3 → 11 → 2 → 2 → 2 | 39 → 26 |
| sympy__sympy-13878 **recovered** | resolved | empty patch | resolved | resolved | resolved | $1.98 | $1.87 | $1.79 | 24 → 21 → 24 → 18 → 17 | 1113 → 1102 |
| sympy__sympy-16450 | resolved | resolved | resolved | resolved | resolved | $0.12 | $0.33 | $0.24 | 3 → 5 → 2 → 4 → 3 | 41 → 86 |
| sympy__sympy-18763 | unresolved | unresolved | unresolved | unresolved | unresolved | $0.33 | $0.18 | $0.17 | 5 → 16 → 6 → 3 → 3 | 143 → 57 |
| sympy__sympy-19495 | unresolved | unresolved | unresolved | unresolved | unresolved | $0.43 | $0.91 | $2.20 | 9 → 15 → 7 → 13 → 29 | 184 → 893 |
| sympy__sympy-20154 **recovered** | resolved | unresolved | resolved | resolved | resolved | $0.18 | $0.62 | $0.32 | 2 → 4 → 3 → 8 → 4 | 63 → 125 |

## What this settles, and what it does not

**Settled: r92's result replicates.** Same contract text, same population, same
seat, a second draw: 34/43 both times, 41 of 43 instances on the same verdict,
and the two flips are one narrower patch and one better one. The contract that
produced the program's best wave produces it again. Four waves of argument about
doctrine now rest on a number that has been measured twice.

**Settled: reverting rules 9 and 10 did what r93 predicted.** Rule 9's own
control instance costs $0.67 again against r93's $3.06, at 10 frames against 41.
r93's four losses are three recovered, and the fourth is a solution-quality
difference rather than the rule. The wave is three verdicts and $6.63 better
than r93 on 522 fewer characters of teaching.

**Settled: the wave-to-wave noise is about four instances and about $5.** Four
rows swung $5.09 between two runs of an identical contract, with three of them
not moving a verdict. Any future finding smaller than that is not distinguishable
from a draw, and this report's own +$2.85 against r92 is inside it.

**Settled, again: the `psf/requests` exclusion is right.** A byte-identical
patch has now graded `resolved`, `unresolved` and `resolved` across three waves.

**Partly settled: the transport rebuild.** For the first time a transport-class
ladder recovered — one rung, settled in the same frame, instance resolved — where
r92's two exhausted five rungs and died. That is the outcome the change was
written for. It is one incident, the swap itself is not journaled, and the
45,000 ms window was never approached, so the honest verdict is "consistent with
working" rather than "confirmed".

**Not settled: the cost target.** $24.96 against a $15.00 ceiling, and 185
minutes against 120. Both are the second-best readings in the program and both
still fail.

**Not settled: the superset goal.** codex-only is 5, or 4 once §6-R2's
`sphinx-7590` is set aside; flows-only is 1. flows 34/43 against codex 38/43.

**Not settled: `VacuousVerification`.** It is off the live path and unpriced.
This wave says nothing about it, which is exactly what taking it off the live
path was for.

### What to do next, in order

1. **Stop paying for contract experiments one wave at a time, and measure the
   noise floor directly.** This wave establishes that two runs of an identical
   subject differ by $5 on four instances and by two verdicts. Three of the last
   four waves were decided by margins at or below that. The cheapest way to make
   the programme's conclusions mean something is one more identical repeat —
   r95 on this same subject, changing nothing — which turns "34, 34" into a
   variance and lets every later report state a difference against it. It costs
   about $25 and answers a question no harness change can.
2. **Price `VacuousVerification` alone, on this contract, in its own lane.** It
   is off the live path, it costs no prompt tokens, and r93's two firings —
   one run that replaced its proof and resolved, one that reverted its own
   correct edit — are still the only data. Re-wire it, run the 45, change
   nothing else. r93 asked for this and the revert made it possible; the only
   reason it is second is that without item 1 a two-verdict result will not be
   readable.
3. **Look at `sympy__sympy-19495` and `sphinx-doc__sphinx-7590`.** They are two
   of the four instances that carried this wave's excess, they are both
   codex-only, and they both went from single-digit frames under r92 to 29 and
   26 here without moving a verdict. Whatever makes an unresolved instance spend
   four times its previous budget on the same contract is the largest single
   lever left in the sample, and it is a run-shape question rather than a
   doctrine one.
4. **Leave the transport ladder alone.** It has now had its incident and the
   incident recovered. The window is still unexercised and tuning an untriggered
   bound remains the wrong move.
5. **Grow the sample.** Unchanged from r93 and more strongly supported by this
   wave than by that one: with a four-instance noise floor on 43, a population
   of 43 cannot resolve the differences the programme is now arguing about.

## Reproducing this

```sh
./preflight.sh                                          # pins the subject
SWB_RERUN_BUDGET_USD=75 ./run-45.sh --lane r94          # the wave itself

node compare-runs.mjs --rerun fullbench/rerun-r94/manifest.jsonl \
  --out fullbench/rerun-r94                             # against the baseline
mkdir -p fullbench/rerun-r94/vs-r92 fullbench/rerun-r94/vs-r93
node compare-runs.mjs --baseline fullbench/rerun-r92/manifest.jsonl \
  --rerun fullbench/rerun-r94/manifest.jsonl \
  --out fullbench/rerun-r94/vs-r92                      # the replication question
node compare-runs.mjs --baseline fullbench/rerun-r93/manifest.jsonl \
  --rerun fullbench/rerun-r94/manifest.jsonl \
  --out fullbench/rerun-r94/vs-r93                      # against r93
mkdir -p fullbench/rerun-r94/vs
node n-way.mjs --wave r90=fullbench/manifest.jsonl \
  --wave r91=fullbench/rerun-r91/manifest.jsonl \
  --wave r92=fullbench/rerun-r92/manifest.jsonl \
  --wave r93=fullbench/rerun-r93/manifest.jsonl \
  --wave r94=fullbench/rerun-r94/manifest.jsonl \
  --out fullbench/rerun-r94/vs                          # all five

node lib/round3-evidence.mjs fullbench/rerun-r94/journals
node lib/round3-evidence.mjs fullbench/rerun-r92/journals-crashed   # the two r92 ladders
node lib/program-evidence.mjs fullbench/rerun-r94/journals
node lib/surgery-evidence.mjs fullbench/rerun-r94/journals \
  --interpreters fullbench/rerun-r94/driver.log
lib/prompt-bytes.sh fullbench/rerun-r94/driver.log
node compare-arms.mjs --manifest fullbench/rerun-r94/manifest.jsonl \
  --codex-manifest fullbench/codex-manifest.jsonl --out fullbench/rerun-r94
./verify.sh                                             # the readers' own fixtures
```

The contract identity check, which is what this wave was gated on:

```sh
git diff de1de1a82 HEAD -- packages/harness/src/internal/cellPrompt.ts   # empty
cd ../../packages/harness && npx vitest run test/CellPrompt.test.ts --coverage.enabled=false
```

The agreement table is a fold of `vs-r92/compare.json`'s `instances[]` under
`lib/excluded.mjs`: an instance is counted in `both resolved` when
`before.resolved && after.resolved`, in a flip when exactly one is true, and the
excluded pair is dropped from the scored column and kept in the raw one.

Every reader takes its numbers off `control.agent.*` events or off a ledger — no
clock, no network, no re-derivation. `n-way.mjs`, `lib/round3-evidence.mjs`,
`three-way.mjs`, `lib/surgery-evidence.mjs`, `lib/program-evidence.mjs` and
`lib/prompt-bytes.sh` are each pinned against synthesised inputs by
`fixtures/check-n-way.mjs`, `fixtures/check-round3-evidence.mjs`,
`fixtures/check-three-way.mjs`, `fixtures/check-surgery-evidence.mjs`,
`fixtures/check-program-evidence.mjs` and `fixtures/check-prompt-bytes.mjs`, all
inside `./verify.sh`, which exits 0 at this subject.

Artifacts: `fullbench/rerun-r94/manifest.jsonl` (the ledger),
`fullbench/rerun-r94/compare.{md,json}` (against the baseline),
`fullbench/rerun-r94/vs-r92/compare.{md,json}` (the replication question),
`fullbench/rerun-r94/vs-r93/compare.{md,json}` (against r93),
`fullbench/rerun-r94/vs/n-way.{md,json}` (all five waves),
`fullbench/rerun-r94/arms.{md,json}` (against codex),
`fullbench/rerun-r94/journals/` (45 journals),
`fullbench/rerun-r94/patches/` (45 patches),
`fullbench/rerun-r94/logs/` (per-instance run and grade logs),
`fullbench/rerun-r94/driver.log`.
