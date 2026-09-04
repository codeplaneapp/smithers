---
title: "Troubleshooting"
description: "Every failure @smthrs/core raises or records: the symptom, what causes it, and what to change."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/troubleshooting.md"
---

Failures split two ways on purpose. A malformed declaration throws, because
there is nothing to inspect. An invalid declaration is recorded, because a
reviewer should see the whole plan and its objections at once.

## Failures that throw

### Cannot call flow "x" without a body

```text
flows/core/FlowError: Cannot call flow "x" without a body
flows/core/FlowError: Cannot build flow "x" without a body
```

A flow declared with no `body`, no `model`, and no `flows` is
declaration-only: schemas and metadata for a catalog to show. Calling it or
building it raises `FlowError` with code `missing_body`.

Add a `body`, or add a `model` or `flows` so the flow becomes dynamic and gets
a default body of one dynamic node. If it is meant to stay declaration-only,
stop calling it.

### Node.all expected a Node at member "x"

```text
flows/core/NodeBuildError: Node.all expected a Node at member "x"
```

A member of the record you passed to `Node.all` is not a node. Usually the
member is the result of a flow's `body` rather than a call to the flow, or a
plain value that needs `Node.succeed`.

### Node.priority expects a safe integer

```text
flows/core/NodeBuildError: Node.priority expects a safe integer, received 1.5
```

Priority is a signed integer ordering ready work. Fractions and values past
`Number.MAX_SAFE_INTEGER` are refused at declaration time rather than silently
truncated.

### Node.andThen at "x" must return a Node

`NodeBuildError` with code `invalid_continuation` is raised during
`Graph.build`, when a continuation or a `catch` recovery arm returns something
other than a node. The message names the node id, so the structural position
tells you which builder in your source is wrong.

An arm that has nothing to do still has to return a node. `Node.succeed` for
the value you want, or `Node.fail` to re-raise, is the shape.

### Node.capture: capture at $.x ...

```text
TypeError: Node.capture: capture at $.bad has unsupported type function; captures must be finite, inert data
TypeError: Node.capture: capture at $.cyc.self is cyclic; captures must be finite, inert data
TypeError: Node.capture: capture at $.n is not finite; captures must be finite, inert data
```

Capture data is canonicalized into a digest, and canonicalization refuses
anything it cannot hash completely rather than hashing part of it. The message
names the path inside the capture record.

Pass plain, finite, inert data: no `undefined`, `bigint`, `symbol`, or function
values, no `NaN` or infinities, no cycles, no non-plain prototypes, no symbol
keys, no accessors, no array holes, and no nesting past 256 levels. A value
that cannot be reduced to that has to stay outside the capture, which means the
function keeps process-local identity.

`TypeError: Node.capture requires a function operation` means the second
argument was not a function.

### plan_too_deep, plan_too_large, payload_too_deep, payload_too_large

`Graph.build` throws a `GraphBuildError` with one of these codes, naming the
node or the value path that crossed a limit. These are not recorded
diagnostics: a plan that crosses a limit is not something to inspect, it is
something the package declined to materialize.

Each limit is exported, so a test can assert on the boundary and a generator
can stay inside it. See [Build limits](/concepts/limits/) for the table.

The usual cause is a generated declaration, or a loop that composes nodes
without a bound. `plan_too_deep` after a recursive builder means the recursion
has no base case that stops at 512.

## Failures that are recorded

Read them with `Graph.diagnostics`. Every code except
`capability_outside_grant` is fatal, which means `Graph.keyMaterial` returns
`Result.fail` carrying that diagnostic unchanged. `Graph.isFatalDiagnostic`
reports which is which.

### effect_outside_envelope

```text
{
  _tag: 'flows/core/GraphBuildError',
  code: 'effect_outside_envelope',
  paths: [ 'secret.txt' ],
  nodeId: 'root'
}
```

A step declared a read or write path the envelope it inherited does not cover.
`paths` names the uncovered paths and `nodeId` names the step.

Either narrow the step to stay inside the envelope, or widen the enclosing
flow's declaration to grant what the step needs. A path containing a whole `.`
or `..` segment is never covered by any pattern, so an escaping path reports
here rather than resolving: normalize the path before you declare it.

### effect_mode_widening

The enclosing envelope is `hermetic`, meaning its declaration is complete, and
a step inside it declared `expected`, meaning its declaration is partial. A
step cannot claim less certainty than its envelope promised.

Make the step `hermetic`, or make the enclosing flow `expected`.

### effect_tier_widening

A step declared a tier less reversible than its envelope's. The order narrows
from `irreversible` to `compensable` to `sealed`, and an omitted tier reads as
`sealed`.

Raise the enclosing flow's tier to cover the step, or lower the step's.

### write_conflict

```text
{
  _tag: 'flows/core/GraphBuildError',
  code: 'write_conflict',
  paths: [ 'out/report.json' ],
  nodes: [ 'root.all.a', 'root.all.b' ]
}
```

Two work nodes declared overlapping writes and at least one of them declared
`onConflict: "fail"`. This is fatal by design: it is what `fail` is for.

Fix the declarations so only one node writes the path, or change the strategy.
`serialize` orders the two writers with a `conflict` edge; `lane` gives each a
lane and synthesizes a merge node. Both keep the graph keyable.

### capability_outside_grant

```text
{
  _tag: 'flows/core/GraphBuildError',
  code: 'capability_outside_grant',
  paths: [ 'net:fetch' ],
  nodeId: 'root'
}
```

A called flow declares a capability the calling flow's grant does not include.
`paths` names the dropped capabilities. This one is advisory: the graph still
keys, and the inner flow's effective grant is the intersection, so the
capability is dropped rather than smuggled through.

Add the capability to the outer flow with `Flow.withCapabilities`, or remove it
from the inner one.

### duplicate_node_id and missing_key_material

Both mean a graph was assembled in a way `Graph.build` does not produce:
`duplicate_node_id` when two nodes claim one structural id, and
`missing_key_material` when a node reached `Graph.keyMaterial` without any.
Neither arises from ordinary declarations. If you see one from a graph
`Graph.build` produced, it is a defect in this package worth reporting.

## Behavior that is not an error

### A step reruns after a restart

The step's mapper, continuation, or flow body has process-local identity, which
is what an unannotated function gets. Declare what the function closes over
with `Node.capture` and the algorithm becomes
`sha256-source-captures/v4`. See
[Keep a step key stable across processes](/guides/keep-a-step-key-stable/).

### A plan contains the text `[planned:...]`

Something computed on the symbolic placeholder rather than reading a member
from it. Arithmetic and string interpolation coerce the placeholder to the
literal text `[planned:<path>]`, and that text is now part of the plan's
identity. No diagnostic is produced, because the plan is well formed.

Look for a template literal or an arithmetic expression in an `andThen` builder
or a flow body. Read members from the placeholder to name what a later step
consumes, and compute with real values inside the step that produces them.

### Only one branch of a conditional was planned

A conditional on the placeholder always takes the truthy branch, because the
placeholder is an object. Only that branch is planned, with no diagnostic.

Move the decision inside the step that has the real value.

### A `then` field reads as `undefined`

The placeholder reserves the member name `then`, so nothing above the plan
mistakes it for a promise. Rename the field, or read it inside the step that
produces it.

### No conflicts, despite overlapping writes

Only `Dynamic` nodes are writers for conflict analysis. A plan built from
`Node.succeed` and flow calls records no conflicts however its declarations
overlap. Reach the conflict through `Node.dynamic` nodes, or through flows
whose bodies contain them.

### A graph will not accept a mutation

`Graph.build` deep-freezes everything it constructs, and the getters hand back
the graph's own values rather than copies. Copy what you need before you edit
it.

### TestRuntime reports missing_operation or missing_flow

The deferred callbacks and flow references live in weak maps beside the AST,
not in it. A declaration that crossed a serialization boundary can still be
planned, but its callbacks are gone, so it cannot be evaluated. Evaluate the
declaration in the process that built it.

## Where to go next

- [Plan time](/concepts/plan-time/): why the failures split the way they do.
- [Inspect a built graph](/guides/inspect-a-graph/): reading diagnostics
  alongside everything else the graph reports.
