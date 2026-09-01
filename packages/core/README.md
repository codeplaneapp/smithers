# @smthrs/core

Pure plan-time data model for flows. It defines inert Flow and Node declarations plus the graph, effect, placement, annotation, key-material, and Markdown projections consumed by the registry and execution layers above it.

```sh
npm install @smthrs/core
```

The published contract lives at [smithers.sh/api/core](https://smithers.sh/api/core), generated from this package's sources.

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/core/<Module>`.

| Module        | Public exports                                                                                                                                                                                                                                                                                                                                             | Description                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Annotations` | `LaneOptions`, `empty`, `add`, `merge`, `getOption`, `Placement`, `Effects`, `Lane`, `Priority`                                                                                                                                                                                                                                                            | Builds and reads typed lexical annotations carried by plan nodes.                  |
| `Digest`      | `crypto`, `layer`, `runSync`, `digest`, `canonical`                                                                                                                                                                                                                                                                                                        | Synchronous SHA-256 and canonical JSON for pure identity constructors.             |
| `Effects`     | `Declaration`, `MakeOptions`, `NarrowResult`, `make`, `covers`, `narrow`, `overlaps`, `sealed`                                                                                                                                                                                                                                                             | Normalizes effect declarations and checks path coverage, narrowing, and conflicts. |
| `Flow`        | `TypeId`, `Flow`, `Any`, `Reference`, `Seat`, `Implementation`, `Input`, `Output`, `Error`, `FlowErrorCode`, `FlowError`, `MakeOptions`, `isFlow`, `make`, `agent`, `withCapabilities`, `within`, `annotate`, `withFlows`, `withEffects`, `sealed`                                                                                                         | Declares callable, schema-described flows without executing them.                  |
| `Graph`       | `AnnotationsProjection`, `GraphNode`, `Edge`, `EdgeReason`, `Conflict`, `EffectEntry`, `PlacementEntry`, `LayerRequest`, `BuildOptions`, `GraphBuildErrorCode`, `GraphBuildError`, `isFatalDiagnostic`, `maximumGraphDepth`, `maximumPayloadDepth`, `Graph`, `build`, `nodes`, `edges`, `effects`, `placements`, `conflicts`, `diagnostics`, `keyMaterial` | Builds and inspects closure-free graph topology and execution metadata.            |
| `KeyMaterial` | `InputRef`, `KeyMaterial`, `Entry`                                                                                                                                                                                                                                                                                                                         | Defines the stable key projection emitted from a built graph. Types only.          |
| `Markdown`    | `MarkdownFrontmatter`, `SkillDocument`, `MarkdownErrorCode`, `MarkdownError`, `lowerMarkdown`, `parseSkill`, `lowerSkill`                                                                                                                                                                                                                                  | Parses and lowers Markdown and Agent Skills declarations to core flows.            |
| `Node`        | `dynamic`, `TypeId`, `Ast`, `Node`, `Any`, `Success`, `Error`, `DynamicOptions`, `NodeBuildErrorCode`, `NodeBuildError`, `CatchOptions`, `isNode`, `succeed`, `fail`, `all`, `capture`, `map`, `andThen`, `catch`, `within`, `lane`, `priority`, `withEffects`                                                                                             | Constructs the inert, pipeable plan AST.                                           |
| `Placement`   | `Options`, `Placement`, `local`, `client`, `sandbox`, `remote`                                                                                                                                                                                                                                                                                             | Creates serializable host-placement declarations.                                  |

```ts
import { Flow, Graph, Node, Placement } from "@smthrs/core"
import { Schema } from "effect"

const greeting = Flow.make({
  name: "greeting",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  body: ({ name }) => Node.succeed(`Hello, ${name}`)
}).pipe(Flow.within(Placement.sandbox()))

const graph = Graph.build(greeting, { name: "world" })
```

`@smthrs/core/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.

## Identity and caching

`Graph.keyMaterial` is the digest-free projection `@smthrs/plan` compiles into step keys, so two declarations with equal key material are the same step.

An unannotated mapper, continuation, or flow body receives a process-local `sha256-source-ephemeral/v4` identity, because JavaScript cannot inspect closure state: two processes give the same function two different digests. Only `Node.capture` produces the cross-process-stable `sha256-source-captures/v3` identity, by folding the canonicalized inert values a function closes over into its digest. A step whose result must survive a restart has to declare its captures.

```ts
const scaled = Node.capture({ factor: 3 }, (value: number) => value * 3)
```

Capture data must be finite, inert, plain data. Accessors, cycles, non-finite numbers, symbols, functions, and non-plain prototypes are rejected rather than hashed incompletely, and accepted capture data is deeply frozen.

## Failure behavior

Construction failures throw; declaration failures are recorded.

| Surface                                                                                              | Failure                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Flow.make`, calling a flow, `Graph.build` on a bodyless flow                                        | throws `FlowError` with code `missing_body`                                                                                                                                                                                        |
| `Node.all`, `Node.priority`, `Node.capture`, continuation elaboration, an unrepresentable plan value | throws `NodeBuildError` with code `invalid_all_member`, `invalid_continuation`, `invalid_priority`, or `unrepresentable_value`                                                                                                     |
| `Markdown.parseSkill`, `Markdown.lowerSkill`                                                         | returns `Result.fail(MarkdownError)` with code `skill_missing_frontmatter`, `skill_invalid_frontmatter`, `skill_missing_name`, or `skill_missing_description`                                                                      |
| `Graph.build` on an invalid declaration                                                              | records `GraphBuildError` in `Graph.diagnostics` with code `effect_outside_envelope`, `effect_mode_widening`, `effect_tier_widening`, `write_conflict`, `capability_outside_grant`, `duplicate_node_id`, or `missing_key_material` |
| `Graph.build` on a malformed or oversized plan                                                       | throws `GraphBuildError` with code `invalid_node`, `plan_too_deep`, or `payload_too_deep`                                                                                                                                          |
| `Graph.keyMaterial` on a graph carrying a fatal diagnostic                                           | returns `Result.fail` with that diagnostic unchanged; `Graph.isFatalDiagnostic` reports which codes block it                                                                                                                       |

## Limits

`Graph.build` walks author-controlled and agent-generated structure, so it enforces documented bounds instead of overflowing the host stack. `Graph.maximumGraphDepth` bounds nested node structure and `Graph.maximumPayloadDepth` bounds a reflected plan value. The write-conflict pass compares every pair of work nodes and tests reachability between them, so its cost grows quadratically with the number of nodes that declare effects.

## Mutability

A built graph is deeply frozen, so `Graph.nodes`, `Graph.edges`, `Graph.conflicts`, and `Graph.diagnostics` hand back the graph's own values and an observer cannot edit the plan it is reading.

Plan values are not copied. `Node.succeed`, `Node.fail`, and a flow call retain the caller's value by reference and read it when the graph is built, so mutating one between construction and `Graph.build` changes the recorded identity.

## Lanes

`Node.lane`, `Annotations.Lane`, and the `LaneMerge` node this package synthesizes when two conflicting writers declare `onConflict: "lane"` are plan-time vocabulary. No runtime in this release executes a lane, and the elaboration deliberately does not cross into `@smthrs/flow`. Treat a lane as a declaration a future scheduler may honor, not as a scheduling guarantee.
