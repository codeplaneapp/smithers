import { getRequiredScopeForGatewayMethod } from "../rpc/index.ts";

export const GATEWAY_SCOPE_VALUES = [
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
] as const;

export type GatewayScope = (typeof GATEWAY_SCOPE_VALUES)[number];

export const GATEWAY_SCOPE_DESCRIPTIONS: Record<GatewayScope, string> = {
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

const RUN_SCOPE_ORDER: GatewayScope[] = ["run:read", "run:write", "run:admin"];
const CRON_SCOPE_ORDER: GatewayScope[] = ["cron:read", "cron:write"];
const TICKET_SCOPE_ORDER: GatewayScope[] = ["ticket:read", "ticket:write"];

function normalizeScope(scope: string): string {
  return scope.trim();
}

export function isGatewayScope(scope: string): scope is GatewayScope {
  return (GATEWAY_SCOPE_VALUES as readonly string[]).includes(scope);
}

function gatewayScopeImplies(granted: GatewayScope, required: GatewayScope): boolean {
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

function legacyAccessImplies(scope: string, required: GatewayScope): boolean {
  switch (scope) {
    case "read":
      return required === "run:read" || required === "cron:read" || required === "account:read" || required === "memory:read" || required === "prompt:read" || required === "score:read" || required === "ticket:read" || required === "observability:read";
    case "execute":
      return required === "run:read" || required === "run:write" || required === "signal:submit" || required === "cron:read" || required === "cron:write" || required === "ticket:read" || required === "ticket:write";
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
 */
function methodGrantSatisfiesRequiredScope(methodName: string, requiredScope: GatewayScope): boolean {
  const methodScope = getRequiredScopeForGatewayMethod(methodName);
  if (methodScope === undefined) {
    return false;
  }
  return gatewayScopeImplies(methodScope, requiredScope);
}

export function hasGatewayScope(
  grantedScopes: readonly string[],
  requiredScope: GatewayScope,
  methodName?: string,
): boolean {
  const normalized = grantedScopes.map(normalizeScope).filter(Boolean);
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
