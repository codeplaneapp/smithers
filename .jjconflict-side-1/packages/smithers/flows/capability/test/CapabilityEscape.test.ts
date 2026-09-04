import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"

const write = (resource: string): Capability.Capability => Capability.make("fs:write", resource)

describe("Capability.tierOf lexical escape boundaries", () => {
  /**
   * Known limit: lexical classification cannot see symlinks; callers that
   * materialize snapshots must resolve links first.
   */
  it("classifies a lexically-inside symlink escape as compensable without filesystem access", () => {
    const resourceWhoseFirstSegmentIsReallyASymlink = "linked-outside/secret.txt"

    expect(Capability.tierOf(write(resourceWhoseFirstSegmentIsReallyASymlink), { workspaceRoot: "/workspace" }))
      .toBe("compensable")
  })

  it("classifies parent traversal that escapes the workspace as irreversible", () => {
    expect(Capability.tierOf(write("a/../../outside"), { workspaceRoot: "/workspace" })).toBe("irreversible")
  })

  it("keeps POSIX backslashes literal when classifying workspace writes", () => {
    expect(Capability.tierOf(write("/workspace\\evil"), { workspaceRoot: "/workspace" }))
      .toBe("irreversible")
    expect(
      Capability.tierOf(write("/tmp/evil\\..\\..\\workspace\\x"), { workspaceRoot: "/workspace" })
    ).toBe("irreversible")
  })
})
