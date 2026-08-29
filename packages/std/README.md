# @smthrs/std

The standard flows tool library for filesystem, search, HTTP, shell, and language-server work. Each callable tool is an ordinary `@smthrs/core` flow declaration with explicit capabilities and effects, plus an injectable handler where execution is host-owned.

```sh
npm install @smthrs/std
```

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/std/<Module>`.

| Module               | Public exports                                                                                                                                           | Description                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Bash`               | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                         | Declares and runs bounded shell commands.                                    |
| `Container`          | `Request`, `Plan`, `Container`, `make`, `makeNoop`, `makeCommand`, `unavailable`, `layerNoop`, `layerCommand`                                            | Routes a command into a named container.                                     |
| `Edit`               | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                         | Declares and applies exact text replacements.                                |
| `ExaWebSearch`       | `layer`                                                                                                                                                  | Provides WebSearch through the Exa API and kernel HTTP client.               |
| `Explore`            | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `make`, `flow`                                                        | Declares a dynamic exploration flow composed from other standard flows.      |
| `Fetch`              | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                         | Declares and runs raw HTTP GET requests.                                     |
| `Glob`               | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                         | Declares and runs filesystem glob searches.                                  |
| `Grep`               | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                         | Declares and runs text searches over files.                                  |
| `HttpPost`           | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                         | Declares and runs HTTP POST requests.                                        |
| `LanguageServer`     | `Position`, `LanguageServer`, `make`, `makeNoop`, `layerNoop`                                                                                            | Defines the language-server query service.                                   |
| `Ls`                 | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                         | Declares and runs directory listings.                                        |
| `Lsp`                | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                         | Declares and runs language-server definition queries.                        |
| `Manifest`           | `flows`, `handlers`, `names`, `readOnly`                                                                                                                 | Exposes frozen flow and handler registries plus the canonical read-only set. |
| `NodeLanguageServer` | `Config`, `make`, `layer`                                                                                                                                | Implements LanguageServer with Node child processes.                         |
| `Read`               | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                         | Declares and runs bounded file reads.                                        |
| `StdError`           | `Code`, `StdError`                                                                                                                                       | Defines typed standard-tool failures.                                        |
| `TestRun`            | `name`, `description`, `Input`, `Outcome`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`, `scratchDirectory`                          | Runs the declared test suite and reads its report.                           |
| `TestRunner`         | `Runner`, `TestRunner`, `captureBase`, `make`, `makeNoop`, `layer`, `layerNoop`                                                                          | Declares how this repository runs its tests.                                 |
| `WebFetch`           | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                         | Declares and runs normalized web-page fetches.                               |
| `WebSearch`          | `name`, `description`, `Input`, `Result`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `WebSearch`, `make`, `makeNoop`, `layerNoop`, `run` | Declares web search and its injectable provider service.                     |
| `Write`              | `name`, `description`, `Input`, `Output`, `effects`, `effectsFor`, `capabilities`, `flow`, `run`                                                         | Declares and runs file writes.                                               |

```ts
import { Read } from "@smthrs/std"
import { Effect } from "effect"

const program = Read.run({ path: "/workspace/notes.md" }).pipe(
  Effect.map((result) => result.content)
)
// Provide the kernel FileSystem and Path layers in the host.
```

`Manifest.flows` is the declaration registry, `Manifest.handlers` contains directly executable handlers, and `Manifest.readOnly` is the canonical read-only projection. `@smthrs/std/package.json` is also exported; `internal/*` and nested `*/index` subpaths are blocked.

`Bash` retains `mode: "hermetic"` as effect-contract vocabulary, but the handler is not an operating-system sandbox. It performs a fail-closed lexical pre-check of explicit path tokens against `reads` and `writes`, then starts an ordinary host shell process. Shell expansion, subprocess access, and paths computed at runtime are not observed. A host that needs confinement must supply a sandbox or access-reporting boundary; the lexical check alone cannot prove hermetic execution.
