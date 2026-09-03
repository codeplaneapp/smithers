# Install

smithers build lives in the Smithers repository as three pnpm workspace packages:

```
smithers/
  BUILD.ts
  packages/
    build/        # @smthrs/build: Install, PackageManager, and Runtime
    targets/      # @smthrs/targets: the BUILD.ts authoring surface
    build-cli/    # @smthrs/build-cli: the smithers-build bin
```

All three are private workspace packages and none of them is published: the
rc.0 release policy fixes `@smthrs/build` as private alongside
`@smthrs/targets` and `@smthrs/build-cli`. A consumer reaches them through the
workspace, never through a registry.

## Requirements

- Node.js 22.19 or newer.
- pnpm. Catalog targets run their tools through whichever package manager the
  workspace declares, and a declaration names pnpm or Bun. The install flow has
  a live implementation only for pnpm today; a Bun declaration fails with a
  typed `unsupported` error.
- A git worktree. Discovery prefers `git ls-files`; outside a worktree it falls
  back to a `.gitignore` walker.

## Link the authoring package

The Smithers root manifest declares both the authoring package and CLI as
devDependencies on the workspace:

```json
// smithers/package.json
{
  "devDependencies": {
    "@smthrs/build-cli": "workspace:*",
    "@smthrs/targets": "workspace:*"
  }
}
```

`pnpm install` links both packages from the workspace. The CLI dependency
exposes the `smithers-build` bin to `pnpm exec` at the workspace root.

`BUILD.ts` files then import by bare specifier:

```ts
// smithers/BUILD.ts
import { Smithers } from "@smthrs/targets"
```

## Install the CLI dependencies

The CLI package depends on the Smithers engine packages, on
`@smthrs/build`, and on `@smthrs/targets`. Published Smithers packages are
pinned at the release version; the private ones are workspace links:

```json
// packages/build-cli/package.json
{
  "dependencies": {
    "@smthrs/engine": "1.0.0-rc.0",
    "@smthrs/flow": "1.0.0-rc.0",
    "@smthrs/plan": "1.0.0-rc.0",
    "@smthrs/build": "workspace:*",
    "@smthrs/targets": "workspace:*"
  }
}
```

The root `pnpm install` installs and links them like every other workspace
package.

## Run the CLI

The bin entry is `smithers-build`, backed by `packages/build-cli/src/main.js`. That
file is a JavaScript bootstrap: it loads `main.ts` through the programmatic
`tsx` loader, which is also what evaluates `BUILD.ts` modules.

```sh
# From the workspace root.
pnpm exec smithers-build query //...
```

Or point the CLI at the workspace explicitly from anywhere:

```sh
smithers-build query //... --workspace /path/to/smithers
```

`--workspace` defaults to the process working directory. The current directory
also determines which package a relative `:target` label resolves in. See
[Labels](../concepts/labels.md).

## Ignore the cache directory

smithers build keeps its result cache and target scratch files under a
workspace-relative directory, `.flows` by default. Add it to the workspace
`.gitignore`, or declare the policy in the root `BUILD.ts` and let the CLI
maintain the entry:

```ts
// smithers/BUILD.ts
import { Smithers } from "@smthrs/targets"

export const config = Smithers.Workspace({ cacheDirectory: ".flows", gitignored: true })
```

See [Configuration](../workspace/configuration.md).

The ordinary target verbs may use another configured directory. The dedicated
`smithers-build install` verb currently requires `.flows`, because its declared pnpm
store boundary is fixed at `.flows/store/pnpm`.

## Next

- [First build](first-build.md)
- [Workspace structure](../workspace/structure.md)
