# @smthrs/e2e

The fault-injection matrix for Smithers 1.0: crash and restart, the served
control plane, time travel, providers, and safety. Every case injects a real
fault into a real process and reads the result out of durable state.

## What a case may and may not do

A case runs against the shipped runtime. It may not stub the engine, the
journal, the control plane, or a provider — a suite that passes against a stub
proves nothing about the product, and this directory exists precisely to catch
what unit suites cannot.

Concretely:

- Crash cases kill a real operating-system process with `SIGKILL` and resume in
  a fresh one, against a SQLite file on disk.
- Gateway cases talk to `smithers serve` — the product's own command, spawned
  from the bin `@smthrs/cli` declares — over a real socket, authenticated with a
  real bearer credential. The suite never composes a server of its own: which
  bind the verb accepts, which authentication layer it installs, and which
  database file it opens are the verb's decisions, and they are what a case
  built on a hand-composed server would stop covering.
- Time-travel cases drive `@smthrs/time-travel` over a real Jujutsu workspace.
- Provider cases stop and kill a real child process and read the typed health
  state that produces.

## Layout

- `harness/` — the fault primitives: `killProcess`, `dropWebSocket`,
  `freezeSqliteLock`, `skewClock`, `stallSandbox`, plus the child-runner
  protocol (`engineChild`, `waitChild`), `smithers serve` (`serveProcess`), and
  the two-plane claim race (`claimRace`). Each primitive has its own suite; a
  harness that lies makes every case built on it a lie too.
- `fixtures/` — the programs a harness spawns. They are separate processes
  because a test cannot kill itself.
- `faults/` — one file per case, named after what it injects.
- `budgets/` — the memory and wall-time ceilings the cases enforce. Change the
  JSON, never the assertion.
- `ci/` — the manifest reader, the JUnit parser, and the suite runner.
- `fault-matrix.json` — the case inventory. `ci/faultMatrix.test.ts` fails if it
  and `faults/` disagree.
- `fault-gaps.md` — what is not covered, and what closing each entry costs.

## Running

The target CI runs, and the one to reproduce a CI failure with:

```sh
pnpm exec smithers-build test '//e2e:faults'
```

The whole matrix, under its wall-time budget:

```sh
pnpm -C e2e run test:faults
```

One case, while writing it:

```sh
pnpm -C e2e exec vitest run faults/case31-real-engine-kill-resume.test.ts
```

The `nightly` suite runs every declared case regardless of tier:

```sh
pnpm -C e2e run test:soak
```

## Requirements

- Node 22.19 or newer. The fixtures are TypeScript and run under Node's own type
  stripping; nothing here is built first.
- `jj` on `PATH` for cases 12 and 21. They skip without it locally and fail
  loudly on CI, because a silent skip is how a real regression against the real
  binary merges.
- `git` on `PATH` for case 32, whose checkpoints are git refs.

No case needs a credential or a network. A case that would is recorded in
`fault-gaps.md` instead of being written against a fake.

## The child-runner protocol

Cross-process cases speak one protocol on stdout, and nothing else:

- `SMITHERS_ENGINE_HANDSHAKE=<phase>:<nonce>` before any work. The phase is
  `probe` or `execute`, and they are distinct so an admission probe can never be
  replayed as evidence that a flow ran. The nonce is minted per spawn.
- `PROBE_STATUS=ok` — the runner booted the product against the real database
  and executed nothing.
- `RESULT_STATUS=<status>` — the run settled.

Everything else a case observes is a file: marker files for progress and an
append-only execution counter for dispatches. A `SIGKILL`ed process cannot
rewrite either, which is what makes them admissible after the kill.

## Budgets

`budgets/memory.json` and `budgets/latency.json` hold the ceilings. Read them
through `budgets/loadBudget.ts`; a regression must fail the case, not quietly
widen the number.

Memory budgets are stated as growth over the suite's own baseline. The matrix
shares one process, so an absolute resident-set ceiling would measure the suite
rather than the path under test.

## What gates this directory

`e2e` is a member of `pnpm-workspace.yaml` and of the root manifest's
`workspaces`, which is what gives it a `node_modules` and therefore a `vitest`
binary. Until that landed, `pnpm exec smithers-build test '//e2e:faults'` failed
in 262 ms with `Command "vitest" not found` and every case below had never run
under any gate (Phase 7 blocker B6). `ci/matrixIsWired.test.ts` pins the
membership and both CI steps.

Two steps in `.github/workflows/ci.yml`, generated from the root `BUILD.ts`:

- `smithers-build build '//e2e:check'`, in the required `test` job. A stale
  fixture is how this directory rots without anybody noticing:
  `fixtures/claimChild.ts` called `Control.pause`, which rc.0 removed, and died
  at runtime in every case that spawned it. The typecheck catches that in
  seconds.
- `smithers-build test '//e2e:faults'`, in the required `e2e-faults` job. It
  was advisory while case 22 below was required to be red at rc.0: a required
  job would have been red on every commit for a defect no commit introduced.
  The section 5.2 redaction deliverable landed the redacting logger, case 22
  went green with no edit to the test, and the matrix is 67 of 67, so the root
  `BUILD.ts` drops `continueOnError` and lists `e2e-faults` in `requiredJobs`.
  The graceful park this directory cannot reach is still broken in the product
  (`fault-gaps.md`, row `03, 05, 31`), but that is a coverage gap: no case here
  fails for it, so it cannot make this job red.

Membership has a second edge. Root `pnpm test` is
`pnpm --recursive --if-present run test`, the pre-PR gate `CONTRIBUTING.md`
names, so it runs this directory's `scripts.test` on every commit. That script
is `vitest run ci/ harness/`: the eight deterministic suites, 40 tests in about
6 s. The cases themselves stay behind `//e2e:faults` and the `test:faults` script,
because they kill process groups and bind ports for about 95 s. Putting them in
the recursive fan-out would spend that on every commit, on a pre-PR gate whose
whole value is that it answers in seconds. `ci/matrixIsWired.test.ts` pins both
halves: it asks vitest which files each argv selects, and fails if a case
reaches `scripts.test` or if a case leaves `//e2e:faults`. Root `pnpm run check` runs this directory's
`tsc -p tsconfig.json --noEmit` in about 4 s, and that one is green.

## Required gates that are red

None. Every case in this matrix is expected to pass, which is what lets
`e2e-faults` gate.

One was red by design until recently, and the shape is worth keeping because the
next requirement the product does not meet yet is enforced the same way.
rc-contract R-12 makes case 22 a required parity test over the journal *and* the
logs. rc.0 shipped no redacting logger, so an action that logged a credential
put it on the operator's terminal, and the requirement was enforced by keeping
`case22 ... redacts the credential out of the operator's terminal` in the matrix
as a plain failure with its owner named in the case file and in `fault-gaps.md`.
Marking it `.fails`, skipping it, or deleting it would have reported a green
matrix over a live credential leak, so `scripts/repo-contract/fault-skips.test.mjs`
refused all three. The section 5.2 redaction deliverable landed
`@smthrs/journal` `RedactedLogger` and the test went green with no edit to this
suite, which is exactly what a plain failing test is for.

State the next one the same way: a plain test that fails, its owner in the case
file, a row in `fault-gaps.md`, the shipped limitation on
`docs/pages/release/known-limitations.md`, and an entry in that contract suite's
`requiredRedGates` so nobody can quietly delete it. `e2e-faults` goes back to
`continueOnError` for as long as one exists.

## Flakes

There is no automated promotion history and no rolling flake cache. A case is
either in `fault-matrix.json` and expected to pass — or, while a required gate
is red, expected to fail for a stated reason with a named owner — or it is not
in the suite. Record a flake by hand in `flake-log.md` with enough detail to
reproduce it.
