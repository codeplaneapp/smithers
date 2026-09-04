/**
 * Explicit access to the build host's process environment.
 *
 * @since 0.1.0
 */

/**
 * Reads the ambient process environment by deliberate host choice.
 *
 * Using this gives up a caller-scoped, hermetic environment. Keep it at host
 * tool-discovery boundaries; execution paths with a configured environment
 * pass that value instead.
 *
 * @category accessors
 * @since 0.1.0
 */
export const ambientEnvironment = (): Readonly<Record<string, string | undefined>> => process.env
