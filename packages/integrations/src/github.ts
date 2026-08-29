/**
 * The GitHub integration surface.
 *
 * A narrow host layer: a REST client, a verified webhook channel, declared
 * webhook reconciliation, and payload schemas. Everything an application
 * builds on top of it is an Action or a Flow it writes itself.
 *
 * @since 1.0.0
 */

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Config from "./github/Config.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as GitHubClient from "./github/GitHubClient.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as ListenerRegistry from "./github/ListenerRegistry.ts"

/**
 * @category schemas
 * @since 1.0.0
 */
export * as Payload from "./github/Payload.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Webhook from "./github/Webhook.ts"
