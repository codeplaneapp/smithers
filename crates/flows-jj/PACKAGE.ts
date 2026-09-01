/**
 * Targets for the `flows-jj` crate and the WebAssembly artifact it produces.
 *
 * Every target that resolves dependencies needs the `vendor/jj` submodule
 * checked out. The crate takes `jj-lib` as a path dependency on
 * `vendor/jj/lib`, so against an empty `vendor/jj` cargo fails resolution
 * rather than compilation, and `fetch` exits 101 before any target that
 * depends on it runs. `cargoFmt` and `buildScript` resolve nothing and pass
 * without it. An operator checks the submodule out once per checkout with
 * `git submodule update --init --recursive vendor/jj`, which needs network on
 * a fresh clone. `Git.Submodules` would express that as a target, but a gate
 * that checks out the jj history rewrites the operator's working copy as a
 * side effect of running a test suite, so it stays the operator's call.
 * SMITHERS-NOTES.md records the worktree hazard that makes it one.
 *
 * The `rust` and `wasm` suites are addressed separately on purpose. The cargo
 * gates need only a Rust toolchain; the wasm rebuild is uncached and takes
 * minutes, so it is its own CI job.
 */
import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({
  srcs: [
    ...S.glob(["src/**/*.rs", "tests/**/*.rs"]),
    S.file("Cargo.toml"),
    S.file("//Cargo.toml"),
    S.file("//Cargo.lock"),
    S.file("//rust-toolchain.toml")
  ]
})
const cwd = "crates/flows-jj"

const fetch = S.Cargo.Fetch({
  workspace: S.file("//Cargo.toml"),
  outFiles: ["//Cargo.lock"],
  outDirs: ["//.cargo-home"],
  sandbox: { network: true }
})

const cargoFmt = S.Cargo.Fmt({
  workspace: true,
  data: [srcs],
  changes: ["**/*.rs"]
})

const cargoClippy = S.Cargo.Clippy({
  workspace: true,
  allTargets: true,
  locked: true,
  offline: true,
  denyWarnings: true,
  data: [srcs, fetch]
})

const cargoTest = S.Cargo.Test({
  workspace: true,
  locked: true,
  offline: true,
  data: [srcs, fetch]
})

const buildScript = S.Shell.Test({
  bin: S.Runtime.bin,
  args: ["--test", "build-wasm.test.mjs"],
  cwd,
  data: [srcs, S.file("build-wasm.mjs"), S.file("build-wasm.test.mjs")]
})

/**
 * Rebuilds `flows_jj.wasm` from source and byte-compares it against the
 * committed artifact.
 *
 * `CARGO_HOME` is deliberately absent from `env`. The `fetch` data edge sets
 * it to that fetch's delivery directory and makes it absolute at spawn, and
 * absolute is what this script needs: it turns `CARGO_HOME` into a
 * `--remap-path-prefix` operand, and rustc matches that prefix against the
 * absolute paths it embeds. A relative value would key the node the same way
 * but silently match nothing, baking this machine's registry path into the
 * bytes and failing the compare on the canonical host too. Declaring
 * `CARGO_HOME` here would shadow the wired value and reintroduce that.
 *
 * `CARGO_NET_OFFLINE` stays declared because `S.Shell.Test` has no `offline`
 * attr to infer it from, and the child cargo must read the fetch's registry
 * rather than the network the sandbox denies.
 */
const wasmReproducibility = S.Shell.Test({
  script: S.file("build-wasm.mjs"),
  args: ["--verify"],
  data: [srcs, fetch, S.file("//packages/jj/wasm/flows_jj.wasm")],
  env: {
    CARGO_NET_OFFLINE: "true",
    CARGO_TARGET_DIR: "target/wasm-reproducibility"
  }
})

const rust = S.Suite({ tests: [cargoFmt, cargoClippy, cargoTest] })
const wasm = S.Suite({ tests: [buildScript, wasmReproducibility] })
const ci = S.Suite({ tests: [rust, wasm] })

export const Package = S.Package({
  targets: {
    srcs,
    fetch,
    cargoFmt,
    cargoClippy,
    cargoTest,
    buildScript,
    wasmReproducibility,
    rust,
    wasm,
    ci
  }
})
