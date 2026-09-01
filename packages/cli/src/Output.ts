/**
 * Deterministic rendering for the CLI projection.
 *
 * @since 0.1.0
 */
import { ControlSchema } from "@smthrs/control"
import { Context, Effect, Layer, Redacted, Schema } from "effect"

/**
 * A CLI output format.
 *
 * @category models
 * @since 0.1.0
 */
export type Format = "human" | "json"

/**
 * Rendered output and its process status.
 *
 * @category models
 * @since 0.1.0
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
 */
export interface Service {
  readonly render: (value: unknown, format: Format) => Effect.Effect<Rendered>
}

/**
 * Rendering service key.
 *
 * @category services
 * @since 0.1.0
 */
export class Output extends Context.Service<Output, Service>()("/cli/Output") {}

const RenderValueTypeId: unique symbol = Symbol("@smthrs/cli/Output/RenderValue")

interface RenderValue {
  readonly [RenderValueTypeId]: true
  readonly value: unknown
}

/**
 * Marks caller-controlled data as output, never as a control receipt.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const renderValue = (value: unknown): RenderValue => ({ [RenderValueTypeId]: true, value })

const isRenderValue = (value: unknown): value is RenderValue =>
  typeof value === "object" && value !== null && RenderValueTypeId in value

const maximumDepth = 256

const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const normalize = (value: unknown, seen = new WeakSet<object>(), depth = 0): unknown => {
  if (Redacted.isRedacted(value)) return "<redacted>"
  if (value === undefined) return "[Undefined]"
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "symbol") return String(value)
  if (typeof value === "function") return "[Function]"
  if (value !== null && typeof value === "object") {
    if (depth >= maximumDepth) return "[Deep]"
    if (seen.has(value)) return "[Circular]"
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        return Array.from({ length: value.length }, (_, index) => normalize(value[index], seen, depth + 1))
      }
      const entries = Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right))
      return Object.fromEntries(entries.map(([key, item]) => [key, normalize(item, seen, depth + 1)]))
    } catch {
      return "[Unrenderable]"
    } finally {
      seen.delete(value)
    }
  }
  return value
}

const json = (value: unknown): string => JSON.stringify(normalize(value)) ?? "\"[Undefined]\""

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
 */
export const make = (): Service => ({
  render: Effect.fn("Output.render")((input, format) => {
    const value = isRenderValue(input) ? input.value : input
    return Effect.succeed({ text: format === "json" ? json(value) : human(value), exitCode: exitCode(input) })
  })
})

/**
 * Default deterministic output layer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.succeed(Output, make())

/**
 * Maps decoded control values to process status codes.
 *
 * @category getters
 * @since 0.1.0
 */
export const exitCode = (value: unknown): number => {
  if (isRenderValue(value)) return 0
  if (!Schema.is(ControlSchema.Receipt)(value)) return 0
  if (value._tag === "Parked") return 3
  if (value._tag === "Terminal") {
    if (value.status === "cancelled") return 130
    if (value.status === "failed") return 1
  }
  if (value._tag === "Conflict") return 1
  return 0
}
