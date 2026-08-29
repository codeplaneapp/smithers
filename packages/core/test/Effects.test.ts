import { describe, expect, it } from "vitest"
import * as Effects from "../src/Effects.ts"

const declaration = (input: Partial<Effects.MakeOptions> = {}): Effects.Declaration =>
  Effects.make({
    reads: input.reads ?? [],
    writes: input.writes ?? [],
    mode: input.mode ?? "expected",
    onConflict: input.onConflict ?? "serialize",
    ...(input.tier === undefined ? {} : { tier: input.tier })
  })

describe("Effects", () => {
  it("normalizes iterable paths deterministically", () => {
    const first = declaration({
      reads: new Set(["src/b.ts", "src/a.ts", "src/a.ts"]),
      writes: ["out/b.ts", "out/a.ts", "out/a.ts"]
    })
    const second = declaration({
      reads: ["src/a.ts", "src/b.ts"],
      writes: new Set(["out/a.ts", "out/b.ts"])
    })

    expect(first).toEqual(second)
    expect(first.reads).toEqual(["src/a.ts", "src/b.ts"])
    expect(first.writes).toEqual(["out/a.ts", "out/b.ts"])
  })

  it("accepts steps that narrow an envelope", () => {
    const envelope = declaration({ reads: ["src/**"], writes: ["out/**"], mode: "expected" })
    const step = declaration({ reads: ["src/index.ts"], writes: ["out/result.json"], mode: "hermetic" })

    expect(Effects.narrow(envelope, step)).toEqual({ ok: true })
  })

  it("reports paths outside the envelope", () => {
    const envelope = declaration({ reads: ["src/**"], writes: ["out/*"] })
    const step = declaration({ reads: ["secret.txt"], writes: ["dist/index.js"] })

    expect(Effects.narrow(envelope, step)).toEqual({
      ok: false,
      code: "effect_outside_envelope",
      paths: ["dist/index.js", "secret.txt"]
    })
  })

  it("reports a hermetic-to-expected mode widening", () => {
    const envelope = declaration({ reads: ["src/**"], writes: [], mode: "hermetic" })
    const step = declaration({ reads: ["src/index.ts"], writes: [], mode: "expected" })

    expect(Effects.narrow(envelope, step)).toEqual({
      ok: false,
      code: "effect_mode_widening",
      paths: []
    })
  })

  it("rejects a more irreversible child tier", () => {
    const envelope = declaration({ writes: ["out/**"], tier: "sealed" })
    const step = declaration({ writes: ["out/result"], tier: "irreversible" })

    expect(Effects.narrow(envelope, step)).toEqual({
      ok: false,
      code: "effect_tier_widening",
      paths: []
    })
  })

  it("finds concrete and globbed overlapping writes", () => {
    const first = declaration({ writes: ["src/a.ts", "docs/**"] })
    const second = declaration({ writes: ["src/**", "docs/readme.md", "out/result.json"] })

    expect(Effects.overlaps(first, second)).toEqual(["docs/readme.md", "src/a.ts"])
  })

  it("seals a declaration without changing the original", () => {
    const original = declaration({
      reads: ["src/**"],
      writes: ["out/**"],
      mode: "expected",
      tier: "compensable"
    })
    const sealed = Effects.sealed(original)

    expect(sealed).toEqual({
      reads: ["src/**"],
      writes: ["out/**"],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    })
    expect(original.mode).toBe("expected")
    expect(original.tier).toBe("compensable")
  })
})
