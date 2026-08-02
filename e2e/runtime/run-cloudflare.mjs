import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { assertRuntimeConformance } from "@smthrs/testing/runtimeConformance";
import { terminateChild } from "./terminateChild.mjs";

const port = 8787;
const wranglerStateDir = join(process.cwd(), "runtime", ".wrangler");
// `detached: true` makes this child its own process-group leader so
// terminateChild can signal the whole tree (wrangler --local spawns
// workerd as a child of its own) instead of leaving it orphaned.
const child = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--config", "runtime/wrangler.toml", "--port", String(port), "--ip", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
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
} finally {
  await terminateChild(child, { killProcessGroup: true });
  await rm(wranglerStateDir, { recursive: true, force: true });
}
