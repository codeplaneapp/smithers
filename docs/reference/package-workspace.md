# Package workspace toolchains

`S.Workspace` accepts either the complete Node trio (`runtime`, `packageManager`, and `nodeModules`) or a non-empty `toolchains` list. Mixed-language repositories may declare both. Omitting only part of the Node trio is rejected.

```ts
const nix = S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
const go = S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: nix })
export const Workspace = S.Workspace("service", {
  repository: "git+https://example.test/service.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [nix, go],
})
```

Generated GitHub setup actions render `actions/setup-go` with `go-version-file` for a Go-only workspace. Package-manager references refuse when no package manager was declared.

## Compile-time `S.file` paths

A workspace can opt into compile-time checking for `S.file`/`Smithers.file`
by generating `known-files.d.ts` and including it in the workspace TypeScript
configuration:

```ts
export const knownFiles = S.Generate({
  script: S.file("//scripts/generate-known-files.mjs"),
  changes: ["known-files.d.ts"]
})
```

The generator uses the same workspace walk as declared-input globs. Nested
`.gitignore` files apply, and `.git`, `node_modules`, the configured workspace
state directory, and `.flows/store` are excluded. The checked-in declaration
is generated through `S.Generate`, so check mode reports drift and `--write`
updates it.

Every discovered file has a `//` workspace-absolute spelling, and every file
below a directory that contains a `BUILD.ts` or `PACKAGE.ts` also has its
package-local spelling. Those are the two spellings a declaration writes; a
path with `..` is not accepted, because a declaration that reaches outside its
package says so with `//`.

The generated declaration supplies a type-only overlay for the
`@smthrs/targets` entry point and leaves runtime exports unchanged. A
repository that does not include one keeps the generic `string` fallback, so
existing workspaces and design-partner repositories load unchanged.
