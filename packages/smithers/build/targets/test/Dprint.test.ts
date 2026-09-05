import { describe, expect, it } from "vitest"
import { Dprint } from "../src/Dprint.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { packageManager } from "./toolchain.ts"

describe("Dprint", () => {
  it("declares a lint-kind, non-cacheable formatting check", () => {
    const target = Dprint({
      packageManager,
      sources: [Input.glob("src/**/*.ts")],
      deps: [],
      config: Input.file("dprint.json"),
      fix: false,
      cwd: "packages/example"
    })
    const metadata = Target.metadata(target)
    expect(metadata.target).toBe("Dprint")
    expect(metadata.kinds).toEqual(["lint"])
    expect(metadata.cacheable).toBe(false)
    expect(metadata.inputs).toHaveLength(2)
  })

})
