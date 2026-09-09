/**
 * Default OTLP export wiring for flows telemetry.
 *
 * The store packages already open spans through Effect's tracer and update
 * `Metric` counters on their hot paths; what they deliberately do not do is
 * ship an exporter. This module is that exporter: one layer that installs
 * Effect's own OTLP logger, metrics exporter, and tracer
 * (`effect/unstable/observability/Otlp`) against a collector endpoint, with
 * the flows service identity filled in. Nothing beyond `effect` is involved;
 * no OpenTelemetry SDK dependency.
 *
 * Browser support is met by construction rather than by a no-op variant:
 * export happens over Effect's `HttpClient`, and {@link layerFetch} binds the
 * `fetch` implementation the host already has, so no entry point here ever
 * resolves a `node:` built-in. See the
 * {@link https://smithers.sh/docs/reference/api/observability | observability API contract}.
 *
 * @since 0.1.0
 */
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Semaphore from "effect/Semaphore"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type * as Headers from "effect/unstable/http/Headers"
import type * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as Otlp from "effect/unstable/observability/Otlp"
import * as Endpoint from "./Endpoint.ts"
import * as Resource from "./Resource.ts"

/**
 * The `service.name` resource attribute installed when the caller supplies
 * none: the flows distribution itself. Override it per application with
 * {@link Options.serviceName}.
 *
 * @category resource
 * @since 0.1.0
 */
export const defaultServiceName = "flows"

/**
 * The `service.version` resource attribute installed when the caller supplies
 * none. Mirrors the release version in this package's `package.json`.
 *
 * A published package cannot read its own manifest on every runtime it
 * supports, so the version lives here as a literal.
 * `scripts/set-release-version.mjs` rewrites this declaration with the
 * manifests, and its `--check` mode reports drift, so a release bump cannot
 * leave it behind.
 *
 * @category resource
 * @since 0.1.0
 */
export const defaultServiceVersion = "1.0.0-rc.0"

// The upstream logger and tracer each buffer at most one 1,000-record batch.
// Do not queue at the transport: upstream forks every full batch independently.
const maxBatchSize = 1000
const maxInFlight = 4
const maxRequestBytes = 1024 * 1024
const requestTimeout = "10 seconds"

const boundedClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const permits = Semaphore.makeUnsafe(maxInFlight)
    // Metric handles cache their first registry, so allocate one per layer.
    const droppedExports = Metric.counter("flows/observability/otlp/dropped")
    return HttpClient.transform(client, (requestEffect, request) =>
      Effect.suspend(() => {
        // A local discard is terminal, so the upstream retry loop must not
        // retain or retry its payload. Count batches, not records, without
        // logging into this exporter.
        const discard = Metric.update(droppedExports, 1).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
        )
        // layerJson always supplies a Uint8Array body with a byte length.
        const body = request.body as HttpBody.Uint8Array
        if (body.contentLength > maxRequestBytes) return discard
        return requestEffect.pipe(
          Effect.timeoutOrElse({ duration: requestTimeout, orElse: () => discard }),
          permits.withPermitsIfAvailable(1),
          Effect.flatMap(Option.match({ onNone: () => discard, onSome: Effect.succeed }))
        )
      }))
  })
)

/**
 * Configuration for the default OTLP wiring.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The collector base URL, for example `http://localhost:4318`. Signals are
   * posted below it at `/v1/logs`, `/v1/metrics`, and `/v1/traces`. It must be
   * an absolute `http://` or `https://` URL without credentials, a query,
   * fragment, backslashes, spaces, or controls. A base path is allowed. Invalid
   * values fail acquisition with {@link Endpoint.InvalidExporterEndpoint}.
   * Use {@link Options.headers} for authentication.
   */
  readonly baseUrl: string
  /** Overrides {@link defaultServiceName} as the `service.name` attribute. */
  readonly serviceName?: string | undefined
  /** Overrides {@link defaultServiceVersion} as the `service.version` attribute. */
  readonly serviceVersion?: string | undefined
  /** Additional resource attributes attached to every exported signal. */
  readonly attributes?: Record<string, unknown> | undefined
  /** Headers sent with every export request, for example vendor auth. */
  readonly headers?: Headers.Input | undefined
  /** Export cadence for all three signals; each signal's Effect default applies when omitted. */
  readonly exportInterval?: Duration.Input | undefined
  /** Upper bound on the shutdown flush when the layer's scope closes. */
  readonly shutdownTimeout?: Duration.Input | undefined
}

/**
 * Creates the OTLP logs, metrics, and traces layer with flows resource
 * defaults, JSON-serialized. Exports share a four-request limit with no waiting
 * queue. Requests larger than 1 MiB or stalled for ten seconds are discarded;
 * `flows/observability/otlp/dropped` counts discarded batches.
 *
 * **Details**
 *
 * The layer still requires an `HttpClient`, which is how it stays
 * platform-neutral: a Node host may hand it `@effect/platform-node`'s Undici
 * client (re-exported by `@smthrs/platform-node`), a browser or test
 * hands it something else. Use {@link layerFetch} when the host's global
 * `fetch` is good enough. On Node 22 and every browser it is.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<
  never,
  Resource.InvalidResourceConfiguration | Endpoint.InvalidExporterEndpoint,
  HttpClient.HttpClient
> =>
  Layer.unwrap(
    Effect.map(
      Effect.all([
        Resource.decode({
          serviceName: options.serviceName ?? defaultServiceName,
          serviceVersion: options.serviceVersion ?? defaultServiceVersion,
          ...(options.attributes === undefined ? {} : { attributes: options.attributes })
        }),
        Endpoint.decode(options.baseUrl, "baseUrl")
      ]),
      ([decoded, baseUrl]) => {
        const resource = Resource.toOpenTelemetryConfiguration(decoded)
        return (
          Otlp.layerJson({
            baseUrl,
            resource: {
              serviceName: resource.serviceName,
              // `serviceVersion` is supplied above before Resource decoding.
              serviceVersion: resource.serviceVersion!,
              ...(resource.attributes === undefined ? {} : { attributes: resource.attributes })
            },
            headers: options.headers,
            maxBatchSize,
            loggerExportInterval: options.exportInterval,
            metricsExportInterval: options.exportInterval,
            tracerExportInterval: options.exportInterval,
            shutdownTimeout: options.shutdownTimeout
          }).pipe(Layer.provide(boundedClient))
        )
      }
    )
  )

/**
 * Provides {@link layer} over the host's global `fetch`, the default wiring
 * for a Node host, and browser-safe by construction because it never touches
 * a `node:` built-in.
 *
 * **Example**
 *
 * ```ts
 * import * as Otlp from "@smthrs/observability/Otlp"
 *
 * const Telemetry = Otlp.layerFetch({ baseUrl: "http://localhost:4318" })
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFetch = (
  options: Options
): Layer.Layer<never, Resource.InvalidResourceConfiguration | Endpoint.InvalidExporterEndpoint> =>
  layer(options).pipe(Layer.provide(FetchHttpClient.layer))

/**
 * Exports nothing. The explicit stand-in for hosts with no collector, such as
 * a development shell, a test, or a browser deployment that has not opted in, so
 * wiring code can switch layers rather than branch.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<never> = Layer.empty
