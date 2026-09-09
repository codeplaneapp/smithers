# Native engine evidence in run cards

The existing run card reads `control.engine.event` from its existing gateway
`run-events` projection. Its compact view lists recorded native executions beside
the recorded agent turns. Selecting a native execution uses the same
`runs.trace.select` flow and persisted selection, cursor, and view as an agent
frame. The debugger shows its recorded child executions, attempts, inputs,
results, failures, and original journal envelope. Native executions do not become
invented model turns, and their IDs are not treated as control run IDs for a new
`runs.open` request.

The decoder reuses the owning schemas:

- `@smthrs/engine-store/RunState` for the existing run-decision state.
- `@smthrs/flow/Flow.ResultEncoded` for its actual terminal result.
- `@smthrs/journal/EngineEvent` for current attempt markers and v2 evidence.

Those first two packages are explicit UI dependencies for their existing data
contracts. No new public package API, app flow, gateway procedure, database, or
collection is introduced. `EngineTrace` holds an ephemeral render projection;
the source remains the card's persisted journal records in TanStack DB.

Attempt identity includes execution ID, native rewind generation, step digest,
and attempt number. Reusing a sequence after a rewind cannot replace a prior
generation's result. The original native timestamp and journal coordinates remain
in the detail pane; the outer control sequence selects the historical cursor.
Current attempt markers contain no result and therefore show none. A native
execution returning `{ passed: false }` completed its procedure successfully; the
UI displays that value and does not convert the procedure's completion into a
passing check. Missing or malformed result evidence cannot make a successful
result appear. Unrecorded terminal events do not close open native attempts.

Only recorded parent IDs establish nesting. If multiple recorded generations
could be a child's parent, the child stays at the root of the native projection;
the raw parent ID remains available. Cyclic evidence is kept separate rather than
recursed through. This is a historical viewer, not a replacement for the engine's
authoritative parent-edge store or scheduling decisions.

## Completion of observation

The control run can settle before the native driver commits its final result.
The private host bridge's observation contract uses
`control.engine.projection-started` before accepting the native launch and
`control.engine.projection-settled` after its terminal drain. Both carry
`{ version: 1, executionId, generation }`. They describe the reader's
completeness, not another execution outcome. Host supervision must supply these
markers; projecting native events alone does not complete this handshake.

The existing run pump preserves the real terminal phase while continuing to read
until the matching generation is settled. It does not repeat the completion
message. Reload restarts this observation when persisted records still show it
pending. A projection gap remains visible evidence; a transport refusal or the
existing quiet deadline leaves a visible observation error without changing the
run's actual verdict. The existing retry gesture can try the observation again.
Legacy runs without a started marker keep their existing terminal behavior.

The compact rows are native buttons with visible existing focus styles. They
enter the same slash/button/agent selection flow; rendering introduces no React
effect or component-owned application state. The current onboarding shell and its
Command-K composer remain the owning presentation.
