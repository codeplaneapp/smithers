import type { RawInbound } from "@smthrs/control/Channels"
import { Effect, Redacted, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Core from "../src/core/Channel.ts"
import { isIntegrationError } from "../src/core/IntegrationError.ts"
import { computeHmacSha256Hex } from "../src/core/Signature.ts"
import * as Payload from "../src/github/Payload.ts"
import * as GitHubWebhook from "../src/github/Webhook.ts"
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

// Carries the association a real delivery carries. `decode` gates the sender,
// so a fixture without one is a delivery the door refuses, not a neutral one.
const pullRequest = {
  action: "opened",
  pull_request: { number: 12, author_association: "OWNER" },
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
    const payload = { action: "created", comment: { author_association: "OWNER" } }
    expect(decode(raw(payload, { "x-github-event": "issue_comment" }), payload).dedupeKey)
      .toBe("delivery-1:integration:github:issue_comment.created:*")
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

describe("sender policy", () => {
  const comment = (association: string | undefined, sender?: Record<string, unknown>) => ({
    action: "created",
    issue: { number: 12 },
    comment: association === undefined ? { body: "/fix" } : { body: "/fix", author_association: association },
    repository: { full_name: "smithersai/smithers" },
    ...(sender === undefined ? {} : { sender })
  })

  const decodeComment = (payload: unknown, policy?: { readonly allowedAssociations?: ReadonlyArray<string> }) =>
    decode(raw(payload, { "x-github-event": "issue_comment" }), payload, 1_700_000_000_000, policy)

  it("admits a comment from an account with write access", () => {
    expect(decodeComment(comment("OWNER")).correlationId).toBe("smithersai/smithers#12")
    expect(decodeComment(comment("MEMBER")).correlationId).toBe("smithersai/smithers#12")
    expect(decodeComment(comment("COLLABORATOR")).correlationId).toBe("smithersai/smithers#12")
  })

  it("refuses a comment from an account with no association to the repository", () => {
    expect(() => decodeComment(comment("NONE"))).toThrow(/author_association/)
  })

  it("refuses a drive-by contributor, the public-repo case that motivated the gate", () => {
    expect(() => decodeComment(comment("CONTRIBUTOR"))).toThrow(/author_association/)
  })

  it("classifies the refusal as permission-denied", () => {
    try {
      decodeComment(comment("NONE"))
      expect.unreachable("a NONE association must not decode")
    } catch (error) {
      expect(isIntegrationError(error) ? error.reason : undefined).toBe("permission-denied")
    }
  })

  it("fails closed when an author-attributed delivery carries no association at all", () => {
    expect(() => decodeComment(comment(undefined))).toThrow(/author_association/)
  })

  it("refuses a bot even when its association is allowed", () => {
    expect(() => decodeComment(comment("OWNER", { login: "dependabot[bot]", type: "Bot" })))
      .toThrow(/Bot/)
  })

  it("admits a human sender named alongside an allowed association", () => {
    expect(decodeComment(comment("OWNER", { login: "will", type: "User" })).eventName)
      .toBe("integration:github:issue_comment.created")
  })

  it("honours a caller-widened association list", () => {
    expect(decodeComment(comment("CONTRIBUTOR"), { allowedAssociations: ["CONTRIBUTOR"] }).correlationId)
      .toBe("smithersai/smithers#12")
  })

  it("refuses every sender when the caller empties the list", () => {
    expect(() => decodeComment(comment("OWNER"), { allowedAssociations: [] })).toThrow(/author_association/)
  })

  it("compares the association without regard to case", () => {
    expect(decodeComment(comment("owner")).correlationId).toBe("smithersai/smithers#12")
  })

  it("fails closed for events without an association", () => {
    const push = { ref: "refs/heads/main", repository: { full_name: "smithersai/smithers" } }
    expect(() => decode(raw(push, { "x-github-event": "push" }), push)).toThrow(/author_association/)
  })

  it("does not borrow an issue author's association for a comment missing its own", () => {
    const payload = { ...comment(undefined), issue: { number: 12, author_association: "OWNER" } }
    expect(() => decodeComment(payload)).toThrow(/author_association/)
  })

  it("refuses bots even when the event has no author association", () => {
    const payload = { sender: { type: "Bot" } }
    expect(() => decode(raw(payload, { "x-github-event": "push" }), payload)).toThrow(/Bot/)
  })

  it("exposes typed skip reasons", () => {
    expect(GitHubWebhook.senderRefusal("issue_comment", comment(undefined)))
      .toMatchObject({ reason: "permission-denied", skipReason: "missing-association" })
    expect(GitHubWebhook.senderRefusal("issue_comment", comment("NONE")))
      .toMatchObject({ reason: "permission-denied", skipReason: "association-not-allowed" })
    expect(GitHubWebhook.senderRefusal("issue_comment", comment("OWNER", { type: "Bot" })))
      .toMatchObject({ reason: "permission-denied", skipReason: "bot-sender" })
  })

  it("still refuses a disallowed association on an event it does not otherwise gate", () => {
    const starred = {
      action: "created",
      repository: { full_name: "smithersai/smithers" },
      author_association: "NONE"
    }
    expect(() => decode(raw(starred, { "x-github-event": "star" }), starred)).toThrow(/author_association/)
  })

  it("gates the channel door with the configured list", async () => {
    const payload = comment("CONTRIBUTOR")
    const body = JSON.stringify(payload)
    const delivery: RawInbound = {
      body: new TextEncoder().encode(body),
      headers: {
        "x-github-event": "issue_comment",
        "x-github-delivery": "delivery-9",
        "x-hub-signature-256": `sha256=${computeHmacSha256Hex(body, SECRET)}`
      },
      idempotencyKey: "delivery-9"
    }
    const refused = GitHubWebhook.channel({
      credential: Redacted.make({ id: "c", name: "github-webhook" }),
      secret: Core.constantSecret(Redacted.make(SECRET)),
      route: Core.startFlow("triage")
    })
    const admitted = GitHubWebhook.channel({
      credential: Redacted.make({ id: "c", name: "github-webhook" }),
      secret: Core.constantSecret(Redacted.make(SECRET)),
      route: Core.startFlow("triage"),
      allowedAssociations: ["CONTRIBUTOR"]
    })
    const refusal = await Effect.runPromise(Effect.exit(refused.decode(delivery) as Effect.Effect<unknown, unknown>))
    expect(refusal._tag).toBe("Failure")
    const accepted = await Effect.runPromise(Effect.exit(admitted.decode(delivery) as Effect.Effect<unknown, unknown>))
    expect(accepted._tag).toBe("Success")
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
