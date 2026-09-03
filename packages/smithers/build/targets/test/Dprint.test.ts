import { describe, expect, it } from "vitest"
import { Dprint } from "../src/Dprint.ts"
import * as Input from "../src/Input.ts"
import { StandardPackage } from "../src/StandardPackage.ts"
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

  it("joins StandardPackage as the fmt target alongside check", () => {
    const targets = StandardPackage({ packageManager, cwd: "packages/example" })
    expect(Target.metadata(targets.fmt).target).toBe("Dprint")
    expect(Target.metadata(targets.fmt).kinds).toEqual(["lint"])
    expect(Target.metadata(targets.check).target).toBe("Typecheck")
    expect(Target.metadata(targets.check).kinds).toEqual(["build"])
    // check resolves workspace dependencies through built declarations, so
    // it must schedule after the package's own lib target.
    expect(Target.metadata(targets.check).dependencies).toContain(targets.lib)
  })
})
