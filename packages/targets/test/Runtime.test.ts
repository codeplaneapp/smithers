import { describe, expect, it } from "vitest"
import * as Runtime from "../src/Runtime.ts"

describe("Runtime declarations", () => {
  it("hardcodes the name of each variant", () => {
    expect(Runtime.Node({ version: ">=22.19.0" })).toEqual({
      name: "node",
      version: ">=22.19.0",
      executable: "node"
    })
    expect(Runtime.Bun({ version: ">=1.3.0" })).toEqual({
      name: "bun",
      version: ">=1.3.0",
      executable: "bun"
    })
  })

  it("discriminates the union on `name`", () => {
    const declarations: ReadonlyArray<Runtime.Runtime> = [
      Runtime.Node({ version: ">=22.19.0" }),
      Runtime.Bun({ version: ">=1.3.0" })
    ]
    const versions = declarations.map((runtime) => {
      // The narrowing is the assertion: each branch sees only its own
      // variant's version enumeration, so a Bun requirement in the Node branch
      // would not typecheck.
      switch (runtime.name) {
        case "node": {
          const version: Runtime.NodeVersion = runtime.version
          return version
        }
        case "bun": {
          const version: Runtime.BunVersion = runtime.version
          return version
        }
      }
    })
    expect(versions).toEqual([">=22.19.0", ">=1.3.0"])
  })

  it("routes versions outside the BUILD.ts enumeration to the WORKSPACE.ts declaration", () => {
    // The reviewed enumeration still selects the classic NodeRuntime; any
    // other version string is the WORKSPACE.ts form and returns the inert
    // NodeDeclaration instead of a runtime the BUILD-era service could
    // measure. Bun keeps the enumeration-only contract.
    const pinned = Runtime.Node({ version: "24.9.0" })
    expect(Runtime.isNodeDeclaration(pinned)).toBe(true)
    expect(Runtime.isRuntime(pinned)).toBe(false)
    // @ts-expect-error a Node requirement is not a supported Bun requirement.
    expect(() => Runtime.Bun({ version: ">=22.19.0" })).toThrow()
  })

  it("honours an executable override and rejects unusable ones", () => {
    expect(Runtime.Node({ version: ">=22.19.0", executable: "/opt/node/bin/node" }).executable).toBe(
      "/opt/node/bin/node"
    )
    expect(() => Runtime.Node({ version: ">=22.19.0", executable: "  " })).toThrow(/must not be empty/)
    expect(() => Runtime.Node({ version: ">=22.19.0", executable: "node\u0000" }))
      .toThrow(/without control characters/)
    expect(() => Runtime.Node({ version: ">=22.19.0", executable: "a".repeat(257) })).toThrow(
      /bounded well-formed text/
    )
  })

  it("recognises only the declared variants", () => {
    expect(Runtime.isRuntime(Runtime.Node({ version: ">=22.19.0" }))).toBe(true)
    expect(Runtime.isRuntime(Runtime.Bun({ version: ">=1.3.0" }))).toBe(true)
    expect(Runtime.isRuntime({ name: "deno", version: "2.1.4", executable: "deno" })).toBe(false)
    expect(Runtime.isRuntime({ name: "node", version: "24.9.0", executable: "node" })).toBe(false)
    expect(Runtime.isRuntime({ name: "bun", version: ">=22.19.0", executable: "bun" })).toBe(false)
    expect(Runtime.isRuntime({ name: "node", version: ">=22.19.0", executable: "" })).toBe(false)
    expect(Runtime.isRuntime({ name: "node" })).toBe(false)
    expect(Runtime.isRuntime(null)).toBe(false)
    expect(Runtime.isRuntime("node")).toBe(false)
  })

  it("builds argv for a script and for an inline program", () => {
    const runtime = Runtime.Node({ version: ">=22.19.0" })
    expect(Runtime.run(runtime, ["build.mjs", "--check"])).toEqual(["node", "build.mjs", "--check"])
    expect(Runtime.evaluate(runtime, "console.log(1)", ["x"])).toEqual([
      "node",
      "-e",
      "console.log(1)",
      "x"
    ])
    expect(Runtime.evaluate(Runtime.Bun({ version: ">=1.3.0" }), "console.log(1)")).toEqual([
      "bun",
      "-e",
      "console.log(1)"
    ])
  })
})
