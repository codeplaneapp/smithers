/** @jsxImportSource react */
/**
 * The oneshot workflow's live UI.
 *
 * Everything on screen is the shared `<OneshotSurface>` from
 * `smithers-orchestrator/gateway-ui` — the same component the Monitor embeds
 * for hijack hand-offs — so the standalone page (`smithers ui`, `smithers
 * oneshot --open`, `smithers chat-create`) and the embedded surface never
 * drift apart.
 */
import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";
import { OneshotSurface } from "smithers-orchestrator/gateway-ui";
import { SmithersUiStyles } from "smithers-orchestrator/ui";

function runIdFromUrl() {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function App() {
  return (
    <>
      <SmithersUiStyles withTheme />
      <OneshotSurface runId={runIdFromUrl()} variant="standalone" />
    </>
  );
}

createGatewayReactRoot(<App />);
