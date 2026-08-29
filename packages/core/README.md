# @smthrs/core

Pure plan-time data model for flows. It defines inert Flow and Node declarations plus the graph, effect, placement, annotation, key-material, and Markdown projections consumed by the registry and execution layers above it.

```sh
npm install @smthrs/core
```

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/core/<Module>`.

| Module        | Public exports                                                                                                                                                                                                                                                              | Description                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Annotations` | `LaneOptions`, `empty`, `add`, `merge`, `getOption`, `Placement`, `Effects`, `Lane`, `Priority`                                                                                                                                                                             | Builds and reads typed lexical annotations carried by plan nodes.                  |
| `Effects`     | `Declaration`, `MakeOptions`, `NarrowResult`, `make`, `covers`, `narrow`, `overlaps`, `sealed`                                                                                                                                                                              | Normalizes effect declarations and checks path coverage, narrowing, and conflicts. |
| `Flow`        | `TypeId`, `Flow`, `Any`, `Reference`, `Seat`, `Implementation`, `Input`, `Output`, `Error`, `FlowErrorCode`, `FlowError`, `isFlow`, `make`, `agent`, `withCapabilities`, `within`, `annotate`, `withEffects`, `sealed`                                                      | Declares callable, schema-described flows without executing them.                  |
| `Graph`       | `AnnotationsProjection`, `GraphNode`, `Edge`, `Conflict`, `EffectEntry`, `PlacementEntry`, `LayerRequest`, `BuildOptions`, `GraphBuildErrorCode`, `GraphBuildError`, `Graph`, `build`, `nodes`, `edges`, `effects`, `placements`, `conflicts`, `diagnostics`, `keyMaterial` | Builds and inspects closure-free graph topology and execution metadata.            |
| `KeyMaterial` | `InputRef`, `KeyMaterial`, `Entry`                                                                                                                                                                                                                                          | Defines the stable key projection emitted from a built graph.                      |
| `Markdown`    | `MarkdownFrontmatter`, `SkillDocument`, `MarkdownErrorCode`, `MarkdownError`, `lowerMarkdown`, `parseSkill`, `lowerSkill`                                                                                                                                                   | Parses and lowers Markdown and Agent Skills declarations to core flows.            |
| `Node`        | `dynamic`, `TypeId`, `Ast`, `Node`, `Any`, `Success`, `Error`, `DynamicOptions`, `NodeBuildErrorCode`, `NodeBuildError`, `CatchOptions`, `isNode`, `succeed`, `fail`, `all`, `map`, `andThen`, `catch`, `within`, `lane`, `priority`, `withEffects`                         | Constructs the inert, pipeable plan AST.                                           |
| `Placement`   | `Options`, `Placement`, `local`, `client`, `sandbox`, `remote`                                                                                                                                                                                                              | Creates serializable host-placement declarations.                                  |

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
