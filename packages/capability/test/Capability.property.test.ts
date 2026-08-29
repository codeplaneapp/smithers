import { Option } from "effect"
import { FastCheck } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  seed: Number(process.env.FC_SEED ?? 20260814),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

const capability = (action: Capability.Action, resource: string): Capability.Capability =>
  Capability.make(action, resource)

const pattern = (action: Capability.PatternAction, resource: string): Capability.CapabilityPattern =>
  new Capability.CapabilityPattern({ action, resource })

const exactActions = [
  "fs:read",
  "fs:write",
  "net:get",
  "net:post",
  "model:call",
  "proc:spawn",
  "jj:status",
  "jj:diff",
  "jj:snapshot",
  "jj:restore",
  "jj:workspace-add",
  "jj:workspace-forget"
] as const satisfies ReadonlyArray<Capability.Action>

const actionArb = FastCheck.constantFrom<Capability.Action>(...exactActions)

const digitArb = FastCheck.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9")

// Every character class matchesResource treats specially, except the glob
// metacharacters `*` and `?`: regex metacharacters, slashes (normalized),
// colons, spaces, and non-ASCII text.
const literalUnit = FastCheck.constantFrom(
  "a",
  "b",
  "Z",
  "0",
  "9",
  ".",
  "+",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "-",
  "_",
  " ",
  ":",
  "/",
  "\\",
  "é",
  "☃"
)

// Glob-free pattern text: either drawn from the special-character alphabet or
// arbitrary binary text (lone surrogates included) with globs stripped.
const globFreePattern = FastCheck.oneof(
  FastCheck.string({ unit: literalUnit, minLength: 1, maxLength: 24 }),
  FastCheck.string({ unit: "binary", minLength: 1, maxLength: 24 }).map((text) => text.replaceAll(/[*?]/g, ""))
).filter((text) => text.length > 0)

describe("Capability properties", () => {
  it("a glob-free pattern matches exactly its own literal resource and nothing one character away", () => {
    FastCheck.assert(
      FastCheck.property(
        actionArb,
        globFreePattern,
        FastCheck.nat({ max: 1023 }),
        digitArb,
        (action, resource, rawIndex, digit) => {
          const selectedPattern = pattern(action, resource)
          expect(Capability.matches(selectedPattern, capability(action, resource))).toBe(true)

          const index = rawIndex % resource.length
          // Digits are case-stable, so the Windows-path `i` flag cannot make a
          // digit substitution compare equal to the original code unit.
          const replacement = resource[index] === digit ? (digit === "0" ? "1" : "0") : digit
          const mutated = resource.slice(0, index) + replacement + resource.slice(index + 1)
          expect(Capability.matches(selectedPattern, capability(action, mutated))).toBe(false)
        }
      ),
      params
    )
  })

  it("a fuzzed literal regex metacharacter matches only the literal, not an arbitrary substitute", () => {
    // Generalizes the fixed metacharacter table in Capability.test.ts to
    // arbitrary surrounding text drawn from the same hostile alphabet.
    const metacharacterArb = FastCheck.constantFrom(".", "+", "(", ")", "[", "]", "^", "$", "|", "{", "}")
    const fragment = FastCheck.string({ unit: literalUnit, maxLength: 12 })
    FastCheck.assert(
      FastCheck.property(
        actionArb,
        fragment,
        metacharacterArb,
        fragment,
        digitArb,
        (action, prefix, metacharacter, suffix, digit) => {
          const selectedPattern = pattern(action, `${prefix}${metacharacter}${suffix}`)
          expect(Capability.matches(selectedPattern, capability(action, `${prefix}${metacharacter}${suffix}`)))
            .toBe(true)
          expect(Capability.matches(selectedPattern, capability(action, `${prefix}${digit}${suffix}`))).toBe(false)
        }
      ),
      params
    )
  })

  // Regression pin for the repeated-star ReDoS: the iterative glob matcher is
  // bounded at O(pattern x resource), so adversarial repeated-star patterns
  // stay inside an honest wall-time budget. Corroborates the 10k-character
  // repeated-star non-match pinned via spawnSync in the example suite.
  it("bounds wall time for adversarial repeated-star patterns against long non-matching resources", () => {
    // At these sizes the old RegExp compilation needed longer than the heat
    // death of the test runner. Keep a one-second wall-clock ceiling: it still
    // catches the catastrophic backtracking regression while tolerating a
    // descheduled, coverage-instrumented worker on a contended CI host.
    const adversarial = FastCheck.tuple(
      FastCheck.integer({ min: 2, max: 12 }),
      FastCheck.integer({ min: 8, max: 4096 })
    )
    FastCheck.assert(
      FastCheck.property(adversarial, ([stars, length]) => {
        const selectedPattern = pattern("fs:read", `${"a*".repeat(stars)}b`)
        const resource = capability("fs:read", "a".repeat(length))
        const startedAt = performance.now()
        const matched = Capability.matches(selectedPattern, resource)
        const elapsedMs = performance.now() - startedAt
        expect(matched).toBe(false)
        expect(elapsedMs).toBeLessThan(1_000)
      }),
      { ...params, examples: [[[12, 4096]]] }
    )
  })

  it("agrees with the retired RegExp compilation on non-adversarial patterns", () => {
    // The retired matcher, verbatim: grant patterns compiled to an anchored
    // RegExp with `*` as `.*`, `?` as `.`, an optional trailing ` .*`, and
    // Windows-path case folding. It is the semantic oracle for the iterative
    // glob matcher; the generator keeps star counts small so the oracle
    // itself cannot backtrack catastrophically.
    const oracle = (patternResource: string, resource: string): boolean => {
      const normalize = (value: string) => value.replaceAll("\\", "/")
      const normalizedPattern = normalize(patternResource)
      const normalizedResource = normalize(resource)
      let expression = normalizedPattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".")
      if (expression.endsWith(" .*")) {
        expression = `${expression.slice(0, -3)}( .*)?`
      }
      const windowsPath = /^[A-Za-z]:\//.test(normalizedPattern) || /^[A-Za-z]:\//.test(normalizedResource)
      return new RegExp(`^${expression}$`, windowsPath ? "is" : "s").test(normalizedResource)
    }

    const fragmentUnit = FastCheck.oneof(
      literalUnit,
      FastCheck.constantFrom("A", "z", "?", "\n", "\uD83D", "\uDE00")
    )
    const fragment = FastCheck.string({ unit: fragmentUnit, maxLength: 8 })
    // At most two `*`s and one optional ` *` tail, splicing fragments so the
    // pattern and the resource share text often enough to exercise both
    // accepting and rejecting paths, plus Windows drive prefixes for the
    // case-folding branch.
    const drive = FastCheck.constantFrom("", "C:/", "c:/")
    const caseArb = FastCheck.tuple(
      drive,
      fragment,
      FastCheck.constantFrom("", "*"),
      fragment,
      FastCheck.constantFrom("", "*", "?"),
      fragment,
      FastCheck.constantFrom("", " *"),
      drive,
      fragment,
      fragment,
      FastCheck.boolean()
    )
    FastCheck.assert(
      FastCheck.property(
        caseArb,
        ([
          patternDrive,
          left,
          starOne,
          middle,
          starTwo,
          right,
          tail,
          resourceDrive,
          filler,
          extra,
          mirror
        ]) => {
          const patternResource = `${patternDrive}${left}${starOne}${middle}${starTwo}${right}${tail}`
          const resource = mirror
            ? `${resourceDrive}${left}${filler}${middle}${extra}${right}`
            : `${resourceDrive}${filler}${extra}`
          const selectedPattern = pattern("fs:read", patternResource)
          const selectedCapability = capability("fs:read", resource)
          expect(Capability.matches(selectedPattern, selectedCapability)).toBe(oracle(patternResource, resource))
        }
      ),
      { ...params, numRuns: Math.max(params.numRuns, 500) }
    )
  })

  it("subsumption composes with matching: subsumes(a, b) and matches(b, c) imply matches(a, c)", () => {
    type SegmentKind = "literal" | "star" | "prefix-star" | "question" | "globstar"
    const fragmentUnit = FastCheck.constantFrom(
      "a",
      "Z",
      "0",
      ".",
      "+",
      "(",
      ")",
      "[",
      "]",
      "^",
      "$",
      "|",
      "{",
      "}",
      "-",
      "_"
    )
    const fragment = FastCheck.string({ unit: fragmentUnit, minLength: 1, maxLength: 4 })
    const expansion = FastCheck.oneof(
      FastCheck.constant(""),
      fragment,
      FastCheck.tuple(fragment, fragment).map(([left, right]) => `${left}/${right}`)
    )
    const segmentArb = FastCheck.tuple(
      FastCheck.constantFrom<SegmentKind>("literal", "star", "prefix-star", "question", "globstar"),
      fragment,
      expansion
    )
    type Segment = readonly [SegmentKind, string, string]
    const patternSegment = ([kind, text]: Segment): string =>
      kind === "literal"
        ? text
        : kind === "star"
        ? "*"
        : kind === "prefix-star"
        ? `${text}*`
        : kind === "question"
        ? "?"
        : "**"
    const resourceSegment = ([kind, text, expanded]: Segment): string =>
      kind === "literal"
        ? text
        : kind === "star"
        ? expanded
        : kind === "prefix-star"
        ? `${text}${expanded}`
        : kind === "question"
        ? text[0]!
        : expanded

    const patternActionArb = FastCheck.constantFrom<Capability.PatternAction>(
      ...exactActions,
      "fs:*",
      "net:*",
      "model:*",
      "proc:*",
      "jj:*",
      "*"
    )
    const familyOf = (action: Capability.PatternAction): Capability.PatternAction =>
      action === "*" ? "*" : `${action.slice(0, action.indexOf(":"))}:*` as Capability.PatternAction
    const concreteAction = (action: Capability.PatternAction, pick: number): Capability.Action => {
      if (action === "*") return exactActions[pick % exactActions.length]!
      if (
        action === "fs:*" || action === "net:*" || action === "model:*" || action === "proc:*" || action === "jj:*"
      ) {
        const family = exactActions.filter((exact) => exact.startsWith(action.slice(0, -1)))
        return family[pick % family.length]!
      }
      return action
    }

    let applicable = 0
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(segmentArb, { minLength: 1, maxLength: 4 }),
        patternActionArb,
        FastCheck.constantFrom("same", "widen-action", "globstar-tail"),
        FastCheck.boolean(),
        FastCheck.nat({ max: 8 }),
        FastCheck.nat({ max: 11 }),
        (segments, rightAction, variant, widenToStar, tailIndex, actionPick) => {
          const right = pattern(rightAction, segments.map(patternSegment).join("/"))
          const requested = capability(
            concreteAction(rightAction, actionPick),
            segments.map(resourceSegment).join("/")
          )
          const leftAction = variant === "same"
            ? rightAction
            : widenToStar
            ? "*"
            : familyOf(rightAction)
          const keep = tailIndex % (segments.length + 1)
          const leftResource = variant === "globstar-tail"
            ? keep === 0 ? "**" : `${segments.slice(0, keep).map(patternSegment).join("/")}/**`
            : right.resource
          const left = pattern(leftAction, leftResource)

          if (Capability.subsumes(left, right) && Capability.matches(right, requested)) {
            applicable += 1
            expect(Capability.matches(left, requested)).toBe(true)
          }
        }
      ),
      params
    )
    expect(applicable).toBeGreaterThan(0)
  })

  it("parse never throws on hostile strings and format(parse(s)) reproduces s exactly on success", () => {
    const hostile = FastCheck.oneof(
      FastCheck.string({ unit: "binary", maxLength: 48 }),
      FastCheck.tuple(actionArb, FastCheck.string({ unit: "binary", maxLength: 32 }))
        .map(([action, resource]) => `${action}:${resource}`),
      FastCheck.tuple(
        FastCheck.string({ unit: "binary", maxLength: 16 }),
        FastCheck.string({ unit: "binary", maxLength: 16 })
      )
        .map(([namespace, rest]) => `${namespace}:${rest}`)
    )
    FastCheck.assert(
      FastCheck.property(hostile, (input) => {
        const parsed = Capability.parse(input)
        if (Option.isSome(parsed)) {
          expect(Capability.format(parsed.value)).toBe(input)
          expect(Option.getOrNull(Capability.parse(Capability.format(parsed.value)))).toEqual(parsed.value)
        } else {
          // Rejection is the typed Option.none, never a throw.
          expect(Option.isNone(parsed)).toBe(true)
        }
      }),
      params
    )
  })
})
