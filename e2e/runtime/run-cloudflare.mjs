import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { assertRuntimeConformance } from "@smithers-orchestrator/testing/runtimeConformance";

const port = 8787;
const child = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--config", "runtime/wrangler.toml", "--port", String(port), "--ip", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
try {
  let response;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { response = await fetch(`http://127.0.0.1:${port}/conformance`); if (response.ok) break; } catch {}
    await delay(250);
  }
  if (!response?.ok) throw new Error(`Cloudflare local worker did not become ready: ${output}`);
  assertRuntimeConformance(await response.json(), "Cloudflare Workers");
  console.log("Cloudflare Workers runtime conformance passed");
} finally { child.kill("SIGTERM"); await delay(100); if (!child.killed) child.kill("SIGKILL"); }
