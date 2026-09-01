/**
 * `smithers bug`: the scrubbing, which is the whole reason the command exists.
 *
 * Every rule here answers a way a credential actually reached a 0.x report.
 */
import * as Redaction from "@smthrs/journal/Redaction"
import { FastCheck } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Bug from "../src/Bug.ts"

describe("scrubbing free text", () => {
  it("strips the password out of a connection string, whatever the key is called", () => {
    expect(Bug.scrubText("postgres://user:hunter2@db.internal/app"))
      .toBe("postgres://user:[REDACTED]@db.internal/app")
    expect(Bug.scrubText("https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz@github.com"))
      .toContain("[REDACTED]@github.com")
  })

  it("strips bearer tokens and provider key formats that carry no key name", () => {
    expect(Bug.scrubText("authorization: Bearer abc123def456")).toBe("authorization: Bearer [REDACTED_TOKEN]")
    expect(Bug.scrubText("sk-abcdefghijklmnop")).toBe("[REDACTED_API_KEY]")
    expect(Bug.scrubText("ghp_abcdefghijklmnopqrstuvwxyz01")).toBe("[REDACTED]")
    expect(Bug.scrubText("github_pat_abcdefghijklmnopqrstuvwxyz")).toBe("[REDACTED]")
    expect(Bug.scrubText("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED]")
    expect(Bug.scrubText("xoxb-1234567890-abcdef")).toBe("[REDACTED]")
    expect(Bug.scrubText(`AIza${"a".repeat(35)}`)).toBe("[REDACTED]")
  })

  it("strips KEY=value pairs and quoted JSON secrets", () => {
    expect(Bug.scrubText("ANTHROPIC_API_KEY=abc123")).toBe("ANTHROPIC_API_KEY=[REDACTED]")
    expect(Bug.scrubText("api_key=abc123")).toBe("api_key=[REDACTED]")
    expect(Bug.scrubText("MY_SECRET=\"quoted value\"")).toBe("MY_SECRET=[REDACTED]")
    expect(Bug.scrubText("{\"apiToken\": \"abc123\"}")).toBe("{\"apiToken\": \"[REDACTED]\"}")
  })

  it("leaves ordinary text alone", () => {
    expect(Bug.scrubText("the run failed after 3 attempts")).toBe("the run failed after 3 attempts")
    expect(Bug.scrubText("https://smithers.sh/docs")).toBe("https://smithers.sh/docs")
  })
})

describe("scrubbing a value", () => {
  it("redacts a secret-looking key wholesale, whatever it holds", () => {
    expect(Bug.scrub({ apiKey: { nested: "structure" }, cookie: "sid", token: 42, note: "fine" }))
      .toEqual({ apiKey: "[REDACTED]", cookie: "[REDACTED]", token: "[REDACTED]", note: "fine" })
  })

  it("retains the report-only dsn and connection key coverage", () => {
    expect(Bug.scrub({ dsn: "postgres://db", connectionDetails: { host: "internal" } }))
      .toEqual({ dsn: Redaction.placeholder, connectionDetails: Redaction.placeholder })
  })

  it("recurses through arrays and objects", () => {
    expect(Bug.scrub({ runs: [{ id: 1, env: "OPENAI_API_KEY=abc123" }] }))
      .toEqual({ runs: [{ id: 1, env: "OPENAI_API_KEY=[REDACTED]" }] })
  })

  it("passes non-string leaves through", () => {
    expect(Bug.scrub([1, true, null, undefined])).toEqual([1, true, null, undefined])
  })
})

describe("the report", () => {
  it("uses the journal rules as the oracle for every posted string", () => {
    const credential = FastCheck.constantFrom(
      "Bearer abcdefghijk",
      "sk-abcdefghijk",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      "github_pat_11ABCDEFG0abcdefghijklmnop",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-1234567890-abcdef",
      `AIza${"a".repeat(35)}`,
      "api_key=lowercase-secret",
      "postgres://user:hunter2@db.internal/app"
    )
    FastCheck.assert(
      FastCheck.property(credential, FastCheck.integer(), (secret, nonce) => {
        const text = `probe-${nonce}:${secret}:end`
        const oracle = Redaction.redact(text)
        expect(oracle).not.toBe(text)

        const posted = Bug.report({
          summary: text,
          version: "1.0.0-rc.0",
          platform: "test",
          node: "test",
          runs: [{ text }]
        })

        expect(posted.summary).toBe(oracle)
        expect(JSON.stringify(posted)).not.toContain(text)
      }),
      { numRuns: 50 }
    )
  })

  it("is scrubbed before it leaves the machine", () => {
    const report = Bug.report({
      summary: "run failed with ANTHROPIC_API_KEY=sk-abcdefghijkl",
      version: "1.0.0-rc.0",
      platform: "darwin-arm64",
      node: "24.0.0",
      runs: [{ runId: "run-1", token: "secret" }]
    })

    expect(report.summary).toContain("[REDACTED]")
    expect(report.summary).not.toContain("sk-abcdefghijkl")
    expect((report.runs as ReadonlyArray<Record<string, unknown>>)[0]).toEqual({
      runId: "run-1",
      token: "[REDACTED]"
    })
  })

  it("refuses an accessor without invoking it", () => {
    let reads = 0
    const run: Record<string, unknown> = {}
    Object.defineProperty(run, "detail", {
      enumerable: true,
      get: () => {
        reads += 1
        return "api_key=must-not-be-read"
      }
    })

    expect(() =>
      Bug.report({
        summary: "failed",
        version: "1",
        platform: "test",
        node: "test",
        runs: [run]
      })
    ).toThrow(/accessor/)
    expect(reads).toBe(0)
  })

  it("collapses a cycle instead of recursing forever", () => {
    const run: Record<string, unknown> = { runId: "run-1" }
    run["self"] = run

    const posted = Bug.report({
      summary: "failed",
      version: "1",
      platform: "test",
      node: "test",
      runs: [run]
    })

    expect((posted.runs as ReadonlyArray<Record<string, unknown>>)[0]?.["self"]).toBe("[Circular]")
  })

  it("refuses values outside the journal walk bounds", () => {
    let deep: unknown = "leaf"
    for (let index = 0; index <= Redaction.maxDepth; index++) deep = { deep }

    expect(() => Bug.report({ summary: "failed", version: "1", platform: "test", node: "test", runs: deep })).toThrow(
      /depth limit/
    )
    expect(() =>
      Bug.report({
        summary: "failed",
        version: "1",
        platform: "test",
        node: "test",
        runs: new Uint8Array(Redaction.binaryWalkLimit + 1)
      })
    ).toThrow(/byte walk limit/)
  })

  it("names the default endpoint and a finite timeout", () => {
    expect(Bug.defaultEndpoint).toBe("https://bug.smithers.sh/api/bugs")
    expect(Bug.timeoutMs).toBe(15_000)
  })
})
