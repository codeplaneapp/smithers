# Fault-matrix gaps

What the matrix does not cover, and what closing each entry would take. Cost
bands: **S** is at most two engineering days with the infrastructure this
repository already has; **M** is roughly three to five days or needs a new CI
service; **L** is more than a week, needs external credentials, or materially
lengthens CI.

Every row here is a gap in coverage, not a gap in the product unless it says so.

| Case | What is covered | What is not, and what it would take | Cost |
| --- | --- | --- | --- |
| 02 | A real sandbox process is stopped and killed while the engine stays up, and `SandboxHealth` reports `unresponsive` and `ping_failed` from what actually happened to it. | The sandbox is a loopback ping responder, not a supported remote provider. Covering a hosted provider needs credentials and a privileged runtime in CI. | L |
| 05 | A timer parked in durable state survives a `SIGKILL`, comes due while no host is running, and fires once. | Two hosts racing one eligible timer. That needs a second engine incarnation admitted at the exact instant the deadline passes, which the current harness cannot schedule. | M |
| 06 | Two hosts drive one parked run and the step dispatches once, and two control planes with different identities race for one suspended run and exactly one is admitted while the other is refused with `ClaimLost`. | **A product gap, not a coverage gap.** The fence tells two planes apart by `hostId` and `pid` only (`control/SqlControlRuntime.ts` `sameProcess`), and `@smthrs/cli` never supplies an owner, so every `smithers serve` on a host is `{hostId: "local", pid: 0}`. Two local control planes therefore consider each other the same process: the loser joins instead of losing the fence, and a second plane can drive a run the first one owns. The case passes because `fixtures/claimChild.ts` gives each plane a real identity. Closing it means `@smthrs/cli` passing an owner whose `pid` is the serving process's own. Repro: two `smithers serve` processes on one project root, launch through one, `resume` through the other, and watch it be accepted. | S |
| 12 | A rewind restores a real jj working copy, archives the journal suffix, and records a completed audit. | Compensation handlers for irreversible effects crossed by the rewind. `CompensationHandlers` is a contribution door with no registered handler here, so a crossed irreversible effect blocks rather than compensating. | M |
| 16 | Five concurrent subscribers over 500 committed events, against the RSS budget in `budgets/memory.json`. | A long-lived soak: hours of streaming with a growth budget. It would add at least ten minutes to every run, so it belongs in a nightly tier this matrix does not yet have a runner for. | L |
| 22 | The journal redacts a credential out of every committed row, structurally by field name and textually inside a value, checked by reading the SQLite file rather than an API that could redact on the way out. | **A product gap, not a coverage gap.** rc.0 ships no redacting logger, so an action that logs a credential puts it on the operator's terminal. Closing it is a Phase 5 deliverable (`docs/migration/rc-contract.md` §5.2) and rc-contract R-12 makes the log half a required Phase 7 parity test. It is recorded here rather than pinned as an inverted test: a case that passes because the leak happens reports a green matrix over a live credential leak. The test to add once a redacting logger exists: run `fixtures/secretChild.ts`, and assert the child's stdout and stderr do not contain the credential. | M |
| 25 | Unauthenticated and wrongly authenticated callers are refused, and an approval is refused when its envelope or digest does not match what the server issued. | A durable denial audit: actor, scope, target, and timestamp persisted for a refused approval. No audit sink exists to assert against. | M |
| 32 | A checkpoint survives the process that took it, and a reading taken at one sees the pinned tree while the live tree has moved on. | The pinned-tree path driven end to end through an agent cell, rather than through `Checkpoints` and `Checkpointed.relocate` directly. That needs a recorded model fixture. | M |

## Cases the 0.x matrix had and this one does not

| 0.x case | Disposition |
| --- | --- |
| 07 continue-as-new lineage | Continue-as-new is excluded from the first RC (`PLAN.md` Phase 5). A case for it would assert a feature the RC does not ship. |
| 10 ghost state on unmount, 13 collapsed-ancestor failure marker, 26 diff review mode | Inspector GUI behaviour. The UI is `apps/ui`, whose own Playwright tiers own these; a fault case here could only assert the DTOs, which the gateway family already does. |
| 17 webhook bad signature | Owned by the integrations lane, which holds the webhook contract tests. |
| 18 cron manual overlap | Trigger scheduling is `@smthrs/triggers`; the overlap policy is not an RC commitment. |
| 19 auth persistence, 20 browser automation in a hosted workspace, 23 network policy, 30 hosted soak | All need hosted-provider credentials. Owned by the providers-hosts lane where a real provider exists to run them against. |
| 24 replay-unsafe approval | Folded into case 25: the RC refuses an approval whose envelope or digest does not match, which is the same fence stated on the shipped API. |
| 27 scorer failure blocks downstream | `@smthrs/scorers` has no engine scheduling dependency in the RC. |
| 28, 29 soak tiers | No nightly runner is declared for the RC. Reinstating one means a scheduled workflow and a growth budget per case, not a new case file. |
