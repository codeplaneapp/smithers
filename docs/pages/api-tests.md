---
description: "What the repository proves about its own public surface, which files prove it, and where the gaps are."
---

# Public API tests

What the repository proves about its own public surface, which files prove it, and where the gaps are. Use this page when you change an API and need to know which suite you have just made responsible for the change.

## The gate

Every package runs `vitest` under v8 coverage with 100% thresholds on branches, functions, lines, and statements over `src/**`. Coverage reports go to a per-process directory under the temp dir, because two concurrent runs sharing `./coverage` destroy each other's profiles. Timeouts are 30 seconds and finite, so a genuine hang still fails.

`packages/flows/test/vitestCoverageIsolation.test.ts` is the conformance suite over that arrangement. It pins each package's vitest config, each package's `scripts.test`, the root workspace globs and aggregator scripts, the CI steps that invoke them, the release workflow's pack-and-smoke ordering, and an allowlist of every coverage-ignore directive in any `src` tree with its count.

| Gate                            | Command                  |
| ------------------------------- | ------------------------ |
| typecheck                       | `pnpm run check`         |
| unit and integration tests      | `pnpm test`              |
| lint and formatting             | `pnpm run lint`          |
| import cycles                   | `pnpm run circular`      |
| browser and Node entry contract | `pnpm run browser`       |
| runnable examples               | `pnpm run test:examples` |

## Required non-mocked cases

These are the behaviors that have to be exercised against real implementations, because a double would prove nothing about them.

| Behavior                                           | Why a mock cannot prove it                         | Where it runs                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Transactional commit of state plus lifecycle entry | the guarantee is a property of the SQL transaction | `engine-store/test/WalAtomicity.test.ts` over real SQLite                                                                          |
| Crash at an interstitial, then restart             | a double cannot lose a partial write               | `WalAtomicity.test.ts`, `journal/test/Notifying.test.ts`                                                                           |
| Claim, activate, heartbeat, steal                  | the compare-and-swap is the database's             | `run-store/test/RunStore.test.ts`, `engine-store/test/Ownership.test.ts`                                                           |
| Hard-killed owner reclaim                          | needs the real stale-running sweep                 | `engine-store/test/HardKillReclaim.test.ts`, `StaleRunningAttempt.test.ts`                                                         |
| Cross-connection write races                       | a single in-process double serializes by accident  | `database/test/DatabaseWriteContract.test.ts`, `NodeDatabaseConcurrentOpen.test.ts`, `engine-store/test/CycleDetectionSql.test.ts` |
| Durable schema                                     | DDL and database invariants                        | `journal/test/Migrations.test.ts`                                                                                                  |
| Retry budget across process death                  | needs persisted attempt rows                       | `engine-store/test/RetryOrigin.test.ts`, `RetryExpiration.test.ts`                                                                 |
| Cache admission gating                             | needs real boundary evidence                       | `engine-store/test/CacheRecordGating.test.ts`, `CacheAdmissionSerialization.test.ts`, `CacheHitReadSetVerification.test.ts`        |
| Replay from persisted attempts                     | the point is that nothing is in memory             | `engine-store/test/Replay.test.ts`, `engine/test/DurableAttemptResume.test.ts`                                                     |
| Host adapters against the real machine             | a stubbed spawner proves nothing about spawning    | `platform-node/test/contract/NodeHost.contract.test.ts`, `jj/test/NodeJj.test.ts`                                                  |
| Sync catch-up and follow                           | needs a real server, client, and journal           | `sync/test/Server.test.ts`, `Client.test.ts`, `TransportFaults.test.ts`                                                            |
| Rewind archive and truncate                        | atomicity again                                    | `time-travel/test/Truncation.test.ts`, `Rewind.test.ts`, `RewindRollback.test.ts`                                                  |
| Browser entry resolution                           | only a bundler can answer it                       | `scripts/browser-check.mjs`, `kernel/test/BrowserBundle.test.ts`, `time-travel/test/BrowserBundle.test.ts`                         |
| Every documented example program                   | a doc sample that never runs drifts                | `examples/test/*.test.ts`                                                                                                          |

## Inventory

| Package                         | Suites | Notable coverage                                                                                                                                                                                                                |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/platform-node`         | 2      | the shared contract suite (`@smthrs/kernel/test/contract`) against the Node bundle, once with explicit expectations and once taking every default                                                                               |
| `@smthrs/platform-bun`          | 1      | the same suite against the Bun bundle, which runs the Node fallback under vitest                                                                                                                                                |
| [`@smthrs/platform-browser`](/api/platform-browser) | 8 | the shared contract suite against `BrowserHost` three ways (the full wasm-backed bundle, manual redirects, one shared mount), the ZenFS filesystem adapter and its bounded streaming against a real directory, the just-bash spawner's rendering, refusals, handle capabilities, and abort boundary, the browser bundle gate, and the barrel with its kernel isolation attestation |
| `@smthrs/jj`                    | 4      | the contract and its no-op, the jj CLI against a real repository, error classification against a scripted binary, and the Bun and browser layers                                                                                |
| `@smthrs/sandbox`               | 23     | the barrel, spawner adaptation and kill, the scripted and real-process providers, both conformance suites, the health probe, supervision, the session contract, and nine machine providers, three of them against real backends |
| `@smthrs/journal`               | 12     | durable and lossy admission, fencing, transactions, retention, redaction, projections, migrations                                                                                                                               |
| `@smthrs/run-store`             | 9      | run and attempt stores, ownership arbitration, run metadata, migrations                                                                                                                                                         |
| `@smthrs/step-cache`            | 6      | cache admission, eviction, provenance, migrations                                                                                                                                                                               |
| `@smthrs/database`              | 4      | the write-serialization contract, concurrent open, artifact shape                                                                                                                                                               |
| `@smthrs/kernel`                | 23     | capability parsing, matching, subsumption, tiers, ambient sets, grants and their journal persistence, every decorated service                                                                                                   |
| `@smthrs/canonical`             | 1      | RFC 8785 vectors, malformed Unicode, boundary values, and large values                                                                                                                                                          |
| [`@smthrs/crypto`](/api/crypto) | 3      | package-owned vector, property, host-adversary, error, redaction, and parity coverage                                                                                                                                           |
| [`@smthrs/keys`](/api/keys)     | 3      | frozen `key1_` vectors, stored-key identity and version rejection, canonical equality properties, typed host failures, diagnostic redaction, irreversibility, and browser-safe source imports                                   |
| [`@smthrs/plan`](/api/plan)     | 10     | the step-key compiler and its collision cases, plan compilation, conflict annotation and append, the append-only store, the node AST, planned-value refusals, build refusals                                                    |
| `@smthrs/artifacts`             | 5      | the store contract, the memory and filesystem implementations, the combined tier, and the remote client                                                                                                                         |
| [`@smthrs/flow`](/api/flow)     | 28     | flow definitions and their combinators, execution ids, results, suspension and nested suspension, cancellation, child boundaries and trampoline handoffs, graph building and priority, the interpreter, action declaration, requirements, combinators and retry pinning, deferreds, clocks, queues, wait points, polling, human tasks, sleeps, file boundaries, cache policy, retry policy data, step identity |
| `@smthrs/engine`                | 18     | action identity and keys, ordinal stability, keyless concurrency, tiers, durable attempt resume, the memory engine, retry decisions, proxies                                                                                    |
| `@smthrs/engine-store`          | 61     | the durability matrix: ownership, adoption, sweeps, parking, cancellation, cycles, attempt persistence, cache admission, boundaries, WAL atomicity, fault matrix                                                                |
| `@smthrs/sync`                  | 20     | protocol, server paging and workspace merge, client cursors and gaps, transport faults, branch commands, presence, share, projection, convergence                                                                               |
| `@smthrs/time-travel`           | 21     | the `TimeTravel` service surface, replay, fork and its lineage, rewind with claims, concurrency and rollback, truncation, compensation, recovery, both stores                                                                   |
| [`@smthrs/flows`](/api/flows)    | 14     | the barrel namespace universe and the absence of an unsupported Cloudflare runtime subpath, the real-SQLite `NodeRuntime` journey and its guarded host composition, three integration hosts (containment, reaping, signals), the AST spawn-containment gate, sandboxed child execution against both a scripted and a real provider plus its retry policy, the authoring end-to-end program and its error surface, the shipped CLI composition contract, and the repository-wide coverage-isolation conformance suite |
| `@smthrs/examples`              | 11     | every documentation example, run end to end against the real packages                                                                                                                                                           |

{/* generated:keys-testing start */}

The [`@smthrs/keys` suite](/api/keys) freezes `key1_` wire vectors, stored-key
identity and version rejection, canonical equality properties, typed host
failures, diagnostic redaction, irreversibility, and browser-safe source
imports. The repository browser and Bun gates run the same public package and
wire format.

{/* generated:keys-testing end */}

{/* generated:crypto-testing start */}

The package-owned Crypto suite pins published SHA-256 and UTF-8 vectors, a
million-byte vector, malformed Unicode, direct and schema APIs, and
synchronous, injected, and Web Crypto parity. Property tests compare both entry
points over arbitrary valid text and byte views. Adversarial service tests cover
input snapshots, malformed or mutable output, missing services, exact stable
failures with preserved causes, diagnostic redaction, and irreversibility.

{/* generated:crypto-testing end */}

{/* generated:platform-browser-testing start */}

The package-owned
[`@smthrs/platform-browser` suite](/api/platform-browser) runs the shared host
contract against `BrowserHost` three ways: the full bundle over the committed
`flows_jj.wasm`, the manual-redirect `HttpClient`, and one real mount shared by
the filesystem, the interpreter, and jj. Beside it, the filesystem adapter is
exercised against a real temp directory for recursive listing, permission
checks, directory modes, symlink and relative canonicalization, and bounded
streaming with refused bounds, and against stub backends for every error tag,
a looping directory tree, and a backend that misreports a read length. The
spawner suite pins the rendered command line against the kernel's own renderer
with hostile argv tokens, every refused capability, and the abort boundary:
an interpreter that ignores its `AbortSignal` must not let a second run start,
and a killed handle must report a `PlatformError` rather than interrupt its
caller. The barrel suite pins the namespace universe and the kernel isolation
attestation that `layer` makes and `make` does not.

{/* generated:platform-browser-testing end */}

{/* generated:plan-testing start */}

The package-owned [`@smthrs/plan` suite](/api/plan) pins the step-key compiler
and its collision cases: prototype-named dependencies, forged digest inputs,
projected values resolved as own data properties only, adversarial projection
corpora, and a memo whose leader is interrupted while a waiter is parked on it.
Payload tests prove the authoring AST is a JSON mirror, so distinct `Date` and
`URL` payloads never share a key, no function survives into a stored plan, and
a `toJSON` returning its own receiver refuses on both the clone and the input
rather than keying as an empty object. Plan tests cover topological order,
conflict annotation and the ordering edges it infers, reader-after-writer
edges, append across generations, diff attribution for every hashed field,
draft validation, and bounded-resource compilation of a large chain in both
declaration orders. Immutability is pinned by mutating the caller's `Date`,
`URL`, and custom-`toJSON` objects after compiling and asserting the stored
material and the plan digest do not move, and by proving an effect edit re-keys
its node instead of moving the approval digest silently. The store suite runs
real SQLite: append-only triggers including the plan-id pin, compare-and-swap
on the plan generation, the persisted-prefix check that rolls back an append
grown from a divergent branch, ordinal uniqueness, and every refusal code.
Property suites cover file-set globbing, overlap, and Unicode normalization.

{/* generated:plan-testing end */}

{/* generated:flow-testing start */}

The package-owned [`@smthrs/flow` suite](/api/flow) combines pure schema,
policy, and graph tests with interpreted flows. Runtime cases drive declared
bodies through `Interpreter.layer` and read the durable record kept by the
package's in-memory `FlowRuntime` contract fixture.

Authoring is covered by flow definitions and their combinators, declared and
inline actions, action requirements, retry pinning, cache policy, file
boundaries, and step identity, including golden key vectors that turn a change
in how a step is keyed into a red test rather than a silent cache miss.

Execution is covered by execution-id derivation and its hostile-source cases,
flow results and their schema, suspension and nested suspension, cancellation,
child boundaries and trampoline handoffs, graph building, structural address
collisions, placement identity, scheduling priority, and the interpreter's own
refusals.

Durability is covered by deferreds and their completion tokens, durable clocks,
queues and their workers, wait points, polling, human tasks and their attempt
budget, and sleeps. Wire formats that outlive a process are pinned by literal:
the base64url completion token, the derived execution-id preimage, and the child
execution-id digest.

Adversarial cases sit beside the ordinary ones rather than in a separate file.
A completion token is refused when it names a deferred other than the one it
was submitted through. A human answer is admitted only while the run is parked
on that exact approval token, so unopened and stale attempts cannot create a
completion. Retry policy, sleeps, deadlines, and queue concurrency each refuse
a non-finite or out-of-range value instead of arming a timer nobody wakes.
Diagnostics that quote author data are bounded, and placement and payload
inspection never run accessors.

{/* generated:flow-testing end */}

## Explicit gaps

These are known and unclosed. None of them is covered by an existing suite.

| Gap                                                                                          | Consequence                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Postgres or PGlite backend, so the write contract runs on SQLite only                     | dialect parity is asserted by classification code, not by execution                                                                                                                     |
| No production whole-tree `StepBoundary`, so no suite exercises a genuine cross-run cache hit | admission is proven to be refused, and never proven to be correct when granted                                                                                                          |
| No automatic time-travel record creation from ordinary execution                             | the protocols are tested against records the suites write by hand                                                                                                                       |
| No cross-process event-driven wake                                                           | `EventDrivenWake.test.ts` proves the in-process `WakeBus` resumes a waiting caller without a poll tick; wake across processes is still covered through polling and sweeps only          |
| No multi-process ownership test spanning real operating-system processes                     | takeover is covered in-process with injected liveness evidence                                                                                                                          |
| No Cloudflare or Vercel engine-store deployment                                              | the hosted adapters live in a separate repository and are not gated here                                                                                                                |
| No compaction under a live cross-process follower                                            | `JournalCompaction.test.ts` proves checkpoint/compact atomicity, the reader gate, and the typed `compacted` resync signal in-process; a follower in another OS process is not exercised |

## Adding a test

Match the package's existing style: real SQLite through `TestJournal.layer()`, `TestStores.layer()`, or `TestDatabase.layer` rather than a fake store, `Notifying.wrap` for crash and fence-loss injection, and the host contract suite rather than a new bespoke adapter assertion.

:::warning
Coverage is already at 100%. A new branch in `src` without a new case fails the gate rather than passing quietly.
:::
