/** @jsxImportSource react */
// The reference "bad" UI: it mounts and shows the run status, but it does NOT
// stream events, does NOT surface the failed node, does NOT render node output,
// and has NO approval control. The verifier must FAIL it on events/output/error/
// approval while passing mounts/status — proving the checks discriminate.
import { createGatewayReactRoot, useGatewayRun } from "smithers-orchestrator/gateway-react";

function App() {
  const runId = new URLSearchParams(location.search).get("runId") ?? undefined;
  const run = useGatewayRun(runId);
  return (
    <main style={{ fontFamily: "sans-serif", padding: 20 }} data-testid="ui-eval-fixture-ui">
      <h1>Run</h1>
      <div>Status: {String(run.data?.status ?? "loading")}</div>
    </main>
  );
}

createGatewayReactRoot(<App />);
