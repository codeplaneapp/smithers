// Throwaway smoke test: drive the smithers electric-proxy against the REAL
// Electric fixture (deploy/electric/docker-compose.yml) and prove a shape opens
// end-to-end with grant-based where scoping.
//
//   docker compose -f deploy/electric/docker-compose.yml -p smithers-electric-test up -d
//   bun deploy/electric/smoke.ts
//
// Expects rows seeded with run_id 'run-1','run-2','run-3'; grants cover only
// run-1/run-2, so run-3 must be filtered out by the proxy's where-template fill.

import { createSmithersElectricProxy } from "../../packages/electric-proxy/src/index.ts";

const ELECTRIC_PORT = process.env.SMITHERS_ELECTRIC_PORT ?? "30001";

const proxy = createSmithersElectricProxy({
  electricUrl: `http://localhost:${ELECTRIC_PORT}/v1/shape`,
  authenticate: () => ({
    principalId: "t",
    scopes: ["run:read"],
    grantedRunIds: ["run-1", "run-2"],
  }),
  // Capture the where the proxy synthesized + forwarded.
  log: (decision) => {
    console.log("[proxy decision]", JSON.stringify(decision));
  },
});

// offset=-1 => Electric initial snapshot. The proxy forwards inbound query
// params verbatim, so we pass offset here. No table predicate in the request:
// the proxy fills run_id IN (...) from the grants.
const req = new Request(
  "http://proxy.local/v1/shape?table=_smithers_runs&offset=-1",
);

const res = await proxy.fetch(req);
const body = await res.text();

console.log("status:", res.status);
console.log("electric-handle:", res.headers.get("electric-handle"));
console.log("electric-offset:", res.headers.get("electric-offset"));
console.log("body:", body);

// Assertions: real seeded rows came back, scoped to the grants.
const hasRun1 = body.includes('"run-1"');
const hasRun2 = body.includes('"run-2"');
const hasRun3 = body.includes('"run-3"');
console.log(
  `assert: status=200 -> ${res.status === 200}; run-1=${hasRun1}; run-2=${hasRun2}; run-3 filtered out=${!hasRun3}`,
);

if (res.status !== 200 || !hasRun1 || !hasRun2 || hasRun3) {
  console.error("SMOKE FAILED");
  process.exit(1);
}
console.log("SMOKE OK");
