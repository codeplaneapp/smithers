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
