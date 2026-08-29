/**
 * The Worker's seat resolver: `<provider>:<model>` over global `fetch`.
 *
 * A seat declaration is portable and carries no credential (AGENT.ts says
 * `openai:gpt-5.5` and nothing else), so the credentialed half lives here, next
 * to the bindings that hold the keys. A provider this module does not know
 * fails `Seat.SeatUnresolved` rather than silently answering with the wrong
 * model.
 *
 * Two providers are credentialed because the app has run on both. The seat in
 * AGENT.ts names one, the deployment supplies the matching secret, and the
 * other branch stays live for the deployment that has the other key.
 * `test/support/liveModel.ts` is the same table with `process.env` in place of
 * the Worker bindings; see its comment for why it is duplicated rather than
 * imported.
 *
 * The transport is Effect's fetch `HttpClient`, which is workerd's own `fetch`.
 * `@smthrs/model` reaches no Node builtin on this path: `RequestExecutor`
 * depends on `@smthrs/kernel/HttpClient`, and that module re-exports Effect's
 * own tag (`packages/kernel/src/HttpClient.ts:48`) rather than declaring one,
 * so the fetch layer satisfies it. The kernel's permission-guard layer is not
 * composed here, so no `GrantStore` is needed either.
 */
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import type * as Model from "@smthrs/model/Model"
import type * as ModelError from "@smthrs/model/ModelError"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import type { SeatProvider } from "@smthrs/create-app/runtime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type * as Result from "effect/Result"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

/** Provider request execution over workerd's `fetch`, with no Node transport. */
const executor: Layer.Layer<RequestExecutor.RequestExecutor> = RequestExecutor.layer.pipe(
  Layer.provide(FetchHttpClient.layer)
)

/** One resolved seat, in the shape `layerFor` asks a host for. */
interface Resolved {
  readonly model: Model.Model
  readonly route: Seat.Seat["route"]
}

const unresolved = (seat: string, message: string): Seat.SeatUnresolved =>
  new Seat.SeatUnresolved({ seat, message })

/** A route builder as `Route.anthropic` and `Route.openai` both shape it. */
type RouteFor = (
  input: { readonly apiKey: Redacted.Redacted<string> }
) => Result.Result<Parameters<typeof Route.toModel>[0], ModelError.ModelError>

/** The credentials a seat may be resolved against. */
export interface SeatEnv {
  readonly ANTHROPIC_API_KEY?: string
  readonly OPENAI_API_KEY?: string
}

/** One credentialed provider: which binding holds its key and how its route is built. */
interface Provider {
  /** The binding name, quoted in the failure message so it names the fix. */
  readonly binding: keyof SeatEnv
  readonly route: RouteFor
}

const providers: Record<string, Provider> = {
  anthropic: { binding: "ANTHROPIC_API_KEY", route: Route.anthropic as RouteFor },
  openai: { binding: "OPENAI_API_KEY", route: Route.openai as RouteFor }
}

/** The provider a seat with no `<provider>:` prefix resolves to. */
const DEFAULT_PROVIDER = "anthropic"

/**
 * Builds the provider from the Worker's bindings.
 *
 * The env is narrowed to the fields this needs, so a test can pass a literal
 * and a caller cannot accidentally widen what the resolver reads.
 *
 * The seat id is read for its provider half only. The model id travels on the
 * request (`Seat.modelIdOf` puts it there), so this never has to know which
 * model a flow declared.
 */
export const seatsFor = (env: SeatEnv): SeatProvider => ({
  resolve: (seatId: string): Effect.Effect<Resolved, Seat.SeatUnresolved> =>
    Effect.gen(function*() {
      const separator = seatId.indexOf(":")
      const name = separator < 0 ? DEFAULT_PROVIDER : seatId.slice(0, separator)
      const provider = providers[name]
      if (provider === undefined) {
        return yield* unresolved(
          seatId,
          `This Worker resolves ${Object.keys(providers).join(" and ")} seats only; "${name}" has no route here`
        )
      }
      const key = env[provider.binding]
      if (key === undefined || key.length === 0) {
        return yield* unresolved(
          seatId,
          `Set the ${provider.binding} secret to run the ${seatId} seat`
        )
      }
      const configured = yield* Effect.fromResult(provider.route({ apiKey: Redacted.make(key) })).pipe(
        Effect.mapError((error) => unresolved(seatId, error.message))
      )
      const model = yield* Route.toModel(configured).pipe(Effect.provide(executor))
      return {
        model,
        route: FlowEngineLike.routeResolver(configured)
      } satisfies Resolved
    })
})

/**
 * The context window a resolved seat reports, so compaction has a real budget.
 * Re-exported so `worker/turn.ts` and any test agree on one source.
 */
export const contextWindowTokensFor = SeatResolver.contextWindowTokensFor
