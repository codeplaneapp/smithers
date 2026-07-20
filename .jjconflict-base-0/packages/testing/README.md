# Workflow testing

The scenario API is deliberately plain TypeScript: authoring data is an immutable
`ScenarioAst`, injected commands are `ControlMessage`s, and observations are
`TraceEvent`s. `replayIdentity` is derived only from the canonical AST, seed, and
ordered control log. Every `run` callback requires an explicit caller-supplied
stable `runnerBinding`, which is canonical AST data and therefore part of the
replay identity. The binding must be a NON-EMPTY string — validity is checked
at runtime, so an empty, whitespace-only, or non-string binding throws
`RUNNER_BINDING_INVALID` at `step()` and is refused again at `runScenario`
admission for hand-crafted ASTs (an executable reachable without a valid
canonical binding fails with `RUNNER_BINDING_REQUIRED`; an inert malformed
binding fails with `RUNNER_BINDING_INVALID`), so a degenerate binding can
never slip out of the canonical AST while still naming an executable. A
callback without a binding throws `RUNNER_BINDING_REQUIRED` (or
`RUNNER_BINDING_AMBIGUOUS` when its source is not even provably stateless — the
diagnostic tells you WHY it could never have carried a content-addressed
identity). Framework-issued anonymous identities are RETIRED: the previous
design recompiled provably-stateless source through the global `Function`
constructor so the digest and the executable were the same bytes, but every
route to a function-construction or evaluation primitive in JavaScript
(`globalThis.Function`, `Function.prototype.constructor`, `eval`,
generator/async constructor chains) resolves through writable realm state, so
a forgery installed BEFORE the package imports could bind divergent behavior
to equal anonymous identities across processes. No unforgeable replacement
exists, so no anonymous executable identity is issued at all: the framework
never invokes a function-construction primitive, the `anonymous:` binding
namespace is rejected at authoring AND at execution admission (a hand-crafted
AST cannot revive it), and the pre-import guarantee is exactly this — realm
forgery cannot mint, alter, or collide an executable identity, because the
only executable identities are caller-owned bindings running the caller's own
function object. The remaining trust assumptions are the caller's: a
`runnerBinding` must name one behavior and stay stable across processes and
versions, and module-loader/preload interception (which could rewrite the
package itself) is outside the threat model (see MIGRATION.md).

The default `unit-sim` harness provides deterministic virtual time, seeded
interleavings, barriers, and mediated-effect simulations. It does not pretend to
be a database or a child process. Requests requiring `real-db` or `real-process`
are rejected with a capability failure unless an executable adapter with a live
admission probe is selected. The deprecated e2e descriptor remains metadata
only; real process tests belong in `e2e/`.

On `unit-sim`, `completion-cas` is the TERMINAL completion transition: one
middleware around the simulated completion CAS commit and its journal/ack
receipt, entered only when a task callback actually completes. The
mediated-effect journal never stands in for it — a mediated effect executes,
journals, and acks before any `completion-cas` phase fires — and a runner-less
no-op step or a failing callback commits no completion, so every declared
`completion-cas` phase stays inert on those scenarios.

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
an adapter that only declares capabilities is not accepted. For the real-process
adapter, admission and the workflow transition are deliberately split: the
admission probe verifies runner identity and production liveness with a
`probe`-mode child that must exit cleanly WITHOUT executing the target
workflow, while `runStep("runWorkflow")` starts the actual production
runWorkflow child under a fresh adapter-owned nonce and holds it verified and
observably in flight, so `resume:during-task` is injected while the production
operation is genuinely executing — and a scenario that never schedules that
operation provably runs no target workflow. Adapters advertise
only the cut points they can execute at a production transition, and
`runScenario` fires those faults through one operation/phase middleware around
the actual adapter call — before-phase faults fire before the production
operation runs, during/ack/after faults fire on its observed receipt — with the
adapter's `injectFault` recording a native durable-state observation. During-
task ambiguities are executed, not declared: the real-db adapter performs a
real `claimRunForResume` takeover whose fencing rejects the old owner's
production heartbeat (lease loss) or races the production completion CAS
against a committed cancel request, and the middleware emits `lease-lost` /
`cancellation-race` only when the durable before/after state records that
outcome.
The `completion-cas:after-journal-before-ack` cut point fires only when the
production CAS actually applied: a rejected/duplicate completion is durable
evidence that no journal transition occurred, so the ack cut point is a
non-occurrence — no fault, no `journal-applied-ack-missing` ambiguity, only
the observed rejection.
Repository e2e suites should compose these adapters with the existing
SmithersDb and child process fixtures and report unavailable infrastructure as
admission failure, never as a passing simulation. Simulation error doubles come
from `simulationSmithersError`/`simulationNativeError` and are certified by the
e2e parity probes; per-test constructor spoofing is not accepted. Parity
probes compare two serializations: the reusable boundary serializer
(`serializeBoundaryError`, native own-fields included) on both sides, and the
GENUINE production durable serializer (packages/errors `errorToJson`) against
the independently implemented `serializeSimulationDurableError` — only stack
locations are excluded from the comparison.
The published entrypoint is the committed `src/index.js` artifact; the
`shipped-artifact-parity` unit gate resolves the real package export (not the
tsconfig alias) and pins its serialization, advertised cut points, and
cut-point receipt behavior to the TypeScript source, and the e2e conformance
table runs against both entrypoints.
