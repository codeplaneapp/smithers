import * as Placement from "@smthrs/core/Placement"
import { describe, expect, it } from "vitest"
import * as Directive from "../src/Directive.ts"

describe("Directive", () => {
  it("compiles every registry placement literal", () => {
    expect(Directive.compile("client")).toEqual(Placement.client())
    expect(Directive.compile("local")).toEqual(Placement.local())
    expect(Directive.compile("sandbox")).toEqual(Placement.sandbox())
    expect(Directive.compile("remote")).toEqual(Placement.remote())
  })

  it("returns serializable placement annotation data", () => {
    const placements = [
      Directive.compile("client"),
      Directive.compile("local"),
      Directive.compile("sandbox"),
      Directive.compile("remote")
    ]

    expect(JSON.parse(JSON.stringify(placements))).toEqual(placements)
  })
})
