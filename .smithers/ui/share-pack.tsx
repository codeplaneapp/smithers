/** @jsxImportSource react */
import { createGatewayReactRoot, useGatewayRun } from "smithers-orchestrator/gateway-react";

function runIdFromUrl() {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

export default function SharePack() {
  const run = useGatewayRun(runIdFromUrl());
  return (
    <main style={{ fontFamily: "system-ui", padding: 24, maxWidth: 760, margin: "auto" }}>
      <h1>Share pack</h1>
      <p>Validate the manifest, prepare the repository, publish it, and open the awesome-smithers pull request.</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>
        {JSON.stringify(run.data ?? (run.loading ? "Loading…" : "Waiting for a run…"), null, 2)}
      </pre>
    </main>
  );
}

createGatewayReactRoot(<SharePack />);
