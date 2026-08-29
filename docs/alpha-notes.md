# Private alpha notes

Smithers release 1 is an engine-group private-alpha pilot: a pre-1.0 durable
execution library for invited operators, not a general-purpose control-plane
release. These notes are the one-page ledger of its shipped posture and limits,
including things a reader would otherwise have to discover from the test tree.
They are statements of current behavior, not promises of planned behavior.

## Support posture

The shipped pilot target is **Node.js 22 with local SQLite**. Package manifests
require Node.js `>=22.19.0`, and CI pins Node `22.19.0`. The durable database
backend is `@effect/sql-sqlite-node`; see the [SQLite operating envelope](../pages/sqlite-operating-envelope.md)
before placing a database file on disk.

**PostgreSQL and PGlite are unsupported.** The write-retry seam recognizes
some of their transient failures, but release 1 ships neither a client layer
nor a migration ladder for either backend. This accepted parity gap is tracked
as [issue #78](../pages/release/support-matrix.md#planned-or-incomplete-integration).

No other runtime is a supported durable target. The Bun lane runs the
non-durable package suites and excludes every durable one, and no browser
execution suite exists, so neither establishes durable-engine support. The
[support matrix](../pages/release/support-matrix.md#support-matrix) states
the status of each platform and storage combination.

The substrate is a release candidate: every release-1 engine manifest pins
`effect` to exactly `4.0.0-rc.108`. An upstream defect against that pin is not
fixed by a patch range, so the known ones and their mitigations are tracked in
[substrate pin and known upstream issues](../pages/release/support-matrix.md#substrate-pin-and-known-upstream-issues).

The alpha control server defaults to loopback (`127.0.0.1`). A non-loopback
bind requires the explicit `--listen`/`listen: true` opt-in and does not add
TLS, token rotation, or multi-principal authorization. Keep ordinary alpha
use localhost-only; if an operator opts into a network bind, they must provide
the bearer-token and TLS/ingress protections described in the
[control-plane trust posture](../pages/guides/control-plane-trust.md).

### Advisory CI lanes

The required release-1 gate is the `test` job, `workspace graph (coverage gates
enforced)`, which runs `smithers-build ci '//packages/...'` and
`smithers-build test '//scripts/...'`. The macOS and Windows package suites,
`package suites (macOS, advisory)` and `package suites (Windows, advisory)`,
are the only explicitly advisory lanes (`continue-on-error: true`) while they
establish a stable green streak; their failures do not establish support for
those hosts or block the Node/Linux private-alpha target.

One advisory lane remains red. On Windows, the server seed-allowlist test
constructs a module path with a doubled drive prefix, and the `jj` package's
symlink/dirent assertions do not yet match Windows behavior. This is a tracked
CI-portability gap, not a waived required check; promote the Windows lane only
after its failures are fixed and repeated main-branch runs are green.

## Not in 1.0.0-rc.0

The release train packs the `engine` and `agent` groups together at one
synchronized version, and every `tooling` package is private. Membership is no
longer a proxy for feature scope, so a package can ship and still not be a
release-candidate feature. The following exist in this repository but are not
rc.0 features: `@smthrs/triggers` and `@smthrs/evals` (both private at rc.0),
memory semantic recall, and observability OTLP export. `@smthrs/gateway`
publishes because the Plue cutover needs its wire schemas, but its supervision
runtime is still a noop. The
[implementation-status scope table](../pages/release/support-matrix.md#not-in-release-1)
explains the status of each; in particular, the published OTLP layer is
application-wired rather than a shipped default.

## Known test pins

A **pin** is a test the default gate does not run to a pass. Three forms count:

- `it.fails` / `test.fails`. The test asserts that current behavior is wrong, so
  the suite goes red on the day it starts passing.
- `.skip` / `.todo`. The test does not execute at all.
- `.skipIf` / `.runIf` on an environment variable nothing in the repo sets. The
  test executes only for someone who remembers it exists.

A `.skipIf` / `.runIf` on a platform, an installed binary, or a built artifact
is a capability gate rather than a pin, because it runs on the supported
configuration. `describe.skipIf(process.platform === "win32")`,
`describe.skipIf(!jjInstalled)` and `describe.skipIf(wasmBytes === undefined)`
are all capability gates, and CI installs `jj`, so the jj-gated suites execute
there. `process.env.CI` is a capability gate for the same reason.

Every pin in every package group (`smthrs.group` in each manifest) must appear
in the table below. `scripts/check-test-pins.mjs` enforces that and CI runs it,
so a new pin fails the build until it is either fixed or written down here. The
1.0 release train packs the `engine` and `agent` groups together, so the
register covers `agent` as well; before 1.0 it covered `engine` and `tooling`
only.

### Surviving pins

| Package | Test | Form |
| --- | --- | --- |
| `database` | `dies with the original lock defect after the fixed open-retry budget is exhausted` | `it.live.runIf(FLOWS_SLOW_TESTS === "1")` |
| `harness` | `workerd smoke` | `describe.skipIf(FLOWS_WORKERD_SMOKE !== "1")` |
| `create-app` | `layerTevm against a mainnet fork` | `it.skip` in `template/aomi` |
| `migrate` | `migrates a single-file JSX project through the bin (${reason})` | `it.skip` without a seat |
| `migrate` | `records what a single-file project could not settle (${reason})` | `it.skip` without a seat |
| `migrate` | `refuses what it cannot translate in a multi-workflow pack (${reason})` | `it.skip` without a seat |

**`migrate` — apply against a real model.** The three cases in
`packages/migrate/test/flow/MigrateFlow.live.e2e.test.ts` drive the migration
tool against a real model: they rewrite a 0.x JSX workflow, record what the
run could not settle, and refuse a multi-workflow pack the tool cannot
translate. Everything else under `test/flow` scripts the seat, so these are
the only cases that prove the contract, the prompt, and the captured sources
are enough for a model to produce a flow the registry discovers. They cost
real money and real minutes, and the package hard-codes no model id on
purpose, so the operator names the seat: set `SMITHERS_MIGRATE_SEAT` to a
`provider:model` seat and set that provider's key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`), then run
`pnpm --filter @smthrs/migrate test`. Without both, each case skips and says
which variable is missing rather than passing without doing the work. What
breaks if it regresses: the migration path an operator runs at cutover could
stop producing a compiling flow and only the release rehearsal would find out.
Closing it for the default gate means paying for a model seat in CI, which
the RC does not do.

**`harness` — workerd smoke.** The suite boots a real `workerd` process to
prove the QuickJS cell runtime runs unchanged on the Cloudflare runtime.
`workerd` is not a repository dependency and CI installs no binary for it, so
the suite is gated off the default run rather than failing on every machine
without one. What breaks if it regresses: the cell runtime could acquire a
Node-only dependency and nothing would notice until an edge deployment. Run it
with `FLOWS_WORKERD_SMOKE=1 pnpm --filter @smthrs/harness test` after
installing `workerd`. Closing it for the default gate means adding `workerd` to
the toolchain the CI lane installs, which the RC does not claim (see the
browser and edge entry in `rc-contract.md` section 7).

**`create-app` — `layerTevm` against a mainnet fork.** The pin is inside
`packages/create-app/template/aomi`, a scaffolding template copied into a new
project rather than a suite this repository runs: `create-app`'s own
`vitest.config.ts` includes `test/**/*.test.ts` only, because the template's
tests resolve against the scaffolded copy's `node_modules`. The test needs a
funded mainnet fork RPC endpoint, which no gate here provides. What breaks if
it regresses: nothing in this repository; a scaffolded project inherits a
skipped test it can enable with its own endpoint. It is listed because the pin
register scans package directories, not vitest include globs, and a pin the
scanner can see is a pin the register documents.

**`database` — open-retry exhaustion.** The contract this test encodes is
correct and the test passes: run under `FLOWS_SLOW_TESTS=1` on 2026-08-16 it
exits 0, at 220-240 s over two measurements. It is gated off the default suite
on cost alone. `NodeDatabase.layer` retries a locked open on a fixed ladder —
`openAttempts = 40`, exponential from 5 ms, jittered, capped at 250 ms — that
`NodeDatabaseOptions` deliberately does not expose, because the ladder bounds a
driver-internal race during layer construction, before any service exists to
configure (see the comment on `openSchedule` in
`packages/database/src/node/NodeDatabase.ts`). Against a lock that is never
released, each attempt also blocks inside SQLite's own WAL-conversion wait, so
the real cost is about 6 s per attempt rather than the schedule's delay, and
exhausting the ladder takes roughly four minutes — more than seven times the
package's 30 s per-test budget. What breaks if it regresses: an open that can
never succeed would surface a retry wrapper's error instead of SQLite's own
`database is locked` defect, making a stuck peer harder to diagnose. Workaround
— run it explicitly:

```sh
FLOWS_SLOW_TESTS=1 pnpm --filter @smthrs/database test
```

Closing it for the default gate needs either the ladder to become configurable
or the per-attempt SQLite wait to be shortened with a `busy_timeout` on the open
path. Both change production source to suit a test, and neither is an alpha
blocker.

### Resolved: the audit's `it.fails` count

The 2026-08-16 readiness audit recorded finding F4, "`it.fails` pins: 29
remain", distributed across engine-store, flow, kernel, time-travel,
capability, database, harness, jj, platform-node, sync, targets and
build-cli. That count was stale at the commit it was filed against. There are
no `it.fails` pins anywhere in `packages/` at `3fcf5fcd`:

```sh
git grep -n 'it\.fails\|test\.fails' -- packages   # no output
```

The last commit carrying any was `c890e65d`, with 12. All 12 were closed by
fixing the defect and flipping the pin, not by deleting the test — each one
still exists as a live assertion in the same file, and each of those suites is
green:

| Package      | Test                                                                                        | Now at                                 |
| ------------ | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| `canonical`  | has no canonical form for a lone surrogate returned by `toJSON`                             | `test/Canonical.test.ts`               |
| `canonical`  | has no canonical form for a lone surrogate key returned by `toJSON`                         | `test/Canonical.test.ts`               |
| `capability` | bounds wall time for adversarial repeated-star patterns against long non-matching resources | `test/Capability.property.test.ts`     |
| `capability` | completes a 10k-character non-match for a repeated-star grant pattern                       | `test/Capability.test.ts`              |
| `flow`       | normalizes Windows and POSIX separator spellings when comparing overlaps                    | `test/FileBoundary.test.ts`            |
| `flow`       | rejects separator variants of the same written and removed path                             | `test/FileBoundary.test.ts`            |
| `flow`       | rejects a very deep `AndThen` graph with a typed error instead of overflowing the stack     | `test/Graph.test.ts`                   |
| `flow`       | rejects a cyclic unknown payload with a typed error instead of overflowing the stack        | `test/Graph.test.ts`                   |
| `flow`       | rejects a very deep unknown payload with a typed error instead of overflowing the stack     | `test/Graph.test.ts`                   |
| `kernel`     | rejects an envelope carrying request-only payload fields                                    | `test/GrantEvent.test.ts`              |
| `kernel`     | fails closed when a page repeats its last sequence with `hasMore`                           | `test/JournalGrantStoreReplay.test.ts` |
| `keys`       | decodes a `key2_` key, which the version marker promises stays readable                     | `test/Key.test.ts`                     |

Agent-group packages are outside this register and outside the guard; F4's
`harness` entry belongs to that group.

## Known limitations

The agent gateway does **not** automatically recover abandoned runs in the
private alpha (audit P1-2). `@smthrs/gateway` exposes the `SuperviseRuntime`
host contract, but its only bundled defaults are `makeNoop` and `layerNoop`:
the default scan returns no candidates and the default resume performs no
work. No production gateway layer connects that contract to the durable
engine's run-driver sweep.

Consequently, a run abandoned by its gateway host is not discovered, reclaimed,
or resumed by the gateway. Operators must recover it explicitly, or use a host
composition that runs the durable engine driver with the relevant flows
registered. Do not rely on unattended gateway recovery for alpha workloads.

This limitation can be retired after a production gateway composition wires
the engine recovery path and a crash-recovery test proves that a stale owner is
reclaimed and the run makes progress automatically.

The rest of what release 1 declines to do is documented where the behavior
lives. The items an alpha operator hits first:

- **Recovery has no deadline.** Inside a process that is already running the
  engine, the 30-second stale cutoff is an eligibility floor, not a
  recovery-time objective: a run becomes eligible only after its heartbeat is
  older than the cutoff, the sweep re-drives at most 64 stale rows per
  one-second tick, and a caller-supplied `isAlive` can refuse the steal for
  unbounded time. See [abandoned runs and supervision](../pages/release/support-matrix.md#abandoned-runs-and-supervision).
- **Flow registrations are in-memory.** A restarted process resumes nothing
  until it re-registers the handlers for its stored runs, because registration
  is what re-arms durable clocks and deferred wakes.
- **The production layer is half-packaged.** `@smthrs/flows/NodeRuntime`
  composes database, migrations, stores, and the engine; the Host and kernel
  half is still the caller's, and it installs no process or signal handlers.
  `examples/src/durable-layer.ts` is the worked composition.
- **Detached child flows are not exposed.** Subflows are attached
  parent/child only; first-class detached execution, automatic durable
  lineage, and structured parent cancellation policy are planned, not shipped
  ([subflows](../pages/concepts/subflows.md#detached-children-and-lineage)).
- **Cross-process wake is polled.** The in-process `WakeBus` completes a
  resume signal directly; a wake published from another process still lands
  through polling and the stale sweep.
- **Copy-back applies without a human gate.** The engine applies a settled
  diff bundle to the host itself. The pending-diff review gate is a spec, not
  shipped behavior.

[Implementation status](../pages/release/support-matrix.md) is the
authoritative list; this section names only the limits that change how an
alpha pilot is operated.

## Adding a pin

Prefer fixing the defect. If a pin is genuinely the right call:

1. Keep the test executable in some configuration — an env-gated `runIf` beats
   a bare `.skip`, because a skipped test rots silently.
2. Add a comment on the pin pointing at this file.
3. Add a row to **Surviving pins** and a paragraph saying why it is pinned,
   what breaks if the behavior regresses, and the workaround.

`node --test scripts/check-test-pins.test.mjs` enforces step 3. Steps 1 and 2
are review conventions; nothing checks them.
