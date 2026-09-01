/**
 * The guest half of `SandboxedFlow`: the program that runs a child flow inside
 * the machine.
 *
 * `SandboxedFlow.execute` bundles the caller's entry module together with this
 * module and starts the bundle on the provisioned machine. The bundle's main
 * calls {@link run} with the entry module's exports and the guest environment,
 * and everything below is the runner protocol as the guest sees it: read the
 * request JSON the host wrote at `SMITHERS_SANDBOX_REQUEST_PATH`, find the
 * flow the request names among the entry's exports, decode the payload through
 * that flow's own payload schema, run the flow to completion, and write the
 * result JSON to `SMITHERS_SANDBOX_RESULT_PATH`.
 *
 * The composition the flow runs under is the smallest one in the tree that
 * drives a flow to completion with no host services: `FlowEngine.layerMemory`
 * as the runtime, `Action.layerImplementations` as the table the entry's
 * action implementations file themselves in, `Interpreter.layer` for the flow,
 * and a `Crypto` built on the platform's WebCrypto. The child completes inside
 * one guest process and the PARENT journals the whole sandboxed execution as
 * one durable action, so an in-guest SQLite journal would add `node:sqlite`,
 * the migration ladder, and a `Jj` stub to every bundle without changing the
 * durability the parent can observe.
 *
 * Failures split two ways on purpose. A flow that fails, a payload the schema
 * refuses, and an entry module that exports no flow of the requested tag are
 * all outcomes the protocol can state, so they are written as a `failed`
 * result and the process exits normally. A missing request path, an
 * unreadable request file, or a result that cannot be written are failures of
 * the protocol itself, so they throw, the process exits non-zero, and the host
 * reports the exit and the guest's stderr rather than a fabricated result.
 *
 * @since 1.0.0
 */
import { FlowEngine } from "@smthrs/engine"
import { Action, type Flow, Interpreter } from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { readFile, writeFile } from "node:fs/promises"

/**
 * The request the host writes for the guest.
 *
 * `payload` is the flow payload encoded through `Schema.toCodecJson` of the
 * flow's payload schema, so the guest decodes it through the same codec: a
 * schema round-trip on both sides of the machine boundary, never a cast.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Request = Schema.Struct({
  flow: Schema.String,
  executionId: Schema.String,
  payload: Schema.Unknown
})

/**
 * What the guest writes back: the flow's success value encoded through its
 * success schema's JSON codec, or the reason it did not produce one.
 *
 * `finished` and `failed` are the 0.x status words, kept so a result file
 * reads the same to anyone who knew the old protocol.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Result = Schema.Union([
  Schema.Struct({ status: Schema.Literal("finished"), output: Schema.Unknown }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String })
])

/**
 * The guest environment as the runner reads it.
 *
 * Passed in rather than read ambiently so the runner is a function of its
 * inputs: the bundle's main hands it the real `process.env`, and an in-process
 * test hands it two temp paths.
 *
 * @category models
 * @since 1.0.0
 */
export interface Environment {
  readonly SMITHERS_SANDBOX_REQUEST_PATH?: string | undefined
  readonly SMITHERS_SANDBOX_RESULT_PATH?: string | undefined
}

const required = (environment: Environment, name: keyof Environment): string => {
  const value = environment[name]
  if (value === undefined || value === "") {
    throw new Error(`SandboxedFlow guest: ${name} is not set; the host starts the bundle with both request and result paths`)
  }
  return value
}

/** A flow declaration with its schemas erased, which is all the runner reads off one. */
type AnyFlow = Flow.Flow<string, Flow.AnyStructSchema, Schema.Top, Schema.Top, any>

/** Whether an export is a flow declaration of the requested tag. */
const isFlowTagged = (value: unknown, tag: string): value is AnyFlow =>
  Predicate.hasProperty(value, "payloadSchema") &&
  Predicate.hasProperty(value, "successSchema") &&
  Predicate.hasProperty(value, "execute") &&
  Predicate.hasProperty(value, "_tag") &&
  value._tag === tag

/**
 * A `Crypto` over the platform's WebCrypto, which Node 22 and Bun both expose
 * as `globalThis.crypto`. Built here rather than imported from a platform
 * package so the guest bundle carries no dependency the entry's own
 * `node_modules` may lack.
 */
const guestCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () => globalThis.crypto.subtle.digest(algorithm, data as Uint8Array<ArrayBuffer>),
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "Crypto",
          method: "digest",
          description: `WebCrypto could not compute a ${algorithm} digest`,
          cause
        })
    }).pipe(Effect.map((buffer) => new Uint8Array(buffer)))
})

/**
 * Runs the request the host wrote and writes the result it expects.
 *
 * `entry` is the namespace of the caller's entry module. The flow is found by
 * tag among its exports, default export included, and an export named `layer`
 * that is an Effect `Layer` is provided beside the interpreter: that is where
 * the entry supplies the implementations of the actions its flow body names.
 *
 * @category constructors
 * @since 1.0.0
 */
export const run = async (entry: Readonly<Record<string, unknown>>, environment: Environment): Promise<void> => {
  const requestPath = required(environment, "SMITHERS_SANDBOX_REQUEST_PATH")
  const resultPath = required(environment, "SMITHERS_SANDBOX_RESULT_PATH")
  const request = Schema.decodeUnknownSync(Request)(JSON.parse(await readFile(requestPath, "utf8")))
  const result = await Effect.runPromise(execute(entry, request))
  await writeFile(resultPath, JSON.stringify(result))
}

const execute = (
  entry: Readonly<Record<string, unknown>>,
  request: typeof Request.Type
): Effect.Effect<typeof Result.Type> =>
  Effect.gen(function*() {
    const flow = Object.values(entry).find((value) => isFlowTagged(value, request.flow))
    if (flow === undefined) {
      return {
        status: "failed",
        error: `the entry module exports no flow tagged "${request.flow}"; export the flow the host was asked to run`
      } as const
    }
    const implementations = Layer.isLayer(entry.layer) ? entry.layer : Layer.empty
    // The entry's layer arrives untyped, so what it requires beyond the table
    // and the runtime is unknown here. Anything it still owes surfaces when
    // the layer is built, which is the failure the `failed` result reports.
    const runtime = Layer.mergeAll(implementations, Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(Layer.succeed(Crypto.Crypto, guestCrypto))
    ) as unknown as Layer.Layer<never>
    const payloadCodec = Schema.toCodecJson(flow.payloadSchema)
    const successCodec = Schema.toCodecJson(flow.successSchema)
    const exit = yield* Effect.exit(
      Schema.decodeUnknownEffect(payloadCodec)(request.payload).pipe(
        Effect.flatMap((payload) => flow.execute(payload, { executionId: request.executionId })),
        Effect.flatMap((value) => Schema.encodeEffect(successCodec)(value)),
        Effect.provide(runtime)
      ) as Effect.Effect<unknown, unknown>
    )
    return Exit.isSuccess(exit)
      ? { status: "finished", output: exit.value } as const
      : { status: "failed", error: Cause.pretty(exit.cause) } as const
  })
