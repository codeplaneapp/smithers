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
 *   node bin/smithers-electric-proxy.js
 */
import { createSmithersElectricProxy } from "../src/createSmithersElectricProxy.js";
import { deriveGrantsFromGateway } from "../src/deriveGrantsFromGateway.js";
import { serveSmithersElectricProxy } from "../src/serveSmithersElectricProxy.js";

/**
 * @param {string} name
 * @returns {string}
 */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * @returns {Promise<void>}
 */
async function main() {
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
