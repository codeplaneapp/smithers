---
title: "API reference"
description: "Flow and Node builders: the pure plan-time data model of the Smithers harness"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/api.md"
---

A flow is a schema-described declaration. A node is an inert, pipeable value
that records an AST. Production code in this package executes no steps:
`Graph.build` evaluates pure flow bodies and pure `Node.andThen` builders exactly once
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

## Testing declarations

`TestRuntime.evaluate` is a pure, synchronous test helper that executes the
deferred maps, continuations, and recovery arms stored in one in-memory Node
AST. Dynamic nodes and flow-call leaves cross an explicit deterministic
resolver. `evaluateInline` additionally enters called flows that carry an
in-memory body.

It intentionally does not model capabilities, persistence, scheduling,
retries, cache, concurrency, or output-schema enforcement. Higher-order
builder packages use it for declaration behavior; durable-engine integration
tests remain responsible for host semantics.

## Identity and caching

`Graph.keyMaterial` is the digest-free projection `@smthrs/plan` compiles into
step keys. Two declarations that produce the same key material are the same
step, so what enters that projection is the package's most consequential
contract.

Functions are the subtle part. An unannotated mapper, continuation, or flow
body receives a _process-local_ `sha256-source-ephemeral/v4` identity, because
JavaScript cannot inspect closure state: two runs of the same program give the
same body two different digests. Only `Node.capture` produces the
cross-process-stable `sha256-source-captures/v4` identity, by folding the
canonicalized inert values a function closes over into its digest. A step whose
result must survive a restart therefore has to declare its captures.

```typescript
const scaled = Node.capture({ factor: 3 }, (value: number) => value * 3)
```

Capture data must be finite, inert, plain data. Accessors, cycles, non-finite
numbers, symbols, functions, and non-plain prototypes are rejected rather than
hashed incompletely, and accepted capture data is deeply frozen. Captures are
compared by structural value: two references to one shared object digest
identically to two structurally equal copies, so aliasing is not identity.

Plan values follow the same rule from the other direction. `Node.succeed`,
`Node.fail`, and a flow call retain the caller's value by reference and read it
when the graph is built, so mutating a value between construction and
`Graph.build` changes the recorded identity.

The symbolic placeholder handed to a `Node.andThen` or `Node.catch` builder
reserves the member name `then`: reading it yields `undefined` so the
placeholder is never mistaken for a thenable. A legitimate `then` field must be
renamed, or read inside the step that produces it.

## Failure behavior

Two distinct mechanisms, deliberately:

- Construction failures throw. `Flow.make` and a flow call raise `FlowError`;
  `Node.all`, `Node.priority`, and continuation elaboration raise
  `NodeBuildError`; `Node.capture` raises a `TypeError`, and a capture-data
  failure names the offending path in its `Node.capture:`-prefixed message; the
  Markdown loaders return a `Result` carrying `MarkdownError` rather than
  throwing.
- Declaration failures are recorded. `Graph.build` returns a graph even when a
  declaration is invalid and lists the problems in `Graph.diagnostics`, so an
  invalid plan stays inspectable.

`Graph.keyMaterial` is where the two meet: it refuses a graph carrying a fatal
diagnostic, returning that diagnostic unchanged, so a declaration the builder
called invalid can never become a durable step key.

## Limits

`Graph.build` walks author-controlled and agent-generated structure, so it
enforces documented bounds instead of failing with a host stack overflow or
exhausting memory. `Graph.maximumGraphDepth` bounds nested node structure and
`Graph.maximumPayloadDepth` bounds a reflected plan value; both refuse with
`plan_too_deep` or `payload_too_deep` naming the offending node.
`Graph.maximumGraphNodes`, `Graph.maximumGraphEdges`, and
`Graph.maximumGraphConflicts` bound plan width, counting synthesized lane
merges and the edges the write-conflict pass adds, and refuse with
`plan_too_large` naming the node whose admission crossed the limit.
`Graph.maximumPayloadMembers` bounds the members one plan value expands to
across every level (object keys, array items and holes, map entries, set and
chunk values, and bytes) and refuses with `payload_too_large` naming the
offending value path. A flow call's input and a declaration body are budgeted
separately, and the effect paths of a flow placed inside a plan value count as
its members.

`Graph.maximumEffectPaths` bounds the read and write paths, summed, of one
effect declaration. Every declaration the graph carries obeys it: an
annotation, a dynamic node's own envelope, a called flow's envelope, and a
synthesized lane merge, whose reads and writes both name the overlap it
merges. `Graph.maximumPlanEffectPaths` bounds the paths admitted across the
plan, counting a declaration where it is declared and again at every work
node that inherits it as its effective envelope, because each such node is a
writer the conflict pass compares. Both refuse with `plan_too_large` naming
the node that declared or inherited the paths, before a path is copied:
declared and inherited envelopes are admitted while the plan is visited,
before the write-conflict pass runs, and a lane merge as it is synthesized.

Every limit is checked before the structure it guards is allocated. An
array-backed declaration is refused by its lengths without reading a member;
a caller-assembled iterable, which has no length to refuse by, is copied one
path at a time and refused as soon as it exceeds the limit.

`Graph.maximumEffectPathLength` bounds one effect path at 4096 UTF-16 code
units, `PATH_MAX` on Linux, so no path that names a file a supported host can
open is refused. `Graph.maximumEffectGlobs` bounds the patterns, entries
ending in `*`, one read list or one write list may carry at 128, enough for a
subtree per package of a large monorepo. Both refuse with `plan_too_large`
naming the node, or with `payload_too_large` naming the value path when the
declaration belongs to a flow placed inside a plan value. Both are read as the
path is admitted, from its length and from its last character, before any
character of it is scanned and before the write-conflict pass compares any
pair, so an over-long path or a pattern past the limit costs one property
read.

Inside the limits the cost of a build is bounded on every axis an author or
an agent controls. Each distinct path is scanned once for a dot segment and
sorted once, so the character work of a build is at most
`maximumPlanEffectPaths` paths of `maximumEffectPathLength` code units plus
the comparisons that sort them; 64 writers of 1024 such paths sharing a
4000-character prefix build in about one second on an idle developer machine
(a loaded one takes two to three times longer; the bound, not the figure, is
the contract). A pattern's prefix is located
once by binary search, patterns nested under another collapse into the
outermost before the paths they cover are enumerated, and every match after
that is an integer comparison, so `Effects.overlaps` costs the two
declarations plus their matches however many patterns nest: two declarations
of 1024 nested patterns overlap in milliseconds, and 16 writers of the widest
nested declaration the limits admit, 128 nested patterns over 896 literal
paths, build in well under a second. An envelope is prepared once, its exact
entries in a set and its covering patterns collapsed to disjoint sorted
prefixes, and every node it encloses is checked against the prepared form, so
`Effects.narrow` inside a build costs the envelope once plus one lookup and
one binary search per enclosed path; an envelope of 1024 longest paths
narrowed by 4095 nodes builds in well under a second. The write-conflict pass
marks candidate pairs from one index of every writer's paths, so disjoint
literal writers cost linear time and the overlap of a pair is computed at
most once per recorded conflict. Its pattern term is one step per path a
pattern covers per writer holding that path, at most `maximumGraphNodes`
times `maximumPlanEffectPaths` steps for a plan of universal writers, about
two seconds before the conflict limit refuses it. The widest shared-literal
conflict set the limits admit, 362 writers sharing 181 paths under
`onConflict: "fail"`, builds in about two seconds including its 65,341
diagnostics.

## Agent Skills validation

`Markdown.parseSkill` parses frontmatter with the failsafe YAML schema and then
enforces the intrinsic rules of the Agent Skills specification: a `name` of 1
to 64 lowercase ASCII letters, digits, or single hyphens that does not start or
end with a hyphen, a `description` of 1 to 1024 characters counted in code
points, a scalar space-separated `allowed-tools`, a scalar `license`, a
`compatibility` of 1 to 500 characters, and `metadata` mapping string keys to
scalar values. Each field reports its own stable `MarkdownError` code, and an
invalid value is never echoed into the message.
`Markdown.validateSkillFrontmatter` applies the same rules to already-parsed
frontmatter. The one rule that needs the file system, that `name` equals the
skill directory name, stays with `@smthrs/registry`.

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
