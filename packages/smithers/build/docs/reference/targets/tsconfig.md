# Tsconfig

Generates and drift-checks a `tsconfig.json`.

```ts
import { Smithers } from "@smthrs/targets"

export const tsconfig = Smithers.Tsconfig({
  extends: Smithers.file("tsconfig.base.json"),
  compilerOptions: {
    noEmit: true,
    module: "NodeNext",
    moduleResolution: "NodeNext"
  },
  include: ["packages/*/src/**/*"],
  exclude: ["**/dist/**"]
})
```

A `tsconfig.json` decides what the compiler reads and what it emits, which
makes it part of the build definition. Leaving it hand-maintained next to a
PACKAGE.ts file that declares the same sources means two descriptions of one
thing, free to disagree.

## Attributes

| Name              | Type                      | Default           | Description                                   |
| ----------------- | ------------------------- | ----------------- | --------------------------------------------- |
| `path`            | `string`                  | `"tsconfig.json"` | Where the file is written, relative to `cwd`  |
| `extends`         | `Input.File \| null`      | `null`            | The base configuration this one extends       |
| `compilerOptions` | `Record<string, unknown>` | `{}`              | Compiler options, rendered verbatim           |
| `include`         | `string[]`                | `[]`              | Include patterns, in tsconfig's glob syntax   |
| `exclude`         | `string[]`                | `[]`              | Exclude patterns                              |
| `references`      | `string[]`                | `[]`              | Project references                            |
| `mode`            | `"write" \| "check"`      | `"check"`         | Write the file, or verify the checked-in copy |
| `cwd`             | `string`                  | `"."`             | The directory `path` resolves against         |

Include and exclude patterns are plain strings rather than `Input.glob`
declarations. A generator's output depends on the pattern text, not on which
files currently match it: keying this target on matched files would make the
config regenerate whenever any source file changed, while changing nothing
about the bytes it writes.

`compilerOptions` is validated as strict JSON before rendering. A Proxy, an
accessor, a cycle, or a bigint is refused rather than executed.

## Rendering

Sections are emitted in the order the compiler's own documentation uses:
`extends`, `compilerOptions`, `include`, `exclude`, `references`. An empty
section is omitted. A bare `extends` path gets the explicit `./` prefix the
compiler needs to resolve it as a file rather than a package name.

## Status

| Property  | Value                                                             |
| --------- | ----------------------------------------------------------------- |
| Kinds     | `build`, `lint`                                                   |
| Cacheable | No                                                                |
| Executes  | Yes; `lint` forces the non-writing view, `build` honours the mode |

## See also

- [PnpmWorkspace](./pnpm-workspace.md)
- [Lockfile](./lockfile.md)
