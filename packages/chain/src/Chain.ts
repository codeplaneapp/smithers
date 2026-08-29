/**
 * The chain trampoline: bootstrap, links, gates, and prefix replay.
 *
 * There is no agent-loop object. A link either runs its authored script to
 * an outcome, or — when it has no script (bootstrap) or its script was
 * rejected by a gate — the harness authors a successor from the goal plus
 * the journaled observations. Continuation is whatever the link returns
 * (`docs/specs/Concepts/Chain Slice.md`,
 * `docs/specs/Concepts/Trampoline Loops.md`).
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import { Effect, Option, Schema } from "effect"
import * as Author from "./Author.ts"
import * as AuthorDeclaration from "./AuthorDeclaration.ts"
import * as Authorize from "./Authorize.ts"
import * as CallKey from "./CallKey.ts"
import * as Catalog from "./Catalog.ts"
import * as Event from "./Event.ts"
import * as Journal from "./Journal.ts"
import * as Observation from "./Observation.ts"
import * as Outcome from "./Outcome.ts"
import * as Script from "./Script.ts"
import * as ScriptRunner from "./ScriptRunner.ts"
import * as Steering from "./Steering.ts"

/**
 * A chain that cannot proceed: a replayed link diverged from its journal,
 * or the journal itself is not a valid chain history.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class ChainError extends Schema.TaggedError<ChainError>()("/chain/ChainError", {
  code: Schema.Literals(["replay_divergence", "invalid_journal"]),
  message: Schema.String
}) {}

class LinkAborted extends Schema.TaggedError<LinkAborted>()("/chain/Chain/LinkAborted", {
  observation: Observation.Observation
}) {}

/**
 * A required approval parks the run mid-link, deliberately without a
 * `LinkEnded`: resuming re-executes the link from its settled prefix and
 * re-asks the seam, converging under whatever grant now exists.
 */
class ApprovalPark extends Schema.TaggedError<ApprovalPark>()("/chain/Chain/ApprovalPark", {
  message: Schema.String
}) {}

/**
 * What a run needs: the goal, the budgets it may spend, and the journal
 * scope it owns.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly goal: string
  readonly envelope?: typeof Schema.Json.Type | undefined
  readonly prefix?: string | undefined
  readonly maxLinks?: number | undefined
  readonly maxCallsPerLink?: number | undefined
  /** Caller-supplied context lines appended after the goal in harness-driven author calls. */
  readonly context?: ReadonlyArray<string> | undefined
  /** The journal scope this run owns; sub-chains derive theirs from the spawning call slot. */
  readonly chain?: string | undefined
}

/**
 * The name every script uses to call the author seat, re-exported from
 * the shared declaration leaf.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const authorName = AuthorDeclaration.authorName

/**
 * The author entry's one-line description, shared with the prompt's
 * catalog block so the model sees the same declaration the key pins.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const authorDescription = AuthorDeclaration.authorDescription

/**
 * The declaration digest pinned into every author call key.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const authorDigest: string = AuthorDeclaration.authorDigest

const decodeScript = Schema.decodeUnknownOption(Script.Script)

const sameJson = (left: typeof Schema.Json.Type, right: typeof Schema.Json.Type): boolean =>
  Digest.canonical(left) === Digest.canonical(right)

type RunError =
  | ChainError
  | Journal.JournalError
  | Author.AuthorError
  | Steering.SteeringError
  | Authorize.AuthorizeError

type Services = Journal.Journal | Catalog.Catalog | Author.Author | ScriptRunner.ScriptRunner

/**
 * Runs a chain to a terminal outcome, resuming from whatever the journal
 * already holds: a finished chain returns its terminal without executing
 * anything, and a half-finished link replays its settled calls by ordinal
 * before running live.
 *
 * @category execution
 * @since 0.1.0
 * @slop
 */
export const run = (options: Options): Effect.Effect<Outcome.Terminal, RunError, Services> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const catalog = yield* Catalog.Catalog
    const author = yield* Author.Author
    const runner = yield* ScriptRunner.ScriptRunner
    const chainId = options.chain ?? ""
    // Steering is optional context: a chain without the service runs
    // unchanged and journals identically. It is also the ROOT's channel
    // only — a sub-chain never drains, so an instruction meant for the
    // root can never be consumed by an unattended child. The envelope
    // seam is optional the same way — end-state it is the kernel's job.
    const steering = chainId === ""
      ? yield* Effect.serviceOption(Steering.Steering)
      : Option.none<Steering.Service>()
    const authorize = yield* Effect.serviceOption(Authorize.Authorize)
    const maxLinks = options.maxLinks ?? 32
    const maxCalls = options.maxCallsPerLink ?? 64
    const prefix = options.prefix ?? ""

    const initial = yield* journal.read
    const events: Array<Event.Event> = [...initial]

    const existing = Event.terminal(events, chainId)

    const append = (event: Event.Event): Effect.Effect<void, Journal.JournalError> =>
      Effect.gen(function*() {
        const scoped = chainId === "" ? event : { ...event, chain: chainId }
        const latest = yield* journal.read
        events.splice(0, events.length, ...latest)
        yield* journal.append(scoped, events.length)
        events.push(scoped)
      })

    const hasRejection = (link: number, ordinal: number): boolean =>
      events.some((event) =>
        event._tag === "GateRejected" && event.link === link && event.ordinal === ordinal
        && Event.inChain(event, chainId)
      )

    const started = events.find(
      (event): event is Event.ChainStarted => event._tag === "ChainStarted" && Event.inChain(event, chainId)
    )
    if (started === undefined) {
      yield* append({ _tag: "ChainStarted", goal: options.goal, envelope: options.envelope ?? null })
    } else if (started.goal !== options.goal || !sameJson(started.envelope, options.envelope ?? null)) {
      return yield* new ChainError({
        code: "replay_divergence",
        message: `chain ${JSON.stringify(chainId)} was started with a different goal or envelope`
      })
    }
    if (existing !== undefined) return existing

    const executeLink = (link: number): Effect.Effect<Outcome.Outcome, RunError | ApprovalPark> =>
      Effect.gen(function*() {
        const script = Event.authored(events, link, chainId)
        const linkDigest = script === undefined ? CallKey.harnessDigest : script.digest
        const settledPrior = Event.settled(events, link, chainId)
        const rejectedPrior = Event.rejected(events, link, chainId)
        let counter = 0
        let lastRejection: Observation.Observation | undefined

        // Steering is link-cumulative: every author attempt of a link sees
        // all lines drained into the link so far, so a gate-rejected
        // attempt never swallows the user's instruction. A boundary is
        // drained at most once per execution and recorded drains are never
        // re-drained; empty drains journal nothing (a settled call pins
        // its context in its payload).
        const steeringLines: Array<string> = [...Event.steeringLines(events, link, chainId)]
        const steeredOrdinals = new Set(Event.steeredOrdinals(events, link, chainId))
        const steeringFor = (ordinal: number): Effect.Effect<ReadonlyArray<string>, RunError> =>
          Effect.gen(function*() {
            if (Option.isNone(steering) || steeredOrdinals.has(ordinal)) return steeringLines
            steeredOrdinals.add(ordinal)
            const drained = yield* steering.value.drain(`${link}/${ordinal}`)
            if (drained.length > 0) {
              yield* append({ _tag: "SteeringDrained", link, messages: drained, ordinal })
              steeringLines.push(...drained)
            }
            return steeringLines
          })

        // Live rejections never need dedupe: a resumed link replays its
        // recorded rejection from `rejectedPrior` before this path can run.
        const reject = (ordinal: number, observation: Observation.Observation) =>
          Effect.gen(function*() {
            lastRejection = observation
            yield* append({ _tag: "GateRejected", link, observation, ordinal })
            return yield* new LinkAborted({ observation })
          })

        const executeCall = (
          origin: "harness" | "script",
          name: string,
          payload: unknown
        ): Effect.Effect<unknown, RunError | LinkAborted | ApprovalPark> =>
          Effect.gen(function*() {
            const ordinal = counter++
            const payloadBoundary = ScriptRunner.jsonBoundary(payload)
            if (payloadBoundary._tag === "Refused") {
              return yield* reject(
                ordinal,
                Observation.make("call_failed", `"${name}" received input that is not JSON-serializable`)
              )
            }
            const jsonPayload = payloadBoundary.value as typeof Schema.Json.Type
            const priorRejection = rejectedPrior.get(ordinal)
            if (priorRejection !== undefined) {
              lastRejection = priorRejection.observation
              return yield* new LinkAborted({ observation: priorRejection.observation })
            }
            const prior = settledPrior.get(ordinal)
            const scriptDigest = origin === "script" ? linkDigest : CallKey.harnessDigest
            if (prior !== undefined) {
              if (prior.key.link !== link || prior.key.scriptDigest !== scriptDigest) {
                return yield* new ChainError({
                  code: "replay_divergence",
                  message: `link ${link} call ${ordinal} settled under a different link or script than the current call`
                })
              }
              if (prior.name !== name) {
                return yield* new ChainError({
                  code: "replay_divergence",
                  message: `link ${link} call ${ordinal} requested "${name}" but the journal settled "${prior.name}"`
                })
              }
              if (!sameJson(prior.payload, jsonPayload)) {
                return yield* new ChainError({
                  code: "replay_divergence",
                  message:
                    `link ${link} call ${ordinal} ("${name}") received a different payload than the journaled call`
                })
              }
              // The settled result only replays under the same declaration
              // it was produced under: a redeclared entry re-keys its calls
              // and a resumed chain refuses loudly rather than serving a
              // stale result (the legacy resume-metadata-mismatch rule).
              const entry = catalog.lookup(name)
              const currentDigest = name === authorName
                ? authorDigest
                : entry === undefined
                ? undefined
                : Catalog.entryDigest(entry)
              if (currentDigest !== prior.key.entryDigest) {
                return yield* new ChainError({
                  code: "replay_divergence",
                  message:
                    `link ${link} call ${ordinal} ("${name}") settled under a different declaration than the catalog now carries`
                })
              }
              return prior.result
            }
            if (ordinal >= maxCalls) {
              return yield* reject(
                ordinal,
                Observation.make("fuel", `link ${link} exceeded its budget of ${maxCalls} calls`)
              )
            }
            if (name === authorName) {
              if (Option.isSome(authorize)) {
                // The model seat is inside the envelope too: a deny-all
                // envelope must not burn model tokens routing around its
                // own denials. A denied seat is unrecoverable by
                // re-authoring, so it propagates typed instead of
                // journaling an observation; an ask parks in place.
                yield* authorize.value
                  .authorize({
                    capabilities: [AuthorDeclaration.authorCapability],
                    name,
                    slot: { chain: chainId, link, ordinal }
                  })
                  .pipe(
                    Effect.catchTag("/chain/AuthorizeError", (error) =>
                      Effect.gen(function*() {
                        if (error.code === "approval_required") {
                          return yield* new ApprovalPark({ message: error.message })
                        }
                        return yield* error
                      }))
                  )
              }
              const promoted = yield* steeringFor(ordinal)
              const context = [
                ...Author.contextOf(payload),
                ...promoted.map((line) => `[steering] ${line}`)
              ]
              const raw = yield* author.author({ context, prefix })
              const extraction = Script.extract(raw)
              if (extraction._tag === "Rejected") {
                // The rejection is journaled before the settled marker so a
                // crash between the two resumes through `rejectedPrior`
                // instead of replaying the marker as an author result.
                const observation = Observation.make("shape", extraction.reason)
                lastRejection = observation
                yield* append({ _tag: "GateRejected", link, observation, ordinal })
                yield* append({
                  _tag: "CallSettled",
                  key: CallKey.make(link, scriptDigest, ordinal, authorDigest),
                  link,
                  name,
                  payload: jsonPayload,
                  result: { raw, rejected: true }
                })
                return yield* new LinkAborted({ observation })
              }
              const result = { digest: extraction.script.digest, text: extraction.script.text }
              yield* append({
                _tag: "CallSettled",
                key: CallKey.make(link, scriptDigest, ordinal, authorDigest),
                link,
                name,
                payload: jsonPayload,
                result
              })
              return result
            }
            const entry = catalog.lookup(name)
            if (entry === undefined) {
              return yield* reject(ordinal, Observation.make("catalog", `"${name}" is not a catalog entry`))
            }
            // An undeclared entry claims everything; an explicit empty
            // claim set claims no external authority and skips the seam.
            const claims = entry.capabilities ?? ["*"]
            if (Option.isSome(authorize) && claims.length > 0) {
              // Gate 4, live calls only: replayed settled calls already
              // ran, and the check stays out of the journal so a later
              // grant is re-decidable (the cell-harness lesson).
              yield* authorize.value
                .authorize({
                  capabilities: claims,
                  name,
                  slot: { chain: chainId, link, ordinal }
                })
                .pipe(
                  Effect.catchTag("/chain/AuthorizeError", (error) =>
                    Effect.gen(function*() {
                      if (error.code === "denied") {
                        return yield* reject(ordinal, Observation.make("denied", error.message))
                      }
                      if (error.code === "approval_required") {
                        return yield* new ApprovalPark({ message: error.message })
                      }
                      return yield* error
                    }))
                )
            }
            const result = yield* entry.handler(payload, { chain: chainId, link, ordinal }).pipe(
              Effect.catchTag("/chain/CallError", (error) =>
                Effect.gen(function*() {
                  // A handler surfacing a required approval — a sub-chain
                  // waiting on a grant — parks in place like the seam's
                  // own ask: nothing settles, resume re-enters here.
                  if (error.cause === "approval_required") {
                    return yield* new ApprovalPark({ message: error.message })
                  }
                  return yield* reject(ordinal, Observation.make("call_failed", `"${name}" failed: ${error.message}`))
                }))
            )
            const resultBoundary = ScriptRunner.jsonBoundary(result)
            if (resultBoundary._tag === "Refused") {
              return yield* reject(
                ordinal,
                Observation.make("call_failed", `"${name}" produced a result that is not JSON-serializable`)
              )
            }
            yield* append({
              _tag: "CallSettled",
              key: CallKey.make(link, scriptDigest, ordinal, Catalog.entryDigest(entry)),
              link,
              name,
              payload: jsonPayload,
              result: resultBoundary.value as typeof Schema.Json.Type
            })
            return resultBoundary.value
          })

        if (script !== undefined) {
          const ran = yield* runner
            .run(script, (request) => executeCall("script", request.name, request.payload))
            .pipe(
              Effect.catchTag("/chain/Chain/LinkAborted", () => Effect.succeed(undefined)),
              Effect.catchTag("/chain/ScriptFailure", (failure) =>
                Effect.gen(function*() {
                  // A failing script — compile, throw, or bad outcome — is an
                  // observation like any gate, not a harness crash. An
                  // unavailable runner lands here too and recovers by
                  // authoring scriptless successors until the link budget
                  // parks the chain.
                  const ordinal = counter++
                  const observation = Observation.make("script_failed", `${failure.code}: ${failure.message}`)
                  lastRejection = observation
                  if (!hasRejection(link, ordinal)) {
                    yield* append({ _tag: "GateRejected", link, observation, ordinal })
                  }
                  return undefined
                }))
            )
          if (ran !== undefined) return ran
        }

        while (true) {
          if (lastRejection !== undefined && lastRejection.kind === "fuel") {
            return Outcome.park("quota", lastRejection.message)
          }
          const attempt = yield* executeCall("harness", authorName, {
            context: [
              options.goal,
              ...(options.context ?? []),
              ...Event.observations(events, link, chainId).map(Observation.render)
            ]
          }).pipe(Effect.catchTag("/chain/Chain/LinkAborted", () => Effect.succeed(undefined)))
          if (attempt === undefined) continue
          const decoded = decodeScript(attempt)
          if (decoded._tag === "None") {
            return yield* new ChainError({
              code: "invalid_journal",
              message: `link ${link} settled an author call whose result is not a script`
            })
          }
          return Outcome.to(decoded.value)
        }
      })

    let link = Event.linkCount(events, chainId)
    while (true) {
      if (link >= maxLinks) {
        const parked = Outcome.park("quota", `the chain reached its budget of ${maxLinks} links`)
        yield* append({ _tag: "LinkEnded", link, outcome: parked })
        return parked
      }
      // A required approval surfaces here as its typed marker: the run
      // parks WITHOUT a LinkEnded, so resuming re-executes this link from
      // its settled prefix and re-asks the seam under the current grants.
      // (A script deliberately returning park("approval") still ends its
      // link below — only the seam's park is resumable-in-place.)
      const outcome: Outcome.Outcome | { readonly _tag: "ApprovalParked"; readonly message: string } =
        yield* executeLink(link).pipe(
          Effect.catchTag(
            "/chain/Chain/ApprovalPark",
            (error) => Effect.succeed({ _tag: "ApprovalParked" as const, message: error.message })
          )
        )
      if (outcome._tag === "ApprovalParked") {
        return Outcome.park("approval", outcome.message)
      }
      if (outcome._tag === "To") {
        if (Event.authored(events, link + 1, chainId) === undefined) {
          yield* append({ _tag: "LinkAuthored", link: link + 1, script: outcome.script })
        }
        yield* append({ _tag: "LinkEnded", link, outcome })
        link = link + 1
        continue
      }
      yield* append({ _tag: "LinkEnded", link, outcome })
      return outcome
    }
  })
