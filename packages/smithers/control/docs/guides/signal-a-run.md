# Signal a run

`Control.signal` admits a named JSON payload under an actor-scoped idempotency
key. `Accepted` confirms that admission is durable. It does not claim that the
run has consumed the payload. Reusing the key with different input returns
`Conflict` before the conflicting payload reaches an executor.

The command, its receipt, and `control.signal.admitted` journal event commit
in the control database first. Execution occurs after that transaction ends;
there is no transaction spanning control.db and engine.db.

The production executor binds each command to one concrete durable wait token
before applying it. One token has at most one admitted command. Application
atomically checks the engine's current wait token, and recovery verifies the
stored deferred result. A crash after application but before acknowledgment
retries the original token. It cannot move the command to a later wait.

Commands without a visible wait remain pending. The running executor
reconciles a bounded page every 250 milliseconds, starting at host startup,
so a signal admitted before its wait opens does not require a restart or
manual resend. Pages rotate so unavailable waits cannot starve later commands.
Malformed stored payloads are rejected and logged rather than blocking a page.

`ControlRuntime.signalCommand(commandId)` exposes `pending`, `delivered`,
`rejected`, and `terminal` dispositions for integrations holding the admitted
command identity. The CLI does not yet expose a dedicated delivery-status
lookup. A definite incompatible wait raises `NoMatchingWait`; retries preserve
that refusal. A signal initially submitted to a settled run returns `Terminal`.

`WaitFor` names one durable fact per `(flowName, executionId, name)`. Calling
it twice with the same name in the same execution intentionally observes the
same fact. Use distinct names for distinct rendezvous points. This is not a
stream of repeated same-name events.

Legacy `control_run_messages` signals have no application identity or token
binding. They remain readable through `deliveredSignals`, but are not
replayed automatically by the new inbox. Operators must inspect legacy wait
state before explicitly resubmitting under a new key; silently replaying them
could apply historical intent to a different wait.
