import { describe, expect, it } from "vitest"
import * as Filegroup from "../src/Filegroup.ts"
import { StandardPackage } from "../src/StandardPackage.ts"
import * as Target from "../src/Target.ts"
import { packageManager } from "./toolchain.ts"

describe("StandardPackage docsFiles", () => {
  const targets = StandardPackage({ packageManager, deps: [], cwd: "packages/smithers/flows/plan" })

  it("emits a Filegroup over the package's documentation beside the verb targets", () => {
    const metadata = Target.metadata(targets.docsFiles)
    expect(metadata.target).toBe("Filegroup")
    expect(metadata.kinds).toEqual([])
    expect(Filegroup.isFilegroup(targets.docsFiles)).toBe(true)
  })

  it("names the colocated docs, the README, and the manifest under the package cwd", () => {
    expect(Filegroup.sources(Target.metadata(targets.docsFiles).attrs as Filegroup.Attrs)).toEqual([
      { _tag: "Glob", pattern: "packages/smithers/flows/plan/docs/**/*.md", exclude: [] },
      { _tag: "File", path: "packages/smithers/flows/plan/README.md" },
      { _tag: "File", path: "packages/smithers/flows/plan/package.json" }
    ])
  })

  it("follows a readme override", () => {
    const overridden = StandardPackage({
      packageManager,
      deps: [],
      cwd: "packages/x",
      readme: { _tag: "File", path: "docs/README.md" }
    })
    expect(Filegroup.sources(Target.metadata(overridden.docsFiles).attrs as Filegroup.Attrs)).toContainEqual(
      { _tag: "File", path: "packages/x/docs/README.md" }
    )
  })
})
