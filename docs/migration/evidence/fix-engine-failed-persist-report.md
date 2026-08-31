# Phase 7 fix lane: engine-failed-persist

Round 1. Status: done. Branch `phase7/engine-failed-persist`, worktree
`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/wt/engine-failed-persist`,
base `41bfdcb06f`. Two commits, no lockfile change.

- `e44159b9ef` 🐛 fix(engine-store): persist a failed run whose exit cause the flow codec rejects
- `5ac7610b5c` 🔧 chore: regenerate known-files.d.ts for the durable exit-encoding sources

## The defect, confirmed at the source

`packages/engine-store/src/internal/RunDriver.ts:1202` (pre-fix) encoded every
round's settlement through the flow's own codec and made a rejection fatal:

```ts
    const encodeResult = (
      flow: Flow.Any,
      result: Flow.Result<unknown, unknown>
    ): Effect.Effect<unknown> =>
      Schema.encodeEffect(
        Schema.toCodecJson(Flow.Result({
          success: flow.successSchema,
          error: flow.errorSchema
        }))
      )(result).pipe(Effect.orDie) as Effect.Effect<unknown>
```

`packages/agent/src/AgentSession.ts:553` declares the flow every agent run is:

```ts
const agentFlow = Flow.make("agent/run", {
  payload: { runId: Schema.String, planId: Schema.String },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})
```

`Schema.toCodecJson(Schema.Unknown)` is `Schema.Json`, whose predicate
`SchemaAST.isJson` (effect 4.0.0-rc.108 `src/SchemaAST.ts:4260`, over `isTree`
at 4195) refuses any value whose prototype chain is deeper than
`Object.prototype`. Every `Data.TaggedError` in the tree is such a value —
`HarnessError`, `ModelError`, `Seat.SeatUnresolved` — so a `Fail` reason
carrying one cannot encode. `Effect.orDie` then turned that into a defect on
the drive fiber, which `RunCoordinator.ts:89` logged and swallowed:

```
engine-store: coordinated drain failed for run-1 SchemaError: Expected JSON value
  at ["exit"]["cause"][0]["error"]
```

The terminal transition at `RunDriver.ts:1745` never ran, so the engine row
stayed `running` with a dead owner while `control.db` said `failed`, and the
next process's `sweepStaleRunning` (`RunDriver.ts:1910`) stole and re-executed
it. That is the cutover's `19-run-1-redrive-check.log`: `flows.engine.run-decision
stolen-and-activated` at sequence 10, `control.agent.discipline-armed` and
`control.agent.turn-opened` at 12 and 13, and a second call to the OpenAI seat.

## Item 1 — reproduction, two processes, real SQLite

Test: `packages/agent/test/FailedRunPersistsAcrossProcesses.test.ts`, two cases
over one `.flows` directory of real `control.db` and `engine.db` files, the
first composition's scope closing between them, a scripted `Model` that fails
every stream with `ModelError { code: "quota_exceeded", message: "You have no
credits remaining" }` and pushes its host name onto a shared `calls` array.

1. `an agent run whose seat rejects the call > is recorded failed in the engine
   store, with the unencodable cause projected onto the row`
2. `an agent run whose seat rejects the call > is never stolen, re-opened, or
   re-billed by the next process over the same .flows`

RED against the pre-fix source (`git checkout` of `RunDriver.ts`, `ExitEncoding.ts`
removed), log `fix-engine-failed-persist-logs/02-red-crossprocess.log`:

```
[01:17:15.021] WARN (#628): engine-store: coordinated drain failed for run-1 SchemaError: Expected JSON value
  at ["exit"]["cause"][0]["error"]
```

```
FAIL  test/FailedRunPersistsAcrossProcesses.test.ts > an agent run whose seat rejects the call > is recorded failed in the engine store, with the unencodable cause projected onto the row
AssertionError: expected 'running' to be 'failed' // Object.is equality
```

```
FAIL  test/FailedRunPersistsAcrossProcesses.test.ts > an agent run whose seat rejects the call > is never stolen, re-opened, or re-billed by the next process over the same `.flows`
AssertionError: expected [ 'created', …(2) ] to not include 'stolen-and-activated'
```

The reproduction is the cutover's chain verbatim: the same warning text, the
same wedged `running` row, the same `stolen-and-activated` decision, and the
second seat call the counting model records.

Two mechanics worth naming. The first process waits for `control.run.failed`
(the event `packages/cli/src/Command.ts` waits on) and then reads the engine row
for up to ten seconds; the control settlement and the engine's terminal write
are two writes, and a drain that dies never reaches the second. Between the
processes the test ages every `running` heartbeat by 120 s directly in
`engine.db` (`WHERE status = 'running'`, so the CHECK constraint on settled rows
is respected). That is the cutover's 86-second gap written as a fact, and it
costs one sweep tick instead of half a minute of wall clock.

GREEN: 2 passed, 10.50 s.

## Item 2 — the fix

`packages/engine-store/src/internal/ExitEncoding.ts` (new, 100% covered).
`encode(flow, result)` keeps the flow's own codec as the ordinary path and,
when that codec rejects the settlement, answers a JSON projection plus a `note`:

- `ValueProjection` — `type` (constructor name, or `typeof` for a primitive),
  `message`, and `tag`, `code`, `stack` (first four lines), `cause` when the
  value carries them, following `cause` links to `maxCauseDepth` (4). Rendering
  is bounded at `maxTextLength` (1024) and never raises: `JSON.stringify`
  answering `undefined` becomes `[symbol]`/`[undefined]`, and a throw becomes
  `[unrepresentable]`.
- `ReasonProjection` — one per `Cause` reason, in order: `Fail` with its error,
  `Die` with its defect, `Interrupt` with its `fiberId` when it has one.
- `ResultProjection` — `_tag: "flows/engine-store/UnencodableResult"`, the
  original result tag, the `note`, the projected `reasons`, and the projected
  `value` for a success or a handoff payload.

The degraded envelope is built as plain JSON rather than re-encoded through a
schema, so nothing in the module can fail: a `Complete` or `Suspended` becomes
`{_tag:"Complete", exit:{_tag:"Failure", cause:[{_tag:"Die", defect: projection}]}}`
and a `Handoff` keeps its shape with the projection as its payload. The
projection's top level deliberately carries no `message` key, because
`Schema.Defect` revives any JSON object with a string `message` as an `Error`;
without that rule the record would not come back out of the row as a record.
There is therefore no "encoding still fails" branch to fall through — the
degraded path cannot raise — and the caller is told to settle `failed` through
`EncodedResult.note`.

`RunDriver.ts:1204` now delegates to it, and `RunDriver.ts:1758` reads the note:

```ts
            const status: RunStore.RunStatus = encodedResult.note !== undefined
              ? "failed"
              : result._tag === "Suspended"
              ? "suspended"
              : Exit.isSuccess(result.exit)
              ? "completed"
              : "failed"
```

Fail closed: a settlement the codec rejected reaches a terminal row in this
process whatever it claimed to be, because the alternative is the `running` row
the next process re-executes. The other three `encodeResult` call sites
(`releaseOwned`'s suspension record, `continueLineage`'s handoff record,
`endLineage`'s budget refusal) take `.encoded` and can no longer die either.

### Per-cause-shape unit tests

`packages/engine-store/test/ExitEncoding.test.ts`, 20 cases. RED against a
pre-fix `encode` (the `Effect.orDie` expression above), log
`fix-engine-failed-persist-logs/01-red-exitencoding.log`, 6 failed / 12 passed:

| Case | Verbatim red line |
| --- | --- |
| `a `Fail` cause carrying a typed error the codec rejects > still answers bytes, and projects the tag, code, message, and nested cause` | `SchemaError: Expected JSON value` / `  at ["exit"]["cause"][0]["error"]` |
| `… > writes bytes the poll path can decode back` | same |
| `a cause mixing a typed failure, a defect, and an interrupt > projects every reason in order` | same |
| `… > projects an interrupt with no fiber id without inventing one` | same |
| `a success value the codec rejects > settles as a failed `Complete` carrying the projected value` | `SchemaError: Expected JSON value` / `  at ["exit"]["value"]` |
| `a handoff whose payload the codec rejects > keeps the handoff shape so the lineage stays readable` | `SchemaError: Expected Flow.Complete` / `Expected JSON value` / `  at ["payload"]` |

The remaining twelve are the shapes that must NOT change: a settlement the codec
accepts encodes through it with no note (including `Exit.die(new Error(...))`,
which `Schema.Defect` takes as-is), plus the value-projection table (primitive,
`JSON.stringify`-dropped, circular, null-prototype, depth cap, stack trim,
message truncation) and the absent-cause case.

A `Flow.Suspended` the codec rejects cannot be constructed — `Schema.Class`
validates `cause: Schema.Cause(Schema.Never, Schema.Defect())` in the
constructor — so that shape is pinned through `projectResult` directly rather
than through `encode`.

### Engine-store-level pin

`packages/engine-store/test/UnencodableSettlement.test.ts`, a real durable run
of a flow declaring `error: Schema.Unknown` whose handler fails with a tagged
error. RED, log `fix-engine-failed-persist-logs/03-red-unencodable-settlement.log`:

```
FAIL  test/UnencodableSettlement.test.ts > a run whose failure the flow's own codec cannot encode > settles `failed` with the cause projected onto its row
SchemaError: Expected JSON value
  at ["exit"]["cause"][0]["error"]
```

```
FAIL  test/UnencodableSettlement.test.ts > a run whose failure the flow's own codec cannot encode > answers the waiting caller the projected failure rather than a suspension
AssertionError: expected SchemaError: Expected JSON value
  at ["e… { …(3) } to match object { …(2) }
```

The second case pins a consequence the cutover also carried: before the fix the
drain died, `poll` found no result on the row, and `execute` answered
`Suspended` — telling the caller to wait for a run that was over. The caller now
gets the projected failure.

## Item 3 — sweep of the same class

Searched `Effect.orDie` around `encodeResult`, `encodeState`, and
`Schema.encodeEffect` in `packages/engine-store/src/internal` and
`packages/agent/src`.

| Site | Guards a terminal transition? | Disposition |
| --- | --- | --- |
| `RunDriver.ts:1202` `encodeResult` | yes, all four settlement paths | fixed, above |
| `RunDriver.ts:414` `encodeState` | yes, every transition | pinned, see below |
| `RunDriver.ts:1225` `normalizePayload` | the handing-off round's `completed` transition | out of the named class (a payload, not an Exit/Cause); recorded below |
| `RunDriver.ts:1989` `ensureRun` payload encode | no — run creation; a defect there means no row was created, which strands nothing | no change |
| `packages/agent/src/FlowEngineLike.ts:998` `Schema.encodeSync(ModelRequest)` | no — step-key material for the digest | no change |
| `packages/agent/src/AgentSession.ts:793`, `:1232`, `EngineChildren.ts:302,304` | no — approval completion, status read, child state decode | no change |
| `ActionPersistence.ts` | no — `Fail` errors are already schema-encoded by `Action.executeEncoded` (`ActionPersistence.ts:422`), outside this package | no change |

`encodeState` is a real second instance of the class and it is now pinned rather
than rewritten, because after the fix nothing reachable can make it fail. A
probe against `Schema.fromJsonString(RunState)` shows the two behaviours: a class
instance encodes lossily but succeeds (`JSON.stringify` walks its own
properties), and a circular value fails
`SchemaError(Expected a JSON-serializable value)`, which `Effect.orDie` would
turn into the same wedge. Every field of the state written on the terminal path
is JSON by construction — `payload` was JSON-encoded at creation and read back
through `JSON.parse`, and `result` is now either the flow's own JSON encoding or
the projection — so the two cases in `ExitEncoding.test.ts >
the state a terminal transition writes` pin exactly that: a projected settlement
survives `encodeState`, and so does the projection of a *circular* failure.

`normalizePayload` remains an `Effect.orDie` that can strand a handing-off round
`running` if a target flow's payload codec rejects the handoff payload. It is a
payload encode, not an Exit/Cause encode, so it is outside this lane's spec; it
is recorded here as the adjacent hazard for whoever owns trampoline handoffs.

## Item 4 — existing pins and thresholds

The six named pins, run explicitly (load 4.74):

- `packages/engine-store`: `InterruptedSuspensionPark`, `CrossDriverCancelSettles` — 2 files, 4 tests, passed.
- `packages/agent`: `EngineParkAcrossProcesses`, `AgentSessionPorts`, `ApprovalResumeAcrossCompositions`, and this lane's `FailedRunPersistsAcrossProcesses` — 4 files, 25 tests, passed.
- `packages/control`: `ApprovalResume`, `CancelReceiptReplay` — 2 files, 9 tests, passed (load 3.91).

## Gates

Every command from the worktree root's package directories, `corepack pnpm`
install `--frozen-lockfile --offline` (exit 0, no lockfile change).

| Package | Command | Load at start | Result |
| --- | --- | --- | --- |
| engine-store | `eslint src --max-warnings=0`, `dprint check`, `tsc -b`, `tsc -p tsconfig.test.json --noEmit`, `scripts/circular.mjs` | 2.72 | all exit 0 |
| engine-store | `vitest run` (coverage enforced) | 2.72 | 102 files, 821 tests passed; statements 100% (3566/3566), branches 100% (1786/1786), functions 100% (933/933), lines 100% (3232/3232) |
| agent | `eslint src --max-warnings=0`, `dprint check`, `tsc -b`, `tsc -p tsconfig.test.json --noEmit`, `scripts/circular.mjs` | 2.80 | all exit 0 |
| agent | `vitest run` (coverage enforced) | 5.02 | 29 files, 424 tests passed; statements 100% (1256/1256), branches 100% (583/583), functions 100% (426/426), lines 100% (1131/1131) |
| control | `tsc -b`, `vitest run` | 3.91 | 27 files, 229 tests passed |
| time-travel | `tsc -b`, `vitest run` | 7.68 | 34 files, 312 tests passed |
| cli | `tsc -b`, `vitest run` | 6.61 | 36 files, 608 tests passed |
| gateway | `tsc -b`, `vitest run` | 5.29 | 10 files, 94 tests passed |
| flows | `tsc -b`, `vitest run` (after the known-files regeneration) | 3.77 | 12 files, 403 tests passed |
| registry | `tsc -b`, `vitest run` | 3.75 | 15 files, 319 tests passed |
| create-app | `tsc -b`, `vitest run` | 3.75 | 8 files, 93 tests passed |
| apps/review | `tsc -p tsconfig.json --noEmit`, `bun test tests` | 4.01 | 569 pass, 1 skip, 0 fail across 69 files |

Load stayed between 1.9 and 7.7 throughout, below the 40 guard, so every suite
ran at its configured worker count and no suite needed an isolated rerun.

`known-files.d.ts` was regenerated with `node scripts/generate-known-files.mjs`
(4654 → 4658 workspace files) in its own commit; no `BUILD.ts` changed, so
`tsconfig.json` and `.github/workflows/ci.yml` are untouched, and the new module
adds no coverage-ignore directive, so the `packages/flows`
`vitestCoverageIsolation` allowlist is unchanged.

## What this does not cover

- S1 (`smithers up` exits 0 for a failed run) is `packages/cli`'s and belongs to
  another lane; no `packages/cli/test` binary pin was needed here.
- S3 (the Cerebras route) and P1 (the pipelines' `-d` launch) are untouched.
- The cutover's `An agent run lifecycle event could not be journaled …
  InterruptError` warning is a separate observation and is not in this spec.

## Logs

`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/fix-engine-failed-persist-logs/`:
`01-red-exitencoding.log`, `02-red-crossprocess.log`,
`03-red-unencodable-settlement.log`.
