# Install

smithers build lives in the flows repository as three pnpm workspace packages:

```
flows/
  BUILD.ts
  packages/
    build/        # @smthrs/build — Install and PackageManager
    @smthrs/targets/  # @smthrs/targets — the BUILD.ts authoring surface
    @smthrs/build-cli/    # @smthrs/build-cli — the smithers build bin
```

`@smthrs/build` is the publishable library. `@smthrs/targets` and
`@smthrs/build-cli` are private and never published.

## Requirements

- Node.js 22.19 or newer.
- pnpm. Catalog targets run their tools through whichever package manager the
  workspace declares, but the install flow has a live implementation only for
  pnpm today; the other managers fail with a typed `unsupported` error.
- A git worktree. Discovery prefers `git ls-files`; outside a worktree it falls
  back to a `.gitignore` walker.

## Link the authoring package

The flows root manifest declares both the authoring package and CLI as
devDependencies at the workspace version:

```json
// flows/package.json
{
  "devDependencies": {
    "@smthrs/build-cli": "0.1.0",
    "@smthrs/targets": "0.1.0"
  }
}
```

`linkWorkspacePackages` resolves the exact version to the workspace package, so
`pnpm install` links both packages with no `file:` or `link:` specifier. The CLI
dependency exposes the `smthrs` bin to `pnpm exec` at the workspace root.

`BUILD.ts` files then import by bare specifier:

```ts
// flows/BUILD.ts
import { Smithers } from "@smthrs/targets"
```

## Install the CLI dependencies

The CLI package depends on the flows engine packages, on
`@smthrs/build`, and on `@smthrs/targets` at the workspace version:

```json
// packages/build-cli/package.json
{
  "dependencies": {
    "@smthrs/engine": "0.1.0",
    "@smthrs/flow": "0.1.0",
    "@smthrs/plan": "0.1.0",
    "@smthrs/build": "0.1.0",
    "@smthrs/targets": "0.1.0",
    "incur": "0.5.1",
    "tsx": "4.23.12"
  }
}
```

The root `pnpm install` installs and links them like every other workspace
package.

## Run the CLI

The bin entry is `smthrs`, backed by `packages/build-cli/src/main.js`. That
file is a JavaScript bootstrap: it loads `main.ts` through the programmatic
`tsx` loader, which is also what evaluates `BUILD.ts` modules.

```sh
# From the workspace root.
pnpm exec smthrs query //...
```

Or point the CLI at the workspace explicitly from anywhere:

```sh
smthrs query //... --workspace /path/to/flows
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
// flows/BUILD.ts
import { Smithers } from "@smthrs/targets"

export const config = Smithers.Workspace({ cacheDirectory: ".flows", gitignored: true })
```

See [Configuration](../workspace/configuration.md).

The ordinary target verbs may use another configured directory. The dedicated
`smthrs install` verb currently requires `.flows`, because its declared pnpm
store boundary is fixed at `.flows/store/pnpm`.

## Next

- [First build](first-build.md)
- [Workspace structure](../workspace/structure.md)
