/**
 * Asking a person something, as an ordinary declared action.
 *
 * {@link module:WaitFor.action} is the general rendezvous: it parks until
 * something outside the run resolves it, and settles with whatever arrived.
 * That is the right primitive and the wrong affordance for a human, because a
 * human answers in prose, in a hurry, and sometimes wrongly. Smithers 0.x had
 * the affordance — a `HumanTask` with a kind, a prompt, an output schema, an
 * attempt budget, and a deadline — and this module is that affordance rebuilt
 * on the primitives this package already has.
 *
 * Four things are added to a bare wait:
 *
 * - a **kind**, so the four shapes a person is asked for (`ask`, `confirm`,
 *   `select`, `json`) are stated rather than reconstructed from a schema;
 * - **validation**, so an answer that does not fit is refused where it arrives
 *   instead of failing three steps later as a decode error;
 * - **re-asking**, so a refused answer parks again on a NEW wait point rather
 *   than ending the run, until the attempt budget is spent;
 * - a **deadline**, so a question nobody answers settles instead of parking
 *   forever.
 *
 * All four are built from what is already durable. Each attempt is its own wait
 * point in {@link module:WaitFor}'s namespace — `WaitFor/<name>#<attempt>` — so
 * an answer is recorded exactly as any other durable deferred completion is, a
 * refused answer stays recorded under the attempt that refused it, and a
 * re-driven round replays every answer it already has before parking on the
 * first attempt that has none. The reason an answer was refused is recorded
 * too, as a sealed step named `HumanTask/<name>#<attempt>/rejected`, so the
 * judgment the run made sits in the journal beside the answer it judged rather
 * than in a log stream nobody replays. The park is declared through the ordinary
 * waiting vocabulary under `approval`, carrying the current attempt's token, so
 * whoever collects answers always sees the one wait point that is open. The
 * deadline is a {@link module:DurableClock} armed once per task and raced
 * against every attempt, which makes it a deadline for the QUESTION rather than
 * for one attempt at answering it.
 *
 * @since 0.1.0
 */
import * as Node from "@smthrs/plan/Node"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Action from "./Action/index.ts"
import * as DurableClock from "./DurableClock.ts"
import * as DurableDeferred from "./DurableDeferred.ts"
import { FlowInstance } from "./FlowRuntime/FlowInstance.ts"
import type { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"
import { annotateWaiting } from "./FlowRuntime/WaitingAnnotation.ts"
import * as WaitFor from "./WaitFor.ts"

/**
 * The shape a person is asked for.
 *
 * `ask` wants prose, `confirm` wants yes or no, `select` wants one of the
 * options the task names, and `json` wants a value the task's JSON Schema
 * accepts. The kind is what an interface renders and what {@link validate}
 * checks; it is stated rather than inferred, because a text box and a two-
 * button confirmation are different questions even when both answers happen to
 * be strings.
 *
 * @category models
 * @since 0.1.0
 */
export type Kind = "ask" | "confirm" | "select" | "json"

/**
 * The schema the `kind` payload field is declared with.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Kind: Schema.Literals<readonly ["ask", "confirm", "select", "json"]> = Schema.Literals([
  "ask",
  "confirm",
  "select",
  "json"
])

/**
 * A question that ended without an answer the task could accept.
 *
 * `request_invalid` is the author's mistake — a `select` with no options, an
 * attempt budget below one, a deadline that is not a length of time, a JSON
 * Schema outside the supported subset — and is refused before anyone is asked
 * anything. `rejected` means every attempt was
 * spent on answers the task refused, and `timeout` means the deadline passed
 * with the question still open. All three are typed failures rather than
 * defects, so a body recovers from them with `Node.catch` like any other
 * declared failure — which is the point, because "the reviewer never answered"
 * is an ordinary outcome of asking a reviewer.
 *
 * @category errors
 * @since 0.1.0
 */
export class HumanTaskFailed extends Schema.TaggedError<HumanTaskFailed>()(
  "@smthrs/flow/HumanTaskFailed",
  {
    code: Schema.Literals(["request_invalid", "rejected", "timeout"]),
    task: Schema.String,
    attempts: Schema.Number,
    rejections: Schema.Array(Schema.String),
    message: Schema.String
  }
) {}

/**
 * The tag the human-task declaration is catalogued and resolved under.
 *
 * @category constructors
 * @since 0.1.0
 */
export const tag = "system/human-task"

/**
 * The attempt budget a task that names none is asked under.
 *
 * @category constructors
 * @since 0.1.0
 */
export const defaultMaxAttempts = 10

/**
 * The durable deferred one attempt at answering resolves through.
 *
 * Attempts are separate wait points on purpose. A durable deferred records the
 * FIRST completion and replays it forever, so re-asking on the same wait point
 * would read the refused answer again on every round; a new point per attempt
 * makes "answer again" expressible without a second completion mechanism, and
 * leaves the refused answers in place as the record of what was asked and what
 * came back.
 *
 * The name lives in {@link module:WaitFor}'s namespace because an answer is
 * completed through exactly the {@link module:WaitFor} path: a token, and
 * `DurableDeferred.succeed`. {@link answer} is that call with the token parsed
 * for you.
 *
 * @category constructors
 * @since 0.1.0
 */
export const deferred = (
  name: string,
  attempt: number
): DurableDeferred.DurableDeferred<typeof Schema.Json> => WaitFor.deferred(`${name}#${attempt}`)

/**
 * The clock a task's deadline is armed on.
 *
 * One clock per task, not one per attempt: the deadline bounds how long the
 * QUESTION stays open, so re-asking does not extend it. The name is the task's,
 * so every attempt's race arms and awaits the same durable timer — a clock row
 * keeps the deadline it was first armed with, which is what makes the bound
 * survive a restart.
 *
 * The deadline settles on both hosts. `@smthrs/engine`'s in-process engine and
 * the SQLite engine store each re-drive a run parked on
 * {@link module:DurableDeferred.raceAll}, so the durable timer wakes the
 * question wherever it was asked
 * (`packages/engine-store/test/RacedParkResume.test.ts`).
 *
 * @private
 */
const timeoutClockName = (name: string): string => `HumanTask/${name}/timeout`

/**
 * What one attempt settled with: the answer that arrived, or the deadline.
 *
 * @private
 */
const Settled = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("answered"), value: Schema.Json }),
  Schema.Struct({ _tag: Schema.Literal("timeout") })
])

type Settled = typeof Settled.Type

/**
 * What {@link validate} checks an answer against.
 *
 * @category models
 * @since 0.1.0
 */
export interface Request {
  readonly kind: Kind
  readonly options?: ReadonlyArray<string> | undefined
  readonly schema?: unknown
}

/** The JSON Schema types the bounded subset understands. */
const supportedTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])

/** The JSON Schema keywords the bounded subset understands. */
const supportedKeywords = [
  "type",
  "enum",
  "properties",
  "required",
  "items",
  "nullable",
  "description",
  "title"
]

/** Renders a JSON pointer-ish path for a rejection message. */
const at = (path: ReadonlyArray<string>): string => path.length === 0 ? "the answer" : `"${path.join(".")}"`

/** Whether a value is a plain JSON object rather than an array or a null. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Checks a value against the bounded JSON Schema subset, returning the first
 * reason it does not fit.
 *
 * The subset is `type` (`object`, `array`, `string`, `number`, `integer`,
 * `boolean`, `null`), `enum`, `properties`, `required`, `items`, and
 * `nullable`. It is deliberately small: a human-task schema exists to say what
 * shape an answer takes, and every keyword beyond these describes a constraint
 * a person cannot be usefully re-asked about. A schema that reaches outside it
 * is refused as `request_invalid` rather than silently ignored, because a
 * quietly dropped constraint reads as a validation that passed.
 *
 * Presence is `Object.hasOwn`, never the `in` operator. An answer is a decoded
 * JSON object, so every property it really has is its own; `in` also reports
 * `Object.prototype`'s members, which would accept a missing required
 * `toString` and check a `constructor` nobody answered against the schema for
 * one.
 *
 * @private
 */
const check = (
  value: unknown,
  schema: unknown,
  path: ReadonlyArray<string>
): string | undefined => {
  if (!isObject(schema)) return `${at(path)} is described by something that is not a JSON Schema object.`
  const nullable = schema["nullable"] === true
  if (nullable && value === null) return undefined
  const unsupported = Object.keys(schema).find((keyword) => !supportedKeywords.includes(keyword))
  if (unsupported !== undefined) {
    return `${at(path)} uses the unsupported JSON Schema keyword "${unsupported}".`
  }
  const enumeration = schema["enum"]
  if (enumeration !== undefined) {
    if (!Array.isArray(enumeration)) return `${at(path)} declares an "enum" that is not an array.`
    return enumeration.some((allowed) => allowed === value)
      ? undefined
      : `${at(path)} must be one of ${enumeration.map((allowed) => JSON.stringify(allowed)).join(", ")}.`
  }
  const type = schema["type"]
  if (type === undefined) return undefined
  if (typeof type !== "string" || !supportedTypes.has(type)) {
    return `${at(path)} declares the unsupported JSON Schema type ${JSON.stringify(type)}.`
  }
  switch (type) {
    case "object": {
      if (!isObject(value)) return `${at(path)} must be an object.`
      const required = schema["required"]
      if (Array.isArray(required)) {
        const missing = required.find((key) => typeof key === "string" && !Object.hasOwn(value, key))
        if (missing !== undefined) return `${at(path)} is missing the required property "${String(missing)}".`
      }
      const properties = schema["properties"]
      if (isObject(properties)) {
        for (const [key, property] of Object.entries(properties)) {
          if (!Object.hasOwn(value, key)) continue
          const rejection = check(value[key], property, [...path, key])
          if (rejection !== undefined) return rejection
        }
      }
      return undefined
    }
    case "array": {
      if (!Array.isArray(value)) return `${at(path)} must be an array.`
      const items = schema["items"]
      if (items === undefined) return undefined
      for (const [index, element] of value.entries()) {
        const rejection = check(element, items, [...path, String(index)])
        if (rejection !== undefined) return rejection
      }
      return undefined
    }
    case "integer":
      return Number.isInteger(value) ? undefined : `${at(path)} must be an integer.`
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : `${at(path)} must be a number.`
    case "string":
      return typeof value === "string" ? undefined : `${at(path)} must be a string.`
    case "boolean":
      return typeof value === "boolean" ? undefined : `${at(path)} must be a boolean.`
    default:
      return value === null ? undefined : `${at(path)} must be null.`
  }
}

/**
 * Checks that a JSON Schema stays inside the bounded subset, at every depth.
 *
 * This is a different question from {@link validate}, which asks whether an
 * ANSWER fits a schema. A question is worth refusing before anyone is asked it:
 * a constraint the subset cannot enforce would otherwise be silently dropped,
 * and the person would be told their answer was fine when half of what was
 * asked for went unchecked.
 *
 * Returns the first reason the schema is out of bounds, or `undefined` when the
 * whole tree is inside it.
 *
 * @category combinators
 * @since 0.1.0
 */
export const validateSchema = (
  schema: unknown,
  path: ReadonlyArray<string> = []
): string | undefined => {
  if (!isObject(schema)) return `${at(path)} is described by something that is not a JSON Schema object.`
  const unsupported = Object.keys(schema).find((keyword) => !supportedKeywords.includes(keyword))
  if (unsupported !== undefined) {
    return `${at(path)} uses the unsupported JSON Schema keyword "${unsupported}".`
  }
  const enumeration = schema["enum"]
  if (enumeration !== undefined && !Array.isArray(enumeration)) {
    return `${at(path)} declares an "enum" that is not an array.`
  }
  const type = schema["type"]
  if (type !== undefined && (typeof type !== "string" || !supportedTypes.has(type))) {
    return `${at(path)} declares the unsupported JSON Schema type ${JSON.stringify(type)}.`
  }
  const properties = schema["properties"]
  if (properties !== undefined) {
    if (!isObject(properties)) return `${at(path)} declares "properties" that is not an object.`
    for (const [key, property] of Object.entries(properties)) {
      const complaint = validateSchema(property, [...path, key])
      if (complaint !== undefined) return complaint
    }
  }
  const items = schema["items"]
  return items === undefined ? undefined : validateSchema(items, [...path, "items"])
}

/**
 * Checks one answer against the question that was asked.
 *
 * Returns the reason the answer was refused, or `undefined` when it fits. It is
 * exported because it is the same check an interface should run BEFORE it
 * records an answer: refusing a typo in the text box the person is looking at
 * is worth more than refusing it one durable round later.
 *
 * ```ts
 * const rejection = HumanTask.validate(value, { kind: "select", options })
 * if (rejection !== undefined) return showTheReviewer(rejection)
 * ```
 *
 * @category combinators
 * @since 0.1.0
 */
export const validate = (value: unknown, request: Request): string | undefined => {
  switch (request.kind) {
    case "ask":
      return typeof value === "string" ? undefined : "The answer must be a string."
    case "confirm":
      return typeof value === "boolean" ? undefined : "The answer must be a boolean."
    case "select": {
      if (request.options === undefined || request.options.length === 0) {
        return "The question declares no options to choose from."
      }
      return request.options.some((option) => option === value)
        ? undefined
        : `The answer ${JSON.stringify(value)} is not one of ${request.options.join(", ")}.`
    }
    default:
      return request.schema === undefined ? undefined : check(value, request.schema, [])
  }
}

/**
 * The fields a question is asked with.
 *
 * @private
 */
const payloadFields = {
  name: Schema.String,
  kind: Kind,
  prompt: Schema.String,
  options: Schema.optional(Schema.Array(Schema.String)),
  schema: Schema.optional(Schema.Json),
  timeoutMs: Schema.optional(Schema.Number),
  maxAttempts: Schema.optional(Schema.Number)
}

/**
 * The declared human-task action.
 *
 * **When to use**
 *
 * Use it in a body wherever the next step depends on a person: a release that
 * needs sign-off, a plan that needs a choice, a field the run cannot compute.
 * The node settles with the answer, so downstream steps read it the way they
 * read any other step result, and {@link decode} gives that answer the caller's
 * own type.
 *
 * ```ts
 * HumanTask.action.call({
 *   name: "release",
 *   kind: "select",
 *   prompt: "Which build should ship?",
 *   options: ["canary", "stable"],
 *   timeoutMs: 6 * 60 * 60 * 1000
 * })
 * ```
 *
 * `name` addresses the question, so two calls naming one question in one
 * execution await one answer — the same reading {@link module:WaitFor} takes,
 * for the same reason: a person has to be able to name what they are answering.
 *
 * @category constructors
 * @since 0.1.0
 */
export const action: Action.Declared<
  typeof tag,
  Schema.Struct<typeof payloadFields>,
  typeof Schema.Json,
  typeof HumanTaskFailed,
  never
> = Action.makeSystem(tag, {
  payload: payloadFields,
  success: Schema.Json,
  error: HumanTaskFailed,
  tier: "sealed"
})

/** The payload the action is called with, as its implementation reads it. */
type Payload = typeof action.payloadSchema.Type

/** Builds the failure a task settles with, with the reasons it refused. */
const failed = (
  payload: Payload,
  code: typeof HumanTaskFailed.Type["code"],
  attempts: number,
  rejections: ReadonlyArray<string>,
  message: string
): HumanTaskFailed => new HumanTaskFailed({ code, task: payload.name, attempts, rejections, message })

/**
 * The attempt budget a payload asks for, refused when it is not a whole number
 * of attempts.
 *
 * @private
 */
const budgetOf = (payload: Payload): Effect.Effect<number, HumanTaskFailed> => {
  const maxAttempts = payload.maxAttempts ?? defaultMaxAttempts
  return Number.isInteger(maxAttempts) && maxAttempts >= 1
    ? Effect.succeed(maxAttempts)
    : Effect.fail(
      failed(
        payload,
        "request_invalid",
        0,
        [],
        `${tag} was called with maxAttempts ${maxAttempts}. A question is asked at least once.`
      )
    )
}

/**
 * The deadline a payload asks for, refused when it is not a length of time.
 *
 * `Duration.millis` takes any number, so an unchecked deadline does not fail —
 * it changes what the question means. `NaN` becomes zero and a negative stays
 * negative, so both are deadlines that have ALREADY passed: the task times out
 * on its first park and nobody is ever really asked. `Infinity` becomes the
 * infinite duration, so the race has a branch that can never win and a question
 * asked with a deadline has none. All three are the same authoring mistake as a
 * `select` with no options, and they are refused in the same place, before the
 * first park, rather than surfacing as a `timeout` nobody waited for.
 *
 * @private
 */
const deadlineOf = (payload: Payload): Effect.Effect<Duration.Duration | undefined, HumanTaskFailed> => {
  const timeoutMs = payload.timeoutMs
  if (timeoutMs === undefined) return Effect.succeed(undefined)
  return Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? Effect.succeed(Duration.millis(timeoutMs))
    : Effect.fail(
      failed(
        payload,
        "request_invalid",
        0,
        [],
        `${tag} was called with timeoutMs ${timeoutMs}. A deadline is a finite number of ` +
          "milliseconds that is not negative; the question would be over before it was asked, or " +
          "never over at all."
      )
    )
}

/**
 * Refuses a question nobody could answer correctly, before anyone is asked.
 *
 * A `select` with no options and a schema outside the supported subset are
 * authoring mistakes whose only symptom at answer time would be a person being
 * refused for something they did not do, so {@link validateSchema} walks the
 * whole schema tree before the first park rather than waiting for an answer to
 * reach the keyword nobody can enforce.
 *
 * @private
 */
const requestOf = (payload: Payload): Effect.Effect<Request, HumanTaskFailed> => {
  const request: Request = {
    kind: payload.kind,
    options: payload.options,
    ...(payload.schema === undefined ? {} : { schema: payload.schema })
  }
  if (payload.kind === "select" && (payload.options === undefined || payload.options.length === 0)) {
    return Effect.fail(
      failed(payload, "request_invalid", 0, [], `${tag} was called as a select with no options to choose from.`)
    )
  }
  if (payload.kind === "json" && payload.schema !== undefined) {
    const complaint = validateSchema(payload.schema)
    if (complaint !== undefined) return Effect.fail(failed(payload, "request_invalid", 0, [], complaint))
  }
  return Effect.succeed(request)
}

/**
 * Awaits one attempt, racing the answer against the task's deadline.
 *
 * The race is named per attempt because a durable race records its winner: one
 * name across attempts would replay the first attempt's answer forever. The
 * clock is NOT named per attempt, for the mirrored reason — the deadline is one
 * fact about the question.
 *
 * @private
 */
const attemptOnce = (
  payload: Payload,
  attempt: number,
  deadline: Duration.Duration | undefined
): Effect.Effect<Settled, never, Crypto.Crypto | FlowRuntime | FlowInstance> => {
  const answered: Effect.Effect<Settled, never, FlowRuntime | FlowInstance> = Effect.map(
    DurableDeferred.await(deferred(payload.name, attempt)),
    (value): Settled => ({ _tag: "answered", value })
  )
  if (deadline === undefined) return answered
  return DurableDeferred.raceAll({
    name: `HumanTask/${payload.name}#${attempt}`,
    success: Settled,
    error: Schema.Never,
    effects: [
      answered,
      Effect.as(
        DurableClock.sleep({
          name: timeoutClockName(payload.name),
          duration: deadline,
          // The wait is the point: the question parks the execution rather than
          // holding a fiber open for however long a person takes.
          inMemoryThreshold: Duration.zero
        }),
        { _tag: "timeout" } as const
      )
    ]
  })
}

/**
 * What a refusal records: which question, which attempt, and why the answer
 * could not be accepted.
 *
 * @private
 */
const RejectionRecord = Schema.Struct({
  task: Schema.String,
  attempt: Schema.Number,
  reason: Schema.String
})

/**
 * Records that an answer was refused, as a step rather than as a log line.
 *
 * A refusal is a decision the run made about something a person did, and it is
 * the only part of the exchange that is not already durable: the answer is
 * recorded under its own wait point and the re-ask is recorded as the next
 * one, but WHY the answer was refused would otherwise live in a log stream
 * nobody replays. `Action.make` is the recorded boundary the rest of this
 * package already writes through — {@link module:DurableClock.sleep} takes it
 * for an in-memory wait — so the refusal is dispatched, journaled, and
 * replayed like any other sealed step, under a name that carries the task and
 * the attempt it refused.
 *
 * The payload names no time. A record whose contents depend on the wall clock
 * would differ between the first run and its replay, which is the one thing a
 * journaled decision may never do.
 *
 * @private
 */
const recordRejection = (task: string, attempt: number, reason: string) =>
  Action.make({
    name: `HumanTask/${task}#${attempt}/rejected`,
    tier: "sealed",
    success: RejectionRecord,
    execute: Effect.succeed({ task, attempt, reason })
  })

/**
 * The human-task implementation: park, validate, re-ask, settle.
 *
 * Provide it beside the other action implementation layers a body calls, over
 * the {@link module:Implementations.layerImplementations} table they file
 * themselves in:
 *
 * ```ts
 * Layer.mergeAll(HumanTask.layer, Interpreter.layer(Release)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<never, never, Crypto.Crypto | FlowRuntime> = action.toLayer((payload) =>
  Effect.gen(function*() {
    const instance = yield* FlowInstance
    const maxAttempts = yield* budgetOf(payload)
    const deadline = yield* deadlineOf(payload)
    const request = yield* requestOf(payload)
    const rejections: Array<string> = []
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const token = DurableDeferred.tokenFromExecutionId(deferred(payload.name, attempt), {
        flow: instance.flow,
        executionId: instance.executionId
      })
      // Declared rather than left to a driver's derivation, so the run parks
      // under `approval` carrying the ONE wait point that is currently open.
      yield* annotateWaiting({ reason: "approval", token })
      const settled = yield* attemptOnce(payload, attempt, deadline)
      // The attempt is over either way, so the declared park is over too. A
      // raced attempt awaits on a copied instance, so the branch that resolved
      // could not clear the annotation itself.
      yield* annotateWaiting(undefined)
      if (settled._tag === "timeout") {
        return yield* Effect.fail(
          failed(
            payload,
            "timeout",
            attempt,
            rejections,
            `Nobody answered "${payload.name}" within ${payload.timeoutMs} ms.`
          )
        )
      }
      const rejection = validate(settled.value, request)
      if (rejection === undefined) return settled.value
      rejections.push(`attempt ${attempt}: ${rejection}`)
      yield* recordRejection(payload.name, attempt, rejection)
    }
    return yield* Effect.fail(
      failed(
        payload,
        "rejected",
        maxAttempts,
        rejections,
        `"${payload.name}" was asked ${maxAttempts} times without an answer it could accept.`
      )
    )
  })
)

/**
 * Records one answer to a human task.
 *
 * `token` is the value the run parked with — the `token` of the waiting
 * annotation, which is the wait point the current attempt is open on. The value
 * is completed through the ordinary durable deferred path, so an answer
 * recorded here is indistinguishable from any other durable completion and
 * resumes the run the same way.
 *
 * ```ts
 * yield* HumanTask.answer({ token: waiting.token, value: { decision: "ship" } })
 * ```
 *
 * The answer is NOT validated here. Whether it fits is the task's own judgment,
 * made where the question's kind and schema are known, and a refused answer
 * stays recorded so the record shows what was actually said. Call
 * {@link validate} first when the interface can refuse it while the person is
 * still looking at it.
 *
 * @category combinators
 * @since 0.1.0
 */
export const answer = (options: {
  readonly token: DurableDeferred.Token
  readonly value: typeof Schema.Json.Type
}): Effect.Effect<void, DurableDeferred.TokenInvalid, FlowRuntime> =>
  Effect.gen(function*() {
    const parsed = yield* Schema.decodeEffect(DurableDeferred.TokenParsed.FromString)(options.token).pipe(
      Effect.mapError(() =>
        new DurableDeferred.TokenInvalid({ message: "The supplied token is not a durable deferred token" })
      )
    )
    yield* DurableDeferred.succeed(
      DurableDeferred.make(parsed.deferredName, { success: Schema.Json }),
      { token: options.token, value: options.value }
    )
  })

/**
 * Gives an answer the caller's own type.
 *
 * The action's success schema is `Schema.Json`, because what a person may
 * answer is described by the task's payload rather than by a TypeScript type.
 * `decode` is the other half: the author states the schema they were really
 * asking for, and the node downstream of the question carries that type.
 *
 * ```ts
 * const Decision = Schema.Struct({ decision: Schema.Literals(["ship", "hold"]) })
 *
 * HumanTask.action.call({ name: "release", kind: "json", prompt, schema }).pipe(
 *   HumanTask.decode(Decision)
 * )
 * ```
 *
 * The two descriptions must agree. The answer already passed the task's own
 * JSON Schema before it reached here, so a value this schema rejects means the
 * payload's schema and the author's schema describe different answers — an
 * authoring mistake, not a human one — and it surfaces as a defect naming the
 * offending path rather than as a failure a body could sensibly catch.
 *
 * @category combinators
 * @since 0.1.0
 */
export const decode =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  <E, R>(self: Node.Node<typeof Schema.Json.Type, E, R>): Node.Node<S["Type"], E, R> =>
    Node.map(self, Schema.decodeUnknownSync(schema))
