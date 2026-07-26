import { getRequiredScopeForGatewayMethod } from "../rpc/index.js";

/** @typedef {(typeof GATEWAY_SCOPE_VALUES)[number]} GatewayScope */

export const GATEWAY_SCOPE_VALUES = /** @type {const} */ ([
  "run:read",
  "run:write",
  "run:admin",
  "approval:submit",
  "signal:submit",
  "cron:read",
  "cron:write",
  "account:read",
  "memory:read",
  "prompt:read",
  "score:read",
  "ticket:read",
  "ticket:write",
  "observability:read",
]);

/** @type {Record<GatewayScope, string>} */
export const GATEWAY_SCOPE_DESCRIPTIONS = {
  "run:read": "Read run state, summaries, event streams, node output, and node diffs.",
  "run:write": "Launch, resume, and cancel runs.",
  "run:admin": "Perform elevated run control such as hijack and rewind.",
  "approval:submit": "Submit approval decisions.",
  "signal:submit": "Submit workflow signals.",
  "cron:read": "List cron schedules.",
  "cron:write": "Create, delete, and trigger cron schedules.",
  "account:read": "List registered agent accounts (API keys redacted).",
  "memory:read": "List cross-run memory facts.",
  "prompt:read": "List registered prompts.",
  "score:read": "List scorer/eval results for a run.",
  "ticket:read": "List work docs (tickets/plans/specs/proposals).",
  "ticket:write": "Create, update, and soft-delete work docs.",
  "observability:read": "Read DevTools and other observability streams.",
};

/** @type {GatewayScope[]} */
const RUN_SCOPE_ORDER = ["run:read", "run:write", "run:admin"];
/** @type {GatewayScope[]} */
const CRON_SCOPE_ORDER = ["cron:read", "cron:write"];
/** @type {GatewayScope[]} */
const TICKET_SCOPE_ORDER = ["ticket:read", "ticket:write"];

/**
 * @param {string} scope
 * @returns {scope is GatewayScope}
 */
export function isGatewayScope(scope) {
  return /** @type {readonly string[]} */ (GATEWAY_SCOPE_VALUES).includes(scope);
}

/**
 * @param {GatewayScope} granted
 * @param {GatewayScope} required
 * @returns {boolean}
 */
function gatewayScopeImplies(granted, required) {
  if (granted === required) {
    return true;
  }
  if (granted.startsWith("run:") && required.startsWith("run:")) {
    return RUN_SCOPE_ORDER.indexOf(granted) >= RUN_SCOPE_ORDER.indexOf(required);
  }
  if (granted.startsWith("cron:") && required.startsWith("cron:")) {
    return CRON_SCOPE_ORDER.indexOf(granted) >= CRON_SCOPE_ORDER.indexOf(required);
  }
  if (granted.startsWith("ticket:") && required.startsWith("ticket:")) {
    return TICKET_SCOPE_ORDER.indexOf(granted) >= TICKET_SCOPE_ORDER.indexOf(required);
  }
  return false;
}

/**
 * @param {string} scope
 * @param {GatewayScope} required
 * @returns {boolean}
 */
function legacyAccessImplies(scope, required) {
  switch (scope) {
    case "read":
      return (
        required === "run:read" ||
        required === "cron:read" ||
        required === "account:read" ||
        required === "memory:read" ||
        required === "prompt:read" ||
        required === "score:read" ||
        required === "ticket:read" ||
        required === "observability:read"
      );
    case "execute":
      return (
        required === "run:read" ||
        required === "run:write" ||
        required === "signal:submit" ||
        required === "cron:read" ||
        required === "cron:write" ||
        required === "ticket:read" ||
        required === "ticket:write"
      );
    case "approve":
      return required === "approval:submit" || legacyAccessImplies("execute", required);
    case "admin":
      return true;
    default:
      return false;
  }
}

/**
 * A name grant ("getRun") or wildcard-prefix grant ("runs.*") authorizes a
 * method invocation, but it must never escalate beyond the scope that method
 * itself requires: holding "getRun" lets you call getRun (a run:read method),
 * not a run:admin method that happens to share the matched name/prefix. We gate
 * the grant on the dispatched method's own required scope so a name/prefix grant
 * can confer at most what that method legitimately needs.
 *
 * @param {string} methodName
 * @param {GatewayScope} requiredScope
 * @returns {boolean}
 */
function methodGrantSatisfiesRequiredScope(methodName, requiredScope) {
  const methodScope = getRequiredScopeForGatewayMethod(methodName);
  if (methodScope === undefined) {
    return false;
  }
  return gatewayScopeImplies(methodScope, requiredScope);
}

/**
 * @param {readonly string[]} grantedScopes
 * @param {GatewayScope} requiredScope
 * @param {string} [methodName]
 * @returns {boolean}
 */
export function hasGatewayScope(grantedScopes, requiredScope, methodName) {
  const normalized = grantedScopes.map((scope) => scope.trim()).filter(Boolean);
  if (normalized.includes("*")) {
    return true;
  }
  for (const granted of normalized) {
    if (methodName && granted === methodName && methodGrantSatisfiesRequiredScope(methodName, requiredScope)) {
      return true;
    }
    if (
      methodName &&
      granted.endsWith(".*") &&
      methodName.startsWith(granted.slice(0, -1)) &&
      methodGrantSatisfiesRequiredScope(methodName, requiredScope)
    ) {
      return true;
    }
    if (isGatewayScope(granted) && gatewayScopeImplies(granted, requiredScope)) {
      return true;
    }
    if (legacyAccessImplies(granted, requiredScope)) {
      return true;
    }
  }
  return false;
}
