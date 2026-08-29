import type * as Route from "@smthrs/model/Route"

/**
 * The credential-free route a test seat resolves to, copied from
 * `examples/src/11-agent-step.ts` in ~/flows/flows.
 *
 * `SeatResolver` hands the agent a model and a route. A replayed run never
 * sends this request anywhere, but the engine still digests it into the sealed
 * step key, so it has to be a real `PreparedRequest` and it has to be stable:
 * changing any field changes every recorded step key.
 */
export const preparedRequest: Route.PreparedRequest = {
  routeId: "aomi-test",
  protocolId: "aomi-test",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}
