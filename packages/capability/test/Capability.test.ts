import { Option, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"

const capability = (action: Capability.Action, resource: string): Capability.Capability =>
  Capability.make(action, resource)

const pattern = (action: Capability.PatternAction, resource: string): Capability.CapabilityPattern =>
  new Capability.CapabilityPattern({ action, resource })

const capabilityModuleUrl = new URL("../src/Capability.ts", import.meta.url).href

const repeatedStarProgram = `
  import { CapabilityPattern, make, matches } from ${JSON.stringify(capabilityModuleUrl)}
  const pattern = new CapabilityPattern({ action: "fs:read", resource: "a*a*a*a*a*b" })
  const capability = make("fs:read", "a".repeat(10_000))
  process.stdout.write(String(matches(pattern, capability)))
`

describe("Capability", () => {
  it("formats and parses resources containing colons", () => {
    const value = capability("net:get", "example.test:8443/api:v1")
    expect(Capability.format(value)).toBe("net:get:example.test:8443/api:v1")
    expect(Option.getOrNull(Capability.parse(Capability.format(value)))).toEqual(value)
    expect(Option.isNone(Capability.parse("unknown:action:resource"))).toBe(true)
    expect(Option.isNone(Capability.parse("fs:read"))).toBe(true)
  })

  it("round trips formatted capabilities", () => {
    const action = FastCheck.constantFrom<Capability.Action>(
      "fs:read",
      "fs:write",
      "net:get",
      "net:post",
      "model:call",
      "proc:spawn",
      "jj:status",
      "jj:diff",
      "jj:snapshot",
      "jj:restore",
      "jj:workspace-add",
      "jj:workspace-forget",
      "jj:root",
      "jj:revert"
    )
    FastCheck.assert(
      FastCheck.property(action, FastCheck.string(), (selectedAction, resource) => {
        const value = capability(selectedAction, resource)
        expect(Option.getOrNull(Capability.parse(Capability.format(value)))).toEqual(value)
      })
    )
  })

  it.each([
    [pattern("fs:read", "src/*.ts"), capability("fs:read", "src/Capability.ts"), true],
    [pattern("fs:read", "src/*.ts"), capability("fs:read", "src/nested/Capability.ts"), true],
    [pattern("fs:read", "src/?.ts"), capability("fs:read", "src/a.ts"), true],
    [pattern("fs:read", "src/?.ts"), capability("fs:read", "src/ab.ts"), false],
    [pattern("fs:read", "src/**/Capability.ts"), capability("fs:read", "src/nested/Capability.ts"), true],
    [pattern("fs:*", "C:/work/**"), capability("fs:write", "C:\\work\\nested\\a.ts"), true],
    [pattern("jj:*", "repository"), capability("jj:diff", "repository"), true],
    [pattern("model:*", "api.example.test/**"), capability("model:call", "api.example.test/large"), true],
    [pattern("*", "**"), capability("proc:spawn", "git status"), true],
    [pattern("proc:spawn", "npm *"), capability("proc:spawn", "npm"), true],
    [pattern("fs:read", "c:/work/**"), capability("fs:read", "C:\\WORK\\nested\\a.ts"), true],
    [pattern("net:*", "example.test"), capability("net:post", "other.test"), false]
  ])("matches %o against %o", (selectedPattern, selectedCapability, expected) => {
    expect(Capability.matches(selectedPattern, selectedCapability)).toBe(expected)
  })

  // Regression pin for the repeated-star ReDoS: the matcher is an iterative
  // glob walk, so this non-match completes instead of backtracking
  // exponentially. The subprocess keeps a regression from hanging the suite.
  it("completes a 10k-character non-match for a repeated-star grant pattern", () => {
    const matchProcess = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", repeatedStarProgram],
      { encoding: "utf8", timeout: 30_000 }
    )

    expect(matchProcess.error).toBeUndefined()
    expect(matchProcess.status).toBe(0)
    expect(matchProcess.stdout).toBe("false")
  })

  it.each([".", "+", "(", ")", "[", "]", "^", "$", "|", "{", "}"] as const)(
    "treats %s as a literal resource-pattern character",
    (metacharacter) => {
      const selectedPattern = pattern("fs:read", `prefix${metacharacter}suffix`)

      expect(Capability.matches(selectedPattern, capability("fs:read", `prefix${metacharacter}suffix`))).toBe(true)
      expect(Capability.matches(selectedPattern, capability("fs:read", "prefixxsuffix"))).toBe(false)
    }
  )

  it("makes the trailing command argument wildcard optional without matching a prefix", () => {
    const selectedPattern = pattern("proc:spawn", "npm *")

    expect(Capability.matches(selectedPattern, capability("proc:spawn", "npm"))).toBe(true)
    expect(Capability.matches(selectedPattern, capability("proc:spawn", "npm install pkg"))).toBe(true)
    expect(Capability.matches(selectedPattern, capability("proc:spawn", "npmx"))).toBe(false)
  })

  it("keeps POSIX resource matching case-sensitive", () => {
    expect(
      Capability.matches(pattern("fs:read", "/Work/**"), capability("fs:read", "/work/a"))
    ).toBe(false)
  })

  it("folds Windows-path case exactly like the regex i-flag canonicalization", () => {
    // `é` uppercases within one unit, so the fold applies; `ß` uppercases to
    // two units and `ı` uppercases onto ASCII `I`, so the ECMA-262
    // non-Unicode canonicalization keeps both distinct from their uppercase
    // forms — and therefore so does the matcher.
    expect(Capability.matches(pattern("fs:read", "c:/é"), capability("fs:read", "C:/É"))).toBe(true)
    expect(Capability.matches(pattern("fs:read", "c:/ß"), capability("fs:read", "C:/SS"))).toBe(false)
    expect(Capability.matches(pattern("fs:read", "c:/ı"), capability("fs:read", "C:/I"))).toBe(false)
  })

  it("preserves resource delimiters and newlines after a valid action while rejecting a malformed action prefix", () => {
    expect(Option.getOrNull(Capability.parse("fs:read:"))).toEqual(capability("fs:read", ""))
    expect(Option.getOrNull(Capability.parse("fs:read::leading"))).toEqual(capability("fs:read", ":leading"))
    expect(Option.getOrNull(Capability.parse("fs:read:trailing:"))).toEqual(capability("fs:read", "trailing:"))
    expect(Option.getOrNull(Capability.parse("fs:read:line\nbreak"))).toEqual(
      capability("fs:read", "line\nbreak")
    )
    expect(Option.isNone(Capability.parse(":fs:read:resource"))).toBe(true)
  })

  it("rejects journal payloads with unknown exact and pattern actions", () => {
    const decodeCapability = Schema.decodeUnknownResult(Capability.Capability)
    const decodePattern = Schema.decodeUnknownResult(Capability.CapabilityPattern)

    expect(decodeCapability({ action: "fs:delete", resource: "/workspace/readme.md" })._tag).toBe("Failure")
    expect(decodePattern({ action: "fs:delete", resource: "/workspace/**" })._tag).toBe("Failure")
  })

  it.each([
    [pattern("fs:read", "src/a.ts"), pattern("fs:read", "src/a.ts"), true],
    [pattern("fs:*", "src/**"), pattern("fs:read", "src/nested/a.ts"), true],
    [pattern("*", "**"), pattern("jj:*", "repository"), true],
    [pattern("jj:*", "repository/**"), pattern("jj:diff", "repository/one"), true],
    [pattern("fs:read", "src/**"), pattern("fs:write", "src/a.ts"), false],
    [pattern("fs:read", "src/*"), pattern("fs:read", "src/a.ts"), false],
    [pattern("fs:read", "src/**"), pattern("fs:read", "source/a.ts"), false]
  ])("conservatively checks subsumption", (left, right, expected) => {
    expect(Capability.subsumes(left, right)).toBe(expected)
  })

  it("records the `*`-crosses-separators asymmetry between matches and subsumes (D10)", () => {
    // `*` compiles to `.*`, so it crosses path separators and `matches` accepts
    // a nested path. `resourceSubsumes` recognises only `**` as recursive, so
    // `subsumes` cannot prove the same coverage and errs closed.
    //
    // Not a bug — `subsumes` is deliberately conservative — but the consequence
    // is invisible at the place a grant is written: a `*` grant can never be
    // *proven* to cover anything, so an envelope built from `*` patterns
    // re-prompts forever. Recorded here rather than rediscovered, alongside the
    // sentence now on `CapabilityPattern`.
    const grant = pattern("fs:read", "src/*")
    const wanted = capability("fs:read", "src/a/b")

    expect(Capability.matches(grant, wanted)).toBe(true)
    expect(Capability.subsumes(grant, pattern("fs:read", "src/a/b"))).toBe(false)
    // The provable form of the same intent.
    expect(Capability.subsumes(pattern("fs:read", "src/**"), pattern("fs:read", "src/a/b"))).toBe(true)
  })

  it.each([
    [capability("fs:read", "anything"), "sealed"],
    [capability("net:get", "example.test"), "sealed"],
    [capability("model:call", "api.example.test/large"), "sealed"],
    [capability("jj:status", "repository"), "sealed"],
    [capability("jj:diff", "repository"), "sealed"],
    [capability("fs:write", "src/a.ts"), "compensable"],
    [capability("fs:write", "/workspace/src/a.ts"), "compensable"],
    [capability("fs:write", "../escape"), "irreversible"],
    [capability("fs:write", "/outside/a.ts"), "irreversible"],
    [capability("jj:snapshot", "repository"), "compensable"],
    [capability("jj:restore", "repository"), "compensable"],
    [capability("jj:workspace-add", "repository"), "compensable"],
    [capability("jj:workspace-forget", "repository"), "compensable"],
    [capability("jj:root", "/workspace/lane"), "sealed"],
    [capability("jj:revert", "abcdef"), "compensable"],
    [capability("proc:spawn", "git status"), "irreversible"],
    [capability("net:post", "example.test"), "irreversible"]
  ])("classifies %o as %s", (value, expected) => {
    expect(Capability.tierOf(value, { workspaceRoot: "/workspace" })).toBe(expected)
  })

  it("requires idempotency keys only for irreversible effects", () => {
    expect(Capability.requiresIdempotencyKey("sealed")).toBe(false)
    expect(Capability.requiresIdempotencyKey("compensable")).toBe(false)
    expect(Capability.requiresIdempotencyKey("irreversible")).toBe(true)
  })

  it.each([
    ["C:/Work", "c:/work/src/a.ts"],
    ["C:/", "c:/src/a.ts"],
    ["c:\\", "C:\\src\\a.ts"]
  ])("classifies Windows writes inside workspace %s case-insensitively", (workspaceRoot, resource) => {
    expect(
      Capability.tierOf(capability("fs:write", resource), { workspaceRoot })
    ).toBe("compensable")
  })
})
