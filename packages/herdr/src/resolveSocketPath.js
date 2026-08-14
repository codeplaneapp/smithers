import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Herdr's config directory: `$XDG_CONFIG_HOME/herdr` when set, else
 * `~/.config/herdr`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function herdrConfigDir(env) {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== "") {
    return join(xdg, "herdr");
  }
  return join(homedir(), ".config", "herdr");
}

/**
 * The control-socket path for a named herdr session
 * (`<config>/herdr/sessions/<name>/herdr.sock`).
 *
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function sessionSocketPath(name, env = process.env) {
  if (name === "default") return join(herdrConfigDir(env), "herdr.sock");
  return join(herdrConfigDir(env), "sessions", name, "herdr.sock");
}

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
export function resolveSocketPath(opts = {}, env = process.env) {
  if (opts.socketPath) {
    return opts.socketPath;
  }
  if (opts.session) {
    return sessionSocketPath(opts.session, env);
  }
  if (env.HERDR_SOCKET_PATH) {
    return env.HERDR_SOCKET_PATH;
  }
  if (env.HERDR_SESSION) {
    return sessionSocketPath(env.HERDR_SESSION, env);
  }
  return join(herdrConfigDir(env), "herdr.sock");
}
