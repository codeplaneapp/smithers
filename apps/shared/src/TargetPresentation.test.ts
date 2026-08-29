import { describe, expect, test } from "bun:test"
import type { Target } from "./LocalApp"
import { defaultTargetsMessage, groupTargets, groupTargetsByWorkspace } from "./TargetPresentation"

const targets: ReadonlyArray<Target> = [
  { id: "one", label: "//src:lint", target: "Shell.Test", kinds: ["lint"], package: "//src", name: "lint", workspace: "." },
  { id: "two", label: "//:test", target: "Shell.Test", kinds: ["test"], package: "//", name: "test", workspace: "sdk" },
  { id: "three", label: "//src:typecheck", target: "Shell.Test", kinds: ["typecheck"], package: "//src", name: "typecheck", workspace: "." }
]

describe("trusted target presentation data", () => {
  test("groups targets without changing package or target order", () => {
    expect(groupTargets(targets)).toEqual([
      { package: "//src", targets: [targets[0], targets[2]] },
      { package: "//", targets: [targets[1]] }
    ])
  })

  test("builds the deterministic transcript message", () => {
    expect(defaultTargetsMessage(1, "force")).toBe("Loaded 1 target for force.")
    expect(defaultTargetsMessage(82, "force")).toBe("Loaded 82 targets for force.")
  })

  test("groups workspaces and packages without changing target order", () => {
    expect(groupTargetsByWorkspace(targets)).toEqual([
      { workspace: ".", packages: [{ package: "//src", targets: [targets[0], targets[2]] }] },
      { workspace: "sdk", packages: [{ package: "//", targets: [targets[1]] }] }
    ])
  })
})
