import { CapabilityPattern } from "@smthrs/capability/Capability"
import { describe, expect, it } from "vitest"
import * as CapabilitySets from "../src/CapabilitySet.ts"

/**
 * `equals` is the structural comparison used to decide whether two authorities
 * are the same set. It must separate authorities that differ in group count and
 * authorities with the same shape but different patterns; otherwise a narrowed
 * ceiling could be mistaken for its parent.
 */

const pattern = (action: CapabilityPattern["action"], resource: string) => new CapabilityPattern({ action, resource })

const reads = pattern("fs:read", "/workspace/**")
const writes = pattern("fs:write", "/workspace/**")
const otherReads = pattern("fs:read", "/other/**")

describe("CapabilitySet.equals", () => {
  it("separates authorities with a different number of groups", () => {
    const one = CapabilitySets.fromPatterns([reads])
    const two = CapabilitySets.intersect(one, CapabilitySets.fromPatterns([writes]))
    expect(one.groups).toHaveLength(1)
    expect(two.groups).toHaveLength(2)
    expect(CapabilitySets.equals(one, two)).toBe(false)
    expect(CapabilitySets.equals(two, one)).toBe(false)
  })

  it("separates same-shaped authorities whose patterns differ", () => {
    expect(
      CapabilitySets.equals(
        CapabilitySets.fromPatterns([reads]),
        CapabilitySets.fromPatterns([otherReads])
      )
    ).toBe(false)
    expect(
      CapabilitySets.equals(
        CapabilitySets.fromPatterns([reads, writes]),
        CapabilitySets.fromPatterns([reads, otherReads])
      )
    ).toBe(false)
  })

  it("separates a group that is a strict prefix of another", () => {
    expect(
      CapabilitySets.equals(
        CapabilitySets.fromPatterns([reads]),
        CapabilitySets.fromPatterns([reads, writes])
      )
    ).toBe(false)
  })

  it("holds for normalized duplicates and reordered patterns", () => {
    expect(
      CapabilitySets.equals(
        CapabilitySets.fromPatterns([writes, reads, reads]),
        CapabilitySets.fromPatterns([reads, writes])
      )
    ).toBe(true)
    expect(CapabilitySets.equals(CapabilitySets.none, CapabilitySets.none)).toBe(true)
  })

  it("separates empty authority from denying authority", () => {
    const unrestricted = CapabilitySets.intersect(
      CapabilitySets.fromPatterns([pattern("*", "**")]),
      CapabilitySets.fromPatterns([pattern("*", "**")])
    )
    expect(CapabilitySets.equals(unrestricted, CapabilitySets.none)).toBe(false)
  })
})
