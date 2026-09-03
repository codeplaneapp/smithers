# Workspace reference

`Workspace` is the workspace configuration declaration the root `PACKAGE.ts` file
exports. It is inert: `Workspace` validates its options and performs no I/O.

```ts
// PACKAGE.ts
import { Smithers } from "@smthrs/targets"

export const config = Smithers.Workspace({ cacheDirectory: ".flows", gitignored: true })
```

Import the callable from the package root. The `Config` module subpath is an
internal CLI surface for normalization and declaration recognition, not a
`PACKAGE.ts` authoring namespace.

## Options

| Option           | Type      | Default    | Description                                                                                                        |
| ---------------- | --------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `cacheDirectory` | `string`  | `".flows"` | A single workspace-relative directory holding the result cache and target scratch files. Normalized and validated. |
| `gitignored`     | `boolean` | `false`    | Ask every command to keep a root `.gitignore` entry for the resolved directory.                                    |

Both are optional. `Workspace()` with no argument is valid and yields the
defaults.

## Value

```ts
interface Workspace {
  readonly [TypeId]: typeof TypeId // Symbol.for("smithers-build/Workspace")
  readonly cacheDirectory: string // normalized posix form
  readonly gitignored: boolean
}
```

The CLI's `isWorkspace(value)` guard recognizes it: the symbol must be present and equal to
itself, `cacheDirectory` must be a string, and `gitignored` must be a boolean.

## Constants

| Export                  | Value                                    | Description                                           |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `defaultCacheDirectory` | `".flows"`                               | Used when no declaration and no flag name a directory |
| `TypeId`                | `Symbol.for("smithers-build/Workspace")` | Runtime marker                                        |

## normalizeCacheDirectory

`normalizeCacheDirectory(value)` is the single validator. `Workspace` calls it,
and so does the CLI on the `--cache-dir` flag, so both paths enforce
the same targets.

Normalization, in order:

1. Trim surrounding whitespace.
2. Split on `/` and `\`.
3. Drop empty segments and `.` segments.
4. Join the rest with `/`.

Refusals:

| Input                                                  | Error                                                  |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `""` or whitespace only                                | `cacheDirectory must not be empty`                     |
| A value that normalizes to no segments, such as `"./"` | `cacheDirectory must not be empty`                     |
| Starts with `/` or `\`                                 | `cacheDirectory must be workspace-relative: <value>`   |
| Starts with a drive letter, such as `C:\cache`         | `cacheDirectory must be workspace-relative: <value>`   |
| Contains a `..` segment                                | `cacheDirectory must not leave the workspace: <value>` |
| Contains a control character or malformed Unicode      | `cacheDirectory must be well-formed text...`           |
| Exceeds 4,096 UTF-8 bytes                              | `cacheDirectory must be at most 4096 UTF-8 bytes`      |
| A segment exceeds 255 UTF-8 bytes                      | `cacheDirectory segments must be at most 255...`       |

Examples:

| Input               | Result        |
| ------------------- | ------------- |
| `".flows"`          | `.flows`      |
| `"  .flows  "`      | `.flows`      |
| `"build\\cache"`    | `build/cache` |
| `"./build//cache/"` | `build/cache` |
| `"/tmp/cache"`      | error         |
| `"../cache"`        | error         |

The value can name a nested directory, such as `build/cache`. It cannot be
absolute and cannot escape the workspace.

## Discovery

`resolveConfig(root, override)` runs before every command.

1. If the workspace root has a `PACKAGE.ts` file, it is imported.
2. The module namespace is scanned in ascending export-name order, and the first
   export that passes `isWorkspace` is the declaration. If there is none, the
   defaults apply.
3. `cacheDirectory` resolves as `normalizeCacheDirectory(override ?? declared.cacheDirectory)`.
4. `gitignored` comes only from the declaration.

The export name does not matter. `config`, `workspaceConfig`, and `settings` all
work. Exporting two `Workspace` values is not an error; the first in name order
wins.

`PACKAGE.ts` module imports are cached by absolute path, so resolving the config
and loading the root package's targets evaluate the module once.

## The gitignore policy

When `gitignored` is true, every command ensures the root `.gitignore` carries an
entry for the resolved directory before touching it.

The check accepts four spellings, shown here for `.flows`:

```
.flows
.flows/
/.flows
/.flows/
```

plus the exact entry the CLI writes: the anchored, trailing-slash form with `*`,
`?`, `[`, `]`, and `\` escaped, for example `/.flows/`.

If any of those is already present as a trimmed line, nothing is written. A
missing `.gitignore` is created containing the entry alone. An existing file
without a trailing newline gets one before the entry is appended.

There is no flag for this. It is a workspace policy, not a per-run choice.

## What the setting controls

| Path                                       | Written by                                                           |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `<cacheDirectory>/cache/<xx>/<key>.json`   | The result cache                                                     |
| `<cacheDirectory>/knip-<fingerprint>.json` | `DepsLint`, when its ignore lists are non-empty and the tool is knip |

It does not control package-manager stores. Those stay at
`.flows/store/<manager>` because fetch declares that fixed path as its
`TreeArtifact` boundary. The direct `install` verb therefore requires the
default `.flows` setting; other verbs accept a custom directory.

## Not key material

The resolved directory is host state and never reaches a cache key or a content
digest.

- Discovery drops the directory and the fixed `.flows/store` subtree from both
  the git listing and the fallback walk, even when the workspace does not ignore
  them.
- Glob expansion receives the resolved directory explicitly and refuses to
  descend into it. A `file()` declaration resolving inside it expands to an empty
  file list.
- Action payloads carry the constant token `{smthrs:cache-directory}` instead
  of the path. `ExecLive` substitutes the validated host directory into every
  argument immediately before spawn.

## Next

- [Configuration](../workspace/configuration.md)
- [CLI reference](cli.md)
- [DepsLint](targets/deps-lint.md)
