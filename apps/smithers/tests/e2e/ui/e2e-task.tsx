/** @jsxImportSource react */
import { useState } from "react";
import { createGatewayReactRoot } from "smthrs/gateway-react";
import { ConnectionBadge, RunEventLog, RunList } from "smthrs/gateway-ui";

// A real workflow UI built from the shared @smthrs/gateway-ui
// components, mounted by the seed gateway for the e2e suite. Exercises the
// package's components end-to-end in a real browser against a real gateway.
function App() {
  const [runId, setRunId] = useState<string>();
  return (
    <div data-testid="e2e-task-ui" style={{ padding: 16 }}>
      <ConnectionBadge />
      <RunList filter={{ limit: 10 }} activeRunId={runId} onSelect={setRunId} />
      <RunEventLog runId={runId} style={{ height: 200 }} />
    </div>
  );
}

createGatewayReactRoot(<App />);
