#!/usr/bin/env bun
/**
 * Single-command launcher for UltraGrill.
 *
 *   bun .smithers/scripts/ultragrill.ts ["your session goal"]
 *
 * Boots the gateway, starts an open-ended collaboration session, opens the UI in
 * your browser, and stays alive until you Ctrl-C. The worker is a real agent
 * working directly in this repo (shared-repo model), so it will read/edit files.
 */
import { Gateway, SmithersDb, mdxPlugin } from "smithers-orchestrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url)); // .smithers/scripts
const packDir = resolve(here, ".."); // .smithers
const uiEntry = resolve(packDir, "ui/ultragrill.tsx");
const artifactPath = resolve(packDir, "artifacts/ultragrill-spec.md");

const mod = await import(resolve(packDir, "workflows/ultragrill.tsx"));
const workflow = (mod as { default: Parameters<Gateway["register"]>[1] & { db: unknown } }).default;

const goal = process.argv.slice(2).join(" ").trim() || "Collaborate with me in real time.";
const port = Number(process.env.PORT ?? "7411");
const host = process.env.HOST ?? "127.0.0.1";
const runId = `ultragrill-${Math.floor(Date.now() / 1000)}`;

const gateway = new Gateway({ heartbeatMs: 250 });
gateway.register("ultragrill", workflow, { ui: { entry: uiEntry, title: "UltraGrill" } });

const auth = { triggeredBy: "cli", scopes: ["*"], role: "operator", tokenId: null };
await gateway.startRun(
  "ultragrill",
  { goal, artifactPath },
  auth as Parameters<typeof gateway.startRun>[2],
  runId,
  { resume: false },
);
await gateway.resumeRunIfNeeded(runId, "ultragrill", new SmithersDb(workflow.db), auth as never);
await gateway.listen({ port, host });

const url = `http://${host}:${port}/workflows/ultragrill?runId=${runId}`;
console.log(`\n  ✨ UltraGrill is live → ${url}`);
console.log(`     goal: ${goal}`);
console.log(`     (Ctrl-C to end)\n`);

if (!process.env.NO_OPEN) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // headless / no browser — the URL above still works
  }
}

async function shutdown() {
  try {
    await gateway.close();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await new Promise(() => undefined);
