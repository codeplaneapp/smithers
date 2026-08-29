# @smthrs/registry

Portable flow descriptor discovery and progressive-disclosure registry services. It scans ordered filesystem sources into serializable metadata, keeps prompt bodies lazy, and exposes lookup and rendering to the harness without evaluating modules during discovery.

```sh
npm install @smthrs/registry
```

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/registry/<Module>`.

| Module          | Public exports                                                                                                                                                                                                                                                                                                                                         | Description                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `Descriptor`    | `EffectTier`, `Placement`, `EffectDeclaration`, `SchemaRefMarkdownArgs`, `SchemaRefMarkdownOutput`, `SchemaRefModule`, `SchemaRefNone`, `SchemaRef`, `BodyRefMarkdown`, `BodyRefModule`, `BodyRef`, `FlowBodyPrompt`, `FlowBodyModule`, `FlowBody`, `Provenance`, `Source`, `DiscoveryWarningCode`, `DiscoveryWarning`, `FlowDescriptor`, `SourceScan` | Defines the serializable descriptor, body, schema, source, provenance, and warning models. |
| `Disclosure`    | `toEntries`, `toXml`                                                                                                                                                                                                                                                                                                                                   | Projects descriptors to compact entries or Agent Skills XML.                               |
| `Discovery`     | `Discovery`, `make`, `layer`, `makeNoop`, `layerNoop`                                                                                                                                                                                                                                                                                                  | Defines and implements metadata-only source scanning over FileSystem and Path.             |
| `MarkdownFlow`  | `Input`, `Output`, `FromMarkdownOptions`, `FromMarkdownResult`, `fromMarkdown`, `loadBody`, `renderPrompt`, `toCoreFrontmatter`                                                                                                                                                                                                                        | Parses Markdown metadata, loads prompt bodies lazily, and renders invocation prompts.      |
| `Registry`      | `Config`, `Registry`, `make`, `layer`, `layerFromDescriptors`, `makeNoop`, `layerNoop`                                                                                                                                                                                                                                                                 | Provides ordered discovery, lookup, visibility, lazy body loading, refresh, and warnings.  |
| `RegistryError` | `DiscoveryErrorCode`, `DiscoveryError`, `RegistryErrorCode`, `RegistryError`, `RegistryFailure`, `discoveryError`, `registryError`                                                                                                                                                                                                                     | Defines typed discovery and registry failures and constructors.                            |

```ts
import { Registry } from "@smthrs/registry"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const registry = yield* Registry.Registry
  return yield* registry.list()
}).pipe(Effect.provide(Registry.layerNoop()))
```

Use `Discovery.layer` with `Registry.layer(config)` for filesystem discovery, or `Registry.layerFromDescriptors(entries)` for an in-memory snapshot with lazy body access. `@smthrs/registry/package.json` is also exported; `internal/*` and nested `*/index` subpaths are blocked.
