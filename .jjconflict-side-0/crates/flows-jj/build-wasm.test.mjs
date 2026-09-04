import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import test from "node:test"
import {
  buildEnvironment,
  canonicalHost,
  foreignHostError,
  remapFlags,
  reproductionFailure,
  rustcCommitHash,
  rustcHost,
  targetDir
} from "./build-wasm.mjs"

const verboseVersion = [
  "rustc 1.89.0 (29483883e 2025-08-04)",
  "binary: rustc",
  "commit-hash: 29483883eed69d5fb4db01964cdf2af4d86e9cb2",
  "commit-date: 2025-08-04",
  "host: aarch64-apple-darwin",
  "release: 1.89.0",
  "LLVM version: 20.1.7"
].join("\n")

test("targetDir defaults to the workspace target directory", () => {
  assert.equal(targetDir({}, "/repo"), join("/repo", "target"))
})

test("targetDir treats an empty CARGO_TARGET_DIR as unset", () => {
  assert.equal(targetDir({ CARGO_TARGET_DIR: "" }, "/repo"), join("/repo", "target"))
})

test("targetDir honors an absolute CARGO_TARGET_DIR", () => {
  const absolute = resolve("/tmp", "flows-ci-target")
  assert.equal(targetDir({ CARGO_TARGET_DIR: absolute }, "/repo"), absolute)
})

test("targetDir resolves a relative CARGO_TARGET_DIR against the workspace root, like cargo", () => {
  assert.equal(
    targetDir({ CARGO_TARGET_DIR: "ci-target" }, "/repo"),
    resolve("/repo", "ci-target")
  )
})

test("rustcCommitHash extracts the commit-hash line of rustc -vV", () => {
  assert.equal(rustcCommitHash(verboseVersion), "29483883eed69d5fb4db01964cdf2af4d86e9cb2")
})

test("rustcCommitHash rejects output without a commit-hash line", () => {
  assert.throws(() => rustcCommitHash("rustc 1.89.0"), /commit-hash/)
})

test("rustcHost extracts the host line of rustc -vV", () => {
  assert.equal(rustcHost(verboseVersion), "aarch64-apple-darwin")
})

test("rustcHost rejects output without a host line", () => {
  assert.throws(() => rustcHost("rustc 1.89.0"), /host/)
})

test("foreignHostError passes the host the committed artifact is built on", () => {
  assert.equal(foreignHostError(canonicalHost), undefined)
})

test("foreignHostError refuses a host whose bytes CI cannot reproduce", () => {
  const error = foreignHostError("aarch64-apple-darwin")
  assert.match(error, /aarch64-apple-darwin/)
  assert.match(error, new RegExp(canonicalHost))
  // The refusal is only actionable if it carries the canonical rebuild.
  assert.match(error, /docker run/)
  assert.match(error, /node crates\/flows-jj\/build-wasm\.mjs/)
})

test("remapFlags replaces every machine-specific prefix with a fixed token", () => {
  assert.deepEqual(
    remapFlags({
      cargoHome: "/home/user/.cargo",
      commitHash: "abc123",
      sysroot: "/home/user/.rustup/toolchains/1.89.0-x86_64-unknown-linux-gnu",
      workspaceRoot: "/home/user/flows"
    }),
    [
      "--remap-path-prefix=/home/user/flows=/flows",
      "--remap-path-prefix=/home/user/.cargo=/cargo",
      "--remap-path-prefix=" +
        join(
          "/home/user/.rustup/toolchains/1.89.0-x86_64-unknown-linux-gnu",
          "lib",
          "rustlib",
          "src",
          "rust"
        ) +
        "=/rustc/abc123"
    ]
  )
})

test("buildEnvironment authors RUSTFLAGS from the remap flags alone", () => {
  const environment = buildEnvironment(
    { PATH: "/usr/bin", RUSTFLAGS: "-C target-cpu=native" },
    ["--remap-path-prefix=/a=/flows"]
  )
  assert.equal(environment.RUSTFLAGS, "--remap-path-prefix=/a=/flows")
  assert.equal(environment.PATH, "/usr/bin")
})

test("buildEnvironment deletes an ambient CARGO_ENCODED_RUSTFLAGS", () => {
  const environment = buildEnvironment(
    { CARGO_ENCODED_RUSTFLAGS: "-Clto", PATH: "/usr/bin" },
    ["--remap-path-prefix=/a=/flows"]
  )
  assert.equal("CARGO_ENCODED_RUSTFLAGS" in environment, false)
})

test("reproductionFailure accepts byte-identical artifacts", () => {
  assert.equal(
    reproductionFailure(Buffer.from([0, 1, 2]), Buffer.from([0, 1, 2])),
    undefined
  )
})

test("reproductionFailure names the canonical host and both sizes on drift", () => {
  const failure = reproductionFailure(Buffer.from([0, 1, 2]), Buffer.from([0, 1]))
  assert.match(failure, /does not reproduce from source/)
  assert.match(failure, /committed 3 bytes, rebuilt 2 bytes/)
  assert.match(failure, new RegExp(canonicalHost))
})
