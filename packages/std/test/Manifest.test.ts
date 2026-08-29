import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Manifest from "../src/Manifest.ts"

const expectedNames = [
  "read",
  "write",
  "edit",
  "ls",
  "glob",
  "grep",
  "bash",
  "test",
  "shell_command",
  "apply_patch",
  "update_plan",
  "fetch",
  "http-post",
  "explore",
  "webfetch",
  "websearch",
  "lsp"
] as const

const forbiddenActions = ["fs:write", "net:post", "proc:spawn"] as const

const hasAction = (capability: string, action: string): boolean =>
  capability === action || capability.startsWith(`${action}:`)

describe("Manifest", () => {
  it("registers every standard flow", () => {
    expect(Object.keys(Manifest.flows)).toEqual(expectedNames)
    expect(Manifest.names).toEqual(expectedNames)
    expect(Object.keys(Manifest.handlers)).toEqual(expectedNames.filter((name) => name !== "explore"))
    expect(Object.isFrozen(Manifest.flows)).toBe(true)
    expect(Object.isFrozen(Manifest.handlers)).toBe(true)
    expect(Object.isFrozen(Manifest.names)).toBe(true)
  })

  it("keeps declaration metadata aligned with registry keys", () => {
    for (const [key, flow] of Object.entries(Manifest.flows)) {
      expect(flow.name).toBe(key)
      expect(flow.description?.trim()).not.toBe("")
      expect(Schema.isSchema(flow.input)).toBe(true)
      expect(Schema.isSchema(flow.output)).toBe(true)
    }
  })

  it("keeps the read-only seat projection free of mutating authority", () => {
    expect(Manifest.readOnly).toEqual([
      "read",
      "ls",
      "glob",
      "grep",
      "fetch",
      "explore",
      "webfetch",
      "lsp"
    ])
    expect(Manifest.readOnly).not.toContain("websearch")
    expect(Object.isFrozen(Manifest.readOnly)).toBe(true)

    for (const name of Manifest.readOnly) {
      const capabilities = Manifest.flows[name].capabilities
      for (const action of forbiddenActions) {
        expect(capabilities.some((capability) => hasAction(capability, action))).toBe(false)
      }
    }
  })
})
