import { describe, expect, it } from "vitest"
import {
  ERROR_REFERENCE_URL,
  getSmithersErrorDefinition,
  getSmithersErrorDocsUrl,
  isKnownSmithersErrorCode,
  knownSmithersErrorCodes,
  smithersErrorDefinitions
} from "../src/ErrorCode.ts"
import { isSmithersError, SmithersError } from "../src/SmithersError.ts"

describe("SmithersError", () => {
  it("appends the documentation URL once", () => {
    const error = new SmithersError("INVALID_INPUT", "no bot token")
    expect(error.message).toBe(`no bot token See ${ERROR_REFERENCE_URL}`)
    expect(error.summary).toBe("no bot token")
    expect(error.docsUrl).toBe(ERROR_REFERENCE_URL)
    expect(new SmithersError("INVALID_INPUT", error.message).message).toBe(error.message)
  })

  it("suppresses the documentation URL on request", () => {
    const error = new SmithersError("UNSUPPORTED", "no Ed25519", undefined, { includeDocsUrl: false })
    expect(error.message).toBe("no Ed25519")
    expect(error.details).toBeUndefined()
  })

  it("carries a cause, a name, and provider-safe details", () => {
    const cause = new Error("socket hang up")
    const error = new SmithersError("INTEGRATION_ERROR", "poll failed", { reason: "poll-failed" }, {
      cause,
      name: "IntegrationError"
    })
    expect(error.name).toBe("IntegrationError")
    expect(error.cause).toBe(cause)
    expect(error.details).toEqual({ reason: "poll-failed" })
  })

  it("keeps the subclass prototype so instanceof works", () => {
    class Subclass extends SmithersError {
      constructor() {
        super("TELEGRAM_API_ERROR", "bad request")
      }
    }
    const error = new Subclass()
    expect(error).toBeInstanceOf(Subclass)
    expect(isSmithersError(error)).toBe(true)
    expect(isSmithersError(new Error("plain"))).toBe(false)
  })
})

describe("error codes", () => {
  it("documents exactly the codes the integration adapters raise", () => {
    expect([...knownSmithersErrorCodes].sort()).toEqual([
      "INTEGRATION_ERROR",
      "INVALID_INPUT",
      "TELEGRAM_API_ERROR",
      "TELEGRAM_INIT_DATA_INVALID",
      "UNSUPPORTED"
    ])
  })

  it("gives every code a category and a trigger description", () => {
    for (const code of knownSmithersErrorCodes) {
      const definition = smithersErrorDefinitions[code]
      expect(definition.category).toBe("integrations")
      expect(definition.when.length).toBeGreaterThan(0)
    }
  })

  it("resolves definitions and refuses unknown codes", () => {
    expect(getSmithersErrorDefinition("INVALID_INPUT")?.category).toBe("integrations")
    expect(getSmithersErrorDefinition("NOT_A_CODE")).toBeUndefined()
    expect(isKnownSmithersErrorCode("INVALID_INPUT")).toBe(true)
    expect(isKnownSmithersErrorCode("toString")).toBe(false)
    expect(isKnownSmithersErrorCode(7)).toBe(false)
  })

  it("points every code at the reference page", () => {
    expect(getSmithersErrorDocsUrl("INTEGRATION_ERROR")).toBe(ERROR_REFERENCE_URL)
  })
})
