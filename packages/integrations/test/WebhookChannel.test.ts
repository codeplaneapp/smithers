import * as Channels from "@smthrs/control/Channels"
import * as Control from "@smthrs/control/Control"
import { Unauthorized } from "@smthrs/control/ControlError"
import { Effect, Layer, Redacted, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Core from "../src/core/Channel.ts"
import { computeHmacSha256Hex } from "../src/core/Signature.ts"
import * as GitHubWebhook from "../src/github/Webhook.ts"
import * as LinearWebhook from "../src/linear/Webhook.ts"

const SECRET = "shared-secret-correct"
const WRONG_SECRET = "shared-secret-wrong"
const CREDENTIAL = Redacted.make({ id: "github-webhook", name: "github-webhook" })
const accepted = { _tag: "Accepted" as const, receiptId: "receipt" }

/** A real `Channels` coordinator over a Control that records what it is asked. */
const controlLayer = (calls: Array<string>) =>
  Layer.succeed(
    Control.Control,
    Control.make({
      plan: () => {
        calls.push("plan")
        return Effect.succeed({
          planId: "plan",
          flowId: "flow",
          digest: "digest",
          inputSummary: "input",
          envelope: { capabilities: [], flows: [], budget: {} },
          deployClass: false,
          nodes: [],
          approval: {
            target: {
              _tag: "Plan",
              planId: "plan",
              digest: "digest",
              envelope: { capabilities: [], flows: [], budget: {} }
            },
            scope: "run",
            idempotencyKey: "approve:plan"
          }
        })
      },
      run: () => {
        calls.push("run")
        return Effect.succeed(accepted)
      },
      signal: () => {
        calls.push("signal")
        return Effect.succeed(accepted)
      },
      approve: () => Effect.die("unused"),
      deny: () => Effect.die("unused"),
      steer: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      pause: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      watch: () => Stream.empty
    })
  )

const ingest = (
  channel: Channels.Channel,
  raw: Channels.RawInbound,
  calls: Array<string> = []
): Promise<{ readonly _tag: "Success" | "Failure" }> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const channels = yield* Channels.Channels
      yield* channels.register(channel)
      return yield* Effect.exit(channels.ingest({ channel: channel.name, raw }))
    }).pipe(
      Effect.provide(Channels.layer.pipe(Layer.provide(controlLayer(calls))))
    ) as Effect.Effect<{ readonly _tag: "Success" | "Failure" }>
  )

/**
 * Ingests the same delivery twice through ONE `Channels` instance.
 *
 * Building the layer per call would give each ingest its own replay set, which
 * is exactly the thing this helper exists to not do.
 */
const ingestTwice = (
  channel: Channels.Channel,
  raw: Channels.RawInbound,
  calls: Array<string> = []
): Promise<ReadonlyArray<{ readonly _tag: string }>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const channels = yield* Channels.Channels
      yield* channels.register(channel)
      const first = yield* channels.ingest({ channel: channel.name, raw })
      const second = yield* channels.ingest({ channel: channel.name, raw })
      return [first, second]
    }).pipe(
      Effect.provide(Channels.layer.pipe(Layer.provide(controlLayer(calls)))),
      // Both deliveries verify, so a control failure here is a defect in the
      // test rather than an outcome worth asserting on.
      Effect.orDie
    )
  ) as Promise<ReadonlyArray<{ readonly _tag: string }>>

const bytes = (value: string) => new TextEncoder().encode(value)

const githubChannel = (secret = SECRET) =>
  GitHubWebhook.channel({
    credential: CREDENTIAL,
    secret: Core.constantSecret(Redacted.make(secret)),
    route: Core.startFlow("triage")
  })

const githubDelivery = (body: string, signature: string): Channels.RawInbound => ({
  body: bytes(body),
  headers: {
    "x-github-event": "issues",
    "x-github-delivery": "delivery-1",
    "x-hub-signature-256": signature
  },
  idempotencyKey: "delivery-1"
})

const ISSUE_BODY = JSON.stringify({
  action: "opened",
  issue: { number: 12 },
  repository: { full_name: "smithersai/smithers" }
})

// This is the requirement the 0.x end-to-end fault case `case17-webhook-bad-signature`
// pinned against the deleted gateway. The gateway is gone; the requirement is
// not, so it is re-pinned here against the channel that replaced it.
describe("case 17: a WebhookChannel bound with the GitHub verifier rejects a bad signature", () => {
  it("refuses a sha256= signature computed with a different secret", async () => {
    const calls: Array<string> = []
    const signature = `sha256=${computeHmacSha256Hex(ISSUE_BODY, WRONG_SECRET)}`
    const exit = await ingest(githubChannel(), githubDelivery(ISSUE_BODY, signature), calls)
    expect(exit._tag).toBe("Failure")
    // Verification is the amplification guard: nothing downstream ran.
    expect(calls).toEqual([])
  })

  it("reports the refusal as Unauthorized and names no digest", async () => {
    const exit = await ingest(
      githubChannel(),
      githubDelivery(ISSUE_BODY, `sha256=${computeHmacSha256Hex(ISSUE_BODY, WRONG_SECRET)}`)
    )
    const failure = JSON.stringify(exit)
    expect(failure).toContain("unauthorized")
    expect(failure).not.toContain(computeHmacSha256Hex(ISSUE_BODY, SECRET))
  })

  // The near-miss case: a digest correct except for its last character is what
  // a byte-at-a-time timing attack produces, and the constant-time compare in
  // `core/Signature` is what makes it indistinguishable from any other miss.
  it("refuses a digest that differs only in its final character", async () => {
    const digest = computeHmacSha256Hex(ISSUE_BODY, SECRET)
    const tampered = `sha256=${digest.slice(0, -1)}${digest.endsWith("a") ? "b" : "a"}`
    const exit = await ingest(githubChannel(), githubDelivery(ISSUE_BODY, tampered))
    expect(exit._tag).toBe("Failure")
  })

  it("refuses a delivery with no signature header at all", async () => {
    const exit = await ingest(githubChannel(), {
      body: bytes(ISSUE_BODY),
      headers: { "x-github-event": "issues", "x-github-delivery": "delivery-1" },
      idempotencyKey: "delivery-1"
    })
    expect(exit._tag).toBe("Failure")
  })

  it("accepts the correctly signed delivery and starts the flow", async () => {
    const calls: Array<string> = []
    const signature = `sha256=${computeHmacSha256Hex(ISSUE_BODY, SECRET)}`
    const exit = await ingest(githubChannel(), githubDelivery(ISSUE_BODY, signature), calls)
    expect(exit._tag).toBe("Success")
    expect(calls).toEqual(["plan", "run"])
  })
})

// The 0.x `deliverEvents` pinned "dedupes redeliveries by (source,
// dedupeKey)". `deliverEvents` is gone; a webhook provider still retries a
// delivery it did not see acknowledged, so the requirement moved to the
// channel and is pinned here rather than assumed.
describe("redelivery", () => {
  it("applies a correctly signed delivery once and reports the retry as AlreadyApplied", async () => {
    const calls: Array<string> = []
    const signature = `sha256=${computeHmacSha256Hex(ISSUE_BODY, SECRET)}`
    const receipts = await ingestTwice(githubChannel(), githubDelivery(ISSUE_BODY, signature), calls)
    // The second delivery carries the same `x-github-delivery`, so it is the
    // same idempotency key and must not start a second run.
    expect(calls).toEqual(["plan", "run"])
    expect(receipts[0]?._tag).toBe("Accepted")
    expect(receipts[1]?._tag).toBe("AlreadyApplied")
  })

  it("treats a different delivery id as a new delivery", async () => {
    const calls: Array<string> = []
    const signature = `sha256=${computeHmacSha256Hex(ISSUE_BODY, SECRET)}`
    const channel = githubChannel()
    const receipts = await Effect.runPromise(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        const first = yield* channels.ingest({
          channel: channel.name,
          raw: githubDelivery(ISSUE_BODY, signature)
        })
        const second = yield* channels.ingest({
          channel: channel.name,
          raw: { ...githubDelivery(ISSUE_BODY, signature), idempotencyKey: "delivery-2" }
        })
        return [first, second]
      }).pipe(
        Effect.provide(Channels.layer.pipe(Layer.provide(controlLayer(calls)))),
        Effect.orDie
      )
    )
    expect(calls).toEqual(["plan", "run", "plan", "run"])
    expect(receipts.map((receipt) => receipt._tag)).toEqual(["Accepted", "Accepted"])
  })
})

describe("GitHub channel", () => {
  it("refuses a verified delivery whose GitHub headers are missing", async () => {
    const calls: Array<string> = []
    const exit = await ingest(githubChannel(), {
      body: bytes(ISSUE_BODY),
      headers: { "x-hub-signature-256": `sha256=${computeHmacSha256Hex(ISSUE_BODY, SECRET)}` },
      idempotencyKey: "delivery-1"
    }, calls)
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("X-GitHub-Event")
    expect(calls).toEqual([])
  })

  it("refuses a verified delivery whose body is not JSON", async () => {
    const body = "not json"
    const exit = await ingest(
      githubChannel(),
      githubDelivery(body, `sha256=${computeHmacSha256Hex(body, SECRET)}`)
    )
    expect(exit._tag).toBe("Failure")
  })

  it("signals an addressed run when the route says so", async () => {
    const calls: Array<string> = []
    const channel = GitHubWebhook.channel({
      credential: CREDENTIAL,
      secret: Core.constantSecret(Redacted.make(SECRET)),
      route: Core.signalRun("run-1")
    })
    const exit = await ingest(
      channel,
      githubDelivery(ISSUE_BODY, `sha256=${computeHmacSha256Hex(ISSUE_BODY, SECRET)}`),
      calls
    )
    expect(exit._tag).toBe("Success")
    expect(calls).toEqual(["signal"])
  })

  it("takes a channel name and projects nothing by default", () => {
    const channel = GitHubWebhook.channel({
      name: "github-enterprise",
      credential: CREDENTIAL,
      secret: Core.constantSecret(Redacted.make(SECRET)),
      route: Core.startFlow("triage")
    })
    expect(channel.name).toBe("github-enterprise")
    const projection = channel.project(
      { runId: "r", flowId: "f", status: "running", createdAt: 1, updatedAt: 2 },
      undefined
    )
    expect(projection).toEqual({ cursor: "2", operation: "noop", message: null })
  })

  it("uses the projection a caller supplies", () => {
    const channel = GitHubWebhook.channel({
      credential: CREDENTIAL,
      secret: Core.constantSecret(Redacted.make(SECRET)),
      route: Core.startFlow("triage"),
      project: (run) => ({ cursor: String(run.updatedAt), operation: "post", message: { status: run.status } })
    })
    expect(channel.project({ runId: "r", flowId: "f", status: "running", createdAt: 1, updatedAt: 2 }, undefined))
      .toEqual({ cursor: "2", operation: "post", message: { status: "running" } })
  })
})

const linearBody = (timestampMs: number) =>
  JSON.stringify({
    action: "update",
    type: "Issue",
    data: { id: "issue-uuid", identifier: "ENG-123", team: { key: "ENG" } },
    webhookId: "hook-1",
    webhookTimestamp: timestampMs
  })

const linearDelivery = (body: string, signature: string): Channels.RawInbound => ({
  body: bytes(body),
  headers: { "linear-signature": signature, "linear-delivery": "linear-delivery-1" },
  idempotencyKey: "linear-delivery-1"
})

describe("Linear channel", () => {
  const now = 1_700_000_000_000

  const channel = (options: { readonly maxTimestampSkewMs?: number } = {}) =>
    LinearWebhook.channel({
      credential: Redacted.make({ id: "linear-webhook", name: "linear-webhook" }),
      secret: Core.constantSecret(Redacted.make(SECRET)),
      route: Core.startFlow("triage"),
      nowMs: now,
      ...options
    })

  it("accepts a fresh, correctly signed delivery", async () => {
    const calls: Array<string> = []
    const body = linearBody(now)
    const exit = await ingest(channel(), linearDelivery(body, computeHmacSha256Hex(body, SECRET)), calls)
    expect(exit._tag).toBe("Success")
    expect(calls).toEqual(["plan", "run"])
  })

  it("refuses a delivery signed with a different secret", async () => {
    const calls: Array<string> = []
    const body = linearBody(now)
    const exit = await ingest(channel(), linearDelivery(body, computeHmacSha256Hex(body, WRONG_SECRET)), calls)
    expect(exit._tag).toBe("Failure")
    expect(calls).toEqual([])
  })

  // A valid signature never expires, so without the freshness window a
  // captured delivery could be replayed forever.
  it("refuses a correctly signed delivery whose timestamp is stale", async () => {
    const body = linearBody(now - 120_000)
    const exit = await ingest(channel(), linearDelivery(body, computeHmacSha256Hex(body, SECRET)))
    expect(exit._tag).toBe("Failure")
  })

  it("accepts a stale delivery when the caller widens the window", async () => {
    const body = linearBody(now - 120_000)
    const exit = await ingest(
      channel({ maxTimestampSkewMs: 600_000 }),
      linearDelivery(body, computeHmacSha256Hex(body, SECRET))
    )
    expect(exit._tag).toBe("Success")
  })

  it("refuses a correctly signed delivery with no timestamp, and one that is not JSON", async () => {
    const noTimestamp = JSON.stringify({ action: "update", type: "Issue", data: { id: "x" } })
    expect(
      (await ingest(channel(), linearDelivery(noTimestamp, computeHmacSha256Hex(noTimestamp, SECRET))))._tag
    ).toBe("Failure")
    const notJson = "not json"
    expect(
      (await ingest(channel(), linearDelivery(notJson, computeHmacSha256Hex(notJson, SECRET))))._tag
    ).toBe("Failure")
  })
})

describe("secret resolution", () => {
  it("resolves through the control plane's credential store", async () => {
    const resolver = Core.credentialSecret({
      list: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      resolve: (reference) => Effect.succeed(Redacted.make(`secret-for-${reference.id}`)),
      rotate: () => Effect.die("unused"),
      revoke: () => Effect.die("unused")
    })
    const secret = await Effect.runPromise(resolver(CREDENTIAL))
    expect(Redacted.value(secret)).toBe("secret-for-github-webhook")
  })

  it("reports an unresolvable credential as Unauthorized", async () => {
    const resolver = Core.credentialSecret({
      list: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      resolve: () => Effect.fail(new Unauthorized({ message: "denied" })),
      rotate: () => Effect.die("unused"),
      revoke: () => Effect.die("unused")
    })
    const failure = await Effect.runPromise(Effect.flip(resolver(CREDENTIAL)))
    expect(failure.message).toBe("denied")
  })
})
