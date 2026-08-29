# Persistence design: transactional UI store

Ruling A asked for a real transactional UI store over the existing storage
host, with one atomic commit point per logical transition, versioned envelopes
with ordered migrations, boot recovery from interrupted commits, and explicit
retention bounds. Ruling B asked for Effect below React where a synchronous UI
contract allows it. This document records the choices and the exact boundaries
of what was converted.

## Backend choice: single-blob write-ahead over the StorageApi host

Two candidate designs were considered.

1. **A direct multi-table transaction.** wa-sqlite can provide one, but the
   TanStack persistence adapter owns its transaction boundary and exposes no
   API spanning collections. Keeping that adapter would preserve the bug.
2. **A backend-independent single-blob write-ahead pattern.** Both OPFS and
   localStorage can expose the three-method `StorageApi` seam. The 13 TanStack
   projections then become entries inside one authoritative envelope, so the
   adapter choice no longer defines transaction semantics.

Chosen: **design 2**, implemented as `TransactionalStorage`
(`src/mainview/chain/TransactionalStorage.ts`) over either the browser's
localStorage or `SqliteKeyValueStorage` (`SqliteKeyValueStorage.ts`). The OPFS
adapter owns one `smithers_kv` table, loads a synchronous read mirror, and
serializes writes in call order. Its live-envelope UPSERT is one SQLite
statement and therefore one SQLite transaction; `AppStore.persist` awaits
`flush()` before the TanStack transaction reports persistence complete.

`TransactionalStorage` holds the whole persisted state as one versioned
envelope (`smithers-mvp.store`): `{ version, entries }` where `entries` maps
each TanStack collection key to the exact string the unwrapped host would have
held. Reads are served from an in-memory mirror loaded once at open.

### One atomic commit point per logical transition

`AppStore.persist` (the dispatch `mutationFn`) wraps its fan-out in
`storage.batch()`. Inside a batch, `setItem`/`removeItem` accumulate into a
pending delta; reads see delta-over-base. The batch ends in one commit:

1. **stage** — write the serialized envelope to `smithers-mvp.store.staged`.
2. **commit** — write the same bytes to `smithers-mvp.store`. This single
   write is the commit point: before it the old envelope is authoritative,
   after it the new one is. localStorage `setItem` is atomic per key; OPFS uses
   one atomic SQLite UPSERT. The commit point cannot tear on either backend.
3. **clear** — remove the staged key.

A batch that fails before the commit point is discarded (`abortBatch`): no
projection changed. A write outside any explicit batch commits its own
three-step protocol immediately, so direct inserts (seed, boot
reconciliation) keep their durability.

The in-memory mirror adopts a write only after the host write returns. A
commit that throws (a quota rejection, a revoked host) leaves the mirror on
the last committed envelope, so the live session cannot read a projection the
host never took and the next successful commit cannot smuggle it out.

### Boot recovery

At open, before any collection reads:

- No staged key: clean.
- Staged key present and its bytes equal the live envelope: the crash happened
  between commit and clear. **Complete** the commit by clearing the staged
  key. The new state is already authoritative.
- Staged key present and its bytes differ from the live envelope: the crash
  happened between stage and commit. **Roll back**: delete the staged key and
  keep the old envelope. No projection of the interrupted transition survives.

`TransactionalStorage.test.ts` injects a crash at every stage of the protocol
(stage write, commit write, clear, and a kill between stage and commit) and
proves both recovery directions from each.

### Versioned envelopes, ordered migrations, quarantine

The envelope carries `version`. `migrateEntries` walks an ordered list of
steps, each migrating version _n_ to _n+1_; open applies every step between
the stored version and `ENVELOPE_VERSION` in order.

- **Version 0** is the pre-envelope layout: the 13 collection keys living
  directly on the host. Step `0 → 1` collects them into the envelope and
  removes the legacy keys. It is also the adoption gate for unstamped rows:
  every legacy row is schema-decoded against its collection's Zod schema
  before adoption. A row that fails decode is **quarantined**
  (`smithers-mvp-quarantine.row.<collection>.<key>`) and never adopted; a
  collection key whose bytes do not parse is quarantined whole. Nothing is
  adopted blind.
  For an existing OPFS database, `SqliteKeyValueStorage` first copies each
  `collection_registry` table into that same version-0 shape. The ordered
  decoder then applies the identical row checks; the former tables are not
  dropped or cleared, so their original bytes remain available for recovery.
- **A future version** (written by a newer build) is quarantined to
  `smithers-mvp-quarantine.store.future.<version>` and the live envelope key
  is removed so this build reseeds empty. The quarantine copy is never
  deleted; a later boot leaves it in place.
- **An unparseable envelope** is quarantined the same way.

The app-level gate (`SchemaVersion.enforceSchemaVersion`, APP_SCHEMA_VERSION)
runs against the selected host first and owns the reset-vs-adopt decision for
the app shape; the blob keys join its declared clear list so a bump quarantines
the envelope too on either backend.

### Retention and compaction

Log collections grow unboundedly without a policy. Chosen bounds, enforced by
compaction inside the same dispatch transaction that appends (so compaction
is part of the atomic commit, never a separate sweep):

- `app-transitions`: keep the newest **500** records (by revision).
- `app-tool-calls`: keep the newest **250** records.
- `app-chain-events`: keep the newest **1000** records.

These cover a long session's debuggable history (the dev-tools journal fold,
`/debug.chain`) while bounding single-blob serialization on both backends.
Records beyond the bound are deleted oldest-first.

## Ruling B boundaries

### Converted

- **CloudAgent** (`src/bun/CloudAgent.ts`): the `Map<runId, AbortController>`
  transport is replaced by a scoped Effect transport. Each turn runs as a
  fiber in one `FiberSet` owned by a `Scope` the agent acquires; `cancel`
  interrupts the fiber. The registry keys a turn by entry identity, not by run
  id alone, so a cancelled turn's teardown cannot evict the turn that replaced
  it. The fetch rides `Effect.tryPromise`'s interruption
  signal, and the stream reader is released with `Effect.acquireRelease`, so
  interrupting a turn cancels the in-flight read instead of leaking it. The
  public call shape (`start`/`cancel` signatures and frame protocol) is
  unchanged.
- **boundedFetch** (`controller/context.ts`): the manual
  `AbortController` + `setTimeout` deadline is an `Effect.timeoutOrElse` over
  `Effect.tryPromise`; interruption aborts the request. Public shape and the
  "seam timeout" failure are unchanged. `Effect.timeout` alone would not hold
  the second half of that: it rejects with a `TimeoutError` whose `message` is
  undefined, so the fallback names the failure explicitly.
- **Controller seam routing**: request/response HTTP seams (the domain seam
  context and controller `ctx.http` call sites) route through `boundedFetch`,
  so every non-streaming call carries the deadline. Streaming paths (the
  agent turn, the workflow SSE pumps, the world-sweep model stream) and the
  workflow event poll deliberately carry no deadline: the poll already has
  its own bounded retry/quiet discipline, and routing it through
  `Effect.runPromise` shifted the pump's dispatch timing enough to expose a
  TanStack optimistic rollback/replay race on the session revision
  (Wave12.test.ts caught it as a duplicate transition id). That race is a
  pre-existing latent property of revision allocation from optimistic state,
  not of this change; the poll stays on the tapped `http` until it is
  addressed.
- **The batch commit adds no latency**: `AppStore.persist` opens the batch
  with `beginBatch()` and calls `commitBatch()` synchronously as the
  acceptMutations fan-out settles. Committing even one microtask later
  leaves the transaction uncommitted when the next dispatch mutates the
  session row, and TanStack answers with an optimistic rollback/replay that
  lets a later dispatch re-allocate the same revision (duplicate
  `transition-N` insert, reproduced by ToolLoop.test.ts).
- **Controller disposal scope**: `ControllerContext` gains a disposal list
  (`onDispose`/`dispose`). The agent subscription (`turns.ts`), the
  cross-tab identity listeners and `BroadcastChannel` (`auth-billing.ts`),
  and the workflow pumps are registered so everything a controller opens is
  released when `AppController.dispose()` runs. Previously the unsubscribe
  was discarded and the listeners/channel leaked for the page lifetime.

  Boundary: the shipped app never calls `dispose()`. `ControllerProvider`
  memoises one boot promise per page (`browserBoot`), so the controller is a
  page-lifetime singleton with no teardown point to hang the call on. The
  scope exists so a controller that IS replaced — an HMR reload, a second
  boot, every test that builds one — releases what it opened instead of
  stacking listeners on the shared `document`/`window`. Wiring `dispose()` to
  `pagehide` would buy nothing: the page is being destroyed anyway.

  The OPFS key/value host participates in the same scope: controller disposal
  flushes the ordered write queue and closes the wa-sqlite database/worker
  handles. localStorage has no acquired resource to release.

### No-go: ambient `commandActor` invocation-context threading

Not converted; the evidence:

- Command invocation must stay synchronous: `runCommand`/`runCommandArgs`
  (`AppController.ts:640-650`) check existence and return `boolean` before
  the async work settles, so an async context cannot be installed by the
  caller.
- The actor is read at 20+ sites across six controller modules and every
  domain seam (`actor: () => ctx.commandActor`, `AppController.ts:288`)
  with no actor parameter on any controller method. Threading an invocation
  context to every read means re-signaturing ~40 methods and every seam.
- The renderer has no `AsyncLocalStorage`, so there is no implicit
  concurrency-safe channel; the bun-side `AsyncLocalStorage` does not exist
  in the webview.
- The residual race is narrow and documented: a user command dispatched
  while an agent command is suspended at an `await` reads `commandActor ===
  "smithers"`. Both actors still record through the dispatcher; the
  mis-attribution affects the recorded actor of that one transition, not
  capability gating (user-only commands are excluded from the agent catalog
  at the registry, not by the cell).

### Completed: OPFS cross-collection atomicity

The per-collection wa-sqlite adapter was replaced in AppStore by the
`SqliteKeyValueStorage` host. OPFS and localStorage now construct the same
TanStack collection adapter over the same `TransactionalStorage` facade. A
logical dispatch buffers every collection projection and commits one live
envelope; OPFS settles that envelope as one SQLite UPSERT before persistence is
reported. The OPFS exception no longer exists.

### Boundary: the NativeBridge import-time singleton

`NativeBridge.ts` constructs its RPC bridge and agent singleton at import
time (`Electroview.defineRPC` + `new Electroview(...)`) and exposes no
teardown API; the composition root (`ControllerBoot.client.ts`) injects the
singleton synchronously, so deferring acquisition into a scope would make
every consumer of `nativeAgent`/`nativeRepositories` asynchronous and break
the synchronous UI command path. The safe portion was converted instead:
everything a CONTROLLER opens on top of the bridge — the agent frame
subscription, the cross-tab identity listeners, the identity
`BroadcastChannel`, the workflow pumps — is scoped to the controller and
released by `AppController.dispose()`. The bridge singleton itself is a
page-lifetime resource by design, like `window.localStorage`, and stays.

### Wall-clock sleeps in tests

Verdict: no-go for a broad conversion, with evidence; the one seam where a
clock conversion was safe — `boundedFetch` — now rides Effect's `Clock`
(interruption-based timeout), which is the seam a future `TestClock`
conversion should use. The evidence for the rest:

- The majority of `await new Promise(r => setTimeout(r, N))` call sites in
  the suites are 0–1 ms promise-drain flushes. No duration is being waited
  out, so advancing a fake clock changes nothing; converting them would be
  churn, not determinism.
- The duration-dependent suites (toast debounce/auto-dismiss, the chain
  runtime's 50 ms windows) interleave the waited duration with real async
  I/O — TanStack persistence promises, stream readers, `queueMicrotask`
  frame delivery. `jest.useFakeTimers` (the bun:test compat the one
  existing fake-timer suite, `StartupWatchdog.test.ts`, uses) freezes the
  macrotask queue those suites drain through, so the awaited work never
  arrives and the suites deadlock.
- The checklist runner and e2e harnesses already take `now`/`sleep` as
  injected parameters (`ProbeContext`), so their waits are faked by
  construction and were never wall-clock-bound in tests.
