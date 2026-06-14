import { StrictMode, useMemo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { SmithersGatewayProvider, SyncProvider } from "@smithers-orchestrator/gateway-react";
import { bindRouteStore } from "./app/bindRouteStore";
import { router } from "./app/router";
import { useAuthStore } from "./auth/authStore";
import { bindDock } from "./apps/bindDock";
import { getGatewayClient } from "./gateway/gatewayClient";
import { startApprovalWatcher } from "./runs/watchApprovals";
import { registerServiceWorker } from "./registerServiceWorker";
import { appGatewayCollections } from "./sync/appGatewayCollections";
import { platformFetch } from "./jjhub/platformFetch";
import { platformJson, PlatformError } from "./jjhub/platformJson";
import "./styles.css";

// Wire the router into the route store and bridge run gates to the chat before
// the first paint, so every store is live when the shell mounts.
bindRouteStore(router);
bindDock();
startApprovalWatcher();
// Kick the auth check once at boot (not from an AuthStatus mount effect).
void useAuthStore.getState().bootstrap();

function GatewayProviders({ children }: { children: ReactNode }) {
  const gatewayBaseUrl = useAuthStore((state) => state.gatewayBaseUrl);
  const hasToken = useAuthStore((state) => state.hasToken);
  const authStatus = useAuthStore((state) => state.status);
  const client = useMemo(
    () => getGatewayClient(),
    [authStatus, gatewayBaseUrl, hasToken],
  );
  return (
    <SmithersGatewayProvider client={client}>
      <SyncProvider client={appGatewayCollections}>
        {children}
      </SyncProvider>
    </SmithersGatewayProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GatewayProviders>
      <RouterProvider router={router} />
    </GatewayProviders>
  </StrictMode>,
);

registerServiceWorker();

// Expose the jjhub seam (`platformJson`/`platformFetch`/`PlatformError`) to
// Playwright when `VITE_SMITHERS_E2E_TEST_HOOKS=1`. Specs drive *real* app
// transport — auth header attach, base-URL resolution, error mapping — so
// "the UI sees fake-plue data" can be asserted from the browser side without
// shipping a debug surface in production. Gate is build-time: the import.meta
// branch goes dead in any other build (preview, deploy, dev without the env).
if (import.meta.env.VITE_SMITHERS_E2E_TEST_HOOKS === "1") {
  (window as unknown as { __smithers_test?: unknown }).__smithers_test = {
    platformFetch,
    platformJson,
    PlatformError,
  };
}
