import { describe, expect, it } from "vitest"
import * as Cargo from "../src/Cargo.ts"
import * as Target from "../src/Target.ts"

describe("Cargo.manifestFacts prototype safety", () => {
  it("refuses __proto__ as a metadata table segment without polluting Object.prototype", () => {
    expect(() =>
      Cargo.manifestFacts("[package]\nname = \"a\"\n[package.metadata.__proto__]\nsmithersPolluted = true\n")
    ).toThrow(/reserved/)
    expect(({} as Record<string, unknown>)["smithersPolluted"]).toBeUndefined()
  })

  it("refuses constructor and prototype as table segments", () => {
    for (const segment of ["constructor", "prototype"]) {
      expect(() => Cargo.manifestFacts(`[package.metadata.${segment}]\nx = 1\n`)).toThrow(/reserved/)
    }
  })

  it("refuses a reserved bare key inside a metadata table", () => {
    expect(() => Cargo.manifestFacts("[package.metadata.smithers]\n__proto__ = 1\n")).toThrow(/reserved/)
    expect(({} as Record<string, unknown>)["__proto__"]).toBe(Object.prototype)
  })

  it("returns a null-prototype metadata table", () => {
    const facts = Cargo.manifestFacts("[package]\nname = \"a\"\n[package.metadata.smithers]\ngroup = \"tooling\"\n")
    expect(facts.name).toBe("a")
    expect(Object.getPrototypeOf(facts.metadata)).toBeNull()
    expect(Object.getPrototypeOf(facts.metadata["smithers"] as object)).toBeNull()
    expect((facts.metadata["smithers"] as Record<string, unknown>)["group"]).toBe("tooling")
  })
})

describe("Cargo.metadataMatches own-property discipline", () => {
  it("does not match an inherited property", () => {
    const filter = { toString: "anything" }
    expect(Cargo.metadataMatches({}, filter)).toBe(false)
  })

  it("refuses a structure nested deeper than the bound", () => {
    let filter: Record<string, unknown> = { leaf: 1 }
    for (let depth = 0; depth < 40; depth += 1) filter = { nested: filter }
    expect(() => Cargo.metadataMatches(filter, filter)).toThrow(/too deep/)
  })

  it("refuses a manifest whose metadata table nests deeper than the bound", () => {
    const header = ["package", "metadata", ...Array.from({ length: 40 }, (_, index) => `t${index}`)].join(".")
    expect(() => Cargo.manifestFacts(`[${header}]\nx = 1\n`)).toThrow(/too deep/)
  })

  it("matches a subset of own properties", () => {
    expect(Cargo.metadataMatches({ a: 1, b: { c: 2 } }, { b: { c: 2 } })).toBe(true)
    expect(Cargo.metadataMatches({ a: 1 }, { a: 2 })).toBe(false)
  })
})

describe("Cargo overload discrimination", () => {
  it("refuses a package-only Clippy key with no crate selector", () => {
    expect(() => Cargo.Clippy({ offline: true } as never)).toThrow(
      /Cargo\.Clippy requires exactly one of workspace, package, crates/
    )
  })

  it("refuses a package-only Test key with no crate selector", () => {
    expect(() => Cargo.Test({ noRun: true } as never)).toThrow(
      /Cargo\.Test requires exactly one of workspace, package, crates/
    )
  })

  it("still builds the BUILD-era check value from its own options", () => {
    expect(Cargo.Clippy({ locked: false })).toEqual({
      name: "clippy",
      allTargets: true,
      locked: false,
      denyWarnings: true
    })
    expect(Cargo.Test({ locked: false })).toEqual({ name: "test", locked: false })
    expect(Cargo.Clippy()).toEqual({ name: "clippy", allTargets: true, locked: true, denyWarnings: true })
  })

  it("still builds the package-mode target when a selector is named", () => {
    expect(Target.isTarget(Cargo.Clippy({ workspace: true, offline: true, data: [] }) as never)).toBe(true)
    expect(Target.isTarget(Cargo.Test({ package: "aomi-sdk", noRun: true, data: [] }) as never)).toBe(true)
  })
})
