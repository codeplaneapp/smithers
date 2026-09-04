import { expect, it } from "@effect/vitest"
import { HostServiceIds } from "@smthrs/kernel/HostServices"
import * as NodeHost from "../src/NodeHost.ts"

it("identifies every host implementation", () => {
  expect(Object.keys(NodeHost.implementationIds).sort()).toEqual([...HostServiceIds].sort())
})
it("refuses invalid roots with the NodeHost error before composition", () => {
  for (const factory of [NodeHost.layerAt, NodeHost.layerContainedAt]) {
    for (const root of ["", "relative", "x".repeat(1000)]) {
      expect(() => factory(root)).toThrow(NodeHost.NodeHostError)
      try {
        factory(root)
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_repository_root" })
        expect((error as Error).message.length).toBeLessThan(200)
      }
    }
    expect(factory("/repo")).toBeDefined()
  }
})
