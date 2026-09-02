import { describe, expect, it } from "vitest"
import { withinEnvelope } from "../src/internal/Paths.ts"

describe("withinEnvelope", () => {
  it.each([
    { declared: [""], candidate: "/etc/evil", expected: false },
    { declared: ["/"], candidate: "/etc/hosts", expected: true },
    { declared: ["/**"], candidate: "/etc/hosts", expected: true },
    { declared: ["/work"], candidate: "/work/../outside/x", expected: false },
    { declared: ["/work/**"], candidate: "/work/../outside/x", expected: false },
    { declared: ["/work"], candidate: "/work/a/b", expected: true },
    { declared: ["/work/"], candidate: "/work/a", expected: true },
    { declared: ["/work//"], candidate: "/work///a", expected: true }
  ])("checks $candidate against $declared", ({ declared, candidate, expected }) => {
    expect(withinEnvelope(declared, candidate)).toBe(expected)
  })
})
