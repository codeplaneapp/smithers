/**
 * A resolved model route: an endpoint, a protocol, a framing, and the
 * credentials to authorize with. Preparing a route yields a credential-free
 * request that can enter a sealed step's key material, with the secret
 * applied only as the request leaves.
 *
 * @since 0.1.0
 */
import { Effect, Layer, Result, Schema, Stream } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as AnthropicMessages from "./AnthropicMessages.ts"
import * as Auth from "./Auth.ts"
import * as CanonicalJson from "./CanonicalJson.ts"
import * as Endpoint from "./Endpoint.ts"
import * as Framing from "./Framing.ts"
import * as Model from "./Model.ts"
import { ModelError } from "./ModelError.ts"
import type { ModelEvent } from "./ModelEvent.ts"
import { type ModelRequest, ModelRequest as ModelRequestSchema } from "./ModelRequest.ts"
import * as OpenAIChatCompletions from "./OpenAIChatCompletions.ts"
import * as OpenAIResponses from "./OpenAIResponses.ts"
import type * as Protocol from "./Protocol.ts"
import * as RequestExecutor from "./RequestExecutor.ts"

/**
 * The credential-free representation used to construct a sealed model step.
 * This view, including the canonical body bytes, is what the engine digests
 * into the sealed-step key when it services `EngineLike.sealStep`
 * (`packages/harness/src/EngineLike.ts`, `docs/reference/model.md`).
 * Credentials are signed onto a copy afterwards and never enter this value.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface PreparedRequest {
  readonly routeId: string
  readonly protocolId: string
  readonly method: "POST"
  readonly url: string
  readonly publicHeaders: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly bodyText: string
}

/**
 * The deployment-specific pieces which compose a protocol into a model route.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Config<Body, Frame, Event, State> {
  readonly id: string
  readonly protocol: Protocol.Protocol<Body, Frame, Event, State>
  readonly endpoint: Endpoint.Endpoint
  readonly auth: Auth.Auth
  readonly framing: Framing.Framing<Frame>
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * A configured, but not yet authenticated, protocol route.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Route<Body, Frame, Event, State> = Config<Body, Frame, Event, State>

const sensitiveHeader = (name: string): boolean => Auth.isCredentialName(name)

const compareCanonical = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const publicHeaders = (
  headers: Readonly<Record<string, string>> | undefined
): Result.Result<Record<string, string>, ModelError> => {
  const normalized = new Map<string, string>([["content-type", "application/json"]])
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (sensitiveHeader(name)) {
      return Result.fail(
        new ModelError({
          code: "invalid_request",
          message: `Route header ${name} must be applied through Auth`
        })
      )
    }
    normalized.set(name.toLowerCase(), value)
  }
  return Result.succeed(Object.fromEntries([...normalized].sort(([left], [right]) => compareCanonical(left, right))))
}

const preparationError = (): ModelError =>
  new ModelError({
    code: "invalid_request",
    message: "Model request could not be encoded as canonical JSON"
  })

/**
 * Compiles a request exactly once into its credential-free sealed-step view.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const prepare = <Body, Frame, Event, State>(
  route: Route<Body, Frame, Event, State>,
  request: ModelRequest
): Effect.Effect<PreparedRequest, ModelError> =>
  Effect.fn("flows/model/Route.prepare")(function*() {
    const validatedRequest = yield* Schema.decodeUnknownEffect(ModelRequestSchema)(request).pipe(
      Effect.mapError(() =>
        new ModelError({
          code: "invalid_request",
          message: "Model request failed Schema validation"
        })
      )
    )
    const native = route.protocol.supportsDeferred(validatedRequest.modelId)
    const candidate = yield* route.protocol.body.from(validatedRequest, { native })
    const body = yield* Schema.decodeUnknownEffect(route.protocol.body.schema)(candidate).pipe(
      Effect.mapError(() =>
        new ModelError({
          code: "invalid_request",
          message: `${route.protocol.id} produced an invalid provider request body`
        })
      )
    )
    const headers = yield* Effect.fromResult(publicHeaders(route.headers))
    const bytes = yield* Effect.try({
      try: () => CanonicalJson.bytes(body),
      catch: preparationError
    })
    return {
      routeId: route.id,
      protocolId: route.protocol.id,
      method: "POST" as const,
      url: Endpoint.render(route.endpoint),
      publicHeaders: headers,
      body: bytes,
      bodyText: new TextDecoder().decode(bytes)
    }
  })()

const stream = <Body, Frame, Event, State>(
  route: Route<Body, Frame, Event, State>,
  executor: RequestExecutor.RequestExecutor,
  request: ModelRequest
): Stream.Stream<ModelEvent, Model.ModelFailure> =>
  Stream.scoped(
    Stream.unwrap(
      Effect.fn("flows/model/Route.stream")(function*() {
        const prepared = yield* prepare(route, request)
        const attempt = Effect.gen(function*() {
          const signedHeaders = yield* route.auth.sign({ ...prepared.publicHeaders })
          const httpRequest = HttpClientRequest.post(prepared.url, { headers: signedHeaders }).pipe(
            HttpClientRequest.bodyUint8Array(prepared.body, "application/json")
          )
          return yield* executor.execute(httpRequest, {
            modelId: request.modelId,
            classifyError: route.protocol.classifyError
          })
        })
        // An `authentication` failure is terminal on both retry ladders — a bad
        // key never repairs itself by waiting. A refresh-capable Auth is the
        // one case where recovery is possible: run its refresh and re-sign
        // exactly once, so an access token that expired mid-flight costs one
        // recovery, while a credential the refresh cannot repair still fails
        // typed on the second attempt.
        const refresh = route.auth.refresh
        const response = yield* (refresh === undefined
          ? attempt
          : attempt.pipe(
            Effect.catchIf(
              (error): error is ModelError => error instanceof ModelError && error.code === "authentication",
              () => Effect.andThen(refresh, attempt)
            )
          ))
        const decodeEvent = Schema.decodeUnknownEffect(route.protocol.stream.event)
        const events = route.framing.frame(
          response.stream.pipe(
            // The code is the contract and the transport's own text is not:
            // `HttpClientError`'s message ends in the method and URL, which a
            // provider authorizing by query parameter would make a credential.
            // `transport` is what the retry ladder classifies on, and a body
            // that dies after the headers is on that ladder from here.
            Stream.mapError(() => new ModelError({ code: "transport", message: "Model response stream failed" }))
          )
        ).pipe(
          // effect rc.108's SSE decoder adds `SseError` (oversized events) to
          // the framing channel; a framing failure is a transport failure here.
          Stream.mapError((error) =>
            error._tag === "SseError"
              ? new ModelError({ code: "transport", message: "Model response stream failed" })
              : error
          ),
          Stream.mapEffect((frame) =>
            decodeEvent(frame).pipe(
              Effect.mapError(() =>
                new ModelError({
                  code: "invalid_provider_output",
                  message: `${route.protocol.id} emitted an invalid stream event`
                })
              )
            )
          ),
          route.protocol.stream.terminal === undefined
            ? (framed) => framed
            : Stream.takeUntil(route.protocol.stream.terminal)
        )
        return events.pipe(
          Stream.mapAccumEffect(
            () => route.protocol.stream.initial(request),
            route.protocol.stream.step,
            route.protocol.stream.onHalt === undefined
              ? undefined
              : { onHalt: route.protocol.stream.onHalt }
          )
        )
      })()
    )
  )

/**
 * Composes Protocol × Endpoint × Auth × Framing into a route value.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = <Body, Frame, Event, State>(
  config: Config<Body, Frame, Event, State>
): Route<Body, Frame, Event, State> => config

/**
 * Builds a `Model` implementation from a composed route.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const toModel = <Body, Frame, Event, State>(
  config: Config<Body, Frame, Event, State>
): Effect.Effect<Model.Model, never, RequestExecutor.RequestExecutor> =>
  Effect.gen(function*() {
    const executor = yield* RequestExecutor.RequestExecutor
    return Model.make({ stream: (request) => stream(config, executor, request) })
  })

/**
 * Provides a configured route as the `Model` service.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layer = <Body, Frame, Event, State>(
  config: Config<Body, Frame, Event, State>
): Layer.Layer<Model.Model, never, RequestExecutor.RequestExecutor> => Layer.effect(Model.Model, toModel(config))

/**
 * Creates Anthropic's Messages deployment configuration.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const anthropic = (
  input: { readonly apiKey: Auth.Redacted<string> }
): Result.Result<
  Route<
    AnthropicMessages.Body,
    string,
    Parameters<typeof AnthropicMessages.protocol.stream.step>[1],
    ReturnType<typeof AnthropicMessages.protocol.stream.initial>
  >,
  ModelError
> =>
  Result.map(Endpoint.make({ url: "https://api.anthropic.com", path: "/v1/messages" }), (endpoint) =>
    make({
      id: "anthropic",
      protocol: AnthropicMessages.protocol,
      endpoint,
      auth: Auth.apiKeyHeader("x-api-key", input.apiKey),
      framing: Framing.sse,
      headers: { "anthropic-version": "2023-06-01" }
    }))

/**
 * Creates OpenAI's Responses deployment configuration.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const openai = (
  input: { readonly apiKey: Auth.Redacted<string> }
): Result.Result<
  Route<
    OpenAIResponses.Body,
    string,
    Parameters<typeof OpenAIResponses.protocol.stream.step>[1],
    ReturnType<typeof OpenAIResponses.protocol.stream.initial>
  >,
  ModelError
> =>
  Result.map(Endpoint.make({ url: "https://api.openai.com", path: "/v1/responses" }), (endpoint) =>
    make({
      id: "openai",
      protocol: OpenAIResponses.protocol,
      endpoint,
      auth: Auth.bearer(input.apiKey),
      framing: Framing.sse
    }))

/**
 * Creates a route for any endpoint that speaks the OpenAI Chat Completions
 * wire shape: Ollama, Gemini's OpenAI-compatibility layer, and most other
 * self-hosted or third-party "OpenAI-compatible" servers, none of which
 * implement api.openai.com's newer Responses API that {@link openai} targets.
 *
 * `apiKey` may be a non-empty placeholder for a server that does not check
 * it (Ollama ignores its `Authorization` header entirely) — {@link Auth.bearer}
 * only rejects an empty credential.
 *
 * @since 0.1.0
 * @category constructors
 */
export const openaiCompatible = (
  input: { readonly id: string; readonly baseUrl: string; readonly apiKey: Auth.Redacted<string> }
): Result.Result<
  Route<
    OpenAIChatCompletions.Body,
    string,
    Parameters<typeof OpenAIChatCompletions.protocol.stream.step>[1],
    ReturnType<typeof OpenAIChatCompletions.protocol.stream.initial>
  >,
  ModelError
> =>
  Result.map(Endpoint.make({ url: input.baseUrl, path: "/chat/completions" }), (endpoint) =>
    make({
      id: input.id,
      protocol: OpenAIChatCompletions.protocol,
      endpoint,
      auth: Auth.bearer(input.apiKey),
      framing: Framing.sse
    }))
