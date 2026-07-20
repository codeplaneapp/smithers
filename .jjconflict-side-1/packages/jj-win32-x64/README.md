# @smithers-orchestrator/jj-win32-x64

The [jj (Jujutsu)](https://github.com/jj-vcs/jj) binary for `win32-x64`, vendored so Smithers works without a system jj install.

`@smithers-orchestrator/vcs` lists this as an `optionalDependency`; your package manager installs only the package matching your platform. `resolveJjBinary()` finds the binary here, falling back to a system `jj` on `PATH` when no bundled package is present.

The binary is built and released by the upstream Jujutsu project under the Apache-2.0 license. It is downloaded into `bin/` at release time by `pnpm fetch:jj`; it is not committed to the repository.
