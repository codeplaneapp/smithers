/**
 * The control-socket path for a named herdr session
 * (`<config>/herdr/sessions/<name>/herdr.sock`).
 *
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
declare function sessionSocketPath(name: string, env?: NodeJS.ProcessEnv): string;
/**
 * Resolve the herdr control-socket path following the herdr contract's
 * precedence, highest first:
 *
 * 1. an explicit `socketPath` option,
 * 2. a `session` option (a named session's socket),
 * 3. the `HERDR_SOCKET_PATH` environment variable,
 * 4. the `HERDR_SESSION` environment variable (a named session's socket),
 * 5. the default session socket (`<config>/herdr/herdr.sock`).
 *
 * @param {{ socketPath?: string, session?: string }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
declare function resolveSocketPath(opts?: {
    socketPath?: string;
    session?: string;
}, env?: NodeJS.ProcessEnv): string;

export { resolveSocketPath, sessionSocketPath };
