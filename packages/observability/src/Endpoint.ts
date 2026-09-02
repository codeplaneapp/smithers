/**
 * Validated collector endpoints for the OTLP exporters.
 *
 * The endpoint is the field an operator most often gets wrong, and a wrong one
 * is invisible: Effect's exporter absorbs export failure by design, so a layer
 * built against `""` or `"localhost:4318"` looks identical to a working one and
 * simply never delivers. Every builder therefore decodes its endpoint during
 * layer acquisition, the same posture `Resource` already takes.
 *
 * @since 1.0.0-rc.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Largest collector endpoint accepted by a builder.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumEndpointLength = 2_048

const isAbsoluteHttpUrl = (value: string): boolean => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return url.username === "" && url.password === ""
}

/**
 * Runtime schema for an absolute `http:` or `https:` collector endpoint that
 * carries no credentials.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Endpoint = Schema.String.check(
  Schema.isMaxLength(maximumEndpointLength),
  Schema.makeFilter((value: string) => isAbsoluteHttpUrl(value), { title: "absoluteCollectorEndpoint" })
)

/**
 * Stable exporter-endpoint refusal shared by every OTLP builder.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class InvalidExporterEndpoint extends Schema.TaggedError<InvalidExporterEndpoint>()(
  "@smthrs/observability/InvalidExporterEndpoint",
  {
    code: Schema.Literal("invalid_exporter_endpoint"),
    path: Schema.String,
    message: Schema.String
  }
) {}

/**
 * Removes the repeated trailing separators that would otherwise produce a
 * double slash in a signal URL.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const normalize = (endpoint: string): string => endpoint.replace(/\/+$/, "")

/**
 * Decodes one collector endpoint into its normalized form without retaining
 * the rejected value.
 *
 * `path` names the option the endpoint arrived on, so the refusal points at the
 * caller's own field rather than at a shared internal name.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export const decode = (
  endpoint: unknown,
  path: string
): Effect.Effect<string, InvalidExporterEndpoint> =>
  Schema.decodeUnknownEffect(Endpoint)(endpoint).pipe(
    Effect.map(normalize),
    Effect.mapError(() =>
      new InvalidExporterEndpoint({
        code: "invalid_exporter_endpoint",
        path,
        message: `OTLP collector ${path} must be an absolute http or https URL without credentials`
      })
    )
  )

/**
 * Builds the OTLP/HTTP URL one signal is posted to below a decoded endpoint.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const signalUrl = (endpoint: string, signal: "traces" | "metrics" | "logs"): string =>
  `${normalize(endpoint)}/v1/${signal}`
