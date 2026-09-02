## Composition

`NodeControl.layer(config)` is the complete Node host for the command tree. A
local invocation creates one durable engine and shares its SQLite connection,
journal, run store, and memory store across every consumer. A remote invocation
builds only authenticated HTTP and WebSocket clients and refuses local-only
memory operations.

`NodeControl.makeConfig(arguments, environment, cwd)` is the pure configuration
boundary. `NodeControl.config` applies it to the ambient process and translates
bad URLs, unreadable MCP files, and malformed JSON into typed usage errors.

## Trust boundaries

The local executor reads provider credentials only while resolving a model
route. Detached launches pass the credential through `SMITHERS_API_KEY`, never
through process arguments. MCP arguments are decoded against the same closed
schemas the server advertises, and failures are redacted before they cross the
protocol boundary.

Gateway hosts bind loopback by default. A non-loopback bind requires both the
explicit listen opt-in and a bearer credential. The exact routes are listed by
`Serve.mounts`; the command page and banner are generated from that surface.

## Process results

`Output` renders keys in code-unit order after snapshotting inert plain data.
It refuses proxies, accessors, callables, cycles, host objects, and values past
its 128-level, 10,000-member, or 4 MiB output bounds with a typed code and path.
Exit codes come only from complete control receipts; use `Output.renderValue`
for arbitrary stored or provider data so a caller-controlled `_tag` cannot
imitate a receipt.

Finite CLI history reads retain at most 50,000 events and 16 MiB, with a 1 MiB
per-event cap. MCP narrows that to 10,000 events and 1 MiB and admits request
and response frames no larger than 4 MiB. Crossing a boundary returns a typed
resource-limit failure rather than partial output.

The stable process statuses are 0 for success, 1 for a failed operation or run,
2 for usage, 3 for a run waiting on approval, 130 for cancellation, and 143 for
termination.

A failure is one line on stderr and nothing on stdout, so a `--json` reader
never finds a diagnostic inside its document. The line names the failure's
class rather than its namespace (`ClaimLost`, not `/control/ClaimLost`),
followed by its sentence. A control failure that carries no sentence is
reported by the fields it does carry, contract code first:
`ClaimLost: claim_lost runId=run-42`.

## Command documentation

The [`smithers` command pages](/cli) are generated from the real Effect CLI
parser and the frozen release contract. This API page documents the library
surface used to compose or embed that executable.
