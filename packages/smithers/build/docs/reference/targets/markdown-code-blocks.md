---
title: "Markdown.CodeBlocks"
description: "Compiles every fenced code block of the declared languages in one Markdown page with tsc --strict, so a page cannot teach an API that does not ship."
---

Compiles every fenced code block of the declared languages in one Markdown
page with `tsc --strict`, so a page cannot teach an API that does not ship.
Declared as `Smithers.Markdown.CodeBlocks`.

The blocks compile from inside the declaring package: each fence is written
under the package's `node_modules/.cache/smithers-build/`, so a fence that
imports the package's dependencies, or the package itself by name, resolves the
way the package's own sources do.

```ts
import { Smithers } from "@smthrs/targets"

const page = (name: string) => Smithers.file(`docs/tutorials/${name}.md`)

// Every `ts` fence on the page compiles.
export const firstFlow = Smithers.Markdown.CodeBlocks({ file: page("first-flow"), lang: ["ts"] })

// A page that continues the first tutorial's project: its fences import
// `./durable-layer.ts`, a file the first page's titled fences declare.
export const crashAndResume = Smithers.Markdown.CodeBlocks({
  file: page("crash-and-resume"),
  lang: ["ts"],
  context: [page("first-flow")]
})
```

## Attributes

| Name      | Type                | Default  | Description                                                                                                            |
| --------- | ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `file`    | `Input.File`        | required | The Markdown page whose fences compile.                                                                                |
| `lang`    | `Array<string>`     | required | The fence languages to compile. `ts` also matches `typescript`, `js` also matches `javascript`.                        |
| `context` | `Array<Input.File>` | `[]`     | Pages whose titled fences are written beside this page's files before compiling. Never judged on their own; see below. |

## Fence metas

The fence's info string steers how a block becomes a file. The syntax is
Expressive Code's, so the same meta that draws a file-name tab on the rendered
page names the scratch file the compiler sees.

| Fence                     | File the lane writes                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| ` ```ts `                 | `block-N.ts`, where `N` is the fence's index among the page's matching fences. Compiles standalone.                        |
| ` ```ts title="greeting.ts" ` | `greeting.ts`. Every fence on the page with the same title concatenates, in document order, into that one file.        |
| ` ```ts title="src/greeting.ts" ` | `src/greeting.ts`, under the scratch directory. The title is a relative path with no `.` or `..` segment.           |
| ` ```ts fragment `        | Nothing. The fence is skipped and counted in the report.                                                                   |

A tutorial that grows `greeting.ts` across three fences therefore compiles as
one module, and another titled fence's `import { Greet } from "./greeting.ts"`
resolves. A `fragment` is for a fence that is not a compilable unit on its own:
the middle of a function, or an edit to an earlier declaration. Use it
sparingly; a skipped fence is exactly the one that can teach an API that does
not ship. A title that names `block-N.ts`, escapes the scratch directory, or is
absolute fails the target.

A `context` page contributes only its titled files. They are the project a
later page continues, not blocks this target judges: the compiler reaches them
through imports only. When the page and a context page both title the same
file, the page's version wins.

## Command

```text
<package manager> exec tsc --noEmit --strict --skipLibCheck
  --module Node16 --moduleResolution Node16 --allowImportingTsExtensions
  --target es2024 --lib es2024,dom,dom.iterable --types node --exactOptionalPropertyTypes <files...>
```

## Inputs

Collected from the attrs: `file` and every entry in `context`.

## Outputs

None. The target's product is its verdict, and the report line names the
counts: `checked 6 fenced code block(s): 1 standalone, 3 file(s), 1 fragment(s)
skipped`.

## Channels and status

|           |                                                          |
| --------- | -------------------------------------------------------- |
| Kinds     | `build`, `test`                                          |
| Cacheable | Always                                                   |
| Executes  | Yes. The executor provides the code-block lane.          |

## See also

- [DocsParity](docs-parity.md): the README gate beside a package's code
- [Typecheck](typecheck.md): the same compiler over a package's own sources
