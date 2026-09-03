import type { RawInbound } from "@smthrs/control/Channels"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { computeHmacSha256Hex } from "../src/core/Signature.ts"
import * as Payload from "../src/github/Payload.ts"
import { correlations, decode, names, verify } from "../src/github/Webhook.ts"

const SECRET = "shared-secret-correct"

const raw = (body: unknown, headers: Record<string, string | undefined> = {}): RawInbound => {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  return {
    body: new TextEncoder().encode(text),
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": `sha256=${computeHmacSha256Hex(text, SECRET)}`,
      ...headers
    },
    idempotencyKey: "delivery-1"
  }
}

const pullRequest = {
  action: "opened",
  pull_request: { number: 12 },
  repository: { full_name: "smithersai/smithers" }
}

describe("verify", () => {
  it("accepts the signature over the exact delivered bytes", () => {
    expect(verify(raw(pullRequest), SECRET)).toBe(true)
  })

  it("rejects a signature over a re-serialized body", () => {
    const text = JSON.stringify(pullRequest)
    const delivery: RawInbound = {
      body: new TextEncoder().encode(`${text}\n`),
      headers: { "x-hub-signature-256": `sha256=${computeHmacSha256Hex(text, SECRET)}` },
      idempotencyKey: "d"
    }
    expect(verify(delivery, SECRET)).toBe(false)
  })

  it("reads the header case-insensitively", () => {
    const text = JSON.stringify(pullRequest)
    const delivery: RawInbound = {
      body: new TextEncoder().encode(text),
      headers: { "X-Hub-Signature-256": `sha256=${computeHmacSha256Hex(text, SECRET)}` },
      idempotencyKey: "d"
    }
    expect(verify(delivery, SECRET)).toBe(true)
  })
})

describe("names", () => {
  it("puts the per-action variant ahead of the bare event", () => {
    expect(names("pull_request", pullRequest)).toEqual([
      "integration:github:pull_request.opened",
      "integration:github:pull_request"
    ])
  })

  it("has only the bare event when the payload has no action", () => {
    expect(names("push", { ref: "refs/heads/main" })).toEqual(["integration:github:push"])
  })
})

describe("correlations", () => {
  it("orders repository-and-number, repository, then null", () => {
    expect(correlations(pullRequest)).toEqual(["smithersai/smithers#12", "smithersai/smithers", null])
  })

  it("reads the number from an issue and from a bare number field", () => {
    expect(correlations({ issue: { number: 3 }, repository: { full_name: "o/r" } })[0]).toBe("o/r#3")
    expect(correlations({ number: 4, repository: { full_name: "o/r" } })[0]).toBe("o/r#4")
  })

  it("drops the number when the payload has none", () => {
    expect(correlations({ repository: { full_name: "o/r" } })).toEqual(["o/r", null])
  })

  it("falls back to null when the repository is missing or malformed", () => {
    expect(correlations({})).toEqual([null])
    expect(correlations({ repository: { full_name: "no-slash" } })).toEqual([null])
  })
})

describe("decode", () => {
  it("produces one event named and correlated at the most specific form", () => {
    const event = decode(raw(pullRequest), pullRequest, 1_700_000_000_000)
    expect(event).toEqual({
      source: "github",
      eventName: "integration:github:pull_request.opened",
      correlationId: "smithersai/smithers#12",
      payload: pullRequest,
      dedupeKey: "delivery-1:integration:github:pull_request.opened:smithersai/smithers#12",
      receivedAtMs: 1_700_000_000_000
    })
  })

  it("marks an uncorrelated delivery in the dedupe key", () => {
    const push = { ref: "refs/heads/main" }
    expect(decode(raw(push, { "x-github-event": "push" }), push).dedupeKey)
      .toBe("delivery-1:integration:github:push:*")
  })

  it("refuses a delivery with no X-GitHub-Event header", () => {
    expect(() => decode(raw(pullRequest, { "x-github-event": undefined }), pullRequest))
      .toThrow(/X-GitHub-Event/)
  })

  it("refuses a delivery with no X-GitHub-Delivery header", () => {
    expect(() => decode(raw(pullRequest, { "x-github-delivery": undefined }), pullRequest))
      .toThrow(/X-GitHub-Delivery/)
  })
})

describe("payload schemas", () => {
  const decodeWith = <A>(schema: Schema.Schema<A>, value: unknown) =>
    Effect.runPromise(
      Effect.exit(Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<A, unknown>)
    )

  it("passes unmodelled fields through untouched", async () => {
    const delivery = {
      action: "opened",
      pull_request: { number: 12, some_new_field: true },
      repository: { full_name: "o/r" },
      unheard_of: { nested: 1 }
    }
    const exit = await decodeWith(Payload.PullRequestEvent, delivery)
    expect(exit._tag).toBe("Success")
    expect(exit._tag === "Success" ? exit.value : undefined).toEqual(delivery)
  })

  it("still rejects a modelled field of the wrong type", async () => {
    const exit = await decodeWith(Payload.PullRequestEvent, {
      action: "opened",
      pull_request: { number: "twelve" },
      repository: { full_name: "o/r" }
    })
    expect(exit._tag).toBe("Failure")
  })

  it("types the issue, comment, and push deliveries", async () => {
    expect(
      (await decodeWith(Payload.IssuesEvent, {
        action: "opened",
        issue: { number: 1 },
        repository: { full_name: "o/r" }
      }))._tag
    ).toBe("Success")
    expect(
      (await decodeWith(Payload.IssueCommentEvent, {
        action: "created",
        issue: { number: 1 },
        comment: { body: "hi" },
        repository: { full_name: "o/r" }
      }))._tag
    ).toBe("Success")
    expect(
      (await decodeWith(Payload.PushEvent, {
        ref: "refs/heads/main",
        repository: { full_name: "o/r" },
        commits: [{ id: "abc", message: "m" }],
        pusher: { name: "will" }
      }))._tag
    ).toBe("Success")
  })
})
