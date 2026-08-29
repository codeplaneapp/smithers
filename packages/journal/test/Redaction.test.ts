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

  it("redactJsonString returns the input when it cannot re-encode it", () => {
    expect(Redaction.redactJsonString("{ not json", Redaction.make())).toBe("{ not json")
    // A redactor that drops the value entirely has nothing to encode; the
    // caller's already-validated JSON is kept rather than corrupted.
    expect(Redaction.redactJsonString(`{"a":1}`, () => undefined)).toBe(`{"a":1}`)
    expect(Redaction.redactJsonString(`{"token":"raw"}`, Redaction.make())).toBe(
      `{"token":"${Redaction.placeholder}"}`
    )
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
