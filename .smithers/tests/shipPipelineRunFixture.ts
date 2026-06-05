// Test fixture: boot a REAL gateway that EXECUTES the real ship-pipeline workflow
// to completion (with whatever `claude` is on PATH — the e2e supplies a fake
// agent binary), then serves the real ship-pipeline UI so a browser can assert it
// renders the real run. Spawned by ship-pipeline-run.e2e.test.tsx with cwd set to a
// throwaway git repo (so the worktrees + ticket files land there, and bun
// resolves modules from the real tree rather than a stale global cache).
import { Gateway, mdxPlugin } from "smithers-orchestrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
const uiEntry = resolve(here, "../ui/ship-pipeline.tsx");
const mod = await import("../workflows/ship-pipeline.tsx");

const gateway = new Gateway({ heartbeatMs: 250 });
gateway.register("ship-pipeline", (mod as { default: Parameters<typeof gateway.register>[1] }).default, {
  ui: { entry: uiEntry, title: "Ship Pipeline" },
});

const auth = { triggeredBy: "e2e", scopes: ["*"], role: "operator", tokenId: null };
const RUN_ID = process.env.UG_RUN_ID ?? "ship-pipeline-e2e";

// Execute the real workflow end-to-end BEFORE listening, so the browser only
// ever sees a completed run (no spec/run race).
await gateway.startRun(
  "ship-pipeline",
  { ticketsDir: ".smithers/tickets/ship-pipeline", baseBranch: "main", tdd: false },
  auth as Parameters<typeof gateway.startRun>[2],
  RUN_ID,
  { resume: false },
);
const inflight = gateway.inflightRuns.get(RUN_ID);
if (inflight) await inflight;

const port = Number(process.env.UG_PORT ?? "7350");
await gateway.listen({ port, host: "127.0.0.1" });
process.stdout.write(`ship-pipeline-run fixture listening on http://127.0.0.1:${port} (run ${RUN_ID})\n`);

async function shutdown() {
  try {
    await gateway.close();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await new Promise(() => undefined);
