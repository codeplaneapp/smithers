# Phase 7 fix lane: polish, round 1

Branch `phase7/polish` at `3ef462b974`, worktree
`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/wt/polish`.
Four commits, one per item plus the generated-file refresh. All four spec items
are fixed and green. `pnpm-lock.yaml` and `bun.lock` are untouched: no manifest
changed.

| Commit | Item |
| --- | --- |
| `5d127f2dc7` | 1 and 2 |
| `a9eaff4c0f` | 3 |
| `80889a65d6` | 4 |
| `54cc0b242d` | `known-files.d.ts` for the new examples suite |

## 1. `smithers --version` ran discovery and opened both databases

Confirmed at the source. `packages/cli/src/bin.ts` built the whole Node control
layer before the parser saw the arguments:

```ts
const applicationConfig = yield* NodeControl.config
...
yield* Command.run(cli, { version: packageVersion }).pipe(
  Effect.provide(NodeControl.layer(applicationConfig))
)
```

`Effect.provide` builds the layer before the effect runs, and
`NodeControl.layer` resolves `Project.root`, builds `layerRegistry` (which
scans `<root>/flows` at build time), and opens `.flows/control.db` and
`.flows/engine.db`.

Reproduced outside the repository: a directory with `.flows/` and a `flows/`
tree, `cwd` a marker-free directory below it, `HOME` pointing at it. With 8,200
entries under `flows/` the process printed nothing for 300 s and was killed.
With 50 flow directories it answered in 37.7 s. In a project with an empty
`flows/`, `--version` answered in 0.85 s and left `control.db` and `engine.db`
behind.

- Test: `packages/cli/test/Bin.test.ts` > `smithers executable` >
  `answers --version without discovery or a database, from a directory with no
  project marker`, and the `--help` case beside it. Each stages a home with
  `.flows/` and 24 flow directories, runs the real `src/bin.ts` from a
  marker-free directory below it, and asserts exit 0, the version string, under
  5 s, and no database file.
- RED against the pre-fix source:
  `AssertionError: expected 21351 to be less than 5000` (`--version`) and
  `AssertionError: expected 12996 to be less than 5000` (`--help`). Whole file:
  51.04 s, 2 failed.
- Fix: `packages/cli/src/bin.ts`. `documentRequested(argv)` reads the arguments
  before any layer is described and runs `Command.run` on `NodeServices.layer`
  alone. The scan stops at the first flag that is not `--help` or `--version`,
  so a value spelled `--help` stays a value.
- GREEN: 2 passed, whole file 4.07 s.

## 2. `POST /rpc {}` answered 500

Confirmed against a real `smithers serve` on 127.0.0.1:7399 in a real project:
`{}`, `[]`, `not json`, and `{"requests":[]}` each answered
`HTTP/1.1 500 Internal Server Error` with an empty body and no log line.
`effect/unstable/rpc` hands each decoded message to the server loop, and a
message with no tag dies there.

- Tests, in `packages/gateway/test/GatewayServer.test.ts` against the real
  loopback gateway over real SQLite:
  - `answers POST /rpc carrying <an empty JSON object|an array|text that is not
    JSON at all|nothing at all> with 400 and a typed error body`
  - `refuses a malformed body on every RPC mount, not only /rpc`
  - `passes a well-formed request message through to the server it names`
  - `the RPC body a mount will act on` > two unit cases over the real ndjson and
    msgpack serializations.
- RED against the pre-fix source: `AssertionError: expected 500 to be 400 //
  Object.is equality`, four cases.
- Fix: `packages/gateway/src/GatewayServer.ts`. `carriesRpcRequest` asks the
  composed `RpcSerialization`'s own parser whether the body holds at least one
  tagged message, and `layerRefuseMalformedRpc` is a global router middleware
  that answers 400 with an encoded `GatewayError` for `POST /rpc`,
  `/projections`, and `/sync` when it does not. `request.text` is cached per
  request, so the mount still reads the body it was going to read. The new code
  `malformed_request` is added to `GatewayErrorCode` in
  `packages/gateway/src/GatewayError.ts`. No change was needed in
  `packages/control/src/ControlServer.ts`.
- GREEN, and verified on the real binary: `smithers serve` on port 7401 answers
  `HTTP/1.1 400 Bad Request` with
  `{"_tag":"flows/gateway/GatewayError","code":"malformed_request","message":"POST /rpc carries no RPC request message","cause":null}`,
  while `GET /health` still answers 200 and `smithers ps --remote` still returns
  `{"_tag":"runs","items":[]}` with exit 0.

One trap worth recording: the first version of the middleware annotated the
wrapped effect as `Effect<HttpServerResponse, any, any>`. It compiled inside
`packages/gateway`, and the `any` travelled through `GatewayServer.layer` into
`NodeControl.layerControl` and broke `packages/cli`'s
`tsc -p tsconfig.test.json` with `Type 'any' is not assignable to type 'never'`
in `test/ControlSurface.test.ts`. The annotation is now
`Effect<HttpServerResponse, Types.unhandled>`.

## 3. Anchors the removal messages link to had no heading

Confirmed. `packages/cli/src/Unsupported.ts` emits `#supervision` (6 flag rows),
`#plan-admission`, `#init`, and, from `reservedFlowError`, `#flows`. The
verdict named the first three; the fourth is new.

- Tests, in `scripts/docs-links.test.mjs`:
  - `a heading answers the anchor a link points at, and one that is gone is
    named` (the fixture pin: removing `#### supervision` from the fixture makes
    the check name `supervision`, and a heading inside a fence does not count).
  - `the anchors are read out of the sentences the CLI prints`.
  - `every anchor the CLI sends an operator to resolves in the migration guide`,
    which imports `Unsupported.ts`, builds the sentences from `verbError`,
    `flagMessage`, and `reservedFlowError`, and reads the real page.
- RED against the pre-fix source:
  `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:`
  `actual: [ 'flows', 'init', 'plan-admission', 'supervision' ]`,
  `expected: []`.
- Fix:
  - `scripts/docs-links.mjs`: `headingAnchor`, `headingAnchors`,
    `anchorsLinkedTo`, `missingAnchors`.
  - `scripts/check-docs.mjs`: gate 14, "every anchor a removal message sends an
    operator to has a heading in the migration guide" (header comment updated
    from thirteen checks to fourteen).
  - `scripts/generate-docs-pages.mjs`: writes one `#### <anchor>` section per
    flag anchor that no other heading answers, and throws
    `generate-docs-pages: no migration-guide section for the flag anchor #<x>`
    for an anchor it has no prose for.
  - `docs/pages/migration/1.0.md`: a hand-written `## Flows` section for the
    reserved-flow-id refusal, plus the three generated flag sections.
  - `docs/llms-full.txt`, `docs/llms-migration.txt`,
    `packages/cli/docs/llms-full.txt`, `skills/smithers/llms-full.txt`
    regenerated.
- GREEN: `node scripts/check-docs.mjs` passes all 16 lines, including
  `✓ all 74 anchors the removal messages link to have a heading in the migration
  guide` and `✓ 43 generated docs pages are current`; `node
  scripts/check-llms.mjs` reports `✓ 12 documentation artifact(s) are current`.

## 4. Example 13 was not deterministically green

Confirmed. Three pre-fix runs of `examples/src/13-agent-live-smoke-local.ts`
against the local Ollama daemon on `qwen2.5:7b`: run 1 failed, runs 2 and 3
printed `RESULT: {"answer":"Paris"}`. The failure is the model finishing with
`ctx.done("Paris")`, a sentence rather than a document.

Nothing was added to `packages/agent`: `AgentAction.Options` already carries
`corrections` (default 1, from `host.defaultCorrections ?? 1`) and an optional
`repair`. Only `corrections` was needed.

- Test: `examples/test/13-agent-live-smoke-local.test.ts` >
  `answers a question through the local agent stack, and decodes every time`.
  It asks the daemon for its model list and skips unless `qwen2.5:7b` is
  pulled, then runs the example three times in a row.
- RED against the pre-fix source (`git stash` of the example, test kept):
  `FAIL test/13-agent-live-smoke-local.test.ts > answers a question through the
  local agent stack, and decodes every time`
  `/harness/StructuredOutputFailure: The agent's answer did not validate against
  its declared output schema after 1 of 1 corrections`, with
  ``issues: [ `Unexpected token 'P', "Paris" is not valid JSON` ]``.
- Fix: `examples/src/13-agent-live-smoke-local.ts`. The system teaching now
  shows the exact call the cell runtime expects
  (`await ctx.done(JSON.stringify({ answer: "<your one-sentence answer>" }))`)
  and the step declares `corrections: 3`.
- GREEN: five consecutive direct runs, all exit 0 with
  `RESULT: {"answer":"Paris"}`, 3 to 4 s each. Transcripts:
  `phase7/ex13-transcripts/ex13-final-{1..5}.log`, with the pre-fix failure at
  `phase7/ex13-transcripts/pre-fix-failure.log`.

Two approaches were tried and rejected before this one, both recorded because
they look attractive:

1. Teaching the schema as "reply with one JSON object" without naming
   `ctx.done` made it worse, 5 of 5 runs failing with the same issue.
2. Passing `structuredOutput` to `Route.openaiCompatible` so Ollama enforces
   the schema natively fails the action outright: a route with
   `response_format` sends no tools, and the agent loop then has no way to
   finish, so all 3 runs failed with `model_failed: The agent action
   "examples/LiveSmokeLocal" ended without a completed answer`. That is the same
   symptom `phase7/examples.md` recorded as the original blocker.

## Gates

Load average is quoted from `uptime` immediately before each run.

| Gate | Result | Load |
| --- | --- | --- |
| `packages/gateway` `pnpm run test` | 9 files, 93 tests passed, coverage 100% on all four counters | 18.03 |
| `packages/gateway` `pnpm run lint` | pass (eslint + dprint) | 18.03 |
| `packages/gateway` `tsc -b` and `tsc -p tsconfig.test.json --noEmit` | pass | - |
| `packages/cli` `vitest run --maxWorkers=4` | 36 files, 607 tests passed; statements 81.54, branches 78.46, functions 76.27, lines 81.87, all above the package thresholds | 5.45 |
| `packages/cli` `pnpm run lint` | pass | - |
| `packages/cli` `pnpm run check` | pass | - |
| `apps/ui` `pnpm run proof:gateway` | `PROOF PASSED`, 8 stages over the real gateway | 4.91 |
| `node scripts/check-docs.mjs` | all 16 checks pass | - |
| `node scripts/check-llms.mjs` | 12 artifacts current | - |
| `node --test scripts/*.test.mjs` | 181 tests passed | - |
| `examples` `pnpm run check` | pass | 5.73 |
| `examples` `vitest run --maxWorkers=4` | 34 files, 59 tests: 33 files and 58 tests passed, 1 pre-existing environmental failure | 5.73 |
| `packages/flows/test/vitestCoverageIsolation.test.ts` | 264 tests passed after the `known-files.d.ts` refresh | - |
| `smithers-build lint '//:ci'` | `ok: true`, no workflow drift | - |

## Not fixed, for the orchestrator

- `examples/test/12-agent-live-smoke.test.ts` fails with
  `Error: You have no credits remaining. Add credits to continue using the API`.
  `OPENAI_API_KEY` is exported on this host and the account is out of credit.
  This is the environmental failure `phase7/examples.md` already recorded, not a
  code defect, and it is outside this lane's owned paths.
- Flow discovery is very slow per flow directory: 50 directories under
  `flows/` cost 37.7 s of startup, roughly 0.7 s each, and 200 directories did
  not finish inside 60 s. `--version` and `--help` no longer pay it, but every
  other verb still does, and a project with a few hundred flows would be
  unusable. `packages/registry` owns this and no lane in this round does.

---

# Phase 7 fix lane: polish, round 2

Branch `phase7/polish`, two commits on top of round 1's `54cc0b242d`. All three
round 1 verifier findings are closed. `pnpm-lock.yaml` and `bun.lock` are
untouched: no manifest changed.

| Commit | Finding |
| --- | --- |
| `387df0b195` | major: example 13 still failed nondeterministically |
| `a90c0b6bc6` | minor: orphaned duplicate JSDoc in `GatewayServer.ts` |
| (evidence only, no code) | minor: the mislabelled pre-fix transcript |

## Major: example 13 was still nondeterministic

Confirmed, and reproduced at a higher rate than the verifier saw. Thirteen
isolated runs of `examples/test/13-agent-live-smoke-local.test.ts` against
`54cc0b242d`, each `corepack pnpm exec vitest run
test/13-agent-live-smoke-local.test.ts` from `examples/`:

| Runs | Result |
| --- | --- |
| 1 to 9, 11, 15, 16, 17, 19 | pass, 5.9 s to 34.0 s |
| 10, 14, 18 | fail, `model_failed`, 35.4 s to 36.7 s |
| 12, 13 | fail, `Error: Test timed out in 180000ms.` |

- Test: `examples/test/13-agent-live-smoke-local.test.ts` > `answers a question
  through the local agent stack, and decodes every time` (round 1's file, kept;
  its docblock now names both failure modes).
- RED against the pre-fix source (round 1's final source at `54cc0b242d`), from
  `round2-red-suite-10.log`:

  ```
   FAIL  test/13-agent-live-smoke-local.test.ts > answers a question through the local agent stack, and decodes every time
  /harness/HarnessError: The agent action "examples/LiveSmokeLocal" ended without a completed answer
  ```

  and from `round2-red-suite-12.log`:

  ```
   FAIL  test/13-agent-live-smoke-local.test.ts > answers a question through the local agent stack, and decodes every time
  Error: Test timed out in 180000ms.
  ```

  5 of 13 failed. The same shape reproduces at the single-run level: 20 direct
  `node src/13-agent-live-smoke-local.ts` runs failed twice, once with
  `model_failed` and once producing no output at all inside 150 s.
- Fix: `examples/src/13-agent-live-smoke-local.ts`. The step declares
  `modelParams: ModelRequest.GenerationParams.make({ temperature: 0 })`, so the
  seat decodes greedily. Sampling was the cause: at the provider default the
  same prompt sometimes spent all eight frames writing prose and never called
  `ctx.done`.
- GREEN, measured on this host against `qwen2.5:7b` with the real Ollama daemon:

  | Source | Direct runs | Suite runs |
  | --- | --- | --- |
  | `54cc0b242d`, provider default sampling | 2 of 20 failed | 5 of 13 failed |
  | with `temperature: 0` | 0 of 60 failed | 0 of 12 failed |

  The twelve consecutive isolated suite runs are `round2-green-suite-1..12.log`;
  every one finished between 5.71 s and 5.99 s, a spread of 0.28 s across 36
  model round trips. The pre-fix spread was 5.9 s to 182.3 s. One path taken
  every time is what that clustering means, and it is the strongest single piece
  of evidence that the flake is gone.
- Full suite after the fix: `env -u OPENAI_API_KEY corepack pnpm exec vitest run
  --maxWorkers=4` from `examples/` is exit 0, 33 files passed and 1 skipped, 58
  tests passed and 1 skipped. Example 12 is the skip: it needs an OpenAI key and
  the host's account has no credits, which is the environmental failure
  `phase7/examples.md` and `docs/migration/phase2-baseline.md` 2.1 both record.

### The retry the verifier asked for does not exist to be added

The verifier's fix text asked for deterministic sampling **and** a bound on the
retry "at the workflow level (retry `LiveSmokeLocal.call` on `model_failed` a
fixed number of times)". That cannot be written in this authoring API, and I
tried it before concluding so. `Flow.make`'s `body` is
`(payload) => Node.Node<...>`: a plan-time graph, not an `Effect`. Wrapping the
call in `Action.retry` fails `examples` `pnpm run check` with

```
src/13-agent-live-smoke-local.ts(143,18): error TS2345: Argument of type 'Node<{ readonly answer: string; }, HarnessError | ...>' is not assignable to parameter of type 'Effect<unknown, unknown, unknown>'.
```

`Action.retry` retries the `Effect` inside an action's *implementation* — that
is how `examples/src/04-retry-policy.ts` uses it — and `AgentAction.make` owns
its own implementation and its own layer. The three other candidates are closed
too: `AgentAction.Options` has no retry field (`corrections`, `repair`,
`modelParams`, `maxFrames`, `seat`, `system`, `prompt`); `Action.make` accepts a
`retryPolicy` but `AgentAction.make` neither takes one nor forwards one to the
`Action.make` it builds; and `Options.repair` fires only for a
`StructuredOutputFailure`, never for `model_failed`. `@smthrs/core`'s `Node` has
no `retry` or `catch` combinator either, and `@smthrs/patterns` `WithRetry` is
built on `@smthrs/core`, a different authoring layer from the one this example
uses.

Adding the field is a `packages/agent` change, outside this lane's owned paths
and outside a polish round. The example's header and the commit message both
state the absence and why, so the next reader does not have to rediscover it.
Determinism is the whole guard, and it is measured rather than asserted.

## Minor: the pre-fix transcript was not a pre-fix transcript

Confirmed. `phase7/ex13-transcripts/pre-fix-failure.log` read `corrections: 3,
limit: 3` and `after 3 of 3 corrections`, which is the fix's own setting.

Both halves of the verifier's fix are done:

- The old file is renamed `intermediate-corrections-3-failure.log`, which is
  what it is.
- A genuine pre-fix transcript now sits at `pre-fix-failure.log`, captured by
  overlaying `3ef462b974:examples/src/13-agent-live-smoke-local.ts` on this
  worktree and running it directly. It failed on run 2 of 25 with

  ```
    corrections: 1,
    limit: 1,
    issues: [ `Unexpected token 'P', "Paris" is not valid JSON` ],
    message: "The agent's answer did not validate against its declared output schema after 1 of 1 corrections"
  ```

  which is the sentence round 1 quoted. The worktree was restored to the fixed
  source immediately after.
- `phase7/ex13-transcripts/README.md` now records what produced every file in
  that directory, so a mislabelled log cannot pass as evidence again.

## Minor: an orphaned duplicate JSDoc block

Confirmed at the source. `packages/gateway/src/GatewayServer.ts:270` opened

```
/**
 * Refuses a body that carries no RPC request message with 400.
```

and closed at line 294 with `@since 1.0.0 @category layers`, with line 295
opening the second block, `Whether a request body carries at least one RPC
message the server can act on`, which is the one `carriesRpcRequest` wants. The
layer 33 lines further down carries the same "Refuses a body ..." text again.

- Test: `packages/gateway/test/SourceDocblocks.test.ts` > `the package's own
  sources` > `attach every JSDoc block to the declaration under it`. It walks
  `packages/gateway/src` and reports every block whose next non-blank line opens
  another block, as `<file>:<line>`. A module docblock — the first block in the
  file, opening on line 1 — is exempt, because the block under it documents the
  first export; without that exemption the scan also names `index.ts:1`, which
  is correct code.
- RED against the pre-fix source:

  ```
   FAIL  test/SourceDocblocks.test.ts > the package's own sources > attach every JSDoc block to the declaration under it
  AssertionError: expected [ 'GatewayServer.ts:270' ] to deeply equal []
  ```

- Fix: delete lines 270 to 294 of `packages/gateway/src/GatewayServer.ts`. The
  layer keeps its own block; `carriesRpcRequest` keeps the predicate block.
- GREEN: 1 passed. The whole package is 10 files, 94 tests, coverage 100% on all
  four counters.

## Gates

`uptime` load average is quoted from immediately before each run.

| Gate | Result | Load |
| --- | --- | --- |
| `packages/gateway` `pnpm run test` | 10 files, 94 tests passed; statements 430/430, branches 283/283, functions 122/122, lines 388/388 | 3.41 |
| `packages/gateway` `pnpm run lint` | pass (`eslint src --max-warnings=0 && dprint check`) | 3.41 |
| `packages/gateway` `pnpm run check` | pass (`tsc -b` and `tsc -p tsconfig.test.json --noEmit`) | 3.41 |
| `examples` `pnpm run check` | pass | 3.41 |
| `examples` `env -u OPENAI_API_KEY vitest run --maxWorkers=4` | 33 files passed, 1 skipped; 58 tests passed, 1 skipped; exit 0 | 4.06 |
| `examples` test 13 in isolation, 12 consecutive runs | 12 of 12 green, 5.71 s to 5.99 s | 7.81 |
| `packages/cli` `pnpm run check` | pass (the gateway types travel into it) | 10.07 |
| `packages/flows` `vitest run test/vitestCoverageIsolation.test.ts` | 264 tests passed after the `known-files.d.ts` refresh; the file's own exit 1 is the package coverage threshold reacting to a single-file run, not a failure | 8.63 |
| `apps/ui` `pnpm run proof:gateway` | `PROOF PASSED`, 8 stages over a real gateway and real SQLite | 6.15 |
| `node scripts/check-docs.mjs` | pass, including `all 74 anchors the removal messages link to have a heading in the migration guide` | 6.15 |
| `node scripts/check-llms.mjs` | `12 documentation artifact(s) are current` | 6.15 |
| `node --test scripts/*.test.mjs` | 181 tests passed, 0 failed | 6.15 |
| `pnpm run test:jsdoc` | 5 tests passed | 6.15 |
| `smithers-build lint '//:ci'` | `ok: true`, no workflow drift | 6.40 |

Install: `corepack pnpm install --frozen-lockfile --offline`, exit 0 in 22m 38s.
It printed one warning, `Failed to create bin at packages/cli/node_modules/.bin/
smithers-migrate`, because `@smthrs/migrate` has no built `dist`; it predates
this lane and blocks nothing that ran here.

## Still not fixed, for the orchestrator

- `AgentAction` cannot be retried by the composition that calls it. A local seat
  that ends a turn without an answer has no bound above the step: no
  `retryPolicy` reaches the `Action.make` inside `AgentAction.make`, and a
  `Flow.make` body cannot wrap the call in `Action.retry` because it is a plan-time
  graph. Example 13 is deterministic without one, but any composition on a
  flakier seat has nothing to reach for. `packages/agent` owns this.
- Flow discovery costs roughly 0.7 s per flow directory at startup. `--version`
  and `--help` no longer pay it after round 1, every other verb still does.
  `packages/registry` owns this. Unchanged from round 1.
- `examples/test/12-agent-live-smoke.test.ts` needs an OpenAI key the host's
  account has no credits for. Environmental, recorded in
  `docs/migration/phase2-baseline.md` 2.1, and it skips cleanly.
