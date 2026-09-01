A flow is a schema-described declaration. A node is an inert, pipeable value
that records an AST. Nothing in this package runs anything: `Graph.build`
evaluates pure flow bodies and pure `Node.andThen` builders exactly once
against symbolic predecessor values so the complete static topology is visible
before the first step executes.

```typescript
import { Flow, Graph, Node, Placement } from "@smthrs/core"
import { Schema } from "effect"

const greeting = Flow.make({
  name: "greeting",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  body: ({ name }) => Node.succeed(`Hello, ${name}`)
}).pipe(Flow.within(Placement.sandbox()))

const graph = Graph.build(greeting, { name: "world" })
const material = Graph.keyMaterial(graph)
```

## Identity and caching

`Graph.keyMaterial` is the digest-free projection `@smthrs/plan` compiles into
step keys. Two declarations that produce the same key material are the same
step, so what enters that projection is the package's most consequential
contract.

Functions are the subtle part. An unannotated mapper, continuation, or flow
body receives a _process-local_ `sha256-source-ephemeral/v4` identity, because
JavaScript cannot inspect closure state: two runs of the same program give the
same body two different digests. Only `Node.capture` produces the
cross-process-stable `sha256-source-captures/v3` identity, by folding the
canonicalized inert values a function closes over into its digest. A step whose
result must survive a restart therefore has to declare its captures.

```typescript
const scaled = Node.capture({ factor: 3 }, (value: number) => value * 3)
```

Capture data must be finite, inert, plain data. Accessors, cycles, non-finite
numbers, symbols, functions, and non-plain prototypes are rejected rather than
hashed incompletely, and accepted capture data is deeply frozen.

Plan values follow the same rule from the other direction. `Node.succeed`,
`Node.fail`, and a flow call retain the caller's value by reference and read it
when the graph is built, so mutating a value between construction and
`Graph.build` changes the recorded identity.

## Failure behavior

Two distinct mechanisms, deliberately:

- Construction failures throw. `Flow.make` and a flow call raise `FlowError`;
  `Node.all`, `Node.priority`, `Node.capture`, and continuation elaboration
  raise `NodeBuildError`; the Markdown loaders return a `Result` carrying
  `MarkdownError` rather than throwing.
- Declaration failures are recorded. `Graph.build` returns a graph even when a
  declaration is invalid and lists the problems in `Graph.diagnostics`, so an
  invalid plan stays inspectable.

`Graph.keyMaterial` is where the two meet: it refuses a graph carrying a fatal
diagnostic, returning that diagnostic unchanged, so a declaration the builder
called invalid can never become a durable step key.

## Limits

`Graph.build` walks author-controlled and agent-generated structure, so it
enforces documented bounds instead of failing with a host stack overflow.
`Graph.maximumGraphDepth` bounds nested node structure and
`Graph.maximumPayloadDepth` bounds a reflected plan value. Both refuse with a
coded `GraphBuildError` naming the offending node.

The write-conflict pass compares every pair of work nodes and tests
reachability between them, so its cost grows quadratically with the number of
nodes that declare effects.

## Mutability

A built graph is frozen. `Graph.nodes`, `Graph.edges`, `Graph.conflicts`, and
`Graph.diagnostics` return the graph's own frozen values, so an observer cannot
edit the plan it is reading. Caller-supplied plan values are not frozen; they
are read by reference as described above.

## Lanes

`Node.lane`, `Annotations.Lane`, and the `LaneMerge` node this package
synthesizes when two conflicting writers declare `onConflict: "lane"` are
plan-time vocabulary. No runtime in this release executes a lane, and the
elaboration deliberately does not cross into `@smthrs/flow`. Treat a lane as a
declaration a future scheduler may honor, not as a scheduling guarantee.
