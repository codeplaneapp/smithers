/**
 * Explicit OpenTelemetry resource metadata for flows.
 *
 * @since 0.1.0
 */
import * as OtelResource from "@effect/opentelemetry/Resource"
import type { Attributes } from "@opentelemetry/api"
import * as Schema from "effect/Schema"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))

/**
 * Configuration used to identify the service emitting telemetry.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Configuration {
  readonly serviceName: string
  readonly serviceVersion?: string
  readonly attributes?: Attributes
}

const ConfigurationSchema = Schema.Struct({
  serviceName: NonEmptyString,
  serviceVersion: Schema.optional(NonEmptyString),
  attributes: Schema.optional(Schema.Unknown)
})

const validate = (configuration: Configuration): Configuration =>
  Schema.decodeUnknownSync(ConfigurationSchema)(configuration) as Configuration

/**
 * Converts explicit service metadata into OpenTelemetry resource attributes.
 * No environment variables are read.
 *
 * @category configuration
 * @since 0.1.0
 * @slop
 */
export const configToAttributes = (configuration: Configuration): Record<string, string> =>
  OtelResource.configToAttributes(validate(configuration))

/**
 * Provides an explicit OpenTelemetry resource.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (configuration: Configuration) => OtelResource.layer(validate(configuration))

/**
 * The OpenTelemetry resource service.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const Resource = OtelResource.Resource
