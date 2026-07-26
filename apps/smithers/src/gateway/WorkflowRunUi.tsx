// Local-only: the gateway serves workflow UIs from the same origin as this app,
// so the base is empty (relative `/workflows/...` paths). The cloud app resolves
// a configured remote gateway base here instead.
function getGatewayBaseUrl(): string {
  return "";
}

function normalizeWorkflowUiPath(uiPath: string): string {
  const value = uiPath.trim() || "/";
  try {
    const parsed = new URL(value, "http://smithers.local");
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch {
    return "/";
  }
}

export function workflowUiSrc(uiPath: string, runId: string, gatewayBaseUrl = getGatewayBaseUrl()): string {
  const base = gatewayBaseUrl || "http://smithers.local";
  const url = new URL(normalizeWorkflowUiPath(uiPath), base);
  url.searchParams.set("runId", runId);
  return gatewayBaseUrl ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Sandbox applied to a SAME-ORIGIN workflow UI frame. Same-origin deployments
 * proxy `/workflows/*` through the app's own Worker, so without isolation the
 * gateway-served bundle would execute on the app origin with full access to the
 * parent DOM, session/local storage (the bearer token, Pair keys), and every
 * same-origin API. Omitting `allow-same-origin` forces the frame into an opaque
 * origin, walling it off from all of that while still letting it run (scripts /
 * forms / popups / dialogs / downloads). We intentionally withhold
 * `allow-top-navigation` so a hostile bundle cannot redirect the parent. The
 * frame keeps working because it boots its own RPC/websocket clients and the
 * Worker proxy authenticates its requests via same-site cookies, which the
 * browser still attaches regardless of the sandboxed document's origin.
 */
const SAME_ORIGIN_UI_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/**
 * A workflow UI frame must be sandboxed whenever it loads from the app's own
 * origin — whether that's a relative proxy path (`/workflows/*`) or an absolute
 * URL whose origin matches the app. The latter happens when the gateway base URL
 * is configured to the app's own origin (via the Remote panel / localStorage or
 * `VITE_SMITHERS_GATEWAY_BASE_URL`), in which case `workflowUiSrc` returns an
 * absolute same-origin URL that string-shape checks ("starts with /") would
 * miss. Only a genuinely cross-origin remote gateway is left unsandboxed, since
 * the same-origin policy already isolates it.
 */
function isSameOriginUiSrc(src: string): boolean {
  if (typeof window === "undefined") {
    // No origin to compare against (non-browser render): fail closed by treating
    // anything that is not an explicit absolute URL as same-origin so it stays
    // sandboxed.
    return !/^[a-z][a-z0-9+.-]*:\/\//i.test(src);
  }
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    // Unparseable src: fail closed to the sandboxed (isolated) path.
    return true;
  }
}

/**
 * Embeds a workflow's own custom UI for a gateway run. Workflows register a UI
 * with the gateway (served at `uiPath`, e.g. `/workflows/<key>`); when a run
 * belongs to such a workflow the inspector defaults to showing that UI here.
 *
 * The UI is a standalone bundle the gateway serves and boots with its own RPC /
 * websocket clients, so it lives behind an iframe — its own document, its own
 * React, its own styles. Any frame that resolves to the app's own origin (a
 * relative `/workflows/*` proxy path, or an absolute URL whose origin matches
 * the app) is `sandbox`ed (no `allow-same-origin`) so the bundle cannot reach
 * the app's DOM/storage. A directly configured remote gateway uses its absolute
 * remote origin and is already isolated by the same-origin policy, so no sandbox
 * is forced there. `?runId=<id>` lets a UI scope to one run by reading
 * `location.search`.
 */
export function WorkflowRunUi({ uiPath, runId }: { uiPath: string; runId: string }) {
  const src = workflowUiSrc(uiPath, runId);
  // A frame that resolves to the app's own origin (relative proxy path, or an
  // absolute URL whose origin equals the app's) needs sandboxing. Only a
  // genuinely cross-origin remote gateway is already isolated and may rely on
  // its own-origin storage.
  const sandbox = isSameOriginUiSrc(src) ? SAME_ORIGIN_UI_SANDBOX : undefined;
  return (
    <div className="gw-ui-frame-wrap" data-testid="gateway-workflow-ui">
      <iframe
        key={src}
        className="gw-ui-frame"
        src={src}
        title="Workflow UI"
        data-testid="gateway-workflow-ui-frame"
        sandbox={sandbox}
      />
    </div>
  );
}
