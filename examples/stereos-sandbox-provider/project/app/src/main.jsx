import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SmithersGatewayProvider } from "smthrs/gateway-react";
import { App } from "./App.jsx";

// The vite dev server proxies /v1 and /rpc to the in-container gateway, so the
// browser talks to a single same-origin base URL.
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <SmithersGatewayProvider options={{ baseUrl: window.location.origin }}>
      <App />
    </SmithersGatewayProvider>
  </StrictMode>,
);
