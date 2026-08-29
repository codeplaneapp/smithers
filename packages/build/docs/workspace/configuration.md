# Configuration

A workspace has one configurable setting: where the CLI keeps its cache and target
scratch files. The root `BUILD.ts` file declares it.

```ts
// BUILD.ts
import { Smithers } from "@smthrs/targets"

export const config = Smithers.Workspace({ cacheDirectory: ".flows", gitignored: true })
```

`Workspace` validates its options and performs no I/O, so `BUILD.ts` evaluation
stays pure. The export name does not matter; when several exports are `Workspace`
values, the workspace takes the first one in ascending export-name order.

For the full schema and every validation target, see
[the Workspace reference](../reference/config.md).

## Precedence

Every command settles the cache directory before it reads or writes anything.

1. The `--cache-dir` flag.
2. The `Workspace` declaration exported from the root `BUILD.ts`.
3. `.flows`.

Both the flag and the declaration go through the same validation, so an absolute
path, a `..` segment, or an empty value fails the command regardless of where it
came from.

```sh
smthrs build //... --cache-dir .smithers-build-cache
```

`gitignored` comes only from the declaration. It is a workspace policy, not a
per-run choice, so there is no flag for it.

## What lives in the cache directory

| Path                                       | Written by                                                           |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `<cacheDirectory>/cache/<xx>/<key>.json`   | The result cache, one JSON file per stored target result             |
| `<cacheDirectory>/knip-<fingerprint>.json` | `DepsLint`, when its ignore lists are non-empty and the tool is knip |

Package-manager stores are not controlled by this setting. They stay at
`.flows/store/<manager>` because fetch declares those fixed paths as
`TreeArtifact` boundaries. The `install` verb requires the default `.flows`
configuration; build, test, lint, docs, run, query, graph, and CI may use a
custom directory.

## The gitignore policy

When the declaration sets `gitignored: true`, every command first ensures the
root `.gitignore` carries an entry for the resolved directory.

The write is idempotent. Any of these spellings already present leaves the file
untouched, for a directory named `.flows`:

```
.flows
.flows/
/.flows
/.flows/
```

A missing `.gitignore` is created with the entry alone. The entry the CLI writes
is the anchored, trailing-slash form with glob metacharacters escaped, for
example `/.flows/`.

## Why the directory is not key material

The resolved cache directory is host state. It names where one machine keeps
replayable files, and two checkouts that configured it differently must still
agree on every content key.

Three mechanisms keep it out.

- **Discovery** drops the directory and the fixed `.flows/store` subtree from
  both the git listing and the fallback walk, even when the workspace does not
  ignore them.
- **Glob expansion** receives the resolved directory explicitly and refuses to
  descend into it. A `file()` declaration that resolves inside it expands to an
  empty file list.
- **Tool execution** never receives the real path in an action payload. `DepsLint`
  emits the constant token `{smthrs:cache-directory}` at plan time, and
  `ExecLive` substitutes the validated host directory into the argv immediately
  before spawn.

## Next

- [Caching](caching.md)
- [Workspace reference](../reference/config.md)
- [Workspace structure](structure.md)
