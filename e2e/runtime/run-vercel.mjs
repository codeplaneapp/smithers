import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { rm } from "node:fs/promises";
import { assertRuntimeConformance } from "@smithers-orchestrator/testing/runtimeConformance";

const port = 8788;
const child = spawn("pnpm", ["exec", "vercel", "dev", "--local-config", "runtime/vercel.json", "--listen", `127.0.0.1:${port}`, "--yes"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VERCEL_TELEMETRY_DISABLED: "1", VERCEL_RUNTIME_CONFORMANCE: "1", VERCEL_ORG_ID: "", VERCEL_PROJECT_ID: "" } });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
try {
  let response;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { response = await fetch(`http://127.0.0.1:${port}/api/conformance`); if (response.ok) break; } catch {}
    await delay(250);
  }
  if (!response?.ok) throw new Error(`Vercel local runtime did not become ready: ${output}`);
  assertRuntimeConformance(await response.json(), "Vercel");
  console.log("Vercel runtime conformance passed");
} finally { child.kill("SIGTERM"); await delay(100); if (!child.killed) child.kill("SIGKILL"); await rm(".vercel", { recursive: true, force: true }); }
