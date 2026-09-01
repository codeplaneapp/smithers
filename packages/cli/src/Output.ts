/**
 * Deterministic rendering for the CLI projection.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Redacted } from "effect"

/**
 * A CLI output format.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Format = "human" | "json"

/**
 * Rendered output and its process status.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Rendered {
  readonly text: string
  readonly exitCode: number
}

/**
 * The rendering service consumed by command handlers.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly render: (value: unknown, format: Format) => Effect.Effect<Rendered>
}

/**
 * Rendering service key.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Output extends Context.Service<Output, Service>()("/cli/Output") {}

const normalize = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return "<redacted>"
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map((
        [key, item]
      ) => [key, normalize(item)])
    )
  }
  return value
}

const json = (value: unknown): string => JSON.stringify(normalize(value))

const human = (value: unknown): string => {
  const normalized = normalize(value)
  if (typeof normalized === "string") return normalized
  return JSON.stringify(normalized, null, 2)
}

/**
 * Renders a decoded value in a deterministic human or machine form.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (): Service => ({
  render: Effect.fn("Output.render")((value, format) =>
    Effect.succeed({ text: format === "json" ? json(value) : human(value), exitCode: exitCode(value) })
  )
})

/**
 * Default deterministic output layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = Layer.succeed(Output, make())

/**
 * Maps decoded control values to process status codes.
 *
 * @category getters
 * @since 0.1.0
 * @slop
 */
export const exitCode = (value: unknown): number => {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (record._tag === "Parked" || record.status === "waiting-approval") return 3
    if (record._tag === "Interrupted" || record.signal === "SIGINT") return 130
    if (record.signal === "SIGTERM") return 143
    if (record._tag === "Error" || record._tag === "Conflict") return 1
  }
  return 0
}
