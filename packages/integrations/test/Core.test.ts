import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { buildAuthorizationUrl } from "../src/core/AuthorizationUrl.ts"
import * as ExternalEvent from "../src/core/ExternalEvent.ts"
import {
  IntegrationError,
  isIntegrationError,
  isRetryable,
  toInvalidInput,
  toUnauthorized
} from "../src/core/IntegrationError.ts"
import { readInteger, readJsonPath, readString } from "../src/core/JsonPath.ts"
import { createCodeVerifier, createPkcePair, deriveCodeChallenge } from "../src/core/Pkce.ts"
import * as SignalName from "../src/core/SignalName.ts"

describe("readJsonPath", () => {
  const payload = { repository: { full_name: "smithersai/smithers" }, issue: { number: 12 }, list: [1, 2] }

  it("reads a dot path", () => {
    expect(readJsonPath(payload, "repository.full_name")).toBe("smithersai/smithers")
    expect(readString(payload, "repository.full_name")).toBe("smithersai/smithers")
    expect(readInteger(payload, "issue.number")).toBe(12)
  })

  it("returns the value itself for an empty path", () => {
    expect(readJsonPath(payload)).toBe(payload)
    expect(readJsonPath(payload, "")).toBe(payload)
    expect(readJsonPath(payload, null)).toBe(payload)
  })

  it("returns undefined when a segment is missing or lands on a non-record", () => {
    expect(readJsonPath(payload, "repository.missing")).toBeUndefined()
    expect(readJsonPath(payload, "repository.full_name.deeper")).toBeUndefined()
    expect(readJsonPath(payload, "list.0")).toBeUndefined()
    expect(readJsonPath(null, "a")).toBeUndefined()
  })

  it("rejects a value of the wrong type", () => {
    expect(readString(payload, "issue.number")).toBeUndefined()
    expect(readString({ a: "" }, "a")).toBeUndefined()
    expect(readInteger(payload, "repository.full_name")).toBeUndefined()
    expect(readInteger({ a: 1.5 }, "a")).toBeUndefined()
  })
})

describe("IntegrationError", () => {
  it("carries a reason and provider-safe details", () => {
    const error = new IntegrationError("poll-failed", "getUpdates failed", { sourceId: "telegram" })
    expect(error.reason).toBe("poll-failed")
    expect(error.code).toBe("INTEGRATION_ERROR")
    expect(error.details).toEqual({ reason: "poll-failed", sourceId: "telegram" })
    expect(isIntegrationError(error)).toBe(true)
  })

  it("recognizes an error that crossed a module boundary by name", () => {
    const foreign = new Error("copy")
    foreign.name = "IntegrationError"
    expect(isIntegrationError(foreign)).toBe(true)
    expect(isIntegrationError(new Error("plain"))).toBe(false)
  })

  it("marks only the failures the clients tagged retryable", () => {
    expect(isRetryable(new IntegrationError("delivery-failed", "429", { retryable: true }))).toBe(true)
    expect(isRetryable(new IntegrationError("delivery-failed", "404", { retryable: false }))).toBe(false)
    expect(isRetryable(new Error("plain"))).toBe(false)
  })

  it("maps onto the control plane without leaking details", () => {
    const error = new IntegrationError("invalid-signature", "github webhook signature did not verify.", {
      digest: "expected"
    })
    const unauthorized = toUnauthorized(error)
    expect(unauthorized.message).toBe("github webhook signature did not verify.")
    expect(JSON.stringify(unauthorized)).not.toContain("expected")
    expect(toInvalidInput(error).issue).toBe("github webhook signature did not verify.")
  })
})

describe("SignalName", () => {
  it("builds names in the reserved namespace", () => {
    expect(SignalName.eventName("github", "pull_request.opened")).toBe("integration:github:pull_request.opened")
    expect(SignalName.receivedBy("telegram")).toBe("integration:telegram")
  })

  it("trims segments and refuses empty or colon-bearing ones", () => {
    expect(SignalName.eventName(" github ", " push ")).toBe("integration:github:push")
    expect(() => SignalName.eventName("", "push")).toThrow(/service must be a non-empty string/)
    expect(() => SignalName.eventName("github", "  ")).toThrow(/event must be a non-empty string/)
    expect(() => SignalName.eventName("git:hub", "push")).toThrow(/must not contain/)
    expect(() => SignalName.eventName("github", "pu:sh")).toThrow(/must not contain/)
    expect(() => SignalName.receivedBy("")).toThrow(/non-empty/)
  })

  it("round-trips a name", () => {
    const name = SignalName.eventName("linear", "issue.update")
    expect(SignalName.isIntegrationSignalName(name)).toBe(true)
    expect(SignalName.parse(name)).toEqual({ service: "linear", event: "issue.update" })
  })

  it("refuses to parse anything outside the namespace or malformed", () => {
    expect(SignalName.isIntegrationSignalName("my-signal")).toBe(false)
    expect(SignalName.isIntegrationSignalName(7)).toBe(false)
    expect(SignalName.parse("my-signal")).toBeNull()
    expect(SignalName.parse("integration::event")).toBeNull()
    expect(SignalName.parse("integration:service:")).toBeNull()
  })
})

const event: ExternalEvent.ExternalEvent = {
  source: "github",
  eventName: "integration:github:issues.opened",
  correlationId: "smithersai/smithers#12",
  payload: { action: "opened" },
  dedupeKey: "delivery-1",
  receivedAtMs: 1_700_000_000_000
}

describe("ExternalEvent", () => {
  it("decodes a well-formed event", async () => {
    expect(await Effect.runPromise(ExternalEvent.decode(event))).toEqual(event)
  })

  it("refuses an event a decoder bug produced", async () => {
    const exit = await Effect.runPromise(Effect.exit(ExternalEvent.decode({ ...event, dedupeKey: "" })))
    expect(exit._tag).toBe("Failure")
  })
})

describe("SignalName conversions", () => {
  it("becomes a control-plane signal", () => {
    expect(SignalName.toSignalPayload(event)).toEqual({
      name: "integration:github:issues.opened",
      payload: { action: "opened" }
    })
  })

  it("becomes a queued system-event notification that coalesces per subject", () => {
    const provenance = {
      sourceRunId: "run-1",
      sourceLineageId: "lineage-1",
      sourceTurn: 0,
      sourceActor: "integration:github"
    }
    const notification = SignalName.toNotification(event, { targetLineageId: "lineage-1", provenance })
    expect(notification._tag).toBe("system-event")
    // Machine events queue: they reach the model when the run would idle,
    // rather than interrupting the turn in flight.
    expect(notification.delivery).toBe("queue")
    expect(notification.id).toBe("delivery-1")
    expect(notification).toHaveProperty("coalescingKey", "integration:github:issues.opened:smithersai/smithers#12")
  })

  it("coalesces an uncorrelated event under an empty subject and takes an explicit id", () => {
    const provenance = {
      sourceRunId: "run-1",
      sourceLineageId: "lineage-1",
      sourceTurn: 0,
      sourceActor: "integration:github"
    }
    const notification = SignalName.toNotification({ ...event, correlationId: null }, {
      id: "explicit",
      targetLineageId: "lineage-1",
      provenance
    })
    expect(notification.id).toBe("explicit")
    expect(notification).toHaveProperty("coalescingKey", "integration:github:issues.opened:")
  })
})

describe("PKCE", () => {
  const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/
  const BASE64URL = /^[A-Za-z0-9\-_]+$/

  it("draws a 43-character verifier by default", () => {
    const verifier = createCodeVerifier()
    expect(verifier).toHaveLength(43)
    expect(verifier).toMatch(VERIFIER)
  })

  it("enforces the byte-length bounds", () => {
    expect(createCodeVerifier(32)).toHaveLength(43)
    expect(createCodeVerifier(96)).toHaveLength(128)
    expect(() => createCodeVerifier(31)).toThrow(/32\.\.96/)
    expect(() => createCodeVerifier(97)).toThrow(/32\.\.96/)
    expect(() => createCodeVerifier(32.5)).toThrow(/integer/)
  })

  it("matches RFC 7636 Appendix B", () => {
    expect(deriveCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })

  it("derives an unpadded base64url challenge", () => {
    const challenge = deriveCodeChallenge(createCodeVerifier())
    expect(challenge).toHaveLength(43)
    expect(challenge).toMatch(BASE64URL)
    expect(challenge).not.toContain("=")
  })

  it("validates the verifier length and character set", () => {
    expect(() => deriveCodeChallenge("a".repeat(42))).toThrow(/43\.\.128/)
    expect(() => deriveCodeChallenge("a".repeat(129))).toThrow(/43\.\.128/)
    expect(() => deriveCodeChallenge(`${"a".repeat(42)}!`)).toThrow(/unreserved/)
    expect(() => deriveCodeChallenge(7 as unknown as string)).toThrow(/must be a string/)
    expect(deriveCodeChallenge(`${"a".repeat(41)}.~`)).toMatch(BASE64URL)
    expect(deriveCodeChallenge("a".repeat(128))).toMatch(BASE64URL)
  })

  it("returns a consistent S256 pair", () => {
    const pair = createPkcePair(96)
    expect(pair.codeChallengeMethod).toBe("S256")
    expect(pair.codeVerifier).toHaveLength(128)
    expect(pair.codeChallenge).toBe(deriveCodeChallenge(pair.codeVerifier))
  })
})

describe("buildAuthorizationUrl", () => {
  const BASE = {
    authorizationEndpoint: "https://provider.example/oauth/authorize",
    clientId: "smithers-client",
    redirectUri: "https://app.example/oauth/callback",
    state: "state-123",
    codeChallenge: "challenge-123"
  }

  it("builds an authorization-code URL with PKCE parameters", () => {
    const url = new URL(buildAuthorizationUrl(BASE))
    expect(url.origin).toBe("https://provider.example")
    expect(url.pathname).toBe("/oauth/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe(BASE.clientId)
    expect(url.searchParams.get("redirect_uri")).toBe(BASE.redirectUri)
    expect(url.searchParams.get("state")).toBe(BASE.state)
    expect(url.searchParams.get("code_challenge")).toBe(BASE.codeChallenge)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  })

  it("space-joins array scopes and uses string scopes verbatim", () => {
    expect(new URL(buildAuthorizationUrl({ ...BASE, scope: ["openid", "profile"] })).searchParams.get("scope"))
      .toBe("openid profile")
    expect(new URL(buildAuthorizationUrl({ ...BASE, scope: "openid offline_access" })).searchParams.get("scope"))
      .toBe("openid offline_access")
  })

  it("omits an absent or empty scope", () => {
    expect(new URL(buildAuthorizationUrl(BASE)).searchParams.has("scope")).toBe(false)
    expect(new URL(buildAuthorizationUrl({ ...BASE, scope: "" })).searchParams.has("scope")).toBe(false)
    expect(new URL(buildAuthorizationUrl({ ...BASE, scope: [] })).searchParams.has("scope")).toBe(false)
  })

  it("honors an explicit plain challenge method", () => {
    expect(
      new URL(buildAuthorizationUrl({ ...BASE, codeChallengeMethod: "plain" })).searchParams
        .get("code_challenge_method")
    ).toBe("plain")
  })

  it("preserves endpoint query parameters and applies extras last", () => {
    const url = new URL(buildAuthorizationUrl({
      ...BASE,
      authorizationEndpoint: "https://login.example/tenant/authorize?tenant=acme&prompt=consent",
      extraParams: { audience: "https://api.example", client_id: "tenant-client", response_type: "custom-code" }
    }))
    expect(url.searchParams.get("tenant")).toBe("acme")
    expect(url.searchParams.get("prompt")).toBe("consent")
    expect(url.searchParams.get("audience")).toBe("https://api.example")
    expect(url.searchParams.get("client_id")).toBe("tenant-client")
    expect(url.searchParams.get("response_type")).toBe("custom-code")
    expect(url.searchParams.get("redirect_uri")).toBe(BASE.redirectUri)
  })

  it("takes the challenge a PKCE pair produced", () => {
    const pair = createPkcePair()
    expect(new URL(buildAuthorizationUrl({ ...BASE, codeChallenge: pair.codeChallenge })).searchParams
      .get("code_challenge")).toBe(pair.codeChallenge)
  })

  it("refuses a relative or non-http endpoint", () => {
    for (
      const authorizationEndpoint of [
        "/oauth/authorize",
        "provider.example/oauth/authorize",
        "ftp://provider.example/oauth/authorize",
        "mailto:admin@example.com"
      ]
    ) {
      expect(() => buildAuthorizationUrl({ ...BASE, authorizationEndpoint })).toThrow(TypeError)
    }
    expect(() => buildAuthorizationUrl({ ...BASE, authorizationEndpoint: 7 as unknown as string })).toThrow(TypeError)
  })

  it("refuses an empty required field", () => {
    for (const field of ["clientId", "redirectUri", "state", "codeChallenge"] as const) {
      expect(() => buildAuthorizationUrl({ ...BASE, [field]: "" })).toThrow(TypeError)
    }
  })
})
