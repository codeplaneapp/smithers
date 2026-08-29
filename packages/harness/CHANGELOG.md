# /harness

## [Unreleased]

### Changed

- **The cell contract is back at the text r92 measured, byte for byte, and it is pinned by digest.** Two rules were re-added for the r93 wave — change 2(f), the minimal-edit rule, alone with `astropy__astropy-14369` as its built-in A/B, and a same-shape sweep written for `django__django-13212` — and `fullbench/reports/rerun-r93.md` priced them. Both failed: `14369` went from 8 frames and $0.67 to **41 frames and $3.06** and stayed unresolved, `13212` still captured one file, and across the wave the patches got _less_ multi-file (6 to 3). The two rules are 522 characters and 131 estimated tokens; the wave they produced is **three verdicts and $9.47 worse** than r92's, at +115 frames. The contract is 9,193 characters / 2,352 estimated tokens again, `CellPrompt.test.ts`'s ceiling is back at 2,400, and a new test pins the rendered contract's SHA-256 at `25a1c933ad18e979fe4282848edee5987b61783f939ac72ff45fee2b6655e8c5` — the text under the r92 subject — so changing it means changing a number and running a wave for it.

- **The worked example no longer calls a flow that does not exist.** It closed on `ctx.call("diagnostics", { path })` and read `lint.errors.length` off the answer; `@smthrs/std` declares no such flow and no composition binds one, so under this release's fail-soft rule that call resolves `{ ok: false, code: "unknown_flow" }` and the very next property read throws — a whole frame, in the one place the contract asks to be copied literally. The second independent reading is now the hunk `edit` itself returns, which is what that field was added for: `sphinx-doc__sphinx-7233` lost its verdict to a mis-indented edit nobody could see. Rule 7 names the hunk and points the diagnostics step at whatever checker `ctx.flows` and the image actually offer. +44 estimated tokens, and the ceiling in `CellPrompt.test.ts` moves with it.

- **A failed `ctx.call` now RESOLVES with `{ ok: false, error: { code, message, hint } }` instead of throwing.** A successful call still resolves with the flow's own value, unwrapped. The fail-stop tax it removes is measured: on `psf__requests-2317` one call against a `tests/` root that does not exist destroyed two settled greps and a never-run probe in the same cell, and `django__django-14351` spent about $0.46 on the same class across five frames — in every case the recovery branch the model had already written sat behind the throw and never ran. `Cell.CallFailureCode` is the closed set a cell branches on and `Cell.callFailureHint` names the one move that recovers each class; `Sandbox.callTimeoutTag`, `Sandbox.callTimeoutErrorName` and `Sandbox.failureError` are gone with the exception they described. An interrupted call still rejects: that is teardown, not a result.

- **A cell is parsed at the boundary, before the frame commits to it,** by the new `CellValidation.validate`, and a cell that does not parse is answered inside its own frame at cached-prefix price rather than settling it. `CellTurn.State.revalidations` arms it (default one, zero disarms) and `AgentEvent.CellRejectedInFrame` journals every in-frame re-ask, because a re-ask is real spend. The r90 wave paid for nine dead frames: `sympy__sympy-20154` $0.70 for a 53 KB program that never executed and $0.10 more to have it replayed back as input, `django__django-15987` 59 % of the instance's whole bill, `sympy__sympy-18763` twice on one instance with the second cell repeating the first's syntax error character for character. JavaScript cells are now syntax-checked too — the realm used to be the first party to notice — and every rejection names the line and column and quotes the offending line.

- **A frame's state section is now a manifest, always**, replacing the key roster that only appeared above 2,048 bytes: `StateManifest.render` names every key's type, byte size, and the frame that last wrote it, so a run can tell a reading it took before its edit from one it took after. The whole JSON is still printed while the state is small, and `render`-named keys are still projected in full. `CellTurn.State.stateStamps` carries the freshness; a key whose canonical value is unchanged keeps its frame, so copying `...ctx.state` forward does not restamp everything.

- **Nothing a frame shows is cut silently.** Every bound in the harness now states what it dropped and the id that brings it back — the state projection, the call-ledger line, the salvage list a raised frame writes, and the model's own reply echoed into the next prompt. Three of the five most expensive r90 instances spent real money re-fetching a region the run had already rendered and clipped (`pydata__xarray-7229` $0.76, `sphinx-doc__sphinx-8721` $0.36, `pytest-dev__pytest-6197` $0.19).

- **A reply is no longer echoed back into the next prompt in full.** A cell that ran is bounded at 8 KB and one that never ran at 1 KB, each with the elision stated. `sympy__sympy-20154` was charged $0.10 to read back a 53 KB program that had already failed to compile once.

- **Structured values render as JSON, everywhere.** A `context` entry's `text`, a completion's `output`, and a park's `message` accept any JSON and are rendered by the new `Cell.renderText`, so a frame that did all its work and handed back a structure is no longer refused as malformed; a thrown non-`Error` is rendered the same way instead of `String(value)`. `sympy__sympy-19495` frame 7 names the defect verbatim in its own justification: "The prior render coerced the structured failure result to [object Object]".

- An `invalid_transition` rejection now carries the decoder's own report — the field and the shape it wanted — instead of only restating the contract. A frame that spent real calls before returning a bad transition cannot be replayed, so "it was not a transition" cost a model turn to re-derive what the decoder already knew.

- `Cell.extract` now runs **every** fenced `cell` block of one reply as one program instead of keeping only the last, and returns `Extracted` (`{ source, blocks }`) rather than bare `Source`. Distinct blocks are concatenated in reply order, so a value bound in one is bound for the ones after it and the first `return` ends the frame; a byte-identical repeat of a block is dropped rather than concatenated. `AgentEvent.CellProduced` carries the reply's block count. Wave-10 django wrote a near-par seven-block program in one reply and the harness executed block seven — the imagined completion — against a tree where blocks one to six had never run: empty patch, run over in two frames. Replaying all five wave-10 journals through the new extraction: 2 of 91 replies were multi-block (7 blocks discarded), the astropy one is a duplicated block that de-duplication now runs unchanged, and the django one is a redeclaration that becomes a `compile_failed` the controller annotates with the block count instead of a wrong completion.

- Moved the frame's state section out of the system context and into one trailing user message after the transcript, so the whole stable span — contract, catalog, task, registry — is a byte-identical prefix for the life of a run and a provider's prefix cache covers all of it. Two graded instances ran at 38% and 69% cached input with the volatile block sitting between the teaching and the transcript.

- Replaced the cell contract's only worked example — three lines of `fs/list` returning `continue` — with a complete single-cell round: search, a read whose window is computed in JavaScript from the search's own hit, the baseline check, an anchor sliced out of the bytes `read` returned, the edit, the identical check replayed, and both exits. Rule 8 has described that shape in prose since the contract existed and five graded waves split it across four frames each, because models imitate the example. The contract grows 1,788 bytes and 471 estimated tokens (6,409 → 8,197 bytes, 1,634 → 2,105 tokens by `Tokens.estimate`); it is a prefix segment, so a run pays that once at full price and then at cache rates, and `CellPrompt.test.ts` pins the ceiling so the next such addition is deliberate.

- Re-worded two demands, wording only, with no change to what either accepts. The unmoved-tree demand's second answer now asks the run to name what it ran to conclude that no change is needed — the wave that armed it answered "No change is needed" from a run that had made one call in its life, and the sentence had offered that exit with nothing attached. The read-only demand's justification now asks what the next frames will do differently from the quiet ones behind it; one instance volunteered twelve justifications across 24 frames, never wrote, and died on the hard stop. Both answers are still accepted exactly as written.

### Added

- Added `VacuousVerification` **as an unwired module: `CellTurn` does not read it, and no run is told anything by it.** It was live for the r93 wave only. `fullbench/reports/rerun-r93.md` §1 reports it fired **twice in 45 journals**, on neither of the instances the diagnosis or the replay predicted, and `django__django-14351` — the run it was written for — resolved that wave with no observation on its journal at all. Of the two firings, `sympy__sympy-13878` replaced its proof, spent seventeen more frames and resolved; `django__django-15732` took the observation on frame 7, the frame that made the correct edit, then on frame 8 rewrote the enclosing block and restored the edit's text byte for byte, producing the wave's only empty patch on an instance that had resolved in r90, r91 and r92. One instance is not a mechanism and two firings is not a rate, so the arm is off rather than tuned, and turning it back on is a wave of its own on r92's contract text. `CellTurn.State.pristineChecks` and `CellTurn.State.vacuousStated` are gone with the wiring; the module, its suite and `AgentEvent.VacuousVerificationObserved` are kept unchanged so the re-measure needs no schema change. What it does when an arm turns it on: when a cell stores `state.verification` naming a call this run had already watched _pass_ over the tree it was handed, before any frame changed a byte, the next frame is told so once per distinct input. It rides the `invalidProbe` channel because it is the same class of fact — a result that reads identically on a broken tree and on a fixed one — and it is journaled as `AgentEvent.VacuousVerificationObserved`. Nothing is bounced, no cap is spent: the sentence is delivered where a frame already exists to read it, and a completion that resolves is told nothing while the event is still written. `CellTurn.State.pristineChecks` is the ledger, which stops growing at the run's first mutating frame, and `CellTurn.State.vacuousStated` is the once-per-input bound. A signature this run has already watched _fail_ over that same untouched tree is never admitted, and is evicted if an earlier pass had put it there: such a run has watched the red the contract asks for, and a later green reading of it before any edit says the command is unsteady rather than that no failure was ever seen. The refusal reads the epoch-zero rows of `Sufficiency`'s own failing-check ledger, so nothing new is measured or stored for it. `django__django-14351` is the run it was written for — one verification script exiting 0 at frame 5 with nothing changed and again at frame 14 after the edit, cited as a before-and-after — and the reason it is a fact rather than a gate is the other two runs of the same wave it speaks to, both of which resolved: `django__django-11299` corrected exactly this itself four frames later, and `django__django-12741` was right to complete on a check that had always been green, because its task is a signature change with no bug to reproduce.

- Added `Cell.Continue.recall` and `CallLedger.recall`: a `continue` transition may name the ordinals of settled calls whose whole results the next frame must see, and the harness prints them into that frame's prompt. It is the sibling of `render` for the half of a run's knowledge that never reached `state`, and it uses the same mechanic, so it costs no model turn of its own. `CallLedger` retains each result while it is under 16 KB and while the run's 32 KB recall budget allows, newest first; a line whose bytes are gone keeps its ordinal, its subject, its structural digest and its size, and a recall of it is answered by name rather than by silence. The call ledger's rendered lines now carry a `recall N` marker so the model can tell which results are still held.

- Added `StateManifest`: the per-frame manifest of `ctx.state` — key, type, byte size, producing frame, freshness — plus the projection bounds `CellTurn` used to own privately.

- Added `CellValidation`: the boundary parse. It reports module syntax, non-erasable TypeScript, and syntax errors with their line, and — free from the same parse — names the top-level statements a cell wrote after its own first `return`, which never ran. That notice reaches the next frame; it is not a rejection, because the program is legal and the model simply did not know.

- Added `Cell.Continue.render`: a `continue` transition may name durable-state keys the next frame must see rendered in full. Named keys are printed in the state section instead of their roster line, bounded at 4,096 bytes each (over-bound values keep their first and last 2,048 bytes with the elision stated) and at 8 keys per transition. Replaying the wave-10 journals, 21 of 91 frames were zero-call frames whose only work was copying state into `context`, and all 86 keys they read were already held by the previous transition's own state — every one of those frames was reachable by `render`.

- Added `CallLedger`, the run's automatic ledger of settled calls, rendered in every frame's state section: ordinal, flow, the first targeting term of the input, ok or failed, and a structural digest of the result (counts, byte lengths, exit codes — never payloads), bounded to the 30 most recent. A call result was previously invisible unless the blind-authored cell that made it happened to copy it, which is what manufactured the zero-call rehydration frames; the ledger also survives a raised frame, so settled work is no longer lost with the throw.

- Added `NarrowedCheck.lex`, the document-order view of the lexer `NarrowedCheck.terms` already sorted, so `CallLedger` asks its positional question of the same lexer rather than copying the separator.

- Added `Sufficiency`, the first control in this package that is not a brake: when a run has watched a check fail over a tree it had not yet changed, changed the workspace, and watched the same check or a broader one pass after, the next frame's context carries one sentence saying so. It asks for nothing, refuses nothing, spends no cap, and is written at most once per run, journaled as `AgentEvent.SufficiencyObserved`. The five armed controls all say "not yet", which costs a careful round one re-check frame and one call-free completion frame — two of the seventeen strokes the best graded rounds spend over par — and produces compliance rather than work: the armed wave answered the read-only demand with a paragraph and no write, and the unmoved-tree demand with "no change is needed" and an empty patch. The ordering is the run's own count of mutating frames, so it holds on a host that measures nothing and knows only what its calls declared; `UnresolvedFailure.passed` is the new half of the wire-key reading, and it is not the negation of `failed` — a call that reports no exit status is neither.

- Added `NarrowedCheck.findOnly` and `demandOnly`, the fourth completion demand, sharing `narrowingCap` with the third and journaled as `AgentEvent.NarrowOnlyDemanded`. `find` fires on broad-then-narrow; this fires when nothing broader was ever taken. Wave 10's pytest instance edited correctly, ran `pytest -rA testing/test_collection.py -k "collect_init_tests or collect_pkg_init_only"`, and completed on it — the filter deselects the one test the patch broke, and the run never ran that file any other way, so there was nothing in the ledger to narrow. The predicate is the completing frame's last check, its subjects as `NarrowedCheck.names` reads them, and two conditions on the ledger: every subject named elsewhere in the run, and no other check naming them all together. Replayed over every completion three graded waves produced — fifteen runs — it fires once, on that instance, naming that command.

- Added `NarrowedCheck.names` and `NarrowedCheck.Check.passing`. `names` is the stricter reading of `targeting` that `CallLedger.subject` had been carrying privately, now one lexical rule instead of two.

### Removed

- **The filing authoring surface is gone, and with it every entry above that describes one.** A run holds one realm for its whole life; a cell states its intent by calling `ctx.done`/`ctx.park`, and `Sandbox.replTransition` builds the transition. Deleted: `Cell.Mode`, `Cell.defaultMode`, `Cell.transition`, `Cell.renderEntry`, `StateManifest`, `CallLedger`'s recall half, `Sandbox.evaluate` / `Sandbox.Evaluation` / `Sandbox.makeRestricted` / `Sandbox.layerRestricted`, `CellTurn.State.cellMode` and `stateStamps`, `AgentEvent.DisciplineArmed.cellMode`, and `Transcript.ProjectedState.agentState`. `Cell.Continue`'s `state`, `context`, `render` and `recall` and `Cell.Complete`/`Cell.Park`'s `state` survive as **decode-only** optional fields: nothing populates them, nothing reads them, and they exist so the r90–r96 journals still decode. Entries in this section's siblings that announce `StateManifest`, `Cell.Continue.render`, `Cell.Continue.recall` or the state manifest describe a surface this release does not ship — they are kept because they name why the fields still decode, not because the features exist. Because nothing is released yet, no migration is owed and no compatibility mode is offered.

- Removed `Steering.drainBoundary`. Its only caller was the deleted legacy
  `Turn`; `drainAtClose` and `promoteAtIdle`, the two operations it composed,
  remain.

### Fixed

- Replaced `Sandbox.ts`'s one `v8 ignore start`/`stop` range with a directive per line, and brought `packages/flows`' coverage-ignore inventory back in step with the harness. The range form is forbidden outright — it hides an arbitrarily large region behind a single allowlist count — and it had held `@smthrs/flows`' conformance suite red since it landed. The inventory had also drifted: `CellTurn.ts` and `CellValidation.ts` were absent, `QuickJSSandbox.ts` read 3 against 5, and `Sandbox.ts` read 1 against 6. No line's coverage changes; `@smthrs/harness` stays at 100% in all four categories.

- Bounded the flow name a `CallLedger` line carries, and the same name in the salvage note a raised frame writes. A call names whatever string the cell passed to `ctx.call`, and a name matching no descriptor still settles — as a failure saying so — so `ctx.call("Z".repeat(50000), {})`, one short line of JavaScript, put fifty kilobytes into durable controller state, into the journal, and into every remaining frame's prompt, thirty times over at the ledger's own bound. Every rendered field of a ledger line is now clipped to `CallLedger.width`, which is what the module already claimed. A real flow name is far under it, so nothing callable renders differently.

- Stopped `Sufficiency` writing its observation in a frame that also watched a check report a failing exit status. The pair it names is real, and in such a frame it is at best half of what the run is holding: a narrow probe going green beside a broad check that stayed red is the shape one graded instance has lost to for six consecutive waves, and a harness that picks the good half out of that frame and hands it back as "evidence held" is doing the opposite of what the counterweight is for. The condition only ever suppresses the sentence and can never manufacture one; replayed over the ten runs wave 9 and wave 10 recorded, it changes neither of the two frames that fire.

- De-duplicated the key list a `continue` transition names in `render`. The list is model-written, so it can repeat, and a repeat rendered the same value again and took a second of the eight projection slots with it — `render: ["a", "a", "a"]` printed one key three times and left five slots for the seven keys the frame actually needed. A key the state does not carry is likewise named once however often it was asked for.

- Bounded each host flow call independently of the cell's 15-minute backstop.
  An over-budget call now returns a catchable, typed
  `FlowCallTimeoutError` with a model-facing narrowing instruction, while the
  cell keeps running and may retry a smaller call.

- Stopped charging a settled flow call's duration to the cell's compute clock; a new `totalMs` ceiling (default 15 minutes) backstops a call that never settles. 57 of the 62 rejected frames in the first SWE-bench benchmark were legitimate long test runs hitting the old 30-second wall clock.

- Journaled the turn-boundary steering drain through the new `EngineLike.record` boundary in `CellTurn`. The drain consumes host queue state, so it is a nondeterministic read: left unjournaled, a run resumed after a park or crash drained an already-drained queue, rebuilt a different context than the original attempt, re-keyed every later sealed step, and could re-execute irreversible effects. The drain is now recorded once per frame boundary and replayed verbatim on re-execution.
- Accepted explicit JSON `null` values for optional top-level flow input fields by retrying rejected input without those fields, while preserving the original rejection when the remaining input is invalid and preserving `null` for schemas that accept it.
- Restored `FlowProjection` construction without an explicit input document by defaulting the field to `Option.none()`.

### Added

- Added `TruncatedOutput`, the run's ledger of output a flow returned after cutting it, and wired it into the cell call boundary: a call that declares writes and carries a string byte-identical to an earlier truncated capture is refused as a catchable `CallResult` failure naming git checkout/restore as the way to restore a file. The ledger is durable controller state (`CellTurn.State.truncatedOutputs`, digests only, sixteen most recent), so a fragment stashed in `state` is still recognised a frame later. A benchmark instance lost this way: `git show <base>:src/_pytest/python.py` returned 30,000 bytes of a 54,000-byte module with `stdoutTruncated: true`, the cell wrote exactly those bytes back over the file, and the mangled tail was the graded patch.

- Taught the cell contract that a result flagged truncated is a fragment: restore a file from git with git checkout or git restore, never by routing file content through captured stdout.

- Made the truncation ledger's sixteen-entry bound count distinct payloads. A repeated call returns the same bytes and so the same digest, and the guard compares digests, so each repetition was taking a slot it added nothing to: seventeen identical `git show` restores evicted every other fragment the run had been handed and re-opened the hole. The run this guard exists for is exactly a run that repeated one restore frame after frame.

- Added the run-start `DisciplineArmed` event, recording the read-only and
  frame caps and every effective sandbox limit before the first frame runs.

- Added the opt-in read-only frame cap (`CellTurn.make({ readOnlyCap })`, default `CellTurn.defaultReadOnlyFrames` = 12 for task runs). A frame that made no call declaring a write extends the run's read-only streak; at the cap the controller demands a write or a typed `justification` on the next transition, and at twice the cap the run stops with `HarnessError` code `read_only_cap` instead of reporting work it never did. A justification is recorded and buys `readOnlyCap` quiet frames without resetting the counter. One benchmark instance read for all 100 frames, made 132 calls with zero edit attempts, and completed claiming the fix was implemented.

- Added `Cell.Continue.justification` to the cell protocol, and taught it in the cell contract.

- Added `AgentEvent.ModelSettled.durationMillis`: the wall-clock duration of one sealed model call, read from the injected clock, so a benchmark can measure latency per call rather than only per run.

- Exposed the previous frame's returned state to the cell as the frozen `ctx.state` binding in both sandbox bindings, and taught the contract to treat it as working memory.
- Rendered large states in the system context as a key roster instead of full JSON; the full value lives in `ctx.state`.
- Preserved a raised frame's completed call results in the correction feedback so the next cell reuses them instead of redoing the work.
- Echoed the received arguments in a schema-refused call's message so one corrected cell fixes the input.

- Taught the cell contract that FlowCallError is worth catching in-cell and that long-running calls are safe to await.

- Added `EngineLike.record` with `RecordBoundary` and `BoundaryIdentity`: the port's generic journaled-boundary operation for nondeterministic controller reads, and `Steering.DrainRecord`/`Steering.drainRecord`, the serializable projection of a turn-boundary drain that the controller journals.
- Carried projectable flow input and output schemas as inline JSON Schema documents in binding descriptors, projected input documents into `ctx.flows`, and rendered them in the cell catalog.

- Added the built-in agent harness for translating dynamic nodes into sealed model steps and child plans.
- Added harness-owned, call-correlated child progress events streamed from the
  engine splice boundary before ordered child settlement.
- Added `Cell`: the cell contract — agent-authored source with a stable digest,
  the serializable `continue` / `complete` / `park` transition a cell returns,
  typed outcomes for a cell that threw or never produced a transition, the
  cell-visible flow projection, and the identity carried by every call made
  inside a cell.
- Added `Sandbox`: the deterministic script sandbox port, whose only effectful
  primitive is flow invocation against the frame's capability-narrowed catalog,
  plus `layerRestricted`, a dependency-free binding that denies ambient time,
  randomness, network, filesystem, process, and module access by identifier.
- Added `QuickJSSandbox`: the QuickJS-WASM binding, a genuinely separate
  JavaScript realm that runs the same single-file build on Node and in a
  browser and can enforce declared memory and step limits.
- Added `CellTurn`: the cell-first controller. It seals one model step per
  frame, recovers the cell, runs it, resolves each of its calls as its own
  durable boundary, and continues, completes, or parks from the transition the
  cell returned rather than from provider tool calls.
- Added `EngineLike.call`, the one-call-at-a-time durable bridge that supports
  data-dependent calls inside a cell.
- Added cell events to `AgentEvent`: `CellProduced`, `CellCallStarted`,
  `CellCallSettled`, `CellSettled`, and `TransitionApplied`.
- Added `CellCalls`: registry-backed resolution for the flow calls a cell makes,
  so `ctx.call` reaches a flow `@smthrs/registry` actually discovered under
  the `flow.ts` -> `flow.mdx` -> `SKILL.md` precedence. Module bodies are bound
  by the host, markdown bodies are rendered and handed to a prompt runner, and
  every resolution refusal is a catchable call failure rather than a run
  failure.
- Added `FlowBinding`: the one executable-flow contract. A `Binding` pairs an
  ordinary flow declaration with its handler, decoding cell input through the
  flow's input schema and validating the handler's output back into
  serializable JSON; a `Source` produces bindings, possibly lazily; a `Catalog`
  composes ordered sources and refuses two implementations under one name; and
  `FlowBinding.registry` discloses a catalog through the ordinary
  `Registry.Registry` contract with file-discovered entries keeping precedence.
  Correctable failures become catchable `Cell.CallResult` failures while
  permission, abort, and suspension failures stay in the typed error channel.
- Added `CellCalls.Options.catalog`, so a bound implementation answers a call
  only when its declaration digest matches the one disclosure published.

### Removed

- Removed the superseded provider-tool-call loop and the modules that existed
  only to serve it: `LegacyHarness`, `Harness`, `Turn`, `Tools`, `Assemble`,
  `AgentStep`, `Elaborate`, `FlowTool`, and `Visibility`. The production agent
  loop is the cell path — `Cell`, `CellTurn`, and `CellCalls` — which decides
  continuation from the transition a cell returns rather than from provider
  tool calls. Foreign CLI adapters, when they return, implement the `Agent`
  service in `@smthrs/agent` instead of the neutral `Harness` contract this
  package used to declare.

### Fixed

- Emitted the `CompactionSettled` event a compaction had always constructed
  material for but never published, so replay no longer rebuilds the
  uncompacted transcript and re-crosses the same overflow threshold.
- Declared `toolChoice` on `ModelRequest` instead of attaching it to a sealed
  request with `Object.assign` after construction.
- Branched context-overflow recovery on the provider adapter's typed
  `context_overflow` code instead of re-deriving it from a regular expression
  over the provider code and message. Recovery no longer depends on prose no
  provider promises to keep stable, and it no longer silently stops working for
  a provider whose wording the harness had not seen.

- Retained inactive deferred tool definitions so additive activation can render native references and complete fallback lists.
- Bounded turns with landing frames, used resolved model context capacity for
  compaction, supplied a stable summary instruction, and kept invalid
  compaction prefixes in a typed error channel.
- Made queue promotion durably consumptive, filtered both disclosure and
  elaboration by seat visibility, and plumbed recorded envelope, environment,
  and self-documentation declarations into the seven-section system prompt.
- Ignored progress emitted after a child settled and kept transient progress
  out of transcript projection.

## [0.1.0]

### Added

- Initial release.
