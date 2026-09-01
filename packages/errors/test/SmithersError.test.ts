import { inspect } from "node:util"
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  ERROR_REFERENCE_URL,
  getSmithersErrorDefinition,
  getSmithersErrorDocsUrl,
  isKnownSmithersErrorCode,
  type KnownSmithersErrorCode,
  knownSmithersErrorCodes,
  type SmithersErrorCode,
  smithersErrorDefinitions
} from "../src/ErrorCode.ts"
import { hasSmithersErrorShape, isSmithersError, SmithersError } from "../src/SmithersError.ts"

describe("SmithersError", () => {
  it("uses the default name", () => {
    expect(new SmithersError("INVALID_INPUT", "x").name).toBe("SmithersError")
  })

  it("is an Error", () => {
    expect(new SmithersError("INVALID_INPUT", "x")).toBeInstanceOf(Error)
  })

  it("appends the documentation URL once", () => {
    const error = new SmithersError("INVALID_INPUT", "no bot token")
    expect(error.message).toBe(`no bot token See ${ERROR_REFERENCE_URL}`)
    expect(error.summary).toBe("no bot token")
    expect(error.docsUrl).toBe(ERROR_REFERENCE_URL)
    const rewrapped = new SmithersError("INVALID_INPUT", error.message)
    expect(rewrapped.message).toBe(error.message)
    expect(rewrapped.summary).toBe("no bot token")
  })

  it("freezes the wire-visible message format", () => {
    expect(new SmithersError("INVALID_INPUT", "no bot token").message).toBe(
      "no bot token See https://smithers.sh/reference/errors"
    )
  })

  it("collapses duplicate documentation URL suffixes", () => {
    const suffix = ` See ${ERROR_REFERENCE_URL}`
    const error = new SmithersError("INVALID_INPUT", `x${suffix}${suffix}`)
    expect(error.summary).toBe("x")
    expect(error.message).toBe(`x${suffix}`)
  })

  it("ignores trailing whitespace when removing the documentation URL suffix", () => {
    const suffix = ` See ${ERROR_REFERENCE_URL}`
    const error = new SmithersError("INVALID_INPUT", `no token${suffix} `)
    expect(error.summary).toBe("no token")
    expect(error.message).toBe(`no token${suffix}`)
  })

  it("collapses documentation URL suffixes separated by whitespace", () => {
    const suffix = ` See ${ERROR_REFERENCE_URL}`
    const error = new SmithersError("INVALID_INPUT", `no token${suffix}   ${suffix}`)
    expect(error.summary).toBe("no token")
    expect(error.message).toBe(`no token${suffix}`)
  })

  it("appends the pointer when the URL is only embedded in the summary", () => {
    const summary = `see ${ERROR_REFERENCE_URL} for more; token bad`
    const error = new SmithersError("INVALID_INPUT", summary)
    expect(error.message).toBe(`${summary} See ${ERROR_REFERENCE_URL}`)
    expect(error.summary).toBe(summary)
  })

  it("does not append the documentation URL to blank summaries", () => {
    expect(new SmithersError("UNSUPPORTED", "").message).toBe("")
    expect(new SmithersError("UNSUPPORTED", "").summary).toBe("")
    expect(new SmithersError("UNSUPPORTED", "   ").message).toBe("   ")
  })

  it("suppresses the documentation URL on request", () => {
    const error = new SmithersError("UNSUPPORTED", "no Ed25519", undefined, { includeDocsUrl: false })
    expect(error.message).toBe("no Ed25519")
    expect(error.details).toBeUndefined()
    const suffix = ` See ${ERROR_REFERENCE_URL}`
    const stripped = new SmithersError("UNSUPPORTED", `no Ed25519${suffix}`, undefined, {
      includeDocsUrl: false
    })
    expect(stripped.message).toBe("no Ed25519")
    expect(stripped.summary).toBe("no Ed25519")
  })

  it("treats an explicit includeDocsUrl true like the default", () => {
    expect(new SmithersError("INVALID_INPUT", "x", undefined, { includeDocsUrl: true }).message)
      .toBe(`x See ${ERROR_REFERENCE_URL}`)
  })

  it("starts the stack with its name and message", () => {
    const error = new SmithersError("INVALID_INPUT", "x")
    expect(error.stack?.startsWith(`${error.name}: ${error.message}`)).toBe(true)
  })

  it("carries a cause, a name, and caller-supplied details", () => {
    const cause = new Error("socket hang up")
    const error = new SmithersError("INTEGRATION_ERROR", "poll failed", { reason: "poll-failed" }, {
      cause,
      name: "IntegrationError"
    })
    expect(error.name).toBe("IntegrationError")
    expect(error.cause).toBe(cause)
    expect(error.details).toEqual({ reason: "poll-failed" })
  })

  it("only installs an own cause property when cause is supplied", () => {
    expect(Object.hasOwn(new SmithersError("INVALID_INPUT", "x"), "cause")).toBe(false)
    expect(Object.hasOwn(new SmithersError("INVALID_INPUT", "x", undefined, { name: "X" }), "cause")).toBe(false)
    expect(Object.hasOwn(new SmithersError("INVALID_INPUT", "x", undefined, { cause: new Error("root") }), "cause"))
      .toBe(true)
    expect(Object.hasOwn(new SmithersError("INVALID_INPUT", "x", undefined, { cause: undefined }), "cause")).toBe(false)
  })

  it("lets subclasses always spell the optional cause key", () => {
    class IntegrationError extends SmithersError {
      constructor(options?: { readonly cause?: unknown }) {
        super("INTEGRATION_ERROR", "poll failed", undefined, {
          cause: options?.cause,
          name: "IntegrationError"
        })
      }
    }

    const withoutCause = new IntegrationError()
    expect(Object.hasOwn(withoutCause, "cause")).toBe(false)
    expect(inspect(withoutCause)).not.toContain("[cause]")

    const cause = new Error("root")
    const withCause = new IntegrationError({ cause })
    expect(Object.hasOwn(withCause, "cause")).toBe(true)
    expect(withCause.cause).toBe(cause)
  })

  it("preserves a cause chain", () => {
    const cause = new Error("middle", { cause: new Error("root") })
    expect((new SmithersError("INTEGRATION_ERROR", "x", undefined, { cause }).cause as Error).cause).toBe(cause.cause)
  })

  it("stores non-Error causes verbatim", () => {
    for (const cause of ["provider failure", { provider: "telegram" }]) {
      expect(new SmithersError("INTEGRATION_ERROR", "x", undefined, { cause }).cause).toBe(cause)
    }
  })

  it("copies and freezes only the top-level details record", () => {
    const nested = { token: "SECRET" }
    const details = { reason: "poll-failed", context: nested }
    const error = new SmithersError("INTEGRATION_ERROR", "poll failed", details)
    details.reason = "changed"
    details.context = { token: "REPLACEMENT" }
    nested.token = "MUTATED"
    expect(error.details).toEqual({ reason: "poll-failed", context: { token: "MUTATED" } })
    expect(error.details?.context).toBe(nested)
    expect(error.details).not.toBe(details)
    expect(Object.isFrozen(error.details)).toBe(true)
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

describe("error refinements", () => {
  class Subclass extends SmithersError {}

  it("accepts real and subclass instances", () => {
    for (const error of [new SmithersError("INVALID_INPUT", "x"), new Subclass("INVALID_INPUT", "x")]) {
      expect(isSmithersError(error)).toBe(true)
      expect(hasSmithersErrorShape(error)).toBe(true)
    }
  })

  it("rejects plain errors, forged names, non-errors, and plain shaped objects", () => {
    const forged = new Error("forged")
    forged.name = "SmithersError"
    const values = [new Error("plain"), forged, null, undefined, {
      code: "INVALID_INPUT",
      summary: "x",
      docsUrl: ERROR_REFERENCE_URL
    }]
    for (const value of values) {
      expect(isSmithersError(value)).toBe(false)
      expect(hasSmithersErrorShape(value)).toBe(false)
    }
  })

  it("structurally accepts an instance detached from the package prototype", () => {
    for (const code of knownSmithersErrorCodes) {
      const error = new SmithersError(code, "x")
      Object.setPrototypeOf(error, Object.getPrototypeOf(new Error()))
      expect(isSmithersError(error)).toBe(false)
      expect(hasSmithersErrorShape(error)).toBe(true)
    }
  })

  it("rejects an Error carrying an unknown code", () => {
    const error = Object.assign(new Error("f"), {
      code: "NOT_A_CODE",
      summary: "s",
      docsUrl: "bogus"
    })
    expect(hasSmithersErrorShape(error)).toBe(false)
  })

  it("narrows a structurally accepted code to the known vocabulary", () => {
    const value: unknown = Object.assign(new Error("f"), {
      code: "INVALID_INPUT",
      summary: "s",
      docsUrl: "from-another-package-version"
    })
    if (!hasSmithersErrorShape(value)) expect.fail("expected a structurally compatible error")
    expectTypeOf(value.code).toEqualTypeOf<KnownSmithersErrorCode>()
  })

  it("rejects errors with incomplete structural fields", () => {
    expect(hasSmithersErrorShape(Object.assign(new Error("partial"), { code: "INVALID_INPUT" }))).toBe(false)
    expect(hasSmithersErrorShape(Object.assign(new Error("partial"), {
      code: "INVALID_INPUT",
      summary: "x"
    }))).toBe(false)
  })
})

describe("error codes", () => {
  it("keeps the error code set closed", () => {
    expectTypeOf<SmithersErrorCode>().toEqualTypeOf<KnownSmithersErrorCode>()
    expectTypeOf<ConstructorParameters<typeof SmithersError>[0]>().toEqualTypeOf<KnownSmithersErrorCode>()
  })

  it("freezes the definitions and known-code table", () => {
    expect(Object.isFrozen(smithersErrorDefinitions)).toBe(true)
    expect(Object.isFrozen(smithersErrorDefinitions.INVALID_INPUT)).toBe(true)
    expect(Object.isFrozen(knownSmithersErrorCodes)).toBe(true)
  })

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

  it("rejects adversarial unknown codes and accepts every known code", () => {
    const adversaries: unknown[] = [
      "hasOwnProperty",
      "__proto__",
      "constructor",
      "",
      null,
      undefined,
      Symbol("INVALID_INPUT"),
      { toString: () => "INVALID_INPUT" }
    ]
    for (const value of adversaries) expect(isKnownSmithersErrorCode(value)).toBe(false)
    for (const code of knownSmithersErrorCodes) expect(isKnownSmithersErrorCode(code)).toBe(true)
  })

  it("keeps definition details meaningful and code membership exact", () => {
    for (const definition of Object.values(smithersErrorDefinitions)) {
      if ("details" in definition) expect(definition.details.length).toBeGreaterThan(0)
    }
    expect(new Set(knownSmithersErrorCodes)).toEqual(new Set(Object.keys(smithersErrorDefinitions)))
  })

  it("documents details carried by input and init-data failures", () => {
    expect(smithersErrorDefinitions.INVALID_INPUT.details)
      .toBe("`{ [field]: value }` on the signal-name failures, otherwise none")
    expect(smithersErrorDefinitions.TELEGRAM_INIT_DATA_INVALID.details)
      .toBe("`{ authDate }` on the expiry failures, otherwise none")
  })

  it("points every code at the reference page", () => {
    expect(getSmithersErrorDocsUrl()).toBe(ERROR_REFERENCE_URL)
  })
})

// The reference page is now generated by `//packages/errors:docsPages`, whose
// `lint` verb re-runs the generator and fails on drift. The Vitest target's
// cache key never included that page, so a cached test hit could not observe a
// documentation edit.
