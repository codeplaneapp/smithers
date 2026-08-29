/**
 * The workspace Rust toolchain layer, `S.Rust.Toolchain`.
 *
 * Two forms exist because two design partners pin differently: a repo with a
 * checked-in `rust-toolchain.toml` names the pin file, and a repo whose CI
 * pins the channel by hand names the channel as text. The assertions here are
 * about which files become key material and which argv installs the pin.
 */
import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as RustToolchain from "../src/RustToolchain.ts"

describe("Rust.Toolchain", () => {
  it("declares the workspace/channel form as inert data", () => {
    const declaration = RustToolchain.Toolchain({
      workspace: Input.file("//Cargo.toml"),
      channel: "1.91"
    })
    expect(declaration).toEqual({
      _tag: "RustToolchain",
      workspace: { _tag: "File", path: "//Cargo.toml" },
      channel: "1.91",
      rustup: "rustup",
      cargo: "cargo"
    })
    // The channel is declared text, so the install names it: a host without it
    // installs exactly the channel the workspace pinned.
    expect(RustToolchain.toolchainInstall(declaration)).toEqual(["rustup", "toolchain", "install", "1.91"])
    // The workspace manifest is key material; there is no pin file to digest.
    expect(RustToolchain.toolchainInputs(declaration)).toEqual([{ _tag: "File", path: "//Cargo.toml" }])
  })

  it("declares the toolchain/lockfile form and digests both files", () => {
    const declaration = RustToolchain.Toolchain({
      toolchain: Input.file("//rust-toolchain.toml"),
      lockfile: Input.file("//Cargo.lock")
    })
    expect(declaration.channel).toBeUndefined()
    // A bare install reads the pin file, so the components and targets the pin
    // names come with it and nothing restates them.
    expect(RustToolchain.toolchainInstall(declaration)).toEqual(["rustup", "toolchain", "install"])
    expect(RustToolchain.toolchainInputs(declaration)).toEqual([
      { _tag: "File", path: "//rust-toolchain.toml" },
      { _tag: "File", path: "//Cargo.lock" }
    ])
  })

  it("keys an enclosing version authority without requiring its brand", () => {
    const versions = { _tag: "Mise", config: Input.file("//mise.toml") }
    const declaration = RustToolchain.Toolchain({ channel: "1.91", versions })
    expect(declaration.versions).toBe(versions)
    expect(RustToolchain.toolchainInputs(declaration)).toEqual([{ _tag: "File", path: "//mise.toml" }])
    expect(() => RustToolchain.Toolchain({ channel: "1.91", versions: {} as never })).toThrow()
  })

  it("refuses a declaration that names both pins, or neither", () => {
    expect(() => RustToolchain.Toolchain({ channel: "1.91", toolchain: Input.file("//rust-toolchain.toml") }))
      .toThrow(/exactly one of channel, toolchain/)
    expect(() => RustToolchain.Toolchain({ workspace: Input.file("//Cargo.toml") }))
      .toThrow(/exactly one of channel, toolchain/)
  })

  it("refuses text that would reach a child argv as something else", () => {
    for (const cargo of ["", "   ", "car\u0000go", "car\ngo", `cargo${"x".repeat(300)}`]) {
      expect(() => RustToolchain.Toolchain({ channel: "1.91", cargo })).toThrow()
    }
    expect(() => RustToolchain.Toolchain({ channel: "1.9\n1" })).toThrow()
    expect(RustToolchain.Toolchain({ channel: "1.91", cargo: "cargo-1.91" }).cargo).toBe("cargo-1.91")
  })

  it("refuses a pin that is not a declared file input", () => {
    expect(() => RustToolchain.Toolchain({ toolchain: "rust-toolchain.toml" as never }))
      .toThrow(/must be an S.file declaration/)
    expect(() => RustToolchain.Toolchain({ channel: "1.91", workspace: "Cargo.toml" as never }))
      .toThrow(/must be an S.file declaration/)
  })

  it("recognises its own declarations and not the BUILD-era pin", () => {
    expect(RustToolchain.isToolchainDeclaration(RustToolchain.Toolchain({ channel: "1.91" }))).toBe(true)
    expect(RustToolchain.isToolchainDeclaration(RustToolchain.Pinned({}))).toBe(false)
    expect(RustToolchain.isToolchainDeclaration(null)).toBe(false)
  })

  it("leaves the BUILD-era pin declaration exactly as it was", () => {
    expect(RustToolchain.Pinned({}))
      .toEqual({ name: "pinned", pin: "rust-toolchain.toml", rustup: "rustup", cargo: "cargo" })
    expect(RustToolchain.install(RustToolchain.Pinned({}))).toEqual(["rustup", "toolchain", "install"])
  })
})
