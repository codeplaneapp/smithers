/**
 * `S.Github.Pr` refusal paths: the target never reaches its outward action
 * without the declared token secret carrying a value and a satisfied
 * approval. This lane ships only the refusals; a satisfied gate is a loud
 * NotImplemented, never a silent green.
 */
import { describe, expect, it } from "vitest"
import * as GithubTarget from "../src/GithubTarget.ts"
import { Secret } from "../src/Secret.ts"
import type * as Target from "../src/Target.ts"

const withToken = (approval?: "required"): Target.AnyTarget =>
  GithubTarget.Pr({
    gates: [],
    secrets: [Secret("GITHUB_TOKEN")],
    ...(approval === undefined ? {} : { approval })
  })

describe("refusePr", () => {
  it("refuses a declaration that never names the GITHUB_TOKEN secret", () => {
    const pr = GithubTarget.Pr({ gates: [], secrets: [Secret("OTHER_TOKEN")] })
    const refusal = GithubTarget.refusePr(pr, {
      environment: { GITHUB_TOKEN: "ghp_value", OTHER_TOKEN: "x" },
      approvalGranted: true
    })
    expect(refusal).toBeDefined()
    expect(refusal!.code).toBe("missing_token_secret")
    expect(refusal!.message).toContain("GITHUB_TOKEN")
  })

  it("refuses a declaration with no secrets at all", () => {
    const pr = GithubTarget.Pr({ gates: [] })
    const refusal = GithubTarget.refusePr(pr, { environment: {}, approvalGranted: true })
    expect(refusal!.code).toBe("missing_token_secret")
  })

  it("refuses a declared token whose environment value is absent or empty", () => {
    for (const environment of [{}, { GITHUB_TOKEN: "" }]) {
      const refusal = GithubTarget.refusePr(withToken(), { environment, approvalGranted: true })
      expect(refusal!.code).toBe("missing_token_secret")
      expect(refusal!.message).toContain("no value in the invoking environment")
    }
  })

  it("refuses approval:\"required\" without a granted approval", () => {
    const refusal = GithubTarget.refusePr(withToken("required"), {
      environment: { GITHUB_TOKEN: "ghp_value" },
      approvalGranted: false
    })
    expect(refusal!.code).toBe("approval_unsatisfied")
  })

  it("passes a satisfied invocation through with no refusal", () => {
    expect(GithubTarget.refusePr(withToken("required"), {
      environment: { GITHUB_TOKEN: "ghp_value" },
      approvalGranted: true
    })).toBeUndefined()
    expect(GithubTarget.refusePr(withToken(), {
      environment: { GITHUB_TOKEN: "ghp_value" },
      approvalGranted: false
    })).toBeUndefined()
  })

  it("never leaks the token value into the refusal text", () => {
    const refusal = GithubTarget.refusePr(withToken("required"), {
      environment: { GITHUB_TOKEN: "ghp_supersecret" },
      approvalGranted: false
    })
    expect(refusal!.message).not.toContain("ghp_supersecret")
  })
})

describe("openPr", () => {
  it("throws the typed refusal before any outward action", () => {
    try {
      GithubTarget.openPr(withToken("required"), {
        environment: { GITHUB_TOKEN: "ghp_value" },
        approvalGranted: false
      })
      throw new Error("expected a PrRefused")
    } catch (cause) {
      expect(GithubTarget.isPrRefused(cause)).toBe(true)
      expect((cause as GithubTarget.PrRefused).code).toBe("approval_unsatisfied")
    }
  })

  it("refuses loudly past the gate instead of faking green", () => {
    expect(() =>
      GithubTarget.openPr(withToken(), {
        environment: { GITHUB_TOKEN: "ghp_value" },
        approvalGranted: true
      })
    ).toThrow(/NotImplemented: Github\.Pr/)
  })

  it("guards reject non-refusal values", () => {
    expect(GithubTarget.isPrRefused(new Error("plain"))).toBe(false)
    expect(GithubTarget.isPrRefused(undefined)).toBe(false)
  })
})
