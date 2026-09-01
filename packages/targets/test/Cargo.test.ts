/**
 * The Rust toolchain declaration and the cargo gates built on it.
 *
 * The flags that make a check a gate rather than a fixer live in the target
 * implementation, so the assertions here are about argv: what `Cargo.Clippy()`
 * renders, and what a declaration that asks for less renders instead.
 */
import { describe, expect, it } from "vitest"
import * as Cargo from "../src/Cargo.ts"
import * as Input from "../src/Input.ts"
import * as RustToolchain from "../src/RustToolchain.ts"
import * as Target from "../src/Target.ts"

const toolchain = RustToolchain.Pinned({})
const srcs = [Input.glob("//crates/flows-jj/**/*.rs")]

const attrsOf = <A>(target: unknown): A => Target.metadata(target as never).attrs as A

describe("RustToolchain", () => {
  it("declares the pin file the install reads, not a separately resolved version", () => {
    expect(toolchain).toEqual({
      name: "pinned",
      pin: { _tag: "File", path: "rust-toolchain.toml" },
      rustup: "rustup",
      cargo: "cargo"
    })
    // A bare install reads the pin, so the components and targets the pin names
    // come with it and nothing restates them.
    expect(RustToolchain.install(toolchain)).toEqual(["rustup", "toolchain", "install"])
    expect(RustToolchain.cargo(toolchain, ["build"])).toEqual(["cargo", "build"])
    expect(RustToolchain.isRustToolchain(toolchain)).toBe(true)
    expect(RustToolchain.isRustToolchain({ name: "nightly" })).toBe(false)
  })

  it("refuses an executable name that would reach an argv as something else", () => {
    for (const rustup of ["", "   ", "rust\nup", "rust\u0000up", `rust${"x".repeat(300)}`]) {
      expect(() => RustToolchain.Pinned({ rustup })).toThrow()
    }
    expect(RustToolchain.Pinned({ cargo: "cargo-1.89" }).cargo).toBe("cargo-1.89")
  })
})

describe("CargoLint", () => {
  it("renders the formatter as a check, never as a fixer", () => {
    const attrs = attrsOf<Cargo.LintAttrs>(
      Cargo.CargoLint({ toolchain, check: Cargo.Fmt(), srcs, deps: [] })
    )
    expect(Cargo.checkArgv(attrs.toolchain, attrs.check)).toEqual(["cargo", "fmt", "--check"])
    // There is no option that would drop `--check`: a formatter that rewrites
    // the tree is not a gate.
    expect(Object.keys(Cargo.FmtCheck.fields)).toEqual(["name"])
  })

  it("renders clippy with warnings as errors, after the rustc separator", () => {
    const attrs = attrsOf<Cargo.LintAttrs>(
      Cargo.CargoLint({ toolchain, check: Cargo.Clippy(), srcs, deps: [] })
    )
    // `-D warnings` goes after `--`; passed before it, cargo reads it as one of
    // its own and rejects it.
    expect(Cargo.checkArgv(attrs.toolchain, attrs.check))
      .toEqual(["cargo", "clippy", "--all-targets", "--locked", "--", "-D", "warnings"])
  })

  it("drops each flag the declaration turns off", () => {
    const check = Cargo.Clippy({ allTargets: false, locked: false, denyWarnings: false })
    expect(Cargo.checkArgv(toolchain, check)).toEqual(["cargo", "clippy"])
  })

  it("participates in the lint verb alone", () => {
    expect(Cargo.CargoLint.kinds).toEqual(["lint"])
    // A `cargo test` gate is not a value this target's attrs can hold, so it
    // cannot be pulled into the lint verb by declaring it here.
    expect(() => Cargo.CargoLint({ toolchain, check: Cargo.Test() as never, srcs, deps: [] })).toThrow()
  })
})

describe("CargoTest", () => {
  it("renders the frozen test run and participates in the test verb alone", () => {
    const attrs = attrsOf<Cargo.TestAttrs>(
      Cargo.CargoTest({ toolchain, check: Cargo.Test(), srcs, deps: [] })
    )
    expect(Cargo.checkArgv(attrs.toolchain, attrs.check)).toEqual(["cargo", "test", "--locked"])
    expect(Cargo.checkArgv(toolchain, Cargo.Test({ locked: false }))).toEqual(["cargo", "test"])
    expect(Cargo.CargoTest.kinds).toEqual(["test"])
    expect(() => Cargo.CargoTest({ toolchain, check: Cargo.Fmt() as never, srcs, deps: [] })).toThrow()
  })

  it("keys on the crate sources and the pin, so a toolchain change re-runs it", () => {
    const metadata = Target.metadata(
      Cargo.CargoTest({
        toolchain,
        check: Cargo.Test(),
        srcs,
        deps: []
      }) as never
    )
    expect(metadata.inputs.map((input) => (input as { readonly path?: string; readonly pattern?: string })))
      .toEqual([{
        _tag: "File",
        path: "rust-toolchain.toml"
      }, { _tag: "Glob", pattern: "//crates/flows-jj/**/*.rs", exclude: [] }])
    expect(metadata.cacheable).toBe(false)
  })
})
