/** Barrel parity with the platform-browser and platform-bun packages. */
import { describe, expect, it } from "@effect/vitest"
import * as Index from "../src/index.ts"
import * as NodeHost from "../src/NodeHost.ts"

describe("@smthrs/platform-node barrel", () => {
  it("re-exports every module as a namespace", () => {
    expect(Object.keys(Index).sort()).toEqual(["HostLiveness", "NodeHost", "ProcessReaper"])
    expect(Index.NodeHost.layer).toBe(NodeHost.layer)
    expect(Index.NodeHost.layerAt).toBe(NodeHost.layerAt)
    expect(Index.NodeHost.layerContained).toBe(NodeHost.layerContained)
    expect(Index.NodeHost.layerContainedAt).toBe(NodeHost.layerContainedAt)
  })
})
