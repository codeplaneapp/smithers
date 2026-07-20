// @smithers-type-exports-begin
/** @typedef {import("./LinearConfig.ts").LinearConfig} LinearConfig */
/** @typedef {import("./LinearConfig.ts").ResolvedLinearConfig} ResolvedLinearConfig */
// @smithers-type-exports-end

/** Default Linear GraphQL endpoint. */
export const LINEAR_API_BASE_URL = "https://api.linear.app/graphql";

/** @type {LinearConfig} */
let registeredConfig = {};

/**
 * Register process-wide Linear configuration (module registry). Components
 * and clients created without an explicit `config` fall back to this, then
 * to the `SMITHERS_LINEAR_*` environment variables. Returns the previous
 * registration so callers (tests) can restore it.
 *
 * @param {LinearConfig} [config]
 * @returns {LinearConfig} the previously registered config
 */
export function configureLinear(config = {}) {
    const previous = registeredConfig;
    registeredConfig = { ...config };
    return previous;
}

/**
 * Resolve the effective Linear config: explicit > `configureLinear` >
 * `SMITHERS_LINEAR_API_KEY` / `SMITHERS_LINEAR_WEBHOOK_SECRET` /
 * `SMITHERS_LINEAR_API_BASE_URL` env vars.
 *
 * @param {LinearConfig} [explicit]
 * @returns {ResolvedLinearConfig}
 */
export function resolveLinearConfig(explicit = {}) {
    const env = typeof process !== "undefined" ? process.env : {};
    return {
        apiKey: explicit.apiKey ??
            registeredConfig.apiKey ??
            env["SMITHERS_LINEAR_API_KEY"] ??
            undefined,
        webhookSecret: explicit.webhookSecret ??
            registeredConfig.webhookSecret ??
            env["SMITHERS_LINEAR_WEBHOOK_SECRET"] ??
            undefined,
        apiBaseUrl: explicit.apiBaseUrl ??
            registeredConfig.apiBaseUrl ??
            env["SMITHERS_LINEAR_API_BASE_URL"] ??
            LINEAR_API_BASE_URL,
    };
}
