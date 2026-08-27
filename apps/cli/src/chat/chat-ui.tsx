/** @jsxImportSource react */
/**
 * The chat run's live UI.
 *
 * Everything on screen is the shared `<RunSurface>` from
 * `smthrs/gateway-ui` — the same component the Monitor embeds
 * for hijack hand-offs — so the standalone page (`smithers ui`,
 * `smithers chat-create`) and the embedded surface never drift apart.
 */
import { createGatewayReactRoot } from "smthrs/gateway-react";
import { RunSurface } from "smthrs/gateway-ui";
import { SmithersUiStyles } from "smthrs/ui";

function runIdFromUrl() {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function App() {
  return (
    <>
      <SmithersUiStyles withTheme />
      <RunSurface runId={runIdFromUrl()} variant="standalone" />
    </>
  );
}

createGatewayReactRoot(<App />);
