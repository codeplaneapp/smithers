import { describe, expect, test } from "bun:test"
import { framePath, parseFramePath } from "./FrameHistory"

describe("frame URLs", () => {
  test("round-trip opaque workspace, branch, and frame ids", () => {
    const location = {
      workspaceId: "workspace/acme",
      branchId: "branch:main",
      frameId: "frame-card:branch:card/1"
    }
    const path = framePath(location)
    expect(path).toBe("/w/workspace%2Facme/b/branch%3Amain/f/frame-card%3Abranch%3Acard%2F1")
    expect(parseFramePath(path)).toEqual(location)
  })

  test("rejects unrelated, incomplete, and malformed paths", () => {
    expect(parseFramePath("/")).toBeUndefined()
    expect(parseFramePath("/w/a/b/b")).toBeUndefined()
    expect(parseFramePath("/w/%E0%A4%A/b/b/f/f")).toBeUndefined()
  })
})
