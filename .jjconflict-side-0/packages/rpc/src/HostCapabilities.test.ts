import { describe, expect, test } from "bun:test"
import { RuntimeCapabilitySchema } from "./AppBootstrap"
import { cloudCapabilities, localCapabilities } from "./HostCapabilities"

const booleans = [false, true] as const

describe("cloudCapabilities (the Worker, host cloud)", () => {
  test("a fully configured Worker emits the four capabilities the Worker emits today, in its order", () => {
    expect(cloudCapabilities({ identity: true, jjhub: true, agent: true, checkout: true, terminal: false }))
      .toEqual(["agent", "identity", "jjhub", "billing.checkout"])
  })

  test("an unconfigured Worker emits nothing", () => {
    expect(cloudCapabilities({ identity: false, jjhub: false, agent: false, checkout: false, terminal: false }))
      .toEqual([])
  })

  test("each flag gates only its own capability", () => {
    expect(cloudCapabilities({ identity: true, jjhub: false, agent: true, checkout: true, terminal: false }))
      .toEqual(["agent", "identity", "billing.checkout"])
    expect(cloudCapabilities({ identity: false, jjhub: true, agent: false, checkout: false, terminal: false }))
      .toEqual(["jjhub"])
  })

  test("cloud.terminal appears last and only when the relay is on", () => {
    expect(cloudCapabilities({ identity: true, jjhub: true, agent: true, checkout: true, terminal: true }))
      .toEqual(["agent", "identity", "jjhub", "billing.checkout", "cloud.terminal"])
    expect(cloudCapabilities({ identity: false, jjhub: false, agent: false, checkout: false, terminal: true }))
      .toEqual(["cloud.terminal"])
  })

  test("the Worker never claims cloud.pat and every entry is a known capability", () => {
    for (const identity of booleans) {
      for (const jjhub of booleans) {
        for (const agent of booleans) {
          for (const checkout of booleans) {
            for (const terminal of booleans) {
              const emitted = cloudCapabilities({ identity, jjhub, agent, checkout, terminal })
              expect(emitted).not.toContain("cloud.pat")
              expect(emitted).not.toContain("local.lsp")
              expect(emitted.includes("cloud.terminal")).toBe(terminal)
              expect(new Set(emitted).size).toBe(emitted.length)
              for (const capability of emitted) expect(RuntimeCapabilitySchema.safeParse(capability).success).toBe(true)
            }
          }
        }
      }
    }
  })
})

describe("localCapabilities (the Bun server, host local)", () => {
  test("a hybrid launch with manual paths emits what the Bun server emits today plus both cloud doors", () => {
    expect(localCapabilities({ agent: true, identity: true, jjhub: true, pathEntry: true })).toEqual([
      "agent",
      "identity",
      "jjhub",
      "cloud.terminal",
      "cloud.pat",
      "local.repositories",
      "local.repository-path-entry",
      "local.targets",
      "local.terminal",
      "local.harnesses",
      "local.lsp"
    ])
  })

  test("an offline launch emits only the five unconditional local capabilities", () => {
    expect(localCapabilities({ agent: false, identity: false, jjhub: false, pathEntry: false })).toEqual([
      "local.repositories",
      "local.targets",
      "local.terminal",
      "local.harnesses",
      "local.lsp"
    ])
  })

  test("the chat stub is an agent without identity or jjhub", () => {
    expect(localCapabilities({ agent: true, identity: false, jjhub: false, pathEntry: false })).toEqual([
      "agent",
      "local.repositories",
      "local.targets",
      "local.terminal",
      "local.harnesses",
      "local.lsp"
    ])
  })

  test("the code-intelligence door is open on every Bun launch: a missing language server is stated per file, never a closed door", () => {
    for (const agent of booleans) {
      for (const jjhub of booleans) {
        expect(localCapabilities({ agent, identity: false, jjhub, pathEntry: false }).at(-1)).toBe("local.lsp")
      }
    }
  })

  test("the cloud doors ride the jjhub upstream: offline answers 501 on /api/cloud-auth and /api/cloud-ws", () => {
    for (const agent of booleans) {
      for (const identity of booleans) {
        for (const jjhub of booleans) {
          for (const pathEntry of booleans) {
            const emitted = localCapabilities({ agent, identity, jjhub, pathEntry })
            expect(emitted.includes("jjhub")).toBe(jjhub)
            expect(emitted.includes("cloud.terminal")).toBe(jjhub)
            expect(emitted.includes("cloud.pat")).toBe(jjhub)
            expect(emitted.includes("local.repository-path-entry")).toBe(pathEntry)
            expect(new Set(emitted).size).toBe(emitted.length)
            for (const capability of emitted) expect(RuntimeCapabilitySchema.safeParse(capability).success).toBe(true)
          }
        }
      }
    }
  })
})
