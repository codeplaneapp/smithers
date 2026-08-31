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
  args: ["--test", "crates/flows-jj/build-wasm.test.mjs"],
  data: [srcs, S.file("build-wasm.mjs"), S.file("build-wasm.test.mjs")]
})

const wasmReproducibility = S.Shell.Test({
  script: S.file("build-wasm.mjs"),
  args: ["--verify"],
  data: [srcs, fetch, S.file("//packages/jj/wasm/flows_jj.wasm")],
  env: {
    CARGO_HOME: ".cargo-home",
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
