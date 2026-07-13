# Workflow testing

The scenario API is deliberately plain TypeScript: authoring data is an immutable
`ScenarioAst`, injected commands are `ControlMessage`s, and observations are
`TraceEvent`s. `replayIdentity` is derived only from the canonical AST, seed, and
ordered control log.

The default `unit-sim` harness provides deterministic virtual time, seeded
interleavings, barriers, and mediated-effect simulations. It does not pretend to
be a database or a child process. Requests requiring `real-db` or `real-process`
are rejected with a capability failure unless an executable adapter with a live
admission probe is selected. The deprecated e2e descriptor remains metadata
only; real process tests belong in `e2e/`.

External effects are at-least-once unless the application supplies its own
idempotency. Effects outside the task-runtime mediation boundary are opaque and
uncontrollable. Journal CAS guarantees do not imply exactly-once external
effects. Effect Cause trees are internal diagnostics and are not a public
compatibility contract.

`dryRun` performs canonicalization, compiler diagnostics, capability admission,
and creates a replay-bundle skeleton without invoking agents or compute
functions. Replay bundles, first-divergence reports, bounded shrinking, scoped
cleanup, journal state, and exactly-once assertion rejection are executable
APIs. `contractProbe` should be used to anchor simulated error shapes to real
production adapters.

## Real-system boundary

The package supplies `realDbAdapter` and `realProcessAdapter` contracts. Their
admission probes must open the production resource and perform a live operation;
an adapter that only declares capabilities is not accepted. Repository e2e
suites should compose these adapters with the existing SmithersDb and child
process fixtures and report unavailable infrastructure as admission failure,
never as a passing simulation.
