# smithers-build CLI

`smithers-build` uses incur and the Bazel verb model. A verb selects a target set.
Targets do not contain per-command scripts.

```sh
smithers-build install --workspace /path/to/smithers
smithers-build build //packages/...
smithers-build test //packages/flow:test
smithers-build lint //packages/flow:lint
smithers-build query 'deps(//packages/flow:lib)'
smithers-build graph //packages/... --mermaid
```

`install` executes the `smithers-build` package's Install Flow with the pnpm layer.
`build`, `test`, `lint`, `query`, and `graph` evaluate and print plans only.

## Cache directory

Every command takes `--cache-dir`, a workspace-relative directory holding the
result cache and rule scratch files. Precedence is the flag, then the `Workspace`
declaration exported from the root `BUILD.ts` file, then `.flows`. An empty
value, an absolute path, and any `..` segment fail the command.

When the declaration sets `gitignored: true`, the command first ensures the
root `.gitignore` carries an entry for the directory, creating the file when it
is absent and leaving it alone when an equivalent entry is already there.

Discovery never lists a path inside the directory, so its content cannot feed
input discovery or a digest, and the directory name itself never enters a cache
key.

## BUILD.ts runtime

The source package requires Node 22.19 or newer. Its JavaScript bin bootstrap
uses the programmatic `tsx` loader that ships as a CLI dependency, then loads
the TypeScript command modules and BUILD.ts files. A built JavaScript
distribution can remove the command-module loader, but BUILD.ts evaluation
still requires tsx or equivalent runtime TypeScript support. BUILD.ts files
must use erasable TypeScript syntax and top-level imports.

Discovery asks git for tracked and non-ignored files, skips `node_modules` and
the resolved cache directory, and falls back to a root `.gitignore` walker
outside a git worktree that skips the same paths. Exact labels
load one BUILD.ts module. Recursive patterns load BUILD.ts modules in the
selected subtree. Direct imports evaluate dependency BUILD.ts modules through
the normal ESM module graph.

## Remote cache

The root `BUILD.ts` may export `RemoteCache.make({ endpoint, tokenEnv })`.
Endpoints must use HTTPS and `tokenEnv` defaults to `SMITHERS_CACHE_TOKEN`.
`SMITHERS_CACHE_URL` overrides the declared endpoint. Token values are read only
from the named environment variable and are removed before target tools spawn.

The CLI reads through HTTP `/ac`: local hits avoid the network, remote hits
hydrate local JSON, and puts publish to both tiers. A remote failure warns once
and disables the remote for the rest of the process; `409` conflicts warn but
do not fail the run.
