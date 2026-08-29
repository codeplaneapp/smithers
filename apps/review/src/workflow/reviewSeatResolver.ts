/**
 * Turning the review flow's four declared seats into live models.
 *
 * The flow declares logical seats (`review`, `review-verify`, `review-narrate`,
 * `review-quiz`) so a step identity does not move when the model behind it
 * changes. This module is where a logical seat becomes a `provider:model`
 * string, and then a credentialed route.
 *
 * It is also the only file in the app that reads a credential.
 *
 * @since 1.0.0
 */
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike";
import * as Seat from "@smthrs/agent/Seat";
import * as SeatResolver from "@smthrs/agent/SeatResolver";
import * as GrantStore from "@smthrs/kernel/GrantStore";
import * as KernelHttpClient from "@smthrs/kernel/HttpClient";
import type * as ModelError from "@smthrs/model/ModelError";
import * as RequestExecutor from "@smthrs/model/RequestExecutor";
import * as Route from "@smthrs/model/Route";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import type * as Result from "effect/Result";
import { SEAT, type ReviewSeats } from "./reviewSeats.ts";

/**
 * The credential variable each provider reads.
 *
 * @since 1.0.0
 * @category constants
 */
export const SEAT_CREDENTIAL: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * Names the credential a seat needs when the environment does not carry it.
 *
 * The check is a courtesy, not the enforcement: an uncredentialed seat is
 * refused with `SeatUnresolved` either way. Doing it up front means a run that
 * cannot possibly reach a model says so before it shells out to git.
 *
 * @since 1.0.0
 * @category constructors
 */
export function missingSeatCredential(
  seat: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const separator = seat.indexOf(":");
  const provider = separator < 0 ? "anthropic" : seat.slice(0, separator);
  const variable = SEAT_CREDENTIAL[provider];
  if (variable === undefined) return `no route is configured for the ${provider} provider (seat "${seat}")`;
  const value = environment[variable];
  return value === undefined || value.trim() === "" ? `the "${seat}" seat needs ${variable}` : undefined;
}

/**
 * The real HTTP transport the routes run on.
 *
 * `FetchHttpClient` rather than undici: this app's bin runs under whichever
 * runtime the caller has, and the undici client's dispatcher teardown is not
 * available on every one of them. Fetch is, and a review makes ordinary
 * streaming POSTs that need nothing undici offers on top.
 */
const executorLayer = RequestExecutor.layer.pipe(
  Layer.provide(KernelHttpClient.layer),
  Layer.provide(GrantStore.layerNoop),
  Layer.provide(FetchHttpClient.layer),
);

const seatOf = <Body, Frame, Event, State>(
  configured: Result.Result<Route.Route<Body, Frame, Event, State>, ModelError.ModelError>,
  executor: RequestExecutor.RequestExecutor,
  seat: string,
  modelId: string,
): Effect.Effect<Seat.Seat, Seat.SeatUnresolved> =>
  Effect.gen(function* () {
    const routeConfig = yield* Effect.fromResult(configured).pipe(
      Effect.mapError((error) => new Seat.SeatUnresolved({ seat, message: error.message })),
    );
    const model = yield* Route.toModel(routeConfig).pipe(
      Effect.provideService(RequestExecutor.RequestExecutor, executor),
    );
    return Seat.make({
      id: seat,
      model,
      route: FlowEngineLike.routeResolver(routeConfig),
      contextWindowTokens: SeatResolver.contextWindowTokensFor(modelId),
    });
  });

/**
 * Builds the seat resolver for one review run.
 *
 * A seat with no separator is a bare model id on the Anthropic route, which is
 * the one provider convention this app assumes. `openrouter:` seats spell the
 * model as `openrouter:vendor/model` and route through the OpenAI-compatible
 * surface at OpenRouter's origin.
 *
 * @since 1.0.0
 * @category layers
 */
export function reviewSeatResolver(
  seats: ReviewSeats,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Layer.Layer<SeatResolver.SeatResolver> {
  const byName: Readonly<Record<string, string>> = {
    [SEAT.review]: seats.review,
    [SEAT.verify]: seats.verify,
    [SEAT.narrate]: seats.narrate,
    [SEAT.quiz]: seats.quiz,
  };
  return Layer.effect(SeatResolver.SeatResolver)(
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.RequestExecutor;
      return SeatResolver.make({
        resolve: (declared) =>
          Effect.suspend(() => {
            const seat = byName[declared] ?? declared;
            const separator = seat.indexOf(":");
            const provider = separator < 0 ? "anthropic" : seat.slice(0, separator);
            const modelId = Seat.modelIdOf(seat);
            const variable = SEAT_CREDENTIAL[provider];
            if (variable === undefined) {
              return Effect.fail(
                new Seat.SeatUnresolved({
                  seat,
                  message: `No route is configured for the ${provider} provider`,
                }),
              );
            }
            const key = environment[variable];
            if (key === undefined || key.trim() === "") {
              return Effect.fail(
                new Seat.SeatUnresolved({ seat, message: `Set ${variable} to run the ${seat} seat` }),
              );
            }
            const credential = Redacted.make(key);
            return provider === "anthropic"
              ? seatOf(Route.anthropic({ apiKey: credential }), executor, seat, modelId)
              : provider === "openrouter"
              ? seatOf(
                Route.openaiCompatible({
                  id: "openrouter",
                  baseUrl: "https://openrouter.ai/api",
                  apiKey: credential,
                }),
                executor,
                seat,
                modelId,
              )
              : seatOf(Route.openai({ apiKey: credential }), executor, seat, modelId);
          }),
      });
    }),
  ).pipe(Layer.provide(executorLayer));
}
