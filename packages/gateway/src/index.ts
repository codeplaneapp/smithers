/**
 * Workspace gateway contracts and supervision ports for flows.
 *
 * The mounts, the bind and credential policy, and the keepalive cadence are
 * documented in this package's README. `docs/reference/gateway.md` is the
 * repository page for it and is the docs lane's to write.
 *
 * @since 0.1.0
 */

/**
 * @since 0.1.0 @category errors
 * @slop
 */
export * as GatewayError from "./GatewayError.ts"

/**
 * @since 0.1.0 @category models
 * @slop
 */
export * as GatewaySchema from "./GatewaySchema.ts"

/**
 * @since 1.0.0 @category projections
 */
export * as Diagnosis from "./Diagnosis.ts"

/**
 * @since 1.0.0 @category projections
 */
export * as GatewayProjection from "./GatewayProjection.ts"

/**
 * @since 1.0.0 @category rpc
 */
export * as GatewayRpcs from "./GatewayRpcs.ts"

/**
 * @since 1.0.0 @category layers
 */
export * as GatewayServer from "./GatewayServer.ts"

/**
 * @since 1.0.0 @category services
 */
export * as Projections from "./Projections.ts"

/**
 * @since 0.1.0 @category services
 * @slop
 */
export * as SuperviseRuntime from "./SuperviseRuntime.ts"

/**
 * The canonical durable journal synchronization package.
 *
 * @since 0.1.0
 * @category services
 * @slop
 */
export * as Sync from "@smthrs/sync"
