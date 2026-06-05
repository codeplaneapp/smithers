#!/usr/bin/env bun
// Boot a local Smithers Gateway that serves the SWE-Bench Pro patch-generation
// workflow. Runs via `bun` so the .tsx workflow + JSX runtime load directly.
//
// Runs are launched through this gateway by the client driver (src/runViaGateway.js),
// exercising the same RPC surface (`launchRun` / `getRun` / `streamRunEvents`) a
// hosted Smithers deployment exposes. No auth on localhost by default; set
// SWEBP_GATEWAY_TOKEN to require a bearer token.
import { Gateway } from "@smithers-orchestrator/server";

import workflow from "../workflow.tsx";

const port = Number(process.env.SWEBP_GATEWAY_PORT ?? 7331);
const host = process.env.SWEBP_GATEWAY_HOST ?? "127.0.0.1";
const key = process.env.SWEBP_GATEWAY_WORKFLOW_KEY ?? "swe-bench-pro";
const token = process.env.SWEBP_GATEWAY_TOKEN;

const gateway = new Gateway(
  token
    ? { auth: { mode: "token", tokens: { [token]: { role: "operator", scopes: ["*"] } } } }
    : {},
);
gateway.register(key, workflow, {});
await gateway.listen({ port, host });

// Sentinel the client waits for before launching runs.
console.log(`[gateway] serving "${key}" on http://${host}:${port}${token ? " (token auth)" : " (no auth)"}`);
console.log("[gateway] READY");
