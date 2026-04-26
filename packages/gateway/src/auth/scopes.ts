export const GATEWAY_SCOPE_VALUES = [
  "run:read",
  "run:write",
  "run:admin",
  "approval:submit",
  "signal:submit",
  "cron:read",
  "cron:write",
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
  "observability:read": "Read DevTools and other observability streams.",
};

const RUN_SCOPE_ORDER: GatewayScope[] = ["run:read", "run:write", "run:admin"];
const CRON_SCOPE_ORDER: GatewayScope[] = ["cron:read", "cron:write"];

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
  return false;
}

function legacyAccessImplies(scope: string, required: GatewayScope): boolean {
  switch (scope) {
    case "read":
      return required === "run:read" || required === "cron:read" || required === "observability:read";
    case "execute":
      return required === "run:read" || required === "run:write" || required === "signal:submit" || required === "cron:read" || required === "cron:write";
    case "approve":
      return required === "approval:submit" || legacyAccessImplies("execute", required);
    case "admin":
      return true;
    default:
      return false;
  }
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
    if (methodName && granted === methodName) {
      return true;
    }
    if (methodName && granted.endsWith(".*") && methodName.startsWith(granted.slice(0, -1))) {
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
