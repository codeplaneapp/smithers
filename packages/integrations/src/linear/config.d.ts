import { LinearConfig as LinearConfig$1, ResolvedLinearConfig as ResolvedLinearConfig$1 } from './LinearConfig.js';

/**
 * Register process-wide Linear configuration (module registry). Components
 * and clients created without an explicit `config` fall back to this, then
 * to the `SMITHERS_LINEAR_*` environment variables. Returns the previous
 * registration so callers (tests) can restore it.
 *
 * @param {LinearConfig} [config]
 * @returns {LinearConfig} the previously registered config
 */
declare function configureLinear(config?: LinearConfig): LinearConfig;
/**
 * Resolve the effective Linear config: explicit > `configureLinear` >
 * `SMITHERS_LINEAR_API_KEY` / `SMITHERS_LINEAR_WEBHOOK_SECRET` /
 * `SMITHERS_LINEAR_API_BASE_URL` env vars.
 *
 * @param {LinearConfig} [explicit]
 * @returns {ResolvedLinearConfig}
 */
declare function resolveLinearConfig(explicit?: LinearConfig): ResolvedLinearConfig;
/** @typedef {import("./LinearConfig.ts").LinearConfig} LinearConfig */
/** @typedef {import("./LinearConfig.ts").ResolvedLinearConfig} ResolvedLinearConfig */
/** Default Linear GraphQL endpoint. */
declare const LINEAR_API_BASE_URL: "https://api.linear.app/graphql";
type LinearConfig = LinearConfig$1;
type ResolvedLinearConfig = ResolvedLinearConfig$1;

export { LINEAR_API_BASE_URL, type LinearConfig, type ResolvedLinearConfig, configureLinear, resolveLinearConfig };
