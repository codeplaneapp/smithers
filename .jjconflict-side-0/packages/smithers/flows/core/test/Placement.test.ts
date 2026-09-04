import { describe, expect, it } from "vitest"
import * as Placement from "../src/Placement.ts"

describe("Placement", () => {
  it("creates serializable tagged placement data", () => {
    const values = [
      Placement.local(),
      Placement.client(),
      Placement.sandbox({ image: "ubuntu-22", profile: "isolated" }),
      Placement.remote({ target: "control-plane" })
    ]

    expect(values).toEqual([
      { _tag: "flows/core/Placement/Local" },
      { _tag: "flows/core/Placement/Client" },
      { _tag: "flows/core/Placement/Sandbox", image: "ubuntu-22", profile: "isolated" },
      { _tag: "flows/core/Placement/Remote", target: "control-plane" }
    ])
    expect(JSON.parse(JSON.stringify(values))).toEqual(values)
  })

  it("does not export host layers", () => {
    expect(Object.keys(Placement).filter((key) => key.toLowerCase().startsWith("layer"))).toEqual([])
  })
})
