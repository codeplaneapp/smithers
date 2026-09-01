import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Journal } from "../src/Journal.ts"
import { Input, type RunId, type SourceId } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as Redaction from "../src/Redaction.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const input = (run: RunId, source: SourceId, eventType: string, payload: unknown, meta?: unknown): Input =>
  new Input({
    runId: run,
    sourceId: source,
    eventType,
    payload,
    ...(meta === undefined ? {} : { meta })
  }, { disableChecks: true })

const journalLayer = (options?: SqlJournal.SqlJournalOptions) =>
  SqlJournal.layer(options ?? { capacity: 8, overflow: "reject" }).pipe(
    Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
  ) as Layer.Layer<Journal | DurableWriter | SqlClient.SqlClient>

const effect = <E>(name: string, body: () => Effect.Effect<void, E>) =>
  it.effect(name, () => body().pipe(Effect.provide(TestClock.layer())))

const nestedValue = (depth: number, leaf: unknown = "leaf"): unknown => {
  let value = leaf
  for (let index = 0; index < depth; index++) value = { nested: value }
  return value
}

interface RedactionHazard {
  readonly id: string
  readonly field: "payload" | "meta"
  readonly make: (secret: string) => unknown
}

const redactionHazards: ReadonlyArray<RedactionHazard> = [
  {
    id: "throwing-getter-payload",
    field: "payload",
    make: (secret) => ({
      visible: secret,
      get boom(): never {
        throw new Error("getter blew up")
      }
    })
  },
  {
    id: "throwing-getter-meta",
    field: "meta",
    make: (secret) => ({
      visible: secret,
      get boom(): never {
        throw new Error("getter blew up")
      }
    })
  },
  {
    id: "hostile-proxy",
    field: "payload",
    make: (secret) =>
      new Proxy({ visible: secret }, {
        ownKeys: () => {
          throw new Error("ownKeys blew up")
        }
      })
  },
  {
    id: "throwing-to-json",
    field: "payload",
    make: (secret) => ({
      visible: secret,
      toJSON: () => {
        throw new Error("toJSON blew up")
      }
    })
  },
  {
    id: "excessive-depth",
    field: "payload",
    make: (secret) => nestedValue(Redaction.maxDepth + 1, secret)
  }
]

const assertHazardFailures = (channel: "durable" | "lossy"): Effect.Effect<void, unknown, Journal> =>
  Effect.gen(function*() {
    const journal = yield* Journal
    for (const hazard of redactionHazards) {
      const secret = `secret-${channel}-${hazard.id}`
      const run = runId(`${channel}-${hazard.id}`)
      const hostile = hazard.make(secret)
      const bad = hazard.field === "payload"
        ? input(run, sourceId("hostile"), "hostile", hostile)
        : input(run, sourceId("hostile"), "hostile", { safe: true }, hostile)
      const failure = yield* Effect.flip(
        channel === "durable" ? journal.emitDurableUnfenced(bad) : journal.emitLossy(bad)
      )
      expect(failure.code).toBe("invalid_event")
      expect(failure.message).toBe(`${hazard.field} could not be redacted`)
      expect(JSON.stringify(failure)).not.toContain(secret)

      const good = input(run, sourceId("healthy"), "healthy", { status: "ok" })
      if (channel === "durable") {
        yield* journal.emitDurableUnfenced(good)
      } else {
        yield* journal.emitLossy(good)
        yield* journal.flush
      }
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries.map((entry) => entry.payload)).toEqual([{ status: "ok" }])
    }
  })

describe("Redaction", () => {
  it("redacts credential-named fields wholesale", () => {
    expect(
      Redaction.redact({ apiKey: "sk-ant-api03-abcdefgh", nested: { "x-api-key": "abc", safe: 7 } })
    ).toEqual({
      apiKey: Redaction.placeholder,
      nested: { "x-api-key": Redaction.placeholder, safe: 7 }
    })
  })

  it("redacts credential-shaped strings anywhere in the payload", () => {
    expect(
      Redaction.redact({
        headers: ["Authorization: Bearer abcdefghijkl"],
        note: "use sk-proj-abcdefghij when calling",
        env: "ANTHROPIC_API_KEY=shhh"
      })
    ).toEqual({
      headers: ["Authorization: Bearer [REDACTED_TOKEN]"],
      note: "use [REDACTED_API_KEY] when calling",
      env: `ANTHROPIC_API_KEY=${Redaction.placeholder}`
    })
  })

  it.each([
    ["GitHub token", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", Redaction.placeholder],
    ["GitHub fine-grained token", "github_pat_11ABCDEFG0abcdefghijklmnop", Redaction.placeholder],
    ["AWS access key", "AKIAIOSFODNN7EXAMPLE", Redaction.placeholder],
    ["Slack token", "xoxb-123456789012-123456789012-abcdefghijkl", Redaction.placeholder],
    ["Google API key", "AIzaSyA1234567890abcdefghijklmnopqrstuvw", Redaction.placeholder],
    [
      "URL password",
      "postgres://admin:hunter2@db.internal:5432/app",
      `postgres://admin:${Redaction.placeholder}@db.internal:5432/app`
    ],
    [
      "embedded JSON token",
      `log line: {"apiToken":"abcd1234efgh5678"}`,
      `log line: {"apiToken":"${Redaction.placeholder}"}`
    ],
    ["double-quoted assignment", `PASSWORD="dummy secret"`, `PASSWORD=${Redaction.placeholder}`],
    ["single-quoted assignment", `TOKEN='dummy secret'`, `TOKEN=${Redaction.placeholder}`],
    ["Bearer token with plus and padding", "Bearer abcdefgh+SENSITIVE==", "Bearer [REDACTED_TOKEN]"],
    ["Bearer token with the full b64token alphabet", "Bearer ab/cd+ef~gh=", "Bearer [REDACTED_TOKEN]"]
  ])("redacts a %s", (_name, source, expected) => {
    expect(Redaction.redact(source)).toBe(expected)
  })

  it("redacts mixed credential shapes in one string", () => {
    const source =
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 AKIAIOSFODNN7EXAMPLE Bearer ab/cd+ef~gh= postgres://admin:hunter2@db.internal/app"
    expect(Redaction.redact(source)).toBe(
      `${Redaction.placeholder} ${Redaction.placeholder} Bearer [REDACTED_TOKEN] postgres://admin:${Redaction.placeholder}@db.internal/app`
    )
  })

  it("preserves adjacent punctuation and redacts a one-character assignment", () => {
    expect(Redaction.redact("(ghp_ABCDEFGHIJKLMNOPQRST), xoxb-1234567890.; TOKEN=x!"))
      .toBe(`(${Redaction.placeholder}), ${Redaction.placeholder}.; TOKEN=${Redaction.placeholder}`)
  })

  it.each([
    ["provider API key", "sk-1234567", "sk-12345678"],
    ["Bearer token", "Bearer abc", "Bearer ab/c"],
    ["GitHub token", `ghp_${"A".repeat(19)}`, `ghp_${"A".repeat(20)}`],
    ["GitHub fine-grained token", `github_pat_${"A".repeat(19)}`, `github_pat_${"A".repeat(20)}`],
    ["AWS access key", `AKIA${"A".repeat(15)}`, `AKIA${"A".repeat(16)}`],
    ["Slack token", `xoxb-${"A".repeat(9)}`, `xoxb-${"A".repeat(10)}`],
    ["Google API key", `AIza${"A".repeat(34)}`, `AIza${"A".repeat(35)}`]
  ])("enforces the %s minimum on both sides", (_name, below, boundary) => {
    expect(Redaction.redact(below)).toBe(below)
    expect(Redaction.redact(boundary)).not.toBe(boundary)
  })

  it("covers every incident-derived textual rule used by Bug.ts", () => {
    // packages/cli/src/Bug.ts is the source of truth. These literals cover
    // every scrubText rule without importing the CLI into the journal package.
    const bugScrubSamples = [
      "postgres://admin:hunter2@db.internal:5432/app",
      "Authorization: Bearer ab/cd+ef~gh=",
      "sk-abcdefgh",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      "github_pat_11ABCDEFG0abcdefghijklmnop",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-123456789012-123456789012-abcdefghijkl",
      "AIzaSyA1234567890abcdefghijklmnopqrstuvw",
      `SERVICE_CREDENTIAL="dummy secret"`,
      `log line: {"apiToken":"abcd1234efgh5678"}`
    ]
    for (const sample of bugScrubSamples) expect(Redaction.redact(sample)).not.toBe(sample)
  })

  it("keeps every built-in textual rule global", () => {
    expect(Redaction.defaultRules.every((rule) => rule.pattern.flags.includes("g"))).toBe(true)
  })

  it("leaves non-credential data untouched and survives cycles", () => {
    const cyclic: Record<string, unknown> = { count: 3, flag: false, text: "plain" }
    cyclic["self"] = cyclic
    expect(Redaction.redact(cyclic)).toEqual({
      count: 3,
      flag: false,
      text: "plain",
      self: "[Circular]"
    })
  })

  it("mirrors JSON.stringify for Date and toJSON values, and names a callable", () => {
    const instant = "2020-01-01T00:00:00.000Z"
    const date = new Date(instant)
    expect(Redaction.redact(date)).toBe(instant)
    expect(Redaction.redact({ at: date, n: 1 })).toEqual({ at: instant, n: 1 })

    const own = {
      ignored: true,
      toJSON: () => ({ note: "Bearer abcdefgh" })
    }
    expect(Redaction.redact(own)).toEqual({ note: "Bearer [REDACTED_TOKEN]" })

    const prototype = { toJSON: () => ({ note: "sk-abcdefgh" }) }
    const inherited = Object.assign(Object.create(prototype) as Record<string, unknown>, { ignored: true })
    expect(Redaction.redact(inherited)).toEqual({ note: "[REDACTED_API_KEY]" })

    const selfReturning: { toJSON?: () => unknown } = {}
    selfReturning.toJSON = () => selfReturning
    expect(Redaction.redact(selfReturning)).toBe("[Circular]")

    // Re-pinned 2026-09-01: these expected `{ safe: 1 }` and the function
    // itself, which was the mirror of `JSON.stringify` for a callable. A
    // function is now NAMED instead, ahead of the `toJSON` branch, because
    // neither its body nor its own properties are text the walk can rewrite in
    // place and a renderer prints all of it: `[Function: deploy] { token:
    // "sk-..." }` reached the operator's terminal that way. Naming costs the
    // `toJSON` parity for a callable, which no journal payload has, and buys a
    // shape carrying no caller text at all.
    const callable = Object.assign(() => "ignored", { toJSON: () => ({ safe: 1 }) })
    expect(Redaction.redact(callable)).toBe(Redaction.functionMarker)
    const plainCallable = () => "kept"
    expect(Redaction.redact(plainCallable)).toBe(Redaction.functionMarker)
  })

  it("accepts a value at the depth bound and rejects one beyond it", () => {
    expect(() => Redaction.redact(nestedValue(Redaction.maxDepth))).not.toThrow()
    expect(() => Redaction.redact(nestedValue(Redaction.maxDepth + 1))).toThrow(
      `redaction depth exceeds ${Redaction.maxDepth}`
    )
  })

  it("keeps a literal __proto__ member a member", () => {
    // Assigning the rebuilt field by key would reach the inherited setter:
    // the member disappears from the payload and lands on the result's
    // prototype instead, so a redacted payload stops matching itself.
    const payload = { ["__proto__"]: { token: "sk-abcdefghij" }, keep: 1 }
    const redacted = Redaction.redact(payload) as Record<string, unknown>
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype)
    expect(Object.keys(redacted)).toEqual(["__proto__", "keep"])
    expect(Object.getOwnPropertyDescriptor(redacted, "__proto__")?.value).toEqual({
      token: Redaction.placeholder
    })
    expect(Redaction.redact(redacted)).toStrictEqual(redacted)
  })

  it("makeNoop persists the value verbatim", () => {
    expect(Redaction.makeNoop()({ token: "raw" })).toEqual({ token: "raw" })
    expect(Redaction.make()({ token: "raw" })).toEqual({ token: Redaction.placeholder })
  })

  effect("never persists a secret through the durable channel", () =>
    Effect.gen(function*() {
      const journal = yield* Journal
      const run = runId("redaction-durable")
      yield* journal.emitDurableUnfenced(
        input(run, sourceId("action"), "action.completed", {
          apiKey: "sk-ant-api03-abcdefgh",
          prompt: "call with Bearer abcdefghijkl"
        }, { authorization: "Bearer abcdefghijkl" })
      )
      const page = yield* journal.entries({ runId: run, limit: 10 })
      const entry = page.entries[0]!
      expect(entry.payload).toEqual({
        apiKey: Redaction.placeholder,
        prompt: "call with Bearer [REDACTED_TOKEN]"
      })
      expect(entry.meta).toEqual({ authorization: Redaction.placeholder })
    }).pipe(Effect.provide(journalLayer()), Effect.scoped))

  effect("persists a Date through its JSON representation", () =>
    Effect.gen(function*() {
      const journal = yield* Journal
      const run = runId("redaction-date")
      yield* journal.emitDurableUnfenced(
        input(run, sourceId("action"), "dated", { at: new Date("2020-01-01T00:00:00.000Z"), n: 1 })
      )
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries[0]!.payload).toEqual({ at: "2020-01-01T00:00:00.000Z", n: 1 })
    }).pipe(Effect.provide(journalLayer()), Effect.scoped))

  effect("never persists a secret through the lossy queue either", () =>
    Effect.gen(function*() {
      const journal = yield* Journal
      const run = runId("redaction-lossy")
      yield* journal.emitLossy(input(run, sourceId("telemetry"), "tool.call", { secret: "hunter2" }))
      yield* journal.flush
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries[0]!.payload).toEqual({ secret: Redaction.placeholder })
    }).pipe(
      Effect.provide(journalLayer({ capacity: 8, overflow: "reject" })),
      Effect.scoped
    ))

  it("applies an empty rule set literally, keeping only the structural redaction", () => {
    // `rules` is caller-supplied, and `[]` is not nullish, so it replaces the
    // defaults rather than falling back to them: no textual rule fires. The
    // by-field-name redaction is not rule-driven and therefore still applies —
    // that split is the contract a custom rule set inherits.
    const redactor = Redaction.make({ rules: [] })
    expect(redactor({ note: "use sk-proj-abcdefghij", apiKey: "sk-proj-abcdefghij" })).toEqual({
      note: "use sk-proj-abcdefghij",
      apiKey: Redaction.placeholder
    })
    // Nothing unexpected is retained either: the default rules are genuinely
    // gone rather than merged in behind the caller's set.
    expect(redactor({ env: "ANTHROPIC_API_KEY=shhh" })).toEqual({ env: "ANTHROPIC_API_KEY=shhh" })
  })

  it("does not leak global regexp state between calls with overlapping rules", () => {
    // Every rule carries a `g` flag, so each `RegExp` object holds a mutable
    // `lastIndex`. Two rules that match overlapping spans of the same string,
    // reused across calls, are where a stale `lastIndex` would show up — as a
    // second call redacting less than the first.
    const rules: ReadonlyArray<Redaction.Rule> = [
      { id: "wide", pattern: /token-[a-z0-9]+/g, replace: "[WIDE]" },
      { id: "narrow", pattern: /[a-z0-9]{6,}/g, replace: "[NARROW]" }
    ]
    const redactor = Redaction.make({ rules })
    const value = { a: "token-abc123 and token-def456", b: "token-abc123 and token-def456" }

    const first = redactor(value)
    const second = redactor(value)
    const third = redactor({ ...value, c: "token-abc123" })

    expect(first).toEqual({
      a: "[WIDE] and [WIDE]",
      b: "[WIDE] and [WIDE]"
    })
    // Identical input, identical output — three times, over two rules that both
    // match every span.
    expect(second).toEqual(first)
    expect(third).toEqual({ ...(first as Record<string, unknown>), c: "[WIDE]" })
    // The shared rule objects are left rewound for the next caller.
    expect(rules.map((rule) => rule.pattern.lastIndex)).toEqual([0, 0])
  })

  it.each([
    ["a match without an equals sign", "my ssn is 123-45-6789", /\d{3}-\d{2}-\d{4}/g, "my ssn is [REDACTED]"],
    ["a match with several equals signs", "value=a=b=c", /value=a=b=c/g, Redaction.placeholder]
  ])("replaces the whole custom-rule match when replace is omitted: %s", (_name, source, pattern, expected) => {
    expect(Redaction.redact(source, { rules: [{ id: "whole", pattern }] })).toBe(expected)
  })

  it("normalizes a non-global custom rule once and redacts every match", () => {
    const pattern = /secretvalue/
    expect(
      Redaction.redact("secretvalue and secretvalue", {
        rules: [{ id: "non-global", pattern, replace: "[X]" }]
      })
    ).toBe("[X] and [X]")
    expect(pattern.lastIndex).toBe(0)
  })

  it("adds global behavior to a sticky custom rule without discarding stickiness", () => {
    const pattern = /secret/y
    expect(
      Redaction.redact("secretsecret tail", {
        rules: [{ id: "sticky", pattern, replace: "[X]" }]
      })
    ).toBe("[X][X] tail")
    expect(pattern.lastIndex).toBe(0)
  })

  it("redactJsonString passes through only input that is not valid JSON", () => {
    expect(Redaction.redactJsonString("{ not json", Redaction.make())).toBe("{ not json")
    expect(Redaction.redactJsonString(`{"token":"raw"}`, Redaction.make())).toBe(
      `{"token":"${Redaction.placeholder}"}`
    )
  })

  it("redactJsonString fails closed after valid JSON has parsed", () => {
    const secret = "s3cr3t-a5"
    const inputJson = JSON.stringify({ password: secret })
    const cycle: Record<string, unknown> = {}
    cycle["self"] = cycle
    const failingRedactors: ReadonlyArray<readonly [string, Redaction.Redactor]> = [
      ["throws", () => {
        throw new Error("redactor blew up")
      }],
      ["returns BigInt", () => ({ big: 1n })],
      ["returns a cycle", () => cycle],
      ["returns an unencodable value", () => undefined]
    ]
    for (const [name, redactor] of failingRedactors) {
      const result = Redaction.redactJsonString(inputJson, redactor)
      expect(result, name).toBe(JSON.stringify(Redaction.placeholder))
      expect(result, name).not.toContain(secret)
    }
  })

  effect(
    "maps durable redaction hazards to typed failures and stays usable",
    () => assertHazardFailures("durable").pipe(Effect.provide(journalLayer()), Effect.scoped)
  )

  effect(
    "maps lossy redaction hazards to typed failures and stays usable",
    () => assertHazardFailures("lossy").pipe(Effect.provide(journalLayer()), Effect.scoped)
  )

  it("scans a long line in linear time", () => {
    // Every rule runs over every logged line and every journal payload, so a
    // rule that rescans is a stall on the hot path. `url-credentials` matched
    // `\b[a-z][a-z0-9+.-]*` before requiring `://`, and `-` is not a word
    // character, so a run of `aaaaaaaa-` gave it 40,000 start positions and it
    // scanned forward from each one: 400 kB took 11 seconds. Every other rule
    // finished the same input in under 2 ms.
    const line = "Bearer " + "aaaaaaaa-".repeat(40_000) + " api_key=" + "b".repeat(200_000)
    expect(line.length).toBeGreaterThan(400_000)
    const redact = Redaction.make()
    const started = Date.now()
    const redacted = String(redact(line))
    // Three orders of magnitude above a linear scan, so machine load cannot
    // fail this, and still finite, which is the whole claim.
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(redacted).toContain(`api_key=${Redaction.placeholder}`)
  })

  it("names a binary view that refuses to describe itself", () => {
    // The description reads two properties off the view, and either can be an
    // own accessor that throws or a prototype the caller removed. Neither is a
    // reason to lose the line, so both fall back to the bare marker.
    const redact = Redaction.make()
    const throwing = new Uint8Array([1, 2])
    Object.defineProperty(throwing, "constructor", {
      get: () => {
        throw new TypeError("no constructor for you")
      },
      configurable: true
    })
    expect(redact(throwing)).toEqual({ [Redaction.binaryMarker]: Redaction.binaryMarker })
    const bare = Object.setPrototypeOf(new Uint8Array([3]), null) as Uint8Array
    expect(redact(bare)).toEqual({ [Redaction.binaryMarker]: Redaction.binaryMarker })
    // Restated 2026-09-01: a caller's own `byteLength` decided the walk here, so
    // this asserted the members were skipped when it threw. That property is
    // not a bound: a getter that merely LIES walked one property per byte and
    // nothing failed. The size is read from the value's internal slot now, and
    // no property a caller writes answers for it, so a throwing own
    // `byteLength` costs nothing, the true size is named, and the member is
    // kept and redacted.
    const sizeless = Object.assign(new Uint8Array([4]), { seat: "token=sk-live-abcdefgh" })
    Object.defineProperty(sizeless, "byteLength", {
      get: () => {
        throw new TypeError("no byteLength for you")
      },
      configurable: true
    })
    expect(redact(sizeless)).toEqual({
      [Redaction.binaryMarker]: "Uint8Array 1 bytes",
      seat: `token=${Redaction.placeholder}`
    })
  })

  effect("keeps payloads verbatim when redaction is disabled", () =>
    Effect.gen(function*() {
      const journal = yield* Journal
      const run = runId("redaction-off")
      yield* journal.emitDurableUnfenced(input(run, sourceId("action"), "raw", { token: "hunter2" }))
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries[0]!.payload).toEqual({ token: "hunter2" })
    }).pipe(
      Effect.provide(
        journalLayer({ capacity: 8, overflow: "reject", redact: Redaction.makeNoop() })
      ),
      Effect.scoped
    ))
})
