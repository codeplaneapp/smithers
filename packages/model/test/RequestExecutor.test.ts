import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Random from "effect/Random"
import type * as Scope from "effect/Scope"
import * as TestClock from "effect/testing/TestClock"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as Request from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import { ModelError } from "../src/ModelError.js"
import * as RequestExecutor from "../src/RequestExecutor.js"

interface ResponseSpec {
  readonly status: number
  readonly body: string
  readonly headers?: Readonly<Record<string, string>> | undefined
}

const response = (
  request: HttpClientRequest.HttpClientRequest,
  spec: ResponseSpec
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(spec.body, {
      status: spec.status,
      ...(spec.headers !== undefined ? { headers: spec.headers } : {})
    })
  )

const executorLayer = (
  specs: ReadonlyArray<ResponseSpec>,
  requests: Array<HttpClientRequest.HttpClientRequest>
): Layer.Layer<RequestExecutor.RequestExecutor> => {
  let cursor = 0
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      const spec = specs[Math.min(cursor, specs.length - 1)]
      cursor += 1
      if (spec === undefined) throw new Error("A fake response is required")
      return response(request, spec)
    })
  )
  return RequestExecutor.layer.pipe(
    Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(client))
  )
}

const execute = (
  executor: RequestExecutor.RequestExecutor,
  request: HttpClientRequest.HttpClientRequest,
  options: Omit<RequestExecutor.ExecuteOptions, "modelId"> = {}
) => executor.execute(request, { modelId: "test-model", ...options })

const run = <A, E>(
  effect: Effect.Effect<A, E, RequestExecutor.RequestExecutor | Scope.Scope>,
  layer: Layer.Layer<RequestExecutor.RequestExecutor>
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(layer),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
      )
    )
  )

const request = (
  url = "https://provider.test/v1/models",
  body = "{}",
  headers: Headers.Input = {}
): HttpClientRequest.HttpClientRequest =>
  Request.post(url, { headers }).pipe(
    Request.bodyText(body, "application/json")
  )

const expectModelError = (value: unknown): ModelError => {
  expect(value).toBeInstanceOf(ModelError)
  if (!(value instanceof ModelError)) throw new Error("Expected ModelError")
  return value
}

const bodyBytes = (value: HttpClientRequest.HttpClientRequest): ReadonlyArray<number> =>
  value.body._tag === "Uint8Array" ? Array.from(value.body.body) : []

const NOW = 1_700_000_000_000

// One non-retryable exchange against a frozen clock, so every reset instant an
// assertion names is exact rather than wall-clock dependent.
const errorFor = async (
  spec: ResponseSpec,
  sent: HttpClientRequest.HttpClientRequest = request()
): Promise<ModelError> => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const layer = executorLayer([spec], requests)
  const error = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        yield* TestClock.setTime(NOW)
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, sent).pipe(Effect.flip)
      }).pipe(
        Effect.provide(layer),
        Effect.provide(TestClock.layer()),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
      )
    )
  )
  expect(requests).toHaveLength(1)
  return expectModelError(error)
}

// A transport failure is retryable, so the bounded schedule is exhausted on the
// TestClock rather than in wall-clock time.
const transportFailure = async (
  reason: (sent: HttpClientRequest.HttpClientRequest) => HttpClientError.HttpClientError["reason"],
  sent: HttpClientRequest.HttpClientRequest
): Promise<ModelError> => {
  const client = HttpClient.make((attempted) =>
    Effect.fail(new HttpClientError.HttpClientError({ reason: reason(attempted) }))
  )
  const layer = RequestExecutor.layer.pipe(
    Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(client))
  )
  const error = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        const fiber = yield* execute(executor, sent).pipe(Effect.flip, Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust(120_000)
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(layer),
        Effect.provide(TestClock.layer()),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
      )
    )
  )
  return expectModelError(error)
}

describe("RequestExecutor", () => {
  it("retries a generic 429 exactly twice and preserves Retry-After metadata", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer(
      Array.from({ length: 3 }, () => ({
        status: 429,
        body: "{\"error\":{\"message\":\"rate limited\"}}",
        headers: { "retry-after": "2" }
      })),
      requests
    )

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.RequestExecutor
          const fiber = yield* execute(executor, request()).pipe(Effect.flip, Effect.forkChild)

          yield* Effect.yieldNow
          expect(requests).toHaveLength(1)
          yield* TestClock.adjust(2_000)
          expect(requests).toHaveLength(2)
          yield* TestClock.adjust(2_000)

          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    const modelError = expectModelError(error)
    expect(requests).toHaveLength(3)
    expect(modelError).toMatchObject({
      code: "rate_limited",
      retryAfterMillis: 2_000,
      resetAtEpochMillis: 6_000,
      resetSource: "retry-after",
      httpStatus: 429
    })
  })

  it("does not retry a 400 response", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([
      { status: 400, body: "{\"error\":{\"message\":\"invalid parameter\"}}" },
      { status: 200, body: "unexpected" }
    ], requests)

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request()).pipe(Effect.flip)
      }),
      layer
    )

    expect(expectModelError(error).code).toBe("invalid_request")
    expect(requests).toHaveLength(1)
  })

  it("retries 503 responses with exponential TestClock-controlled backoff", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([
      { status: 503, body: "busy" },
      { status: 503, body: "still busy" },
      { status: 200, body: "ok" }
    ], requests)

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.RequestExecutor
          const fiber = yield* execute(executor, request()).pipe(Effect.forkChild)

          yield* Effect.yieldNow
          expect(requests).toHaveLength(1)
          yield* TestClock.adjust(500)
          expect(requests).toHaveLength(2)
          yield* TestClock.adjust(1_000)

          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(Random.Random, {
            nextDoubleUnsafe: () => 0.5,
            nextIntUnsafe: () => 0
          }),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(result.status).toBe(200)
    expect(requests).toHaveLength(3)
  })

  it("classifies explicit quota before retry and retains its reset", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([
      {
        status: 429,
        body: "{\"error\":{\"code\":\"insufficient_quota\",\"message\":\"billing quota exhausted\"}}",
        headers: {
          "x-ratelimit-reset-requests": "1m",
          "x-request-id": "req_quota"
        }
      },
      { status: 200, body: "unexpected" }
    ], requests)

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.setTime(10_000)
          const executor = yield* RequestExecutor.RequestExecutor
          return yield* execute(executor, request()).pipe(Effect.flip)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(expectModelError(error)).toMatchObject({
      code: "quota_exceeded",
      providerCode: "insufficient_quota",
      requestId: "req_quota",
      resetAtEpochMillis: 70_000,
      resetSource: "x-ratelimit-reset-requests",
      httpStatus: 429
    })
    expect(requests).toHaveLength(1)
  })

  it("does not classify quota-like prose without an explicit provider code", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer(
      Array.from({ length: 3 }, () => ({
        status: 429,
        body: "{\"error\":{\"message\":\"billing quota exhausted\"}}",
        headers: { "retry-after-ms": "0" }
      })),
      requests
    )

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request()).pipe(Effect.flip)
      }),
      layer
    )

    expect(expectModelError(error).code).toBe("rate_limited")
    expect(requests).toHaveLength(3)
  })

  it("reuses byte-identical method, URL, headers, and body", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([
      { status: 503, body: "busy", headers: { "retry-after-ms": "0" } },
      { status: 503, body: "busy", headers: { "retry-after-ms": "0" } },
      { status: 503, body: "busy", headers: { "retry-after-ms": "0" } }
    ], requests)
    const original = request(
      "https://provider.test/v1/models?debug=1",
      "{\"model\":\"test\"}",
      { authorization: "Bearer test-secret", "x-public": "same" }
    )

    await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        yield* execute(executor, original).pipe(Effect.flip)
      }),
      layer
    )

    expect(requests).toHaveLength(3)
    const signatures = requests.map((value) => ({
      method: value.method,
      url: value.url,
      urlParams: value.urlParams.params,
      headers: Object.entries(value.headers),
      body: bodyBytes(value)
    }))
    expect(signatures[1]).toEqual(signatures[0])
    expect(signatures[2]).toEqual(signatures[0])
  })

  it("parses an HTTP-date Retry-After against the Effect Clock", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const now = 1_700_000_000_000
    const reset = now + 2_000
    const layer = executorLayer([
      {
        status: 429,
        body: "rate limited",
        headers: { "retry-after": new Date(reset).toUTCString() }
      },
      { status: 200, body: "ok" }
    ], requests)

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.setTime(now)
          const executor = yield* RequestExecutor.RequestExecutor
          const fiber = yield* execute(executor, request()).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(1_999)
          expect(requests).toHaveLength(1)
          yield* TestClock.adjust(1)
          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(result.status).toBe(200)
    expect(requests).toHaveLength(2)
  })

  it("normalizes Anthropic and OpenAI reset headers to absolute instants", async () => {
    const now = 1_700_000_000_000

    const openAiRequests: Array<HttpClientRequest.HttpClientRequest> = []
    const openAiLayer = executorLayer([{
      status: 400,
      body: "bad",
      headers: { "x-ratelimit-reset-tokens": "10s" }
    }], openAiRequests)
    const openAiError = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.setTime(now)
          const executor = yield* RequestExecutor.RequestExecutor
          return yield* execute(executor, request()).pipe(Effect.flip)
        }).pipe(
          Effect.provide(openAiLayer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )
    expect(expectModelError(openAiError)).toMatchObject({
      resetAtEpochMillis: now + 10_000,
      resetSource: "x-ratelimit-reset-tokens"
    })

    const anthropicRequests: Array<HttpClientRequest.HttpClientRequest> = []
    const anthropicReset = now + 30_000
    const anthropicLayer = executorLayer([{
      status: 400,
      body: "bad",
      headers: {
        "anthropic-ratelimit-requests-reset": new Date(anthropicReset).toISOString()
      }
    }], anthropicRequests)
    const anthropicError = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.setTime(now)
          const executor = yield* RequestExecutor.RequestExecutor
          return yield* execute(executor, request()).pipe(Effect.flip)
        }).pipe(
          Effect.provide(anthropicLayer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )
    expect(expectModelError(anthropicError)).toMatchObject({
      resetAtEpochMillis: anthropicReset,
      resetSource: "anthropic-ratelimit-requests-reset"
    })
  })

  it("selects only the exhausted resource window", async () => {
    const now = 1_700_000_000_000
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{
      status: 400,
      body: "bad",
      headers: {
        "x-ratelimit-remaining-tokens": "100",
        "x-ratelimit-reset-tokens": "1s",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "1m"
      }
    }], requests)

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.setTime(now)
          const executor = yield* RequestExecutor.RequestExecutor
          return yield* execute(executor, request()).pipe(Effect.flip)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(expectModelError(error)).toMatchObject({
      resetAtEpochMillis: now + 60_000,
      resetSource: "x-ratelimit-reset-requests"
    })
  })

  it("prefers Retry-After over resource reset windows", async () => {
    const now = 1_700_000_000_000
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{
      status: 400,
      body: "bad",
      headers: {
        "retry-after": "30",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "1m"
      }
    }], requests)

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.setTime(now)
          const executor = yield* RequestExecutor.RequestExecutor
          return yield* execute(executor, request()).pipe(Effect.flip)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(expectModelError(error)).toMatchObject({
      retryAfterMillis: 30_000,
      resetAtEpochMillis: now + 30_000,
      resetSource: "retry-after"
    })
  })

  it("normalizes an explicit provider-body reset field", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const resetAtEpochMillis = 1_700_000_060_000
    const layer = executorLayer([{
      status: 400,
      body: `{"error":{"message":"bad","reset_at":${resetAtEpochMillis / 1_000}}}`
    }], requests)

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request()).pipe(Effect.flip)
      }),
      layer
    )

    expect(expectModelError(error)).toMatchObject({
      resetAtEpochMillis,
      resetSource: "body.error.reset_at"
    })
  })

  it("retains provider request IDs", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{
      status: 400,
      body: "bad",
      headers: { "x-amzn-requestid": "amazon-request-123" }
    }], requests)

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request()).pipe(Effect.flip)
      }),
      layer
    )

    expect(expectModelError(error).requestId).toBe("amazon-request-123")
  })

  it("redacts before capping oversized provider diagnostics", async () => {
    const secret = "credential-before-cap"
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{
      status: 400,
      body: `${secret}${"x".repeat(20_000)}`
    }], requests)

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(
          executor,
          request("https://provider.test/v1/models", "{}", { authorization: `Bearer ${secret}` })
        ).pipe(Effect.flip)
      }),
      layer
    )

    const serialized = JSON.stringify(expectModelError(error))
    expect(serialized).not.toContain(secret)
    expect(serialized.length).toBeLessThan(16_384)
  })

  it("never serializes header, query, JSON-body, or echoed credential bytes", async () => {
    const headerSecret = "header-secret-123"
    const querySecret = "query-secret-456"
    const bodySecret = "body-secret-789"
    const responseSecret = "response-secret-012"
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{
      status: 400,
      body: JSON.stringify({
        error: {
          message: `echoed ${headerSecret} ${querySecret} ${bodySecret}`,
          api_key: responseSecret
        }
      })
    }], requests)

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        const credentialRequest = request(
          `https://provider.test/v1/models?key=${querySecret}`,
          JSON.stringify({ api_key: bodySecret, model: "safe" }),
          { authorization: `Bearer ${headerSecret}` }
        )
        return yield* execute(executor, credentialRequest).pipe(Effect.flip)
      }),
      layer
    )

    const serialized = JSON.stringify(expectModelError(error))
    for (const secret of [headerSecret, querySecret, bodySecret, responseSecret]) {
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain(encodeURIComponent(secret))
    }
    expect(serialized).toContain("<redacted>")
  })

  it("classifies network failures as transport errors with a redacted URL", async () => {
    const secret = "transport-query-secret"
    const cause = Object.assign(new Error(`socket closed for ${secret}`), {
      name: "SocketError",
      code: "ECONNRESET"
    })
    const client = HttpClient.make((failedRequest) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request: failedRequest,
            description: `provider echoed ${secret}`,
            cause
          })
        })
      )
    )
    const layer = RequestExecutor.layer.pipe(
      Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(client))
    )

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(
          executor,
          request(`https://provider.test/v1/models?key=${secret}`)
        ).pipe(Effect.flip)
      }),
      layer
    )

    const modelError = expectModelError(error)
    expect(modelError.code).toBe("transport")
    expect(JSON.stringify(modelError)).not.toContain(secret)
    expect(modelError.message).toContain("%3Credacted%3E")
    expect(modelError.message).toContain("SocketError [ECONNRESET] socket closed")
  })

  it("preserves a typed kernel denial without converting it to ModelError", async () => {
    // The kernel projects a permission failure into the error channel Effect's
    // `HttpClient` tag fixes, keeping the structured failure on the cause.
    const deniedClient = HttpClient.make((request) =>
      Effect.fail(
        KernelHttpClient.toHttpClientError({
          request,
          error: new Permission.PermissionDenied({
            capability: Capability.make("model:call", "provider.test/test-model"),
            reason: "denied by policy"
          })
        })
      )
    )
    const layer = RequestExecutor.layer.pipe(
      Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(deniedClient))
    )

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request()).pipe(Effect.flip)
      }),
      layer
    )

    expect(error).toBeInstanceOf(Permission.PermissionDenied)
    expect(error).toMatchObject({
      code: "permission_denied",
      capability: Capability.make("model:call", "provider.test/test-model"),
      reason: "denied by policy"
    })
  })

  it("preserves the complete typed permission suspension request", async () => {
    const required = new Permission.PermissionRequired({
      requestId: "permission-model-1",
      runId: "run-7",
      capability: Capability.make("model:call", "provider.test/test-model"),
      tier: "sealed",
      meta: { provider: "provider.test", attempt: 1 }
    })
    const permissionClient = HttpClient.make((request) =>
      Effect.fail(KernelHttpClient.toHttpClientError({ request, error: required }))
    )
    const layer = RequestExecutor.layer.pipe(
      Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(permissionClient))
    )

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request()).pipe(Effect.flip)
      }),
      layer
    )

    expect(error).toBe(required)
    expect(error).toMatchObject({
      code: "permission_required",
      requestId: "permission-model-1",
      runId: "run-7",
      capability: Capability.make("model:call", "provider.test/test-model"),
      tier: "sealed",
      meta: { provider: "provider.test", attempt: 1 }
    })
  })

  it("retries transport failures with bounded backoff", async () => {
    let attempts = 0
    const original = request()
    const client = HttpClient.make((attemptedRequest) =>
      Effect.sync(() => {
        attempts += 1
        return attempts
      }).pipe(
        Effect.flatMap((attempt) =>
          attempt < 3
            ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request: attemptedRequest,
                  description: "temporary network failure"
                })
              })
            )
            : Effect.succeed(response(attemptedRequest, { status: 200, body: "ok" }))
        )
      )
    )
    const layer = RequestExecutor.layer.pipe(
      Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(client))
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.RequestExecutor
          const fiber = yield* execute(executor, original).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(attempts).toBe(1)
          yield* TestClock.adjust(500)
          expect(attempts).toBe(2)
          yield* TestClock.adjust(1_000)
          return yield* Fiber.join(fiber)
        }).pipe(
          Effect.provide(layer),
          Effect.provide(TestClock.layer()),
          Effect.provideService(Random.Random, {
            nextDoubleUnsafe: () => 0.5,
            nextIntUnsafe: () => 0
          }),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(result.status).toBe(200)
    expect(attempts).toBe(3)
  })

  it("redacts password credentials in headers, query, request bodies, and echoed diagnostics", async () => {
    const headerPassword = "header-password"
    const queryPassword = "query-password"
    const bodyPassword = "body-password"
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{
      status: 400,
      body: JSON.stringify({
        error: {
          message: `${headerPassword} ${queryPassword} ${bodyPassword}`,
          password: "response-password"
        }
      })
    }], requests)

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(
          executor,
          request(
            `https://provider.test/v1/models?password=${queryPassword}`,
            JSON.stringify({ password: bodyPassword }),
            { "x-password": headerPassword }
          )
        ).pipe(Effect.flip)
      }),
      layer
    )

    const serialized = JSON.stringify(expectModelError(error))
    for (const password of [headerPassword, queryPassword, bodyPassword, "response-password"]) {
      expect(serialized).not.toContain(password)
    }
  })

  it("classifies each status that is not a rate limit", async () => {
    expect((await errorFor({ status: 403, body: "{}" })).code).toBe("authentication")
    expect((await errorFor({ status: 400, body: "blocked by content_filter" })).code).toBe("content_policy")
    expect((await errorFor({ status: 400, body: "maximum context length is 200000 tokens" })).code).toBe(
      "context_overflow"
    )
    for (const status of [404, 409, 413, 422]) {
      expect((await errorFor({ status, body: "{}" })).code).toBe("invalid_request")
    }
    // 402 is neither retryable nor one of the recognized request faults.
    expect(await errorFor({ status: 402, body: "{}" })).toMatchObject({
      code: "unknown",
      message: "Provider request failed with HTTP 402: {}"
    })
  })

  it("reports an empty and an unreadable response body without inventing detail", async () => {
    expect(await errorFor({ status: 400, body: "" })).toMatchObject({
      code: "invalid_request",
      message: "Provider request failed with HTTP 400"
    })
    expect(await errorFor({ status: 400, body: "   " })).toMatchObject({ code: "invalid_request" })

    const unreadable = HttpClient.make((sent) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          sent,
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("body stream failed"))
              }
            }),
            { status: 400 }
          )
        )
      )
    )
    const layer = RequestExecutor.layer.pipe(
      Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(unreadable))
    )

    const error = await run(
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        return yield* execute(executor, request(), {
          classifyError: (status, body) =>
            new ModelError({ code: "invalid_provider_output", message: `classified ${status} from "${body}"` })
        }).pipe(Effect.flip)
      }),
      layer
    )

    // The classifier still runs, and sees an empty body rather than `undefined`.
    expect(expectModelError(error)).toMatchObject({
      code: "invalid_provider_output",
      message: "classified 400 from \"\""
    })
  })

  it("keeps a provider's own code and message when the body has no error envelope", async () => {
    expect(await errorFor({ status: 418, body: "{\"code\":\"teapot\",\"message\":\"short and stout\"}" }))
      .toMatchObject({
        code: "unknown",
        providerCode: "teapot",
        httpStatus: 418
      })
    expect(await errorFor({ status: 418, body: "{\"type\":\"teapot\",\"detail\":\"short and stout\"}" }))
      .toMatchObject({ providerCode: "teapot" })
  })

  it("normalizes every reset instant a provider body can express", async () => {
    expect(await errorFor({ status: 400, body: "{\"rate_limit\":{\"remaining\":0,\"reset\":30}}" })).toMatchObject({
      resetAtEpochMillis: NOW + 30_000,
      resetSource: "body.rate_limit.reset"
    })
    // A resource with headroom left is not the window this request waits on.
    expect(
      (await errorFor({ status: 400, body: "{\"rate_limit\":{\"remaining\":5,\"reset\":30}}" })).resetAtEpochMillis
    )
      .toBeUndefined()

    expect(await errorFor({ status: 400, body: "{\"limits\":[{\"retry_after_ms\":1500}]}" })).toMatchObject({
      resetAtEpochMillis: NOW + 1_500,
      resetSource: "body.limits[0].retry_after_ms"
    })
    expect(await errorFor({ status: 400, body: "{\"retry_after\":\"2\"}" })).toMatchObject({
      resetAtEpochMillis: NOW + 2_000,
      resetSource: "body.retry_after"
    })
    // The nearest of two competing retry windows wins.
    expect(await errorFor({ status: 400, body: "{\"retry_after\":9,\"nested\":{\"reset_after\":4}}" })).toMatchObject({
      resetAtEpochMillis: NOW + 4_000,
      resetSource: "body.nested.reset_after"
    })
    expect(await errorFor({ status: 400, body: "{\"reset_at\":1700000060000}" })).toMatchObject({
      resetAtEpochMillis: 1_700_000_060_000
    })
    expect(await errorFor({ status: 400, body: "{\"reset_at\":\"1700000060\"}" })).toMatchObject({
      resetAtEpochMillis: 1_700_000_060_000
    })
    expect(await errorFor({ status: 400, body: "{\"reset_at\":\"1m30s\"}" })).toMatchObject({
      resetAtEpochMillis: NOW + 90_000
    })

    // Values that cannot name an instant leave the field absent.
    for (
      const body of [
        "{\"reset_at\":\"not-a-time\"}",
        "{\"reset_at\":\"x1s\"}",
        "{\"reset_at\":{\"nested\":1}}",
        "{\"reset_at\":true}",
        "{\"retry_after\":1e308}"
      ]
    ) {
      expect((await errorFor({ status: 400, body })).resetAtEpochMillis).toBeUndefined()
    }
  })

  it("ignores reset headers it cannot read and an unparseable Retry-After", async () => {
    expect(
      (await errorFor({ status: 400, body: "bad", headers: { "x-ratelimit-reset-requests": "not-a-time" } }))
        .resetAtEpochMillis
    ).toBeUndefined()
    expect(await errorFor({ status: 400, body: "bad", headers: { "x-ratelimit-reset-requests": "" } }))
      .toMatchObject({ resetAtEpochMillis: NOW, resetSource: "x-ratelimit-reset-requests" })
    expect(await errorFor({ status: 400, body: "bad", headers: { "retry-after": "tomorrow" } })).toMatchObject({
      retryAfterMillis: undefined,
      resetAtEpochMillis: undefined
    })
    expect(await errorFor({ status: 400, body: "bad", headers: { "retry-after": "  " } })).toMatchObject({
      retryAfterMillis: undefined
    })
  })

  it("scrubs credentials from raw, byte, structured, and form request bodies", async () => {
    const rawForm = Request.setBody(
      Request.post("https://provider.test/v1/models"),
      HttpBody.raw("api_key=raw-secret&page=1")
    )
    expect(JSON.stringify(await errorFor({ status: 400, body: "echoed raw-secret" }, rawForm)))
      .not.toContain("raw-secret")

    const rawBytes = Request.setBody(
      Request.post("https://provider.test/v1/models"),
      HttpBody.raw(new TextEncoder().encode("{\"api_key\":\"bytes-secret\"}"))
    )
    expect(JSON.stringify(await errorFor({ status: 400, body: "echoed bytes-secret" }, rawBytes)))
      .not.toContain("bytes-secret")

    const rawStructured = Request.setBody(
      Request.post("https://provider.test/v1/models"),
      HttpBody.raw({ api_key: "object-secret", nested: [{ password: 987654321, secret_flag: true }] })
    )
    const structured = await errorFor(
      { status: 400, body: "echoed object-secret 987654321 true" },
      rawStructured
    )
    expect(JSON.stringify(structured)).not.toContain("object-secret")
    expect(JSON.stringify(structured)).not.toContain("987654321")

    const formData = new FormData()
    formData.append("api_key", "form-secret")
    formData.append("model", "safe")
    const form = Request.bodyFormData(Request.post("https://provider.test/v1/models"), formData)
    expect(JSON.stringify(await errorFor({ status: 400, body: "echoed form-secret" }, form)))
      .not.toContain("form-secret")
  })

  it("scrubs credentials carried as appended URL parameters", async () => {
    const withParams = Request.post("https://provider.test/v1/models").pipe(
      Request.setUrlParam("access_token", "param-secret"),
      Request.setUrlParam("page", "2")
    )

    const error = await errorFor({ status: 400, body: "echoed param-secret" }, withParams)
    expect(JSON.stringify(error)).not.toContain("param-secret")

    const transport = await transportFailure(
      (attempted) => new HttpClientError.TransportError({ request: attempted, description: "echoed param-secret" }),
      withParams
    )
    expect(transport.message).toContain("access_token=%3Credacted%3E")
    expect(transport.message).toContain("page=2")
    expect(transport.message).not.toContain("param-secret")
  })

  it("redacts the header names the caller's policy names, not only the built-in ones", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const layer = executorLayer([{ status: 400, body: "echoed tenant-secret and public-value" }], requests)

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.RequestExecutor
          return yield* execute(
            executor,
            request("https://provider.test/v1/models", "{}", {
              "x-tenant": "tenant-secret",
              "x-public": "public-value"
            })
          ).pipe(Effect.flip)
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(Headers.CurrentRedactedNames, [/^x-tenant/i, "x-session"]),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    const serialized = JSON.stringify(expectModelError(error))
    expect(serialized).not.toContain("tenant-secret")
    expect(serialized).toContain("public-value")
  })

  it("describes a transport failure without a description, a cause, or headers", async () => {
    const bare = await transportFailure(
      (attempted) => new HttpClientError.TransportError({ request: attempted, cause: { code: 42 } }),
      Request.post("https://provider.test/v1/models")
    )
    expect(bare).toMatchObject({
      code: "transport",
      message: "HTTP transport failed: TransportError (POST https://provider.test/v1/models)"
    })

    const stringCause = await transportFailure(
      (attempted) => new HttpClientError.TransportError({ request: attempted, cause: "connection reset" }),
      Request.post("https://provider.test/v1/models")
    )
    expect(stringCause.message).toBe(
      "HTTP transport failed: TransportError: connection reset (POST https://provider.test/v1/models)"
    )

    const plainError = await transportFailure(
      (attempted) => new HttpClientError.TransportError({ request: attempted, cause: new Error("plain failure") }),
      request("https://provider.test/v1/models", "{}", { "x-public": "yes" })
    )
    expect(plainError.message).toBe(
      "HTTP transport failed: TransportError: plain failure (POST https://provider.test/v1/models, headers redacted)"
    )
  })

  it("redacts a request URL it cannot parse rather than echoing it", async () => {
    // A relative URL never resolves to a host, so the client rejects it before
    // the fake handler runs and the executor reports the target as redacted.
    const relative = await transportFailure(
      (attempted) => new HttpClientError.TransportError({ request: attempted, description: "unused" }),
      Request.post("/v1/models")
    )

    expect(relative.message).toBe("HTTP transport failed: InvalidUrlError (POST <redacted>)")
  })

  it("replaces a poisoned transport once waiting has stopped being the explanation", async () => {
    // The r92 shape, scripted: a client whose session the peer destroyed, which
    // fails identically however long the ladder waits. Rebuilding is the rung
    // the ladder did not have — a fresh connection pool is the only thing that
    // answers — and the double proves the executor reaches for it rather than
    // spending the whole budget on a socket that is not coming back.
    const attempts: Array<string> = []
    let rebuilds = 0
    const poisoned = HttpClient.make((attempted) => {
      attempts.push("poisoned")
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request: attempted,
            description: "The session has been destroyed",
            cause: Object.assign(new Error("ERR_HTTP2_INVALID_SESSION"), { name: "SessionError" })
          })
        })
      )
    })
    const healthy = HttpClient.make((attempted) =>
      Effect.sync(() => {
        attempts.push("healthy")
        return response(attempted, { status: 200, body: "{}" })
      })
    )
    const transport: RequestExecutor.Transport = {
      client: poisoned,
      rebuild: Effect.sync(() => {
        rebuilds += 1
        return healthy
      })
    }

    const settled = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.makeWith(transport)
          // The executor's own ladder: one attempt plus two retries, all on the
          // poisoned client, and no rebuild while the count is under the bound.
          const fiber = yield* execute(executor, request()).pipe(Effect.flip, Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(120_000)
          const failed = yield* Fiber.join(fiber)
          expect(expectModelError(failed).code).toBe("transport")
          expect(attempts).toEqual(["poisoned", "poisoned", "poisoned"])
          expect(rebuilds).toBe(0)

          // The outer ladder comes back. The count has reached the bound, so
          // the next attempt is made on a client the host built fresh, and it
          // answers.
          const again = yield* execute(executor, request()).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(120_000)
          return yield* Fiber.join(again)
        }).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(settled.status).toBe(200)
    expect(rebuilds).toBe(1)
    expect(attempts).toEqual(["poisoned", "poisoned", "poisoned", "healthy"])
  })

  it("hands the rebuilt transport the identical request the dead one failed on", async () => {
    // What "resumes across the rebuild" means at this seam: the work the caller
    // was doing is not re-derived and not lost. The request that failed on the
    // poisoned client is the request the rebuilt one receives — same method,
    // same URL, same bytes — so a frame that has already settled calls keeps
    // them and the run carries on rather than ending on a dead socket.
    const seen: Array<{ readonly method: string; readonly url: string; readonly body: string }> = []
    let rebuilt = false
    const client = HttpClient.make((attempted) => {
      seen.push({
        method: attempted.method,
        url: attempted.url,
        body: attempted.body._tag === "Uint8Array" ? new TextDecoder().decode(attempted.body.body) : ""
      })
      return rebuilt
        ? Effect.succeed(response(attempted, { status: 200, body: "{}" }))
        : Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: attempted,
              description: "The session has been destroyed"
            })
          })
        )
    })

    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.makeWith({
            client,
            rebuild: Effect.sync(() => {
              rebuilt = true
              return client
            })
          })
          // One execute spends the executor's own ladder — an attempt plus
          // `MAX_RETRIES` — which is what reaches `rebuildAfter`.
          const dead = yield* execute(executor, request("https://provider.test/v1/chat", "{\"n\":1}")).pipe(
            Effect.flip,
            Effect.forkChild
          )
          yield* Effect.yieldNow
          yield* TestClock.adjust(120_000)
          yield* Fiber.join(dead)

          const fiber = yield* execute(executor, request("https://provider.test/v1/chat", "{\"n\":1}")).pipe(
            Effect.forkChild
          )
          yield* Effect.yieldNow
          yield* TestClock.adjust(120_000)
          const settled = yield* Fiber.join(fiber)
          return settled.status
        }).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(status).toBe(200)
    expect(seen).toHaveLength(RequestExecutor.rebuildAfter + 1)
    expect(new Set(seen.map((sent) => `${sent.method} ${sent.url} ${sent.body}`)))
      .toEqual(new Set(["POST https://provider.test/v1/chat {\"n\":1}"]))
  })

  it("counts only the transport, and forgets it the moment anything answers", async () => {
    // A 500 arrived over a connection that worked, so it says nothing about the
    // client. Without this a provider having a bad afternoon would throw away a
    // healthy connection pool every third request.
    let rebuilds = 0
    let statuses: Array<number> = [500, 500, 500, 500]
    let cursor = 0
    const client = HttpClient.make((attempted) =>
      Effect.sync(() => response(attempted, { status: statuses[Math.min(cursor++, statuses.length - 1)]!, body: "{}" }))
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.makeWith({
            client,
            rebuild: Effect.sync(() => {
              rebuilds += 1
              return client
            })
          })
          for (let spent = 0; spent < RequestExecutor.rebuildAfter + 1; spent += 1) {
            const fiber = yield* execute(executor, request()).pipe(Effect.flip, Effect.forkChild)
            yield* Effect.yieldNow
            yield* TestClock.adjust(120_000)
            yield* Fiber.join(fiber)
          }
          return undefined
        }).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(rebuilds).toBe(0)
    statuses = []
    cursor = 0
  })

  it("answers every rebuild with the same client when the host has nothing to replace", async () => {
    // The browser's answer, and the default one: `fixed` is what a host with no
    // connection pool of its own says, and its executor behaves exactly as it
    // did before the seam existed.
    const attempts: Array<string> = []
    const client = HttpClient.make((attempted) => {
      attempts.push(attempted.url)
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: attempted, description: "dead" })
        })
      )
    })
    const transport = RequestExecutor.fixed(client)

    expect(await Effect.runPromise(transport.rebuild)).toBe(client)
    expect(transport.client).toBe(client)
    expect(attempts).toEqual([])
  })

  it("propagates interruption of an in-flight execute", async () => {
    let started = false
    const client = HttpClient.make(() =>
      Effect.sync(() => {
        started = true
      }).pipe(Effect.andThen(Effect.never))
    )
    const layer = RequestExecutor.layer.pipe(
      Layer.provide(Layer.succeed(KernelHttpClient.HttpClient)(client))
    )

    const interrupted = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const executor = yield* RequestExecutor.RequestExecutor
          const fiber = yield* execute(executor, request()).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(started).toBe(true)
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )

    expect(Exit.hasInterrupts(interrupted)).toBe(true)
  })
})
