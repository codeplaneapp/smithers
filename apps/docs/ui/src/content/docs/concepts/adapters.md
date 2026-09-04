---
title: "The adapters boundary"
description: "Why heavy third-party renderers ship behind @smthrs/ui/adapters/* subpaths, what each one costs a consumer's bundle, and the ratchet that keeps them out of the base barrel."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/ui/docs/concepts/adapters.md"
---

Every dependency this package carries is either cheap enough for every consumer
or expensive enough that only the consumer who asked for it should pay. The
boundary between the two is a package subpath.

The rule has one sentence: a heavy third-party renderer lives under
`src/adapters/`, ships behind its own entry in the `exports` map, and is never
re-exported from `src/index.ts`. Import `@smthrs/ui` and you get the component
library. Import `@smthrs/ui/adapters/pierre-diff-view` and you also get Shiki.

## What the base barrel costs, and what each adapter adds

The numbers below come from bundling each entry point the way a consumer
reaches it: an entry module that imports the namespace and retains it, built
with `bun build --target=browser --minify` and React marked external. The build
does not split, which is the mode this package is consumed in, so a lazily
loaded grammar still counts. Read them as orders of magnitude rather than
budgets.

| Entry point                             | Bundled output | What dominates it                             |
| --------------------------------------- | -------------: | --------------------------------------------- |
| `@smthrs/ui`                            |     about 500 KB | Radix primitives, CVA, clsx, the CSS string  |
| `@smthrs/ui/adapters/knowledge-graph`   |     about 155 KB | `d3-force`                                    |
| `@smthrs/ui/adapters/chart`             |     about 270 KB | `recharts`                                    |
| `@smthrs/ui/adapters/terminal`          |     about 390 KB | `@xterm/xterm` and `@xterm/addon-fit`         |
| `@smthrs/ui/adapters/markdown-editor`   |     about 2.9 MB | `@milkdown/crepe` and `@milkdown/kit`         |
| `@smthrs/ui/adapters/code-view`         |      about 10 MB | `@pierre/diffs`, and Shiki's grammars and themes |
| `@smthrs/ui/adapters/pierre-diff-view`  |      about 10 MB | The same Shiki payload                        |

The two pierre surfaces are the reason this boundary exists at all. A single
`export` line that pulled `CodeFileView` onto the root barrel would multiply
every consumer's bundle by roughly twenty, including the consumers that render
nothing but a `Button`.

## Why a subpath rather than tree shaking

Tree shaking is a promise about a bundler's analysis, and this package cannot
make that promise on a consumer's behalf. It ships TypeScript sources compiled
by whatever bundler the app uses, in whatever mode the app configures, and a
side effect anywhere in a module graph is enough to retain it. A subpath is not
an optimization the bundler might apply: it is a module the consumer never
imported.

The boundary also survives a mistake. When the base barrel carried
`export * from "./vault"`, the wildcard could not tell the pure graph math from
the renderer that draws it, and 34 KB of `d3-force` reached every consumer
through `KnowledgeGraph`. That is why `src/index.ts` names the `vault` and
`calendar` exports one by one instead of re-exporting a subdirectory barrel: a
future heavy addition to a lane barrel cannot ride in silently.

## The ratchet

`tests/barrel-weight.test.ts` measures the thing the rule is about, which is
what a bundler emits for a consumer, not what a source file appears to import.
It bundles `src/index.ts` in a fresh Bun subprocess and asserts that
`node_modules/recharts`, `node_modules/@xterm`, `node_modules/@milkdown`,
`node_modules/@pierre/diffs`, and `node_modules/d3-force` are all absent from
the output.

Two controls guard the guard, because a negative assertion passes against an
empty bundle:

- The bundle must exceed 200 KB and must contain `node_modules/react`, so a
  build that stopped emitting `node_modules/` paths cannot report "no heavy
  renderer here" about a bundle full of them.
- `src/adapters/code-view/index.ts` must contain both pierre and Shiki, and
  `src/adapters/knowledge-graph.ts` must contain `d3-force` as bundled code
  rather than as an externalized `import("d3-force")` call. A dependency that is
  no longer reachable from anywhere in the package would make the negative
  assertion vacuous.

The subprocess is not incidental. Bun's bundler shares its file cache with the
test runner's module registry, so an in-process `Bun.build` running after
another suite has imported the same modules reads crossed content and silently
drops modules it cannot parse. That produced a green control measuring a bundle
that never contained `d3-force`: passing alone, failing under the full suite.

## Getting the light surface instead

Reach for an adapter when you need the renderer, not when you need the job it
does. Three surfaces on the base barrel cover the common cases with no heavy
dependency at all:

| You want                          | Base barrel                                              | Adapter                                                     |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| Render a unified diff             | `DiffHunks` plus the `parseUnifiedFile` helpers          | `PierreDiffView` for per-token syntax highlighting          |
| Render fenced code                | `CodeBlock`, with an optional `highlight` seam           | `CodeFileView` for a whole file on Shiki                    |
| Render markdown                   | `Markdown`, a dependency-free renderer with no `innerHTML` | `MarkdownEditor` for WYSIWYG editing                       |
| Draw a vault graph                | `computeGraphModel`, `nodeRadius`, `folderTint`          | `KnowledgeGraph` for the force simulation and the canvas    |

`CodeBlock` is the sharpest example. Its `highlight` prop takes a
`CodeBlockHighlighter`, a function from code and language to tokenized lines, so
a host that already owns a highlighter can pass it in and never load a second
one. The component itself imports nothing heavier than React.

## When you do import an adapter

Import it from its own subpath, in the module that renders it, and keep that
module off your app's initial route when the payload matters. Nothing in the
package re-exports these names, so an import from `@smthrs/ui` that names
`Terminal`, `ChartContainer`, `CodeFileView`, `PierreDiffView`,
`MarkdownEditor`, or `KnowledgeGraph` fails to resolve rather than working by
accident.

The task-shaped version of this page is the guide
[Use a heavy renderer](/guides/use-a-heavy-renderer/).
