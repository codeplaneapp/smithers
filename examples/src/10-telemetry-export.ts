/**
 * Add the one telemetry layer to a durable run and read the granular trace
 * data back three ways.
 *
 * The flow and engine composition are example 02's: nothing in the flow body
 * or the layers changes for telemetry. The store packages already open spans
 * through Effect's tracer and update `Metric` counters on their hot paths;
 * what they deliberately do not do is export. `Otlp.layerFetch` is that
 * exporter — one layer against an OTLP collector endpoint, no OpenTelemetry
 * SDK involved — and providing it is the entire wiring. Deleting the
 * `Effect.provide(telemetry)` line removes telemetry and changes nothing
 * else.
 *
 * The three read paths this example demonstrates:
 *
 * 1. The OTLP export: every span the packages open — the flow lifecycle, the
 *    engine dispatch, run claims and heartbeats, journal writes, down to
 *    individual `sql.execute` statements — posts to `/v1/traces`, and every
 *    metric series to `/v1/metrics`.
 * 2. The durable journal: `Journal.entries` reads the run's lifecycle events
 *    in-process, no collector involved.
 * 3. The metric handles: `Metric.value` reads a counter in-process, no
 *    exporter involved. An outcome-dimensioned counter is read through its
 *    exported attribute view (`EngineStoreMetrics.dispatch.Success` here):
 *    the engine updates only the tagged series, so the bare counter handle
 *    would read the attribute-less series and always see zero.
 *
 * `main` wraps the caller's `fetch` with a recorder so the summary can list
 * what the collector received; a production program provides
 * `Otlp.layerFetch` exactly as written here and skips the recording.
 */
import { EngineStoreMetrics } from "@smthrs/engine-store"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Journal, type JournalEvent } from "@smthrs/journal"
import * as Otlp from "@smthrs/observability/Otlp"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { durableEngine } from "./durable-layer.ts"

export const Pack = Action.make("examples/Pack", {
  payload: { target: Schema.String },
  success: Schema.String
})

export const Ship = Flow.make("examples/Ship", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Pack.call(payload)
})

export interface Summary {
  readonly result: string
  /** Distinct span names the collector received, sorted. */
  readonly spanNames: ReadonlyArray<string>
  /** Distinct metric series names the collector received, sorted. */
  readonly metricNames: ReadonlyArray<string>
  /** The run's journal event types, in order, read without the collector. */
  readonly journalEventTypes: ReadonlyArray<string>
  /** `Metric.value` on the tagged dispatch view, read without the exporter. */
  readonly successfulDispatches: number
}

/** The narrow slice of an OTLP JSON body the summary reads. */
interface TraceExport {
  readonly resourceSpans?: ReadonlyArray<{
    readonly scopeSpans?: ReadonlyArray<{
      readonly spans?: ReadonlyArray<{ readonly name: string }>
    }>
  }>
}

interface MetricExport {
  readonly resourceMetrics?: ReadonlyArray<{
    readonly scopeMetrics?: ReadonlyArray<{
      readonly metrics?: ReadonlyArray<{ readonly name: string }>
    }>
  }>
}

interface Recorded {
  readonly url: string
  readonly body: string
}

const requestBody = (init: RequestInit | undefined): string =>
  typeof init?.body === "string"
    ? init.body
    : new TextDecoder().decode(init?.body as Uint8Array)

const distinctSorted = (names: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(names)].sort()

const spanNames = (recorded: ReadonlyArray<Recorded>): ReadonlyArray<string> =>
  distinctSorted(
    recorded
      .filter((request) => request.url.endsWith("/v1/traces"))
      .flatMap((request) => (JSON.parse(request.body) as TraceExport).resourceSpans ?? [])
      .flatMap((resource) => resource.scopeSpans ?? [])
      .flatMap((scope) => scope.spans ?? [])
      .map((span) => span.name)
  )

const metricNames = (recorded: ReadonlyArray<Recorded>): ReadonlyArray<string> =>
  distinctSorted(
    recorded
      .filter((request) => request.url.endsWith("/v1/metrics"))
      .flatMap((request) => (JSON.parse(request.body) as MetricExport).resourceMetrics ?? [])
      .flatMap((resource) => resource.scopeMetrics ?? [])
      .flatMap((scope) => scope.metrics ?? [])
      .map((metric) => metric.name)
  )

/**
 * Executes the flow with telemetry provided, then summarizes what exported.
 *
 * The default `fetchImpl` posts to a local collector; the test passes a stub
 * so the suite needs no network. Export flushes when the telemetry layer's
 * scope closes, so the summary is built after `Effect.scoped` completes.
 */
export const main = (
  filename: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const recorded: Array<Recorded> = []
    const recordingFetch: typeof globalThis.fetch = (input, init) => {
      recorded.push({ url: String(input), body: requestBody(init ?? undefined) })
      return fetchImpl(input, init)
    }

    // The entire telemetry wiring: one layer against a collector endpoint.
    const telemetry = Otlp.layerFetch({
      baseUrl: "http://localhost:4318",
      serviceName: "examples-telemetry"
    })

    const program = Effect.gen(function*() {
      const result = yield* Ship.execute({ target: "server" }, { executionId: "telemetry-1" })

      // Read path 2: the durable journal, no collector involved.
      const journal = yield* Journal.Journal
      yield* journal.flush
      const page = yield* journal.entries({
        runId: "telemetry-1" as JournalEvent.RunId,
        limit: 200
      })

      // Read path 3: the tagged metric view, no exporter involved.
      const dispatches = yield* Metric.value(EngineStoreMetrics.dispatch.Success)

      return {
        result,
        journalEventTypes: page.entries.map((entry) => entry.eventType),
        successfulDispatches: dispatches.count
      }
    })

    const outcome = yield* program.pipe(
      Effect.provide(
        Layer.mergeAll(
          Pack.toLayer(({ target }) => Effect.succeed(`dist/${target}.tar`)),
          Interpreter.layer(Ship)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(durableEngine(filename, "examples-telemetry"))
        )
      ),
      Effect.provide(telemetry),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.scoped
    )

    // The telemetry scope closed above, so the shutdown flush has posted.
    return {
      ...outcome,
      spanNames: spanNames(recorded),
      metricNames: metricNames(recorded)
    }
  }).pipe(Effect.orDie)
