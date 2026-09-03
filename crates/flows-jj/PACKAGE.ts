/**
 * Targets for the `flows-jj` crate and the WebAssembly artifact it produces.
 *
 * The Rust gates and the wasm reproducibility gate are declared here, beside the
 * crate that owns them, so `smithers-build lint '//crates/flows-jj:cargoClippy'` is the
 * same command a pipeline runs. The cargo flags that make a check a gate live in
 * the target implementations, not here.
 *
 * The two lanes are addressed by exact label rather than by a recursive pattern
 * on purpose. The cargo gates need only a Rust toolchain; the wasm rebuild needs
 * an uncached one and takes minutes, so it is a separate CI job and a bare
 * `//crates/flows-jj` under the test verb would pull it into both.
 */
import { Smithers } from "@smthrs/targets"
import { runtime, rustToolchain } from "../../PACKAGE.ts"

const cwd = "."

/**
 * The crate sources, the vendored jj submodule's manifests, and the lockfile.
 *
 * `vendor/jj` is a git submodule the crate builds against; a checkout without it
 * fails on a missing manifest, which is why the CI jobs that use these targets
 * declare `submodules`.
 */
const sources = [
  Smithers.glob("//crates/flows-jj/**/*.rs"),
  Smithers.file("//Cargo.toml"),
  Smithers.file("//Cargo.lock"),
  Smithers.file("//rust-toolchain.toml")
]

/**
 * Refuses any crate source `rustfmt` would rewrite.
 *
 * @since 0.1.0
 * @category lint
 */
const cargoFmt = Smithers.CargoLint({
  toolchain: rustToolchain,
  check: Smithers.Cargo.Fmt(),
  srcs: sources,
  deps: [],
  cwd
})

/**
 * Runs clippy over every target with warnings promoted to errors.
 *
 * @since 0.1.0
 * @category lint
 */
const cargoClippy = Smithers.CargoLint({
  toolchain: rustToolchain,
  check: Smithers.Cargo.Clippy(),
  srcs: sources,
  deps: [],
  cwd
})

/**
 * Runs the crate's native test suite against the vendored jj-lib.
 *
 * @since 0.1.0
 * @category test
 */
const cargoTest = Smithers.CargoTest({
  toolchain: rustToolchain,
  check: Smithers.Cargo.Test(),
  srcs: sources,
  deps: [],
  cwd
})

/**
 * Checks the build script's own helpers: path remapping, the host guard, and
 * the reproducibility comparison.
 *
 * @since 0.1.0
 * @category test
 */
const buildScript = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//crates/flows-jj/build-wasm.test.mjs")]),
  srcs: [Smithers.file("//crates/flows-jj/build-wasm.mjs")],
  deps: []
})

/**
 * Rebuilds `flows_jj.wasm` from source and byte-compares it against the
 * committed artifact.
 *
 * The committed module is a reproducibility contract: rebuilding it from source
 * with the pinned toolchain must give the same bytes. `--verify` is what makes
 * that one target — the script rebuilds into a scratch directory, compares, and
 * never overwrites the committed bytes. A scratch `CARGO_TARGET_DIR` keeps the
 * rebuild clean-room and exercises the script's own handling of it.
 *
 * This runner's host triple is part of the contract, so the script refuses to
 * run anywhere but the canonical host rather than report a byte diff.
 *
 * @since 0.1.0
 * @category test
 */
const wasmReproducibility = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("//crates/flows-jj/build-wasm.mjs"), ["--verify"]),
  srcs: [...sources, Smithers.file("//packages/jj/wasm/flows_jj.wasm")],
  deps: [],
  env: { CARGO_TARGET_DIR: "target/wasm-reproducibility" },
  cwd
})

export const Package = Smithers.Package({
  targets: { buildScript, cargoClippy, cargoFmt, cargoTest, wasmReproducibility }
})
