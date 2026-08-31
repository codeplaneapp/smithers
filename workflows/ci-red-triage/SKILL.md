# CI red triage

Turn one failing CI run and shard into a deterministic local reproduction and
the smallest durable correction. Issues #1549 and #1577 looked like a shard-3
SQLite wedge; PR #1617 fixed the leaked handles and PR #1621 corrected the
metric assertion. Find that class of cause instead of repeatedly rerunning CI.

## Inputs

- `runUrl` identifies the failing run or job and its exact revision.
- `shard` identifies the failing shard, index, runner, and command. Treat an
  index without its matrix parameters as incomplete.

## Procedure

1. Read the run metadata and logs. Record the exact commit, runtime versions,
   operating system, matrix values, shard command, seed, first failing test,
   preceding tests, timeout, and any retained artifacts. Do not diagnose a
   different local revision.
2. Reproduce with the CI command and environment on the failing commit. Repeat
   enough times to distinguish a deterministic order-dependent failure from a
   true flake; preserve the seed and test order. Do not use arbitrary retries
   as a passing result.
3. Minimize the reproducer while retaining the failure: first the shard, then
   the smallest ordered suite pair, then one test or resource lifecycle. For
   hangs and SQLite failures, inspect open handles, scopes, temp databases,
   workers, timers, and cleanup on both success and failure paths. Capture a
   regression test that fails before the implementation fix.
4. Fix the root cause at the narrowest ownership boundary. Keep the minimized
   regression, restore the original shard command, and run it repeatedly with
   the original seed before running the owning package and root suites.
5. Pin only when the minimized failure depends on an unavailable external or
   platform condition and no honest deterministic fix is possible in this
   change. Follow `scripts/check-test-pins.mjs` exactly: use a pin form the
   script recognizes and add or update `### Surviving pins` in
   `docs/alpha-notes.md` with the exact package, test title, and concrete
   rationale in the same diff. Include the condition, owner, and removal
   trigger. Never pin a reproducible product defect, broaden a skip to a
   package, or weaken an assertion to obtain green.
6. Run `node scripts/check-test-pins.mjs`, the original failing shard, the
   owning package suite, and the committed root gates. If the fix affects
   generated files or manifests, perform their normal regeneration and refresh
   both lockfiles where required.
7. Report the failing revision and command, reproduction count, minimized
   cause, regression test, fix or documented pin, and every final gate result.

## Decline conditions

Decline without edits when the run URL or shard identity is incomplete; the
logs or exact revision are inaccessible; required credentials, services, or
artifacts are not authorized; bounded reproduction cannot establish a failure
or credible cause; the first correction requires a product/contract decision;
or a proposed pin cannot satisfy the surviving-pins contract. Never claim a
rerun-only green result as a fix.
