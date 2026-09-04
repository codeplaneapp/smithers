---
title: "Docs Parity"
description: "Bazel-style TypeScript workflow orchestration with explicit pnpm installation"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/docs/reference/targets/docs-parity.md"
---

Checks that a package README has a level-one title and substantive prose.

```ts
import { Smithers } from "@smthrs/targets"

export const docs = Smithers.DocsParity({
  readme: Smithers.file("README.md"),
  deps: [],
  cwd: "packages/widget"
})
```

Run it with:

```sh
smithers-build docs //packages/widget:docs
```

## Attributes

| Name                     | Type                   | Default  | Description                                         |
| ------------------------ | ---------------------- | -------- | --------------------------------------------------- |
| `readme`                 | `Input.File`           | required | README declared as content-key input                |
| `deps`                   | `Array<Target.Target>` | required | Target dependencies                                 |
| `minimumProseCharacters` | integer                | `120`    | Required prose after markup-only blocks are removed |
| `cwd`                    | `string`               | `"."`    | Workspace-relative package directory                |

The prose floor is between 1 and 4 MiB. README reads are confined to the
workspace, descriptor-stable, exact UTF-8, and limited to 4 MiB.

## Policy

The first level-one ATX heading is the title. Prose is counted from blank-line
separated paragraphs after excluding headings, lists, blockquotes, tables,
thematic breaks, HTML blocks, link definitions, fenced code, badges, image
targets, URLs, and Markdown markers. A title plus badge row therefore fails;
an actual package description passes.

The target does not duplicate JSDoc linting. Export descriptions, `@since`, and
`@category` remain ESLint's responsibility.

## Channels and status

| Property  | Value                                                    |
| --------- | -------------------------------------------------------- |
| Kinds     | `docs`                                                   |
| Cacheable | Yes; README content and the prose floor are key material |
| Success   | `void`                                                   |
| Error     | `DocsParityError`, `{path, message}`                     |
| Executes  | Yes, through `CheckDocsLive`                             |

The `docs` verb also runs these targets standalone; `ci` merges them into its
graph alongside lint, build, and test.

## See also

- [Running targets](/workspace/running-targets/)
- [Writing targets](/extending/writing-targets/)
