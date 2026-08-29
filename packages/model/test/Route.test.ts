import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import { Effect, Layer, Redacted, Result, Schema, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as Auth from "../src/Auth.ts"
import * as Endpoint from "../src/Endpoint.ts"
import * as Framing from "../src/Framing.ts"
import * as Model from "../src/Model.ts"
import { ModelError } from "../src/ModelError.ts"
import * as ModelEvent from "../src/ModelEvent.ts"
import * as ModelRequest from "../src/ModelRequest.ts"
import * as OpenAICompatible from "../src/OpenAICompatible.ts"
import * as Protocol from "../src/Protocol.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const request = ModelRequest.ModelRequest.make({
  modelId: "test-model",
  system: [],
  messages: [],
  tools: [],
  params: ModelRequest.GenerationParams.make()
})

const endpoint = (options: Endpoint.MakeOptions): Endpoint.Endpoint => Result.getOrThrow(Endpoint.make(options))

const TestBody = Schema.Struct({
  z: Schema.Finite,
  a: Schema.Array(Schema.String)
})
const TestEvent = Schema.Record(Schema.String, Schema.Unknown)

const kernelHttpClientLayer = (
  client: HttpClient.HttpClient
): Layer.Layer<KernelHttpClient.HttpClient> => Layer.succeed(KernelHttpClient.HttpClient)(client)

const protocol = Protocol.make({
  id: "test",
  supportsDeferred: () => false,
  body: {
    schema: TestBody,
    from: () => Effect.succeed({ z: 1, a: ["body"] })
  },
  stream: {
    event: Schema.fromJsonString(TestEvent),
    initial: () => 0,
    step: (state) => Effect.succeed([state, []] as const),
    onHalt: () => []
  },
  classifyError: (status, body) => new ModelError({ code: "transport", message: `${status}: ${body}` })
})

describe("Route.prepare", () => {
  it("is deterministic and excludes credentials from the sealed-step view", async () => {
    const key = "test-secret-api-key"
    const route = Route.make({
      id: "test-route",
      protocol,
      endpoint: endpoint({ url: "https://example.test", path: "/v1/responses" }),
      auth: Auth.bearer(Redacted.make(key)),
      framing: Framing.sse,
      headers: { "x-public": "yes" }
    })

    const first = await Effect.runPromise(Route.prepare(route, request))
    const second = await Effect.runPromise(Route.prepare(route, request))

    expect(first.body).toEqual(second.body)
    expect(first.bodyText).toBe("{\"a\":[\"body\"],\"z\":1}")
    expect(first.publicHeaders).toEqual({ "content-type": "application/json", "x-public": "yes" })
    expect(JSON.stringify(first)).not.toContain(key)
    expect(JSON.stringify(new ModelError({ code: "transport", message: "safe" }))).not.toContain(key)
  })

  it("rejects credential-bearing headers before they can enter the prepared view", async () => {
    const route = Route.make({
      id: "unsafe",
      protocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("auth-secret")),
      framing: Framing.sse,
      headers: { "x-api-key": "step-key-secret" }
    })

    const error = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "invalid_request" })
    expect(JSON.stringify(error)).not.toContain("step-key-secret")
  })

  it("rejects password headers before they can enter the prepared view", async () => {
    const route = Route.make({
      id: "unsafe-password",
      protocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("auth-secret")),
      framing: Framing.sse,
      headers: { "x-password": "step-key-password" }
    })

    const error = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "invalid_request" })
    expect(JSON.stringify(error)).not.toContain("step-key-password")
  })

  it("rejects invalid request and protocol body values before canonical encoding", async () => {
    const invalidProtocol = Protocol.make({
      ...protocol,
      body: {
        schema: TestBody,
        from: () => Effect.succeed({ z: Number.NaN, a: ["body"] })
      }
    })
    const route = Route.make({
      id: "invalid-body",
      protocol: invalidProtocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })

    const invalidBody = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))
    expect(invalidBody).toMatchObject({ code: "invalid_request" })

    const invalidRequest = {
      ...request,
      params: { temperature: Number.NaN }
    } as unknown as ModelRequest.ModelRequest
    const invalidParams = await Effect.runPromise(
      Route.prepare(
        Result.getOrThrow(Route.openai({
          apiKey: Redacted.make("secret")
        })),
        invalidRequest
      ).pipe(Effect.flip)
    )
    expect(invalidParams).toMatchObject({ code: "invalid_request" })
  })

  it("keeps OpenAI-compatible routes on the portable protocol surface", async () => {
    const compatible = Result.getOrThrow(OpenAICompatible.make({
      id: "groq",
      baseUrl: "https://api.groq.com/openai",
      apiKey: Redacted.make("compatible-secret")
    }))

    expect(compatible.protocol.id).toBe("openai-responses")
    expect(compatible.protocol.supportsDeferred("gpt-5.4")).toBe(false)
    expect(compatible.headers).toBeUndefined()
    await expect(Route.prepare(compatible, request).pipe(Effect.runPromise)).resolves.toMatchObject({ routeId: "groq" })
  })

  it("mounts the live Chat Completions route on compatible provider base paths", async () => {
    const groq = Result.getOrThrow(Route.openaiCompatible({
      id: "groq-chat",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: Redacted.make("compatible-secret")
    }))

    expect(groq.protocol.id).toBe("openai-chat-completions")
    expect(groq.protocol.supportsDeferred("gpt-5.4")).toBe(false)
    expect(groq.endpoint.url).toBe("https://api.groq.com/openai/v1/chat/completions")

    const gemini = Result.getOrThrow(Route.openaiCompatible({
      id: "gemini-chat",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: Redacted.make("compatible-secret")
    }))
    expect(gemini.endpoint.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    )
    await expect(Route.prepare(gemini, request).pipe(Effect.runPromise)).resolves.toMatchObject({
      protocolId: "openai-chat-completions"
    })
  })

  it("carries an OpenAI-compatible deployment's own headers and rejects an unusable base URL", async () => {
    const withHeaders = Result.getOrThrow(OpenAICompatible.make({
      id: "vllm",
      baseUrl: "https://vllm.test/",
      apiKey: Redacted.make("compatible-secret"),
      headers: { "x-tenant": "acme" }
    }))

    expect(withHeaders.headers).toEqual({ "x-tenant": "acme" })
    expect(withHeaders.endpoint.url).toBe("https://vllm.test/v1/responses")
    const prepared = await Effect.runPromise(Route.prepare(withHeaders, request))
    expect(prepared.publicHeaders).toEqual({ "content-type": "application/json", "x-tenant": "acme" })

    const invalid = OpenAICompatible.make({
      id: "broken",
      baseUrl: "not a url",
      apiKey: Redacted.make("compatible-secret")
    })
    expect(Result.isFailure(invalid)).toBe(true)
  })

  it("composes the built-in provider deployments and their credential-free views", async () => {
    const anthropic = Result.getOrThrow(Route.anthropic({ apiKey: Redacted.make("anthropic-secret") }))

    expect(anthropic.id).toBe("anthropic")
    expect(anthropic.protocol.id).toBe("anthropic-messages")
    expect(anthropic.framing.id).toBe("sse")
    expect(anthropic.endpoint).toEqual({
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      query: []
    })
    expect(anthropic.headers).toEqual({ "anthropic-version": "2023-06-01" })

    const prepared = await Effect.runPromise(Route.prepare(anthropic, request))
    expect(prepared).toMatchObject({
      routeId: "anthropic",
      protocolId: "anthropic-messages",
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      publicHeaders: { "anthropic-version": "2023-06-01", "content-type": "application/json" },
      bodyText: "{\"max_tokens\":4096,\"messages\":[],\"model\":\"test-model\",\"stream\":true}"
    })
    expect(JSON.stringify(prepared)).not.toContain("anthropic-secret")

    const signed = await Effect.runPromise(anthropic.auth.sign({ "content-type": "application/json" }))
    expect(signed).toEqual({ "content-type": "application/json", "x-api-key": "anthropic-secret" })

    const openai = Result.getOrThrow(Route.openai({ apiKey: Redacted.make("openai-secret") }))
    expect(openai.endpoint.url).toBe("https://api.openai.com/v1/responses")
    expect(openai.headers).toBeUndefined()
    expect(await Effect.runPromise(openai.auth.sign({}))).toEqual({ Authorization: "Bearer openai-secret" })
  })

  it("fails a route whose credential is empty rather than sending an unauthenticated request", async () => {
    const route = Result.getOrThrow(Route.anthropic({ apiKey: Redacted.make("") }))
    const executor = RequestExecutor.RequestExecutor.of({
      execute: () => Effect.die(new Error("the request must never be sent"))
    })

    const error = await Effect.runPromise(
      Effect.scoped(
        Route.toModel(route).pipe(
          Effect.flatMap((model) => model.stream(request).pipe(Stream.runDrain, Effect.flip)),
          Effect.provideService(RequestExecutor.RequestExecutor, executor)
        )
      )
    )

    expect(error).toMatchObject({ code: "authentication", message: "API key must not be empty" })
  })

  it("rejects a provider body that cannot be canonically encoded", async () => {
    const uncanonical = Protocol.make({
      ...protocol,
      body: {
        schema: Schema.Unknown,
        from: () => Effect.succeed({ generatedAt: new Date(0) } as unknown)
      }
    })
    const route = Route.make({
      id: "uncanonical",
      protocol: uncanonical,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })

    const error = await Effect.runPromise(Route.prepare(route, request).pipe(Effect.flip))
    expect(error).toMatchObject({
      code: "invalid_request",
      message: "Model request could not be encoded as canonical JSON"
    })
  })

  it("wires route, auth, executor, framing, protocol, and settlement over a fake HTTP client", async () => {
    let sent: HttpClientRequest.HttpClientRequest | undefined
    const sse = [
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"wired\"}",
      "",
      "event: response.output_text.done",
      "data: {\"type\":\"response.output_text.done\",\"item_id\":\"msg_1\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}",
      "",
      ""
    ].join("\n")
    const client = HttpClient.make((httpRequest) =>
      Effect.sync(() => {
        sent = httpRequest
        return HttpClientResponse.fromWeb(
          httpRequest,
          new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
        )
      })
    )

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const model = yield* Model.Model
          return yield* model.stream(request).pipe(Stream.runCollect)
        }).pipe(
          Effect.provide(Route.layer(Result.getOrThrow(Route.openai({ apiKey: Redacted.make("openai-secret") })))),
          Effect.provide(RequestExecutor.layer),
          Effect.provide(kernelHttpClientLayer(client)),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(Array.from(events)).toEqual([
      { type: "text-start", id: "msg_1" },
      { type: "text-delta", id: "msg_1", text: "wired" },
      { type: "text-end", id: "msg_1" },
      {
        type: "settle",
        stopReason: "stop",
        responseId: "resp_1"
      }
    ])
    expect(sent?.headers.authorization).toBe("Bearer openai-secret")
    expect(sent?.body._tag).toBe("Uint8Array")
    const settled = ModelEvent.settledMessage(events)
    expect(settled.message).toMatchObject({
      responseId: "resp_1",
      content: [{ type: "text", text: "wired" }]
    })
    if (sent?.body._tag === "Uint8Array") {
      expect(new TextDecoder().decode(sent.body.body)).toContain("\"stream\":true")
    }
  })

  it("uses the route protocol classifier for HTTP failures", async () => {
    const classifiedProtocol = Protocol.make({
      ...protocol,
      classifyError: (status: number) =>
        new ModelError({
          code: "content_policy",
          message: "protocol-specific refusal",
          providerCode: "policy_violation",
          httpStatus: status
        })
    })
    const route = Route.make({
      id: "classified",
      protocol: classifiedProtocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })
    const client = HttpClient.make((httpRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(httpRequest, new Response("provider body", { status: 418 })))
    )

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const model = yield* Model.Model
          return yield* model.stream(request).pipe(Stream.runDrain, Effect.flip)
        }).pipe(
          Effect.provide(Route.layer(route)),
          Effect.provide(RequestExecutor.layer),
          Effect.provide(kernelHttpClientLayer(client)),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(error).toMatchObject({
      code: "content_policy",
      message: "protocol-specific refusal",
      providerCode: "policy_violation",
      httpStatus: 418
    })
  })

  it("keeps protocol parser failures in the typed stream error channel", async () => {
    const expected = new ModelError({
      code: "invalid_provider_output",
      message: "fixture parser failure"
    })
    const failingProtocol = Protocol.make({
      ...protocol,
      stream: {
        ...protocol.stream,
        step: () => Effect.fail(expected)
      }
    })
    const config = Route.make({
      id: "failing",
      protocol: failingProtocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth: Auth.bearer(Redacted.make("secret")),
      framing: Framing.sse
    })
    const executor = RequestExecutor.RequestExecutor.of({
      execute: (httpRequest) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            httpRequest,
            new Response("data: {}\n\n", {
              status: 200,
              headers: { "content-type": "text/event-stream" }
            })
          )
        )
    })
    const model = await Effect.runPromise(
      Route.toModel(config).pipe(Effect.provideService(RequestExecutor.RequestExecutor, executor))
    )
    const error = await Effect.runPromise(
      Effect.scoped(model.stream(request).pipe(Stream.runDrain, Effect.flip))
    )

    expect(error).toBe(expected)
  })
})

const executorOf = (
  respond: (httpRequest: HttpClientRequest.HttpClientRequest) => Response
): RequestExecutor.RequestExecutor =>
  RequestExecutor.RequestExecutor.of({
    execute: (httpRequest) => Effect.succeed(HttpClientResponse.fromWeb(httpRequest, respond(httpRequest)))
  })

const sseResponse = (frames: ReadonlyArray<string>): Response =>
  new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })

const collect = <Body, Frame, Event, State>(
  config: Route.Config<Body, Frame, Event, State>,
  executor: RequestExecutor.RequestExecutor
): Promise<ReadonlyArray<ModelEvent.ModelEvent>> =>
  Effect.runPromise(
    Effect.scoped(
      Route.toModel(config).pipe(
        Effect.flatMap((model) => model.stream(request).pipe(Stream.runCollect)),
        Effect.provideService(RequestExecutor.RequestExecutor, executor)
      )
    )
  ).then((events) => Array.from(events))

const drainError = <Body, Frame, Event, State>(
  config: Route.Config<Body, Frame, Event, State>,
  executor: RequestExecutor.RequestExecutor
): Promise<Model.ModelFailure> =>
  Effect.runPromise(
    Effect.scoped(
      Route.toModel(config).pipe(
        Effect.flatMap((model) => model.stream(request).pipe(Stream.runDrain, Effect.flip)),
        Effect.provideService(RequestExecutor.RequestExecutor, executor)
      )
    )
  )

const routeOf = <Body, Frame, Event, State>(
  input: {
    readonly protocol: Protocol.Protocol<Body, Frame, Event, State>
    readonly framing: Framing.Framing<Frame>
  }
): Route.Route<Body, Frame, Event, State> =>
  Route.make({
    id: "streamed",
    protocol: input.protocol,
    endpoint: endpoint({ url: "https://example.test" }),
    auth: Auth.bearer(Redacted.make("secret")),
    framing: input.framing
  })

describe("Route.stream", () => {
  it("reports a response body that dies mid-stream as a transport failure", async () => {
    const executor = executorOf(() =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {\"text\":\"partial\"}\n\n"))
            controller.error(new Error("socket reset"))
          }
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    )

    const error = await drainError(routeOf({ protocol, framing: Framing.sse }), executor)
    expect(error).toMatchObject({ code: "transport", message: "Model response stream failed" })
    expect(JSON.stringify(error)).not.toContain("socket reset")
  })

  it("reports an oversized SSE event as a transport failure", async () => {
    const framing: Framing.Framing<string> = {
      id: "sse-too-large",
      frame: () => Stream.fail(new Sse.SseError({ reason: new Sse.EventTooLarge({ maxEventSize: 8 }) }))
    }

    const error = await drainError(routeOf({ protocol, framing }), executorOf(() => sseResponse(["{}"])))
    expect(error).toMatchObject({ code: "transport", message: "Model response stream failed" })
  })

  it("rejects a frame the protocol cannot decode", async () => {
    const error = await drainError(
      routeOf({ protocol, framing: Framing.sse }),
      executorOf(() => sseResponse(["{\"ok\":true}", "not-json"]))
    )

    expect(error).toMatchObject({
      code: "invalid_provider_output",
      message: "test emitted an invalid stream event"
    })
  })

  it("stops at the protocol's terminal event and needs no halt handler", async () => {
    const terminal = Protocol.make({
      id: "terminal",
      supportsDeferred: () => false,
      body: protocol.body,
      stream: {
        event: Schema.fromJsonString(TestEvent),
        initial: () => 0,
        step: (state: number, event: { readonly [key: string]: unknown }) =>
          Effect.succeed(
            [
              state + 1,
              [ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: `f${state}`, text: String(event["text"]) })]
            ] as const
          ),
        terminal: (event: { readonly [key: string]: unknown }) => event["stop"] === true
      },
      classifyError: protocol.classifyError
    })

    const events = await collect(
      routeOf({ protocol: terminal, framing: Framing.sse }),
      executorOf(() =>
        sseResponse([
          "{\"text\":\"one\"}",
          "{\"text\":\"two\",\"stop\":true}",
          "{\"text\":\"three\"}"
        ])
      )
    )

    expect(events).toEqual([
      { type: "text-delta", id: "f0", text: "one" },
      { type: "text-delta", id: "f1", text: "two" }
    ])
  })

  it("streams zero events when the provider settles without sending any", async () => {
    const events = await collect(routeOf({ protocol, framing: Framing.sse }), executorOf(() => sseResponse(["[DONE]"])))
    expect(events).toEqual([])
  })
})

describe("Route.stream refresh", () => {
  const refusal = () => new ModelError({ code: "authentication", message: "expired", httpStatus: 401 })

  const countingExecutor = (
    respond: (attempt: number, httpRequest: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response, ModelError>
  ) => {
    const seen: Array<HttpClientRequest.HttpClientRequest> = []
    const executor = RequestExecutor.RequestExecutor.of({
      execute: (httpRequest) => {
        seen.push(httpRequest)
        return respond(seen.length, httpRequest).pipe(
          Effect.map((response) => HttpClientResponse.fromWeb(httpRequest, response))
        )
      }
    })
    return { executor, seen }
  }

  const refreshingAuth = () => {
    let token = "stale-token"
    let refreshes = 0
    const auth: Auth.Auth = {
      sign: (headers) => Effect.sync(() => ({ ...headers, Authorization: `Bearer ${token}` })),
      refresh: Effect.sync(() => {
        refreshes += 1
        token = "fresh-token"
      })
    }
    return { auth, count: () => refreshes }
  }

  const withAuth = (auth: Auth.Auth) =>
    Route.make({
      id: "refreshing",
      protocol,
      endpoint: endpoint({ url: "https://example.test" }),
      auth,
      framing: Framing.sse
    })

  it("refreshes and re-signs exactly once after an authentication failure", async () => {
    const { auth, count } = refreshingAuth()
    const { executor, seen } = countingExecutor((attempt) =>
      attempt === 1 ? Effect.fail(refusal()) : Effect.succeed(sseResponse(["[DONE]"]))
    )

    const events = await collect(withAuth(auth), executor)

    expect(events).toEqual([])
    expect(count()).toBe(1)
    expect(seen.map((request) => request.headers.authorization)).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token"
    ])
  })

  it("surfaces the second authentication failure rather than retrying again", async () => {
    const { auth, count } = refreshingAuth()
    const { executor, seen } = countingExecutor(() => Effect.fail(refusal()))

    const error = await drainError(withAuth(auth), executor)

    expect(error).toMatchObject({ code: "authentication", httpStatus: 401 })
    expect(count()).toBe(1)
    expect(seen).toHaveLength(2)
  })

  it("keeps a static credential terminal: no refresh, one attempt", async () => {
    const { executor, seen } = countingExecutor(() => Effect.fail(refusal()))

    const error = await drainError(withAuth(Auth.bearer(Redacted.make("static-key"))), executor)

    expect(error).toMatchObject({ code: "authentication" })
    expect(seen).toHaveLength(1)
  })

  it("does not treat other failures as refreshable", async () => {
    const { auth, count } = refreshingAuth()
    const { executor, seen } = countingExecutor(() =>
      Effect.fail(new ModelError({ code: "rate_limited", message: "slow down", httpStatus: 429 }))
    )

    const error = await drainError(withAuth(auth), executor)

    expect(error).toMatchObject({ code: "rate_limited" })
    expect(count()).toBe(0)
    expect(seen).toHaveLength(1)
  })
})
