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
    // An envelope pattern whose own prefix carries a dot segment covers
    // nothing, not even the identical entry.
    expect(Effects.narrow(declaration({ writes: ["../**", "repo/**"] }), declaration({ writes: ["../**", "repo/a"] })))
      .toEqual({ ok: false, code: "effect_outside_envelope", paths: ["../**"] })
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

  it("bounds a pattern whose prefix ends in the highest code unit", () => {
    // No string follows every string under a prefix ending in U+FFFF, so the
    // block it covers runs to the end of the sorted paths or, when a lower
    // code unit precedes the run, to that code unit's successor.
    const writes = ["a\uffff\uffff", "a\uffffb", "b", "\uffff", "\uffffx"]

    expect(Effects.overlaps(declaration({ writes: ["a\uffff*"] }), declaration({ writes })))
      .toEqual(["a\uffff\uffff", "a\uffffb"].sort())
    expect(Effects.overlaps(declaration({ writes: ["\uffff*"] }), declaration({ writes })))
      .toEqual(["\uffff", "\uffffx"])
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

  it("overlaps two wide literal writers in time linear in their size", () => {
    const shared = Array.from({ length: 20_001 }, (_, index) => `out/${index}`)
    const left = declaration({ writes: [...shared, "left"] })
    const right = declaration({ writes: [...shared, "right"] })

    const started = performance.now()
    const matches = Effects.overlaps(left, right)
    const elapsed = performance.now() - started

    expect(matches).toEqual([...shared].sort())
    expect(elapsed).toBeLessThan(1_000)
  })

  it("narrows a wide literal envelope in time linear in its size", () => {
    const inside = Array.from({ length: 20_000 }, (_, index) => `src/${index}`)
    const envelope = declaration({ reads: inside, writes: inside })
    const step = declaration({ reads: [...inside, "outside/read"], writes: ["outside/write", ...inside] })

    const started = performance.now()
    const result = Effects.narrow(envelope, step)
    const elapsed = performance.now() - started

    expect(result).toEqual({ ok: false, code: "effect_outside_envelope", paths: ["outside/read", "outside/write"] })
    expect(elapsed).toBeLessThan(1_000)
  })

  it("examines each path a bounded number of times however many patterns of the other side cover it", () => {
    // Every per-character operation the matcher can apply to a path goes
    // through one of these methods; sorting and set lookups are native and
    // cost each path at most one comparison per binary-search step. Counting
    // calls per receiver shows each path is scanned a constant number of
    // times, not once per pattern that covers it.
    const methods = ["indexOf", "lastIndexOf", "charCodeAt", "startsWith", "endsWith", "slice"] as const
    const counted = <A>(body: () => A): { readonly result: A; readonly calls: ReadonlyMap<string, number> } => {
      const calls = new Map<string, number>()
      const originals = methods.map((name) => [name, String.prototype[name]] as const)
      for (const [name, original] of originals) {
        Object.defineProperty(String.prototype, name, {
          configurable: true,
          writable: true,
          value: function(this: string, ...args: Array<unknown>) {
            calls.set(this, (calls.get(this) ?? 0) + 1)
            return (original as (this: string, ...args: Array<unknown>) => unknown).apply(this, args)
          }
        })
      }
      try {
        return { result: body(), calls }
      } finally {
        for (const [name, original] of originals) {
          Object.defineProperty(String.prototype, name, { configurable: true, writable: true, value: original })
        }
      }
    }
    const nested = (count: number): Array<string> =>
      Array.from({ length: count }, (_, index) => `x${"0".repeat(index)}*`)
    const most = (calls: ReadonlyMap<string, number>, paths: ReadonlyArray<string>): number =>
      Math.max(...paths.map((path) => calls.get(path) ?? 0))
    const bound = 8

    for (const count of [32, 512]) {
      const globs = nested(count)
      const outside = Array.from({ length: count }, (_, index) => `y/${index}`)
      const patterned = declaration({ reads: globs, writes: globs })
      const escaping = declaration({ reads: outside, writes: outside })

      const overlapping = counted(() => Effects.overlaps(patterned, patterned))
      expect(overlapping.result).toEqual([...globs].sort())
      expect(most(overlapping.calls, globs)).toBeLessThanOrEqual(bound)

      const narrowing = counted(() => Effects.narrow(patterned, escaping))
      expect(narrowing.result).toEqual({ ok: false, code: "effect_outside_envelope", paths: [...outside].sort() })
      expect(most(narrowing.calls, globs)).toBeLessThanOrEqual(bound)
      expect(most(narrowing.calls, outside)).toBeLessThanOrEqual(bound)
    }
  })

  it("matches globs of a caller-assembled declaration exactly as covers does", () => {
    // Hand-built declarations are unsorted and may repeat paths. The indexed
    // search must report what the pairwise definition reports: the covered
    // path when one side covers the other, the shared path when equal.
    const assembled = (writes: ReadonlyArray<string>): Effects.Declaration => ({
      reads: [],
      writes,
      mode: "expected",
      onConflict: "serialize"
    })
    const pairwise = (a: Effects.Declaration, b: Effects.Declaration): ReadonlyArray<string> => {
      const matches: Array<string> = []
      for (const left of a.writes) {
        for (const right of b.writes) {
          if (left === right || Effects.covers(left, right)) {
            matches.push(right)
          } else if (Effects.covers(right, left)) {
            matches.push(left)
          }
        }
      }
      return [...new Set(matches)].sort()
    }
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, ReadonlyArray<string>, ReadonlyArray<string>]> = [
      [["b/**", "a", "../**", "a/**"], ["a/b", "../x", "b", "a", "b/c/**", "../**"], ["../**", "a", "a/b", "b/c/**"]],
      [["ab**", "ab*"], ["abc", "ab*", "ab**"], ["ab*", "ab**", "abc"]],
      [["*"], ["x", "./y", "*"], ["*", "x"]],
      [["src/**", "src/**"], ["src", "src/", "srcX"], ["src/"]],
      [["x*", "x/**"], ["x/**", "x*"], ["x*", "x/**"]],
      [["a/**"], ["b", "a0", "a/z", "a", "a/b", "a/"], ["a/", "a/b", "a/z"]],
      [["a/", "a/b"], ["a/**", "a/", "a/b", "a"], ["a/", "a/b"]]
    ]

    for (const [left, right, expected] of cases) {
      expect(Effects.overlaps(assembled(left), assembled(right))).toEqual(expected)
      expect(Effects.overlaps(assembled(left), assembled(right))).toEqual(pairwise(assembled(left), assembled(right)))
      expect(Effects.overlaps(assembled(right), assembled(left))).toEqual(pairwise(assembled(right), assembled(left)))
    }
  })
})
