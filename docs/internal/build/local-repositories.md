# Local repositories in package mode

Package-mode workspaces can declare complete Smithers workspaces nested below
their root. The loader treats each declared repository as opaque. It does not
merge the child packages into the parent label graph.

## Declare repository boundaries

Use `S.LocalRepository(path)` in the root `S.Workspace` declaration and give
each repository a stable name in `repos`:

```ts
import { Smithers as S } from "@smthrs/targets"

const runtime = S.Runtime.Node({ version: ">=22.19.0" })

export const Workspace = S.Workspace("parent", {
  repository: "git+https://example.com/parent.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.21.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  repos: {
    app: S.LocalRepository("app"),
    sdk: S.LocalRepository("vendor/sdk", { branch: "main" })
  }
})
```

Repository paths are workspace-relative. Absolute paths, `..` segments, and
duplicate normalized paths are invalid. At load time, each path must be a
directory containing `.smithers/WORKSPACE.ts` or `WORKSPACE.ts`.

Discovery prunes every declared repository before looking for parent
`PACKAGE.ts` files. An undeclared nested workspace fails with
`nested_workspace_undeclared` and a declaration example. This prevents child
packages, workspace services, and root-anchored `//` inputs from being
silently interpreted against the parent.

## Inputs that enter a repository

A broad parent glob stops at repository boundaries:

```ts
const parentFiles = S.glob("**")
```

A pattern with a literal prefix inside a repository is explicit and remains
valid:

```ts
const deployment = S.glob("app/infra/**")
const manifest = S.file("vendor/sdk/Cargo.toml")
```

Explicit repository globs still exclude `.git`, `node_modules`, and nested
`.flows` state. Declaring a repository changes the parent graph digest by its
name and path, but the loader does not scan child contents for that digest.

## Depend on a child target

Use `S.Repo.Target` to add one parent node that delegates to an exact child
label:

```ts
const sdkTests = S.Repo.Target("sdk", "//packages/core:test", {
  data: [S.file("vendor/sdk/Cargo.lock")],
  args: ["--no-cache"]
})

export const Package = S.Package({
  targets: {
    sdkTests,
    ci: S.Suite({ tests: [sdkTests] })
  }
})
```

The `repo` argument may be the `repos` name or its `S.LocalRepository`
declaration. The child label must use the absolute `//package:name` spelling;
relative `:name` labels are not accepted. `data`, `gates`, and `sandbox` use
the same shapes as shell targets. `args` are appended after the child label.

Query and graph operations invoke the same CLI in the child directory with
`query <label> --format json`. Query reports the child's target kinds. Graph
renders the external edge as `@sdk//packages/core:test`. If the child graph
refuses to load, the parent graph still loads: the repository target has no
kinds and carries the child refusal in query and graph output.

## Execution and caching

Execution invokes the same Node process and build-cli entry point with the
child repository as both `cwd` and `--workspace`. Parent write and plan modes
are forwarded, followed by the declared `args`. Child stdout and stderr stream
through the parent process.

The parent cache key includes the child `HEAD`, full `git status --porcelain`
state, child label and args, and parent `data` inputs. A dirty child repository
never reads or writes a parent result-cache entry.

The outer child-CLI process runs without a macOS sandbox. This is deliberate:
nesting the parent sandbox would prevent the child CLI from applying the
sandbox policies of its own targets. The child target executor remains
responsible for its declared sandbox, and the parent logs this delegation.
