#!/usr/bin/env node
/**
 * Runnable cloud entry point for the Smithers Electric proxy. Fronts a real
 * `electricsql/electric` service (SMITHERS_ELECTRIC_URL) with auth, scope, and
 * grant-based shape filtering, deriving each caller's grants from the gateway
 * (SMITHERS_GATEWAY_URL): the set of runs a bearer token can read IS its
 * granted run ids. Designed to run alongside the deploy/electric stack.
 *
 *   SMITHERS_ELECTRIC_URL=http://electric:3000/v1/shape \
 *   SMITHERS_GATEWAY_URL=http://gateway:7342 \
 *   SMITHERS_ELECTRIC_PROXY_PORT=8443 \
 *   node bin/smithers-electric-proxy.ts
 */
import {
  createSmithersElectricProxy,
  type SmithersElectricAuthContext,
} from "../src/createSmithersElectricProxy.ts";
import { serveSmithersElectricProxy } from "../src/serveSmithersElectricProxy.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function deriveGrantsFromGateway(
  gatewayUrl: string,
  authorization: string,
): Promise<SmithersElectricAuthContext | null> {
  // listRuns returns exactly the runs the token is authorized to read, so its
  // result is the authoritative grant set. A 401/403 means no access.
  const response = await fetch(`${gatewayUrl.replace(/\/+$/, "")}/v1/rpc/listRuns`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({}),
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const body = (await response.json().catch(() => null)) as { payload?: unknown } | null;
  const payload = body?.payload;
  const rows = Array.isArray(payload) ? payload : [];
  const grantedRunIds = rows
    .map((row) => (row && typeof row === "object" ? (row as { runId?: unknown }).runId : undefined))
    .filter((id): id is string => typeof id === "string");
  return {
    principalId: authorization.slice(-12),
    scopes: ["run:read"],
    grantedRunIds,
  };
}

async function main(): Promise<void> {
  const electricUrl = requireEnv("SMITHERS_ELECTRIC_URL");
  const gatewayUrl = requireEnv("SMITHERS_GATEWAY_URL");
  const port = Number(process.env.SMITHERS_ELECTRIC_PROXY_PORT ?? 8443);
  const outputTables = (process.env.SMITHERS_ELECTRIC_OUTPUT_TABLES ?? "")
    .split(",")
    .map((table) => table.trim())
    .filter(Boolean);

  const proxy = createSmithersElectricProxy({
    electricUrl,
    outputTables,
    authenticate: async (request) => {
      const authorization = request.headers.get("authorization");
      if (!authorization) return null;
      return deriveGrantsFromGateway(gatewayUrl, authorization);
    },
  });

  const { port: boundPort } = await serveSmithersElectricProxy({ proxy, port });
  // eslint-disable-next-line no-console
  console.log(`smithers-electric-proxy listening on :${boundPort} -> ${electricUrl}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
