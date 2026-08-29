# The REPL A/B: one realm for a whole run, against the surface that files (r95repl vs r95)

Measured 2026-08-22 22:27Z to 2026-08-23 02:33Z. Two lanes over the same 45
instances, same seeded draw order, same pinned subject, one variable:
`FLOWS_CELL_MODE`. `r95repl` armed `repl`; `r95` armed `filing` and is the
contemporaneous control — the r94 configuration re-run.

**The REPL arm loses no verdict, costs less, and finishes in a third of the
time.** Against the contemporaneous filing control it is +3 verdicts on both
denominators, −18 % on money scored (−21 % raw), and **−64 % on the agent's own
wall clock**. It loses no instance the control resolved: of 45 instances the two
arms agree on 42, and all three disagreements are REPL gains. Against r94 — the
previous draw of the same filing configuration — it ties on verdicts exactly
(34/43, 36/45) and is −18 % on money and −46 % on wall clock.

The mechanism is legible in the token bill and confirmed in the journals. The
REPL arm spends **70 % fewer output tokens** and 45 % more input, because a cell
with no transition object to write is shorter and a print buffer is cheaper to
send than a summary is to compose. And the surface does what it was built to do:
across 45 runs and 358 frames it filed nothing, projected no context, and
**re-read a file it had already been handed zero times**, against 8 such re-reads
in the filing control.

Two cautions travel with that. **Resolved is a tie, not a win**, once r94 is in
the frame: the same filing contract scored 34 and then 31 on two draws, so the
+3 over r95 is inside the filing arm's own draw-to-draw spread. Cost and wall
clock are not — 5,434 s against 10,098 s and 15,325 s across the filing arm's two
draws is outside anything variance explains. And the arm buys its cost win
**inside a worse cache**: the hit rate falls from 62.1 % to 42.3 %, so the bill
moves from output-dominated to uncached-input-dominated, which is where the next
measurement should go.

## What the arm is, and what it is not

`FLOWS_CELL_MODE` selects the cell authoring surface. It is the one variable
these two lanes move, and both lanes ran the same 45 instances in the same
seeded draw order, at the same seat, on the same budgets, from the same pinned
subject.

**`filing`** is the shipped surface. Every cell is the body of its own async
function. Its names vanish when it returns, and what carries forward is the JSON
it filed in `state` plus the `context` entries it projected for the next model
turn. `render` and `recall` name bytes the harness then prints back for free.

**`repl`** gives a run one QuickJS realm for its whole life. A cell is a global
async script, so its top-level `const`/`let`/`var`/`function`/`class` are still
bound in the next cell with the values they had. `console.log` is the channel to
the next model turn. The frame ends by falling off the end of the script, and
the run ends with `ctx.done(output)` rather than a returned transition.
Governing design: `docs/specs/Concepts/Repl Realm.md`.

**The model authoring surface is still plain JavaScript over `await
ctx.call(name, input)`.** The 2026-08-20 ruling stands and this wave does not
test it. What moved is the realm's *lifetime* and the *context channel*, not the
language: both arms write the same JavaScript against the same `ctx.call`, and
`lib/write-flow.mjs` renders a byte-identical task prompt for both.

Neither arm has a review step, an audit step, or anything that knows this is
SWE-bench. The two contracts differ, and the difference is the surface:

| | `filing` | `repl` |
| --- | --- | --- |
| rendered `cell-contract` | `sha256:25a1c933ad18e979fe4282848edee5987b61783f939ac72ff45fee2b6655e8c5` | `sha256:0b0bee6bc27ac53913d4ab3edc23b173d91fefb3fad166756bbca84a898292e0` |
| characters | 9,193 | 7,711 (−1,482, −16 %) |
| est tokens | 2,352 | 1,973 |
| memory between frames | `state`, a JSON document | the realm's bindings |
| channel to the next turn | `context`, `render`, `recall` | `console.log` |
| how a run ends | `{ intent: "complete", … }` | `ctx.done(output)` |

The filing contract is **byte-identical to r92's and r94's** — same digest, same
9,193 characters — so the control lane is a re-run of r94's configuration and not
a new arm wearing its name.

## Preconditions

Both lanes, one pin.

| | |
| --- | --- |
| subject stamp | `sha256:543705ce812f911a76573c2edadd5c9e4d25d3a07d7c97949a0d57b5dc6310bf` |
| git HEAD at the pin | `a9ce6f250c1786b037aec1eca92e467ee109dbf9` |
| HEAD subject | 🧪 test(harness): pin the repl contract, and restore a run that went wrong |
| `@smthrs/harness` src | `sha256:1461b8c895ab4b5b2299da893a4a1cf6c8bd7ad059d65cc757c03c3791f33189` |
| `@smthrs/std` src | `sha256:7d8cadd8b693ca7e959a8dea97f2fd4701be73ebd31350fedb0fadc39dc8be53` — identical to r92, r93 and r94; no tool moved |
| `@smthrs/model` src | `sha256:5c45d25000804ada48a822f60d43c9d08e3fb7688db4bc2d688b15825c96fc95` — identical to r94 |
| preflight refusals | none |
| node | v24.18.0 darwin-arm64 |
| seat | `openai:gpt-5.6-sol`, both lanes |
| attempts | one per instance, both lanes |
| per-instance budget | 1200 s, both lanes |
| in flight | 3, both lanes |
| disk gate | 8192 MiB, both lanes |
| budget gate | $60, both lanes |
| population | the 45 the r90 baseline ledger graded, same seeded draw order, derived by `lib/rerun-queue.mjs` |
| grading | official evaluator, x86_64 images, run ids `rerun-r95repl` and `rerun-r95` |
| arm, as journaled | `cellMode: "repl"` in `rerun-r95repl`'s header and in every run's `discipline-armed`; `cellMode: "filing"` in `rerun-r95`'s |

Both denominators are printed on every rate. `lib/excluded.mjs` names two
instances — `psf__requests-1766` and `psf__requests-2317` — whose verdicts are
statements about the grading environment rather than about a harness. They are
excluded for **both arms** and for the r94 column, they keep their per-instance
rows, and they are in no movement set.

Cost is every attempt, which is what the invoice says. Wall clock is the
journal's own span across the agent's frames, summed per instance — never the
wall clock of the run as a whole, which depends on concurrency.

## Disclosures

- **The two lanes ran sequentially, not interleaved, and the REPL arm ran
  first.** `r95repl` spans 2026-08-22 22:27Z to 2026-08-23 00:03Z (97 min);
  `r95` started 00:04Z. Interleaving was considered and rejected: this machine
  has 16 cores and sat at load 12.4 with three instances in flight, so six would
  have contended for CPU, and the agent's own frame span — which is the wall
  clock this benchmark compares — is exactly what CPU contention inflates. Disk
  allowed it (27 GiB free against an 8 GiB gate); CPU did not. The cost of
  running sequentially is that the arms are two hours apart rather than
  simultaneous; the cost of interleaving would have been a wall-clock column
  neither arm's number was its own.
- **Four commits landed while the REPL lane was in flight, and the pinned
  subject did not move.** Every one of them touches **only `evals/swebench`** —
  `git show --name-only` on each returns nothing outside it — so none is in the
  subject and none is loaded by the per-instance pipeline:

  | commit | at | what |
  | --- | --- | --- |
  | `a97a097ee` | 22:40Z | a sibling session's: the codex arm's sealed lane, its two fixtures and its `verify.sh` lines |
  | `7b097b133` | 22:43Z | `lib/repl-evidence.mjs`, `fixtures/check-repl-evidence.mjs`, the `verify.sh` line that runs it |
  | `cd426be06` | 22:59Z | the wording of that check's own output line |
  | `68f22eff1` | 23:06Z | the elided-print counter in the same reader |

  `lib/subject.mjs --check` exits 0 at the same stamp,
  `sha256:543705ce812f911a76573c2edadd5c9e4d25d3a07d7c97949a0d57b5dc6310bf`,
  before the first of them and after the last, and every `flows.sh` invocation
  in both lanes checked itself against that stamp or refused to run. The r95
  header therefore records `head: 68f22eff1` where the r95repl header records
  `a9ce6f250`: four commits apart, one subject. This is a weaker disclosure than
  r94's, which had an empty `git log` across its whole span; it is stated in
  full rather than rounded to "nothing changed".
- **The r94 journals carry no arm field.** `cellMode` was added to
  `discipline-armed` by the commit that added the arm, so `lib/repl-evidence.mjs`
  reads r94's mode as `unknown`. r94 ran the filing surface — its contract digest
  says so — but the *journaled* filing control is `r95`, which is why this wave
  ran one rather than comparing the REPL arm to r94 alone.
- **Two instances reached the 1,200 s budget, both in the filing control**:
  `pytest-dev__pytest-6197` at 1,206 s (resolved anyway) and
  `sphinx-doc__sphinx-7757` at 1,208 s (empty patch). **No REPL instance came
  close** — its longest harness run was 658 s. Every other harness exit in both
  lanes was 0.
- **One empty patch, in the filing control** (`sphinx-doc__sphinx-7757`, the
  budget hit). The REPL lane recorded none: 45 of 45 patches, mean 1,471 bytes
  against the control's 1,484.
- **Model retries: six in the REPL lane across five instances, seven in the
  control across five.** All recovered. No crashed journals, no
  `journals-crashed/` in either lane, and no instance re-run in either.
- **Neither budget gate was reached and neither disk gate blocked**: no `note`
  row of any kind in either ledger, and no wait line in either driver log.
- **`./verify.sh` exits 0** at this subject, so every reader quoted below —
  including `lib/repl-evidence.mjs`, whose definitions this report turns on — is
  pinned against its synthesised fixture.

## The three-way

`node three-way.mjs --baseline r94 --first r95 --second r95repl`, written to
`fullbench/reports/repl-ab-three-way.md`. Both denominators on every row a name
can reach.

| | r94 (filing) | **r95 (filing control)** | **r95repl (REPL)** | repl vs control | repl vs r94 |
| --- | ---: | ---: | ---: | ---: | ---: |
| **resolved (scored, 43)** | 34 | **31** | **34** | **+3** | +0 |
| resolved (raw, 45) | 36 | 33 | 36 | +3 | +0 |
| **total cost (scored)** | $24.96 | **$24.98** | **$20.37** | **−$4.61 (−18 %)** | −$4.59 (−18 %) |
| total cost (raw) | $25.31 | $26.61 | $21.14 | −$5.46 (−21 %) | −$4.17 (−16 %) |
| **agent wall (scored)** | 9,981 s | **14,232 s** | **5,168 s** | **−9,064 s (−64 %)** | −4,813 s (−48 %) |
| agent wall (raw) | 10,098 s | 15,325 s | 5,434 s | −9,891 s (−65 %) | −4,664 s (−46 %) |
| instance wall (scored) | 11,120 s | 15,618 s | 5,914 s | −9,704 s (−62 %) | −5,206 s (−47 %) |
| frames (scored) | 327 | 323 | 340 | +17 (+5 %) | +13 (+4 %) |
| frames (raw) | 333 | 342 | 358 | +16 | +25 |
| calls (raw) | 1,078 | 1,063 | 796 | −267 (−25 %) | −282 (−26 %) |
| calls per frame | 3.24 | 3.11 | 2.22 | −0.89 | −1.02 |
| output tokens (raw) | 591,709 | 635,103 | 190,079 | **−445,024 (−70 %)** | −401,630 (−68 %) |
| input tokens (raw) | 3,392,916 | 3,427,962 | 4,984,761 | **+1,556,799 (+45 %)** | +1,591,845 (+47 %) |
| cache rate (raw) | 61.6 % | 62.1 % | 42.3 % | **−19.8 pp** | −19.3 pp |
| mean agent s per instance | 224 s | 341 s | 121 s | −220 s | −103 s |
| wave wall clock, 3 in flight | 110 min | 149 min | 97 min | −52 min | −13 min |

Per instance against the control: **43 of 45 faster**, 2 slower; 27 cheaper, 18
dearer; 12 with fewer frames, 30 with more. Against r94: 29 faster, 16 slower;
22 cheaper, 23 dearer.

**Read the r94 column before reading the win.** r94 and r95 are two draws of the
identical configuration — the same 9,193-character contract, digest
`25a1c933…`, at seats and budgets that did not move — and they differ by three
verdicts (34 → 31), 43 % of wall clock (9,981 s → 14,232 s) and $1.30 raw. That
spread is the filing arm's own noise, and it is exactly the size of the REPL
arm's verdict gain. So:

- **resolved: a tie.** 34 = 34 against r94, +3 against r95. Nothing here says the
  realm resolves more; it says it does not resolve less, twice.
- **cost: a win, small.** −18 % against both filing draws, which agree with each
  other to within 5 % raw. The effect is larger than the noise but not by much.
- **wall clock: a win, large.** 5,434 s against 10,098 s and 15,325 s. The REPL
  arm is faster than the *faster* of the two filing draws by 46 %, and the gap
  to either is several times the gap between them.

### Where the money went

Same price table, `openai:gpt-5.6-sol` at $5.00/M uncached input, $0.50/M cached
input, $30.00/M output. The bill, raw:

| | r94 | r95 | r95repl |
| --- | ---: | ---: | ---: |
| uncached input | $6.51 | $6.49 | **$14.39** |
| cached input | $1.05 | $1.07 | $1.05 |
| output | **$17.75** | **$19.05** | $5.70 |
| total | $25.31 | $26.61 | $21.14 |

The filing arm's invoice is an output invoice: 70 % of r94's and 72 % of r95's is
the model writing transitions, state documents and context summaries. The REPL
arm's is an input invoice — 73 % of it — because it writes a third as much and
reads half again as much, and at a
6:1 output-to-input price ratio that trade is worth $5.46. **It is also fragile.**
If the price ratio narrows, or if the cache rate falls further as runs get
longer, the same trade stops paying. The cost win is a consequence of today's
prices; the wall-clock win is not.

## Per-instance agreement

The A/B proper, `r95` against `r95repl`, both arms over all 45:

| | |
| --- | --- |
| instances compared | 45 |
| **agree on the verdict** | **42** |
| disagree | 3 |
| REPL gained | 3 — `django__django-14351`, `sphinx-doc__sphinx-7757`, `sympy__sympy-19495` |
| REPL lost | **0** |

Nothing the filing control resolved was lost by the REPL arm. That is the
strongest single line in this wave: an arm that trades away a mechanism usually
pays for it somewhere, and this one has no row where it did.

The three disagreements, each with its own reason legible in the journals:

| instance | r94 | r95 (filing) | r95repl (REPL) |
| --- | --- | --- | --- |
| `django__django-14351` | resolved, 27 frames, $2.34, 934 s | **unresolved**, 25 frames, $2.19, 1,075 s | **resolved**, 15 frames, $1.65, 232 s |
| `sphinx-doc__sphinx-7757` | resolved, 5 frames, $0.51, 201 s | **empty patch**, 24 frames, $2.16, 1,177 s — hit the 1,200 s budget | **resolved**, 6 frames, $0.91, 250 s |
| `sympy__sympy-19495` | unresolved, 29 frames, $2.20, 893 s | unresolved, 10 frames, $0.69, 369 s | **resolved**, 6 frames, $0.19, 42 s |

`sympy__sympy-19495` is the wave's sharpest instance. **It has never resolved in
this program**: `unresolved` in r90, r91, r92, r93, r94 and r95 — 29 frames and
$2.20 in r94, 10 frames and $0.69 in r95. The REPL arm took it in **6 frames,
$0.19 and 42 seconds**, a 21× cut in the agent's own wall clock against r94 and
the verdict with it.

Two of the three are also instances where the filing control demonstrably lost
track of what it had read; that is the next section.

### All 45, side by side

`carried refs` is the REPL run's own; `re-reads` is the information-repeat count
of each arm, the note-taking failure defined below. r94 is shown for context and
is not part of the agreement count.

| instance | r94 | r95 filing | r95repl REPL | agree | $ r95 | $ repl | agent s r95 → repl | frames r95 → repl | carried refs | re-reads r95 → repl |
| --- | --- | --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `astropy__astropy-14365` | unresolved | unresolved | unresolved | yes | $0.26 | $0.24 | 172 → 48 | 4 → 6 | 7 | 0 → 0 |
| `astropy__astropy-14369` | unresolved | unresolved | unresolved | yes | $0.57 | $0.59 | 244 → 110 | 9 → 9 | 8 | 0 → 0 |
| `astropy__astropy-7166` | resolved | resolved | resolved | yes | $0.20 | $0.19 | 111 → 47 | 4 → 5 | 7 | 0 → 0 |
| `astropy__astropy-8707` | resolved | resolved | resolved | yes | $0.51 | $0.40 | 452 → 108 | 6 → 8 | 12 | 0 → 0 |
| `django__django-10914` | resolved | resolved | resolved | yes | $0.75 | $0.66 | 387 → 117 | 11 → 13 | 9 | 0 → 0 |
| `django__django-11299` | resolved | resolved | resolved | yes | $0.65 | $0.47 | 328 → 102 | 7 → 11 | 14 | 0 → 0 |
| `django__django-11490` | resolved | resolved | resolved | yes | $0.42 | $0.39 | 213 → 77 | 6 → 8 | 8 | 0 → 0 |
| `django__django-11815` | unresolved | resolved | resolved | yes | $0.35 | $0.41 | 260 → 157 | 5 → 3 | 7 | 0 → 0 |
| `django__django-12273` | unresolved | unresolved | unresolved | yes | $0.34 | $0.28 | 159 → 121 | 5 → 6 | 6 | 0 → 0 |
| `django__django-12741` | resolved | resolved | resolved | yes | $0.46 | $0.36 | 256 → 83 | 8 → 9 | 4 | 0 → 0 |
| `django__django-13128` | resolved | unresolved | unresolved | yes | $0.90 | $0.53 | 399 → 117 | 14 → 11 | 8 | 0 → 0 |
| `django__django-13212` | unresolved | unresolved | unresolved | yes | $0.92 | $0.40 | 473 → 71 | 12 → 9 | 12 | 0 → 0 |
| `django__django-13343` | resolved | resolved | resolved | yes | $0.22 | $0.24 | 104 → 66 | 3 → 5 | 4 | 0 → 0 |
| `django__django-13346` | resolved | resolved | resolved | yes | $0.44 | $0.85 | 192 → 160 | 6 → 12 | 10 | 0 → 0 |
| `django__django-13406` | resolved | resolved | resolved | yes | $0.82 | $0.34 | 409 → 74 | 10 → 8 | 9 | 0 → 0 |
| `django__django-13821` | resolved | resolved | resolved | yes | $0.50 | $0.36 | 249 → 72 | 7 → 8 | 13 | 0 → 0 |
| `django__django-14351` | resolved | unresolved | resolved | **no** | $2.19 | $1.65 | 1075 → 232 | 25 → 15 | 18 | 1 → 0 |
| `django__django-15380` | resolved | resolved | resolved | yes | $0.40 | $0.50 | 209 → 81 | 8 → 12 | 9 | 0 → 0 |
| `django__django-15569` | resolved | resolved | resolved | yes | $0.39 | $0.28 | 235 → 84 | 7 → 6 | 6 | 0 → 0 |
| `django__django-15732` | resolved | unresolved | unresolved | yes | $0.38 | $0.69 | 207 → 145 | 6 → 12 | 12 | 0 → 0 |
| `django__django-15987` | resolved | resolved | resolved | yes | $0.17 | $0.32 | 111 → 106 | 3 → 3 | 8 | 0 → 0 |
| `django__django-16612` | resolved | resolved | resolved | yes | $0.18 | $0.16 | 123 → 92 | 3 → 1 | 0 | 0 → 0 |
| `django__django-16662` | resolved | resolved | resolved | yes | $0.36 | $0.27 | 267 → 76 | 5 → 7 | 7 | 0 → 0 |
| `django__django-16899` | resolved | resolved | resolved | yes | $0.36 | $0.39 | 284 → 114 | 5 → 9 | 3 | 0 → 0 |
| `django__django-16901` | resolved | resolved | resolved | yes | $0.23 | $0.70 | 134 → 276 | 4 → 5 | 10 | 0 → 0 |
| `matplotlib__matplotlib-20826` | resolved | resolved | resolved | yes | $0.29 | $0.91 | 189 → 134 | 4 → 14 | 10 | 0 → 0 |
| `matplotlib__matplotlib-20859` | resolved | resolved | resolved | yes | $0.16 | $0.21 | 76 → 63 | 2 → 6 | 4 | 0 → 0 |
| `matplotlib__matplotlib-22865` | resolved | resolved | resolved | yes | $0.16 | $0.18 | 101 → 62 | 2 → 5 | 3 | 0 → 0 |
| `matplotlib__matplotlib-24970` | resolved | resolved | resolved | yes | $0.22 | $0.30 | 103 → 87 | 3 → 6 | 10 | 0 → 0 |
| `psf__requests-1766` **excluded** | resolved | resolved | resolved | yes | $0.14 | $0.21 | 55 → 50 | 3 → 6 | 2 | 0 → 0 |
| `psf__requests-2317` **excluded** | resolved | resolved | resolved | yes | $1.49 | $0.57 | 1038 → 216 | 16 → 12 | 8 | 0 → 0 |
| `pydata__xarray-7229` | unresolved | unresolved | unresolved | yes | $0.84 | $0.72 | 538 → 161 | 9 → 11 | 7 | 0 → 0 |
| `pydata__xarray-7233` | resolved | resolved | resolved | yes | $0.18 | $0.22 | 87 → 57 | 4 → 6 | 3 | 0 → 0 |
| `pydata__xarray-7393` | resolved | resolved | resolved | yes | $0.70 | $0.55 | 549 → 97 | 7 → 9 | 8 | 1 → 0 |
| `pytest-dev__pytest-6197` | resolved | resolved | resolved | yes | $1.31 | $0.80 | 1154 → 211 | 18 → 9 | 7 | 0 → 0 |
| `sphinx-doc__sphinx-11445` | resolved | resolved | resolved | yes | $0.27 | $0.31 | 215 → 136 | 4 → 6 | 6 | 0 → 0 |
| `sphinx-doc__sphinx-7590` | unresolved | unresolved | unresolved | yes | $0.98 | $0.80 | 466 → 167 | 10 → 12 | 9 | 0 → 0 |
| `sphinx-doc__sphinx-7757` | resolved | empty patch | resolved | **no** | $2.16 | $0.91 | 1177 → 250 | 24 → 6 | 5 | 1 → 0 |
| `sphinx-doc__sphinx-8721` | resolved | resolved | resolved | yes | $1.37 | $0.31 | 718 → 74 | 17 → 7 | 7 | 0 → 0 |
| `sympy__sympy-13372` | resolved | resolved | resolved | yes | $0.15 | $0.10 | 65 → 43 | 2 → 3 | 1 | 0 → 0 |
| `sympy__sympy-13878` | resolved | resolved | resolved | yes | $1.63 | $1.20 | 956 → 649 | 13 → 13 | 19 | 5 → 0 |
| `sympy__sympy-16450` | resolved | resolved | resolved | yes | $0.14 | $0.19 | 46 → 59 | 2 → 4 | 6 | 0 → 0 |
| `sympy__sympy-18763` | unresolved | unresolved | unresolved | yes | $0.33 | $0.51 | 146 → 87 | 5 → 10 | 9 | 0 → 0 |
| `sympy__sympy-19495` | unresolved | unresolved | resolved | **no** | $0.69 | $0.19 | 369 → 42 | 10 → 6 | 3 | 0 → 0 |
| `sympy__sympy-20154` | resolved | resolved | resolved | yes | $0.45 | $0.26 | 224 → 53 | 4 → 6 | 4 | 0 → 0 |

The same rows with r94's dollars and frames, plus the exclusion causes in full,
are in `fullbench/reports/repl-ab-three-way.md`. The pairwise folds are
`fullbench/rerun-r95repl/vs-r95/compare.md` and
`fullbench/rerun-r95repl/vs-r94/compare.md`, and the per-run realm readings are
`fullbench/rerun-r95repl/realm-evidence.json` and
`fullbench/rerun-r95/realm-evidence.json`.

## REPL-specific evidence, off the journals

Read by `lib/repl-evidence.mjs`, whose every definition is pinned in
`fixtures/check-repl-evidence.mjs`. It reads both arms with the same code. Three
questions, and the answer to each is a count off the runs' own journals rather
than a claim about what the surface makes possible.

### 1. Were bindings actually reused across frames?

A **top-level binding** is a `const`/`let`/`var`/`function`/`class` whose keyword
starts at column 0 of a cell — the top level of a script, which is the level the
next cell inherits. A **carried reference** is an identifier in cell N that a
*strictly earlier* cell bound at its top level and that cell N does not itself
declare. A cell that writes `const hits = …` again has rebound the name and is
reading its own value, so that counts as a rebinding and never as a carry.
Identifiers inside strings, template literals, comments and regular expressions
are stripped first, so a `bash` script that mentions a variable name is data;
member accesses and object-literal keys are stripped too, so `hits.matches`
mentions `hits` and not `matches`. Every one of those rules can only *lose* a
carry, so the numbers below are a floor.

| | r95 (filing) | r95repl (REPL) |
| --- | ---: | ---: |
| runs read | 45 | 45 |
| arm, off `discipline-armed` | `filing` × 45 | `repl` × 45 |
| cells | 340 | 357 |
| top-level names bound | 2,019 | 1,107 |
| **cells carrying a name from an earlier cell** | **3 of 340 (0.9 %)** | **192 of 357 (54 %)** |
| **carried references** | **3** | **342** |
| deepest carry, in frames | 10 | 12 |
| runs with at least one carry | 3 of 45 | **44 of 45** |
| redeclarations of an already-bound name | 351 | 4 |

The two columns are the same code over the same definitions, and they separate by
two orders of magnitude. The filing arm rebinds: 351 times a cell declares a name
an earlier cell had, because in filing mode that is the only way to have it — the
value came back through `ctx.state` and has to be given a name again. The REPL
arm does that 4 times and instead reaches back 342 times.

The three carries the filing arm *does* score are the honest reading of the
control: a model writing as though a name survived, in a mode where it does not.
They are 3 references in 340 cells, which is the floor this metric sits on when
nothing carries.

The realm is not scratch space for one frame. Of the 44 runs that carry, the
median reaches **4 frames back**, carries 7.5 references, and does it in 57 % of
its cells; 31 reach at least 3 frames back and 16 reach at least 5. The furthest
reached 12. The heaviest users are the hard instances: `django__django-14351`
carries 18 references across 9 of its 15 frames, `sympy__sympy-13878` 19 across 9
of 13, and `matplotlib__matplotlib-20826` 10 across 8 of 14 at a depth of 12.

Here is what a carry looks like, from `astropy__astropy-14365`, frames 2 to 4.
Frame 2 reads two files and binds the results:

```js
const source = await ctx.call("read", {path: "astropy/io/ascii/qdp.py", offset: 1, limit: 260})
const tests = await ctx.call("read", {path: "astropy/io/ascii/tests/test_qdp.py", offset: 1, limit: 260})
```

Frame 3 does not read them again. It computes from the names:

```js
const srcText = source.content
const testText = tests.content
const srcCommandPos = srcText.indexOf("if datatype == \"command\"")
```

and frame 4, two frames after the read, is still slicing the same bytes:

```js
const relevantTestPositions = ["_line_type", "READ SERR", "read serr"].map(x => [x, testText.indexOf(x)])
console.log("SOURCE PARSER:\n" + source2.content + "\nTEST POSITIONS:\n", relevantTestPositions, "\nTEST BEGINNING:\n" + testText.slice(0, 4600))
```

That is the mechanism the whole arm is about: the second and third uses of a
file's bytes cost nothing, because the bytes never left.

### 2. What did a frame say to its successor?

`console.log` is the whole of the REPL context channel, and
`control.agent.cell-printed` journals the buffer as the next turn will read it.

| | r95 (filing) | r95repl (REPL) |
| --- | ---: | ---: |
| frames that printed | — (no print channel) | 324 of 357 |
| frames that printed nothing | — | 33 |
| **frames whose buffer the harness cut** | — | **6 (1.7 %)** |
| total bytes printed | — | 1,243,043 |
| total lines printed | — | 18,629 |
| mean bytes per printing frame | — | 3,837 |

The filing arm's zeros are structural, not a finding: filing mode has no
`console`, so `CellTurn` emits no `cell-printed` and the comparable quantity is
its `context` projection, counted in section 3. Nothing is being reported as
absent that was ever possible.

The 16 KiB per-frame print bound was reached by **6 frames of 357** — under 2 %.
The channel was not the binding constraint on this population, so a report that
attributed anything to it would be attributing it to a ceiling nobody was
standing on.

### 3. Was anything filed?

Filing is read off the durable transition, not off the source: a
`control.agent.transition-applied` whose `continue` carries a non-null `state` or
a non-empty `context`. In REPL mode the contract offers neither, so a non-zero
count here would say the arm did not take.

| | r95 (filing) | r95repl (REPL) |
| --- | ---: | ---: |
| continuing frames that filed `state` | **285** | **0** |
| continuing frames that projected `context` | **285** | **0** |
| frames | 342 | 358 |

**Zero filing, confirmed on both fields, over 45 runs and 358 frames.** Every
REPL transition in the lane reads `{"_tag":"continue","state":null,"context":[]}`.
Nothing was filed and no context was hand-projected: the variable was the memory
and the print was the summary, for the whole lane, with no fallback to the old
surface anywhere in it.

## The note-taking failure class

The brief asked this by name: **did any REPL run lose track of what it had read?**

### The definition, and why it is split

A **repeat** is one (flow, input) signature settled in two or more *different*
frames of one run. Twice inside one frame is never a repeat: a cell that runs the
same check before and after its edit is rule 9 working. Across frames it is three
different things, and adding them would report the contract being obeyed as a
defect:

- **`information` — `read`, `grep`, `glob`, `ls`.** These return bytes of a tree
  they do not change, so a second issue in a later frame returns what the first
  one did. **This is the note-taking failure**, and the only class that is one.
  Both surfaces exist partly to prevent it: filing through `state` and `recall`,
  REPL through the variable.
- **`check` — `bash`, `test`.** Rule 7 *requires* holding the check that failed
  for the right reason and reusing that exact pair after edits. A repeat here is
  compliance. Counted, never charged.
- **`edit` — `edit`, `write`, `apply_patch`.** Re-applying an identical hunk in a
  later frame is a run that lost its own edit or forgot making it.

The signature is the canonical rendering of the pair, so two spellings of one
input are one signature. All of this is pinned in
`fixtures/check-repl-evidence.mjs`.

### The answer

| repeats, across frames | r94 (filing) | r95 (filing control) | r95repl (REPL) |
| --- | ---: | ---: | ---: |
| **`information` — re-read what it already had** | **6** | **8** | **0** |
| runs affected | 5 of 45 | 4 of 45 | **0 of 45** |
| extra calls paid for | 6 | 9 | **0** |
| `check` — rule-7 re-verification | 53 | 66 | 48 |
| `edit` — hunk re-applied | 1 | 0 | 2 |
| `ReferenceError` — a name the realm did not hold | 0 | 0 | 1 |

**No REPL run lost track of what it had read.** Zero information repeats over 45
runs, 358 frames and 796 calls. The filing control did it eight times across four
runs, and r94 six times across five — so this is not a quirk of one filing draw.

The filing control's eight, in full:

| instance | frames | the call it paid for twice |
| --- | --- | --- |
| `django__django-14351` | 15, 18, **19** | `read django/db/models/fields/related_lookups.py` lines 45–124 |
| `pydata__xarray-7393` | 4, 6 | `read xarray/core/indexing.py` lines 1412–1591 |
| `sphinx-doc__sphinx-7757` | 16, 22 | `read sphinx/util/inspect.py` lines 525–664 |
| `sympy__sympy-13878` | 1, 2 | `read sympy/stats/crv_types.py` lines 130–229 |
| `sympy__sympy-13878` | 1, 2 | the same file, lines 630–859 |
| `sympy__sympy-13878` | 1, 2 | the same file, lines 1000–1299 |
| `sympy__sympy-13878` | 1, 2 | the same file, lines 1340–1769 |
| `sympy__sympy-13878` | 1, 2 | the same file, lines 2180–2609 |

Every one is a byte-identical `read`. `sympy__sympy-13878` re-read the same five
regions of one file in the very next frame — a whole frame spent re-acquiring what
the previous frame had been handed. `django__django-14351` read the same 80 lines
in three separate frames — 15, then 18, then 19 again.

**Two of the three instances the REPL arm gained are on that list.**
`django__django-14351` and `sphinx-doc__sphinx-7757` are both filing runs that
re-read and both REPL runs that resolved — `14351` in 15 frames against 25, and
`7757` in 6 frames against 24 and an empty patch at the budget wall. That is not
proof the re-reading caused the loss, and this report does not claim it: it is one
mechanism, visible in the journals, pointing the same way as the verdict.

### The one REPL throw, and what it actually was

One REPL cell raised a `ReferenceError`, in `django__django-16901` frame 1:
`'notARealBinding' is not defined`. Reading the cell settles what it was. The
model emitted a bare stray identifier as a statement, between a `console.log` and
a template literal:

```js
console.log(JSON.stringify({paths, data:excerpts.map((r,i)=>({p:paths[i],c:r.content}))}))
console.log("MARKER", inspect)
notARealBinding
const reproScript = `from django.conf import settings
```

It is a typo, not a memory failure: nothing in the run had ever bound that name,
and no earlier cell referred to it. What happened next is the interesting part.
Rule 3 promises that a cell which throws keeps every name it had already
assigned, and the realm kept them: frame 2 opened with `xorHits`, `dirs`,
`inspect`, `paths` and `excerpts` still bound, assigned `reproScript` without
`const` — because the throw had left the frame-1 `const` uninitialised — and the
run went on to resolve. The one throw in the arm is the one place the realm's
crash behaviour was exercised on the live path, and it held.

## What this settles, and what it does not

### Settled

1. **The arm takes.** 45 of 45 runs journaled `cellMode: "repl"`, filed `state`
   zero times and projected `context` zero times. There is no partial adoption
   and no fallback to the old surface anywhere in the lane.
2. **The realm is used as a realm.** 342 carried references across 192 of 357
   cells, reaching up to 12 frames back, in 44 of 45 runs — against 3 references
   in the filing control read by the same code.
3. **The note-taking failure disappears.** Zero information repeats over 45 runs,
   against 8 in the contemporaneous control and 6 in r94.
4. **It costs no verdict.** 42 of 45 instances agree; the 3 that differ are all
   REPL gains; the loss column is empty.
5. **It is much faster.** 5,434 s of agent wall against the filing arm's 10,098 s
   and 15,325 s on two draws — 43 of 45 instances faster than the control, and
   faster than the *better* filing draw by 46 %.
6. **It is cheaper at today's prices**, by 18 % on both denominators and against
   both filing draws.

### Not settled

1. **Whether it resolves more.** 34/43 ties r94 exactly. The +3 over r95 is the
   size of the filing arm's own draw-to-draw spread, which this wave measured
   directly (34 then 31). One more draw of each arm would separate them or show
   they are the same; this one cannot.
2. **The cache regression.** The hit rate falls 62.1 % → 42.3 % and uncached
   input more than doubles, from $6.49 to $14.39. The REPL window is
   append-only — `[cell₁, prints₁], [cell₂, prints₂], …` — so a falling hit rate
   is not obviously a prefix problem, and this report does not know which of the
   variables panel, the call ledger or the print volume is responsible. That is
   the next measurement, and it is where the remaining money is: at the control's
   62.1 % hit rate the same token volume would bill $16.70 raw against the
   control's $26.61, taking the arm from −21 % to −37 %.
3. **Whether the shorter contract did some of the work.** The REPL contract is
   1,482 characters shorter than the filing one. The r91 wave showed teaching
   changes are expensive, so some of this result may be the smaller prompt rather
   than the realm. Separating them needs a third arm — the filing surface at the
   REPL contract's length — and it is not in this wave.
4. **Longer runs.** The longest REPL run here was 658 s and 15 frames. Nothing
   here says what a realm holding a hundred names for fifty frames does to the
   memory ceiling or the panel bound, and the 6 frames whose prints were cut are
   the first sign of where that starts to bind.
5. **Anything outside this population.** 45 instances, one seat, one attempt each.

### The ranked next steps

1. **Find the cache regression and price it.** It is the largest number left on
   the table and it is a harness question, not a model one.
2. **Run one more draw of each arm.** Two draws of filing and one of REPL cannot
   separate a +3 from noise; three and two can.
3. **Arm the shorter contract on the filing surface**, to attribute the result
   between the realm and the teaching.
4. **Do not adopt on this wave alone.** The standing rule is that a drop in
   resolved is disqualifying and adoption follows on cost and wall clock; there
   is no drop, and both of those moved the right way. But resolved is a tie, and
   a surface change this large should clear the bar twice, the way r92's contract
   had to.

## Reproducing this

```sh
./preflight.sh                                          # pins the subject

FLOWS_CELL_MODE=repl ./run-45.sh --lane r95repl         # the REPL arm
./run-45.sh --lane r95                                  # the filing control

node compare-runs.mjs --baseline fullbench/rerun-r95/manifest.jsonl \
  --rerun fullbench/rerun-r95repl/manifest.jsonl \
  --out fullbench/rerun-r95repl                         # the A/B itself

node three-way.mjs --baseline fullbench/rerun-r94/manifest.jsonl \
  --first fullbench/rerun-r95/manifest.jsonl \
  --second fullbench/rerun-r95repl/manifest.jsonl \
  --baseline-name r94 --first-name r95 --second-name r95repl \
  --out fullbench/reports                               # against r94

node lib/repl-evidence.mjs fullbench/rerun-r95repl/journals
node lib/repl-evidence.mjs fullbench/rerun-r95/journals  # the realm evidence

./verify.sh                                             # every reader, offline
```
