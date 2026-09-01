import { CapabilityPattern, parse } from "@smthrs/capability/Capability"
import { evaluate, Rule } from "@smthrs/capability/Permission"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import type * as Event from "../src/Event.ts"
// The barrel is the advertised surface: the seam's own suite reaches the
// author claim the way a host must, not through the `./*` deep subpath.
import { Author, AuthorDeclaration, Authorize, Catalog } from "../src/index.ts"
import { countingEntry, failChain, flow, runChain } from "./harness.ts"

const readEntry = (result: unknown): Catalog.Entry & { count: () => number } => {
  const counting = countingEntry("repo/read", result)
  return { ...counting.entry, capabilities: ["fs:read:src/**"], count: counting.count }
}

const pattern = (action: CapabilityPattern["action"], resource: string): CapabilityPattern =>
  new CapabilityPattern({ action, resource })

const allowAuthor = new Rule({ effect: "allow", pattern: pattern("model:call", "**") })
const allowRead = new Rule({ effect: "allow", pattern: pattern("fs:read", "**") })
const denyAll = new Rule({ effect: "deny", pattern: pattern("*", "**") })
const allowAll = new Rule({ effect: "allow", pattern: pattern("*", "**") })
const denyEtc = new Rule({ effect: "deny", pattern: pattern("fs:write", "/etc/*") })
const allowRepoStar = new Rule({ effect: "allow", pattern: pattern("fs:read", "/repo/*") })
const allowRepoGlob = new Rule({ effect: "allow", pattern: pattern("fs:read", "/repo/**") })
const allowExact = new Rule({ effect: "allow", pattern: pattern("fs:read", "/repo/a.ts") })
const denyMiddleStar = new Rule({ effect: "deny", pattern: pattern("fs:read", "a/*/x") })
const denyWrite = new Rule({ effect: "deny", pattern: pattern("fs:write", "**") })
const allowSrc = new Rule({ effect: "allow", pattern: pattern("fs:read", "src/**") })
const denyVendor = new Rule({ effect: "deny", pattern: pattern("fs:read", "vendor/*") })
const denySecret = new Rule({ effect: "deny", pattern: pattern("fs:write", "secret") })

/** The seam's verdict for one claim, in `Permission.evaluate`'s vocabulary. */
const verdictOf = (
  rules: ReadonlyArray<Rule>,
  claim: string
): Promise<"allow" | "ask" | "deny"> =>
  Effect.runPromise(
    Effect.flatMap(
      Authorize.Authorize,
      (seam) => seam.authorize({ capabilities: [claim], name: "probe", slot: { chain: "", link: 0, ordinal: 0 } })
    ).pipe(
      Effect.as("allow" as const),
      Effect.catchTag(
        "/chain/AuthorizeError",
        (error) => Effect.succeed(error.code === "denied" ? "deny" as const : "ask" as const)
      ),
      Effect.provide(Authorize.layerRules(rules)),
      Effect.orDie
    )
  )

const readScript = flow(
  `const content = await ctx.call("repo/read", { path: "src/a.ts" })`,
  `return done(content)`
)

const authorizeWith = (...rules: ReadonlyArray<Rule>) => Authorize.layerRules(rules)

describe("Authorize", () => {
  it("allows a ruled-in call and journals nothing extra", async () => {
    const entry = readEntry("file body")
    const { events, outcome } = await runChain({
      author: Author.layerMock([readScript]),
      authorize: authorizeWith(allowAuthor, allowRead),
      entries: [entry]
    })
    expect(outcome).toEqual({ _tag: "Done", value: "file body" })
    expect(entry.count()).toBe(1)
    expect(events.some((event) => event._tag === "GateRejected")).toBe(false)
  })

  it("grants everything through an allow-all rule, system entries included", async () => {
    const script = flow(
      `const now = await ctx.call("sys/now")`,
      `const content = await ctx.call("repo/read", { path: "src/a.ts" })`,
      `return done([typeof now, content])`
    )
    const entry = readEntry("file body")
    const { outcome } = await runChain({
      author: Author.layerMock([script]),
      authorize: authorizeWith(allowAll),
      entries: Catalog.withSystem([entry])
    })
    expect(outcome).toEqual({ _tag: "Done", value: ["number", "file body"] })
  })

  it("journals a denial as an observation the next author sees", async () => {
    const entry = readEntry("file body")
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1 ? readScript : flow(`return done("worked around")`)
    })
    const { events, outcome } = await runChain({
      author,
      authorize: authorizeWith(allowAuthor, allowRead, new Rule({ effect: "deny", pattern: pattern("fs:read", "**") })),
      entries: [entry]
    })
    expect(outcome).toEqual({ _tag: "Done", value: "worked around" })
    expect(entry.count()).toBe(0)
    const rejection = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
    expect(rejection.observation.kind).toBe("denied")
    expect(seen[1]?.context.some((line) => line.startsWith("[denied]"))).toBe(true)
  })

  it("parks without LinkEnded on approval, and a regrant resumes through the same link", async () => {
    const entry = readEntry("file body")
    const first = await runChain({
      author: Author.layerMock([readScript]),
      // The author seat is allowed; nothing covers fs:read -> the seam asks.
      authorize: authorizeWith(allowAuthor),
      entries: [entry]
    })
    expect(first.outcome).toEqual({
      _tag: "Park",
      reason: { code: "approval", message: `"repo/read" needs approval for fs:read:src/**` }
    })
    expect(entry.count()).toBe(0)
    // The park is resumable-in-place: no LinkEnded was journaled.
    expect(first.events.some((event) => event._tag === "LinkEnded" && event.link === 1)).toBe(false)

    const regranted = readEntry("file body")
    const resumed = await runChain({
      author: Author.layerMock([]),
      authorize: authorizeWith(allowAuthor, allowRead),
      entries: [regranted],
      initial: first.events
    })
    expect(resumed.outcome).toEqual({ _tag: "Done", value: "file body" })
    expect(regranted.count()).toBe(1)
  })

  it("gates the author seat: a denied model seat fails typed without burning calls", async () => {
    const error = await failChain({
      author: Author.layerMock([readScript]),
      authorize: authorizeWith(allowAll, new Rule({ effect: "deny", pattern: pattern("model:call", "**") }))
    }) as { _tag: string; code: string }
    expect(error._tag).toBe("/chain/AuthorizeError")
    expect(error.code).toBe("denied")
  })

  it("parks an unruled author seat and resumes it under a later grant", async () => {
    const first = await runChain({
      author: Author.layerMock([flow(`return done("authored")`)]),
      authorize: authorizeWith()
    })
    expect(first.outcome).toEqual({
      _tag: "Park",
      reason: {
        code: "approval",
        message: `"author" needs approval for ${AuthorDeclaration.authorCapability}`
      }
    })
    expect(first.events.some((event) => event._tag === "LinkEnded")).toBe(false)
    const resumed = await runChain({
      author: Author.layerMock([flow(`return done("authored")`)]),
      authorize: authorizeWith(allowAuthor),
      initial: first.events
    })
    expect(resumed.outcome).toEqual({ _tag: "Done", value: "authored" })
  })

  it("asks for an undeclared entry and for an unparseable declaration", async () => {
    const undeclared = countingEntry("mystery", null)
    const first = await runChain({
      author: Author.layerMock([flow(`await ctx.call("mystery", {})`, `return done(null)`)]),
      authorize: authorizeWith(allowAuthor, allowRead),
      entries: [undeclared.entry]
    })
    expect(first.outcome._tag).toBe("Park")
    expect(undeclared.count()).toBe(0)

    const weird = { ...countingEntry("weird", null).entry, capabilities: ["not a capability"] }
    const second = await runChain({
      author: Author.layerMock([flow(`await ctx.call("weird", {})`, `return done(null)`)]),
      authorize: authorizeWith(allowAll),
      entries: [weird]
    })
    expect(second.outcome._tag).toBe("Park")
  })

  it("never lets a rule's metacharacters cover a broader claim", async () => {
    // Intent: allow single-character filenames only; the claim covers
    // every .ts file. Subsumption must refuse, not literal-match the *.
    const narrow = new Rule({ effect: "allow", pattern: pattern("fs:read", "src/?.ts") })
    const broad = { ...countingEntry("broad", null).entry, capabilities: ["fs:read:src/*.ts"] }
    const { outcome } = await runChain({
      author: Author.layerMock([flow(`await ctx.call("broad", {})`, `return done(null)`)]),
      authorize: authorizeWith(allowAuthor, narrow),
      entries: [broad]
    })
    expect(outcome._tag).toBe("Park")
  })

  it("lets deny win over ask across a request's claims", async () => {
    const entry = {
      ...countingEntry("mixed", null).entry,
      capabilities: ["not a capability", "fs:write:secrets/**"]
    }
    const seen: Array<Author.Input> = []
    const author = Author.layerFn((input) => {
      seen.push(input)
      return seen.length === 1
        ? flow(`await ctx.call("mixed", {})`, `return done(null)`)
        : flow(`return done("routed")`)
    })
    const { events, outcome } = await runChain({
      author,
      authorize: authorizeWith(allowAuthor, new Rule({ effect: "deny", pattern: pattern("fs:write", "**") })),
      entries: [entry]
    })
    expect(outcome).toEqual({ _tag: "Done", value: "routed" })
    const rejection = events.find((event) => event._tag === "GateRejected") as Event.GateRejected
    expect(rejection.observation.kind).toBe("denied")
  })

  it("does not gate replayed settled calls: a revoked grant still resumes them", async () => {
    const entry = readEntry("file body")
    const first = await runChain({
      author: Author.layerMock([readScript]),
      authorize: authorizeWith(allowAuthor, allowRead),
      entries: [entry]
    })
    expect(first.outcome._tag).toBe("Done")
    const replayEntry = readEntry("file body")
    const replay = await runChain({
      author: Author.layerMock([]),
      authorize: authorizeWith(allowAuthor, new Rule({ effect: "deny", pattern: pattern("fs:read", "**") })),
      entries: [replayEntry],
      initial: first.events
    })
    expect(replay.outcome).toEqual(first.outcome)
    expect(replayEntry.count()).toBe(0)
  })

  it("leaves chains without the seam untouched", async () => {
    const entry = readEntry("file body")
    const { events, outcome } = await runChain({
      author: Author.layerMock([readScript]),
      entries: [entry]
    })
    expect(outcome).toEqual({ _tag: "Done", value: "file body" })
    expect(events.some((event) => event._tag === "GateRejected")).toBe(false)
  })

  it("propagates a broken seam as its typed error", async () => {
    const entry = readEntry("file body")
    const error = await failChain({
      author: Author.layerMock([readScript]),
      authorize: Authorize.layerNoop(),
      entries: [entry]
    }) as { _tag: string; code: string }
    expect(error._tag).toBe("/chain/AuthorizeError")
    expect(error.code).toBe("authorize_unavailable")
  })

  it("propagates a seam that breaks after the author seat", async () => {
    const flaky = Authorize.make({
      authorize: (request) =>
        request.capabilities.includes(AuthorDeclaration.authorCapability)
          ? Effect.void
          : Effect.fail(
            new Authorize.AuthorizeError({ code: "authorize_unavailable", message: "grant store offline" })
          )
    })
    const error = await failChain({
      author: Author.layerMock([readScript]),
      authorize: Layer.succeed(Authorize.Authorize)(flaky),
      entries: [readEntry("file body")]
    }) as { _tag: string; code: string }
    expect(error._tag).toBe("/chain/AuthorizeError")
    expect(error.code).toBe("authorize_unavailable")
  })

  it("allows everything under the allow-all layer and supports noop overrides", async () => {
    const entry = readEntry("file body")
    const { outcome } = await runChain({
      author: Author.layerMock([readScript]),
      authorize: Authorize.layerAllowAll,
      entries: [entry]
    })
    expect(outcome._tag).toBe("Done")

    const overridden = Authorize.makeNoop({ authorize: () => Effect.void })
    await Effect.runPromise(
      overridden.authorize({ capabilities: [], name: "x", slot: { chain: "", link: 0, ordinal: 0 } })
    )
    const viaLayer = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(
          Authorize.Authorize,
          (seam) => seam.authorize({ capabilities: [], name: "x", slot: { chain: "", link: 0, ordinal: 0 } })
        )
      ).pipe(Effect.provide(Authorize.layerNoop()), Effect.orDie)
    )
    expect(viaLayer.code).toBe("authorize_unavailable")
  })

  it("defends direct service use: empty claims ask under empty rules", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(
          Authorize.Authorize,
          (seam) => seam.authorize({ capabilities: [], name: "direct", slot: { chain: "", link: 0, ordinal: 0 } })
        )
      ).pipe(Effect.provide(authorizeWith()), Effect.orDie)
    )
    expect(error.code).toBe("approval_required")
  })

  // The seam must not be a second, weaker permission engine. Every row is a
  // rule/claim pair the old pattern-against-pattern evaluation got wrong in
  // one direction or the other, and each asserts the chain's verdict AND
  // that it equals what `@smthrs/capability` decides for the same inputs.
  it.each(
    [
      ["a single-star deny", [denyEtc], "fs:write:/etc/passwd", "deny"],
      ["a single-star allow", [allowRepoStar], "fs:read:/repo/a.ts", "allow"],
      ["a double-star allow", [allowRepoGlob], "fs:read:/repo/a.ts", "allow"],
      ["an exact rule", [allowExact], "fs:read:/repo/a.ts", "allow"],
      ["a deny after an allow", [allowRead, denyEtc], "fs:write:/etc/passwd", "deny"],
      ["an allow after a deny", [denyEtc, allowRead], "fs:read:/repo/a.ts", "allow"],
      ["no rule at all", [], "fs:read:/repo/a.ts", "ask"]
    ] as const
  )("decides %s exactly as the capability kernel does", async (_case, rules, claim, expected) => {
    const parsed = Option.getOrThrow(parse(claim))
    expect(await verdictOf(rules, claim)).toBe(expected)
    expect(evaluate([rules], parsed)).toBe(expected)
  })

  it("denies a wildcard claim whose overlap with a deny rule cannot be proven", async () => {
    // `fs:read:a/b/**` plainly covers `a/b/x`, which the deny rule forbids,
    // and the deny is placed LAST so rule ordering cannot excuse an allow.
    // `Capability.subsumes` cannot prove that overlap, and reading "cannot
    // prove" as "does not apply" is exactly the fail-open this pins shut.
    expect(await verdictOf([allowRead, denyMiddleStar], "fs:read:a/b/**")).toBe("deny")
  })

  it("compares literal resources exactly when a family claim carries one", async () => {
    // `fs:*:secret` names a set of actions but one exact resource, so the
    // pattern path decides it: two literals overlap only when they are equal.
    expect(await verdictOf([allowRead, denySecret], "fs:*:secret")).toBe("deny")
    expect(await verdictOf([allowRead, denySecret], "fs:*:public")).toBe("ask")
  })

  it("keeps a deny alive across a question mark it cannot expand", async () => {
    // `?` is a metacharacter the disjointness proof cannot expand, so the
    // literal prefixes are all it has: `secre` against `secret` agrees.
    expect(await verdictOf([allowRead, denySecret], "fs:*:secre?")).toBe("deny")
  })

  it("denies a claim naming everything whenever any deny rule exists", async () => {
    // The claim `*` is the broadest possible set, so it overlaps every rule
    // in the other direction: the seam must not read "the rule does not
    // subsume this claim" as "the rule does not apply".
    expect(await verdictOf([allowAll, denySecret], "*")).toBe("deny")
  })

  it("still allows a wildcard claim when the deny rule is provably disjoint", async () => {
    // A different action namespace and a different literal resource prefix
    // are both provable, so failing closed must not swallow them.
    expect(await verdictOf([allowRead, denyWrite], "fs:read:src/**")).toBe("allow")
    expect(await verdictOf([allowSrc, denyVendor], "fs:read:src/**")).toBe("allow")
  })

  it("parses claims into patterns", () => {
    expect(Option.isSome(Authorize.claimPattern("*"))).toBe(true)
    expect(Option.isSome(Authorize.claimPattern("fs:read:src/**"))).toBe(true)
    expect(Option.isSome(Authorize.claimPattern("model:call"))).toBe(true)
    expect(Option.isNone(Authorize.claimPattern(""))).toBe(true)
    expect(Option.isNone(Authorize.claimPattern("fs"))).toBe(true)
    expect(Option.isNone(Authorize.claimPattern(":read"))).toBe(true)
    expect(Option.isNone(Authorize.claimPattern("bogus:verb:thing"))).toBe(true)
  })

  it("scopes a script park('approval') differently: the link ends and the park is terminal", async () => {
    const scriptPark = flow(`return park("approval", "the script chose to wait")`)
    const first = await runChain({
      author: Author.layerMock([scriptPark]),
      authorize: Authorize.layerAllowAll
    })
    expect(first.outcome._tag).toBe("Park")
    expect(first.events.some((event) => event._tag === "LinkEnded" && event.link === 1)).toBe(true)
    const replay = await runChain({
      author: Author.layerMock([]),
      initial: first.events
    })
    expect(replay.outcome).toEqual(first.outcome)
  })
})
