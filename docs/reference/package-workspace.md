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
