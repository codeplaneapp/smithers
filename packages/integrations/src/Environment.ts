/**
 * Explicit access to the integrations host's process environment.
 *
 * @since 1.0.0
 */

/**
 * Reads the ambient process environment by deliberate host choice.
 *
 * Using this gives up a caller-scoped credential source. Integration clients
 * use it only for their documented host convenience; callers that require
 * account isolation pass an environment record explicitly.
 *
 * @category accessors
 * @since 1.0.0
 */
export const ambientEnvironment = (): Readonly<Record<string, string | undefined>> => process.env

/**
 * Reads the ambient process working directory by deliberate host choice.
 *
 * Same trade as {@link ambientEnvironment}: a workspace resolved from wherever
 * the operator's shell happens to sit is a host convenience, so it is spelled
 * once here rather than appearing as a bare `process.cwd()` in the middle of a
 * function that otherwise takes its workspace as an argument.
 *
 * @category accessors
 * @since 1.0.0
 */
export const ambientWorkingDirectory = (): string => process.cwd()
