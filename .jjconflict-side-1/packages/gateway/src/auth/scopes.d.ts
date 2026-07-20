/**
 * @param {string} scope
 * @returns {scope is GatewayScope}
 */
declare function isGatewayScope(scope: string): scope is GatewayScope;
/**
 * @param {readonly string[]} grantedScopes
 * @param {GatewayScope} requiredScope
 * @param {string} [methodName]
 * @returns {boolean}
 */
declare function hasGatewayScope(grantedScopes: readonly string[], requiredScope: GatewayScope, methodName?: string): boolean;
/** @typedef {(typeof GATEWAY_SCOPE_VALUES)[number]} GatewayScope */
declare const GATEWAY_SCOPE_VALUES: readonly ["run:read", "run:write", "run:admin", "approval:submit", "signal:submit", "cron:read", "cron:write", "account:read", "memory:read", "prompt:read", "score:read", "ticket:read", "ticket:write", "observability:read"];
/** @type {Record<GatewayScope, string>} */
declare const GATEWAY_SCOPE_DESCRIPTIONS: Record<GatewayScope, string>;
type GatewayScope = (typeof GATEWAY_SCOPE_VALUES)[number];

export { GATEWAY_SCOPE_DESCRIPTIONS, GATEWAY_SCOPE_VALUES, type GatewayScope, hasGatewayScope, isGatewayScope };
