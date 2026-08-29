# Go package targets

`S.Go.Toolchain` declares `go.mod`, `go.sum`, its version authority, module-wide CGO policy, and `GOEXPERIMENT` values. `go version` is probed in the module directory, so `GOTOOLCHAIN=auto` selects and keys the resolved version.

The executable rules are `S.Go.Test`, `Binary`, `ModDownload`, `Lint`, `Generate`, and `Fuzz`. `S.Go.bin` and `S.Go.run("module/cmd@version")` are tool references. All constructors reject unknown attrs.

`S.Go.Packages({ pkgs })` resolves packages with `go list`; it composes through `S.Files.difference`. Tests and binaries key on digests of the transitive Go files, test files, cgo files, and `go:embed` files returned by `go list -deps -json`. An unrelated edit therefore remains a cache hit.

`offline: true` adds `GOPROXY=off` and `GOFLAGS=-mod=readonly`. Binary `goos`, `goarch`, CGO, experiments, ordinary ldflags, and the resolved toolchain are key material. Stamp values are late-bound and excluded.
