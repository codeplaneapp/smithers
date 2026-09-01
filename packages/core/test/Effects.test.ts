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

  it("covers the exhaustive exact and prefix-glob grammar", () => {
    expect(Effects.covers("**", "anything")).toBe(true)
    expect(Effects.covers("*", "anything")).toBe(true)
    expect(Effects.covers("src/**", "src")).toBe(false)
    expect(Effects.covers("src/**", "srcX/a")).toBe(false)
    expect(Effects.covers("src/**", "src/a")).toBe(true)
    expect(Effects.covers("src*", "srcX/a")).toBe(true)
    expect(Effects.covers("src/a", "src/a")).toBe(true)
    expect(Effects.covers("src/a", "src/b")).toBe(false)
  })

  it("treats paths with whole dot segments as outside every envelope", () => {
    const escaped = "repo/../../etc/passwd"
    const envelope = declaration({ writes: ["repo/**"] })
    const step = declaration({ writes: [escaped] })

    expect(Effects.covers("repo/**", escaped)).toBe(false)
    expect(Effects.covers("**", "repo/./file")).toBe(false)
    expect(Effects.covers("repo/**", "repo/plain/file")).toBe(true)
    expect(Effects.covers("repo/**", "repo/a..b/c")).toBe(true)
    expect(Effects.narrow(envelope, step)).toEqual({
      ok: false,
      code: "effect_outside_envelope",
      paths: [escaped]
    })
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

  it("finds an overlap between a universal writer and a concrete writer", () => {
    const universal = declaration({ writes: ["**"] })
    const concrete = declaration({ writes: ["out/result.json"] })

    expect(Effects.overlaps(universal, concrete)).toEqual(["out/result.json"])
  })

  it("overlaps two writers of the same unnormalized path that no glob covers", () => {
    const escaped = declaration({ writes: ["repo/../secret"] })
    const globbed = declaration({ writes: ["repo/**"] })

    // Glob coverage stays strict, so the path still escapes no envelope.
    expect(Effects.covers("repo/**", "repo/../secret")).toBe(false)
    expect(Effects.overlaps(escaped, globbed)).toEqual([])
    // Two writers naming the same resource still collide.
    expect(Effects.overlaps(escaped, escaped)).toEqual(["repo/../secret"])
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
