// Test fixture: boot a REAL gateway serving the REAL ultragrill workflow + UI,
// start an open-ended session, and keep listening. The browser e2e drives the
// session over real RPC (submitSignal utterances → worker dispatch → end).
// Spawned by ultragrill.e2e.test with cwd set to a throwaway dir and a fake
// `claude` on PATH so the worker resolves deterministically.
import { Gateway, SmithersDb, mdxPlugin } from "smithers-orchestrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
const uiEntry = resolve(here, "../ui/ultragrill.tsx");
const mod = await import("../workflows/ultragrill.tsx");
const workflow = (mod as { default: Parameters<Gateway["register"]>[1] }).default;

const gateway = new Gateway({ heartbeatMs: 250 });
gateway.register("ultragrill", workflow, { ui: { entry: uiEntry, title: "UltraGrill" } });

const auth = { triggeredBy: "e2e", scopes: ["*"], role: "operator", tokenId: null };
const RUN_ID = process.env.UG_RUN_ID ?? "ultragrill-e2e";

// Start the open-ended session. The first frame parks on the intake WaitForEvent
// (status waiting-event); the browser's submitSignal calls wake it from there.
await gateway.startRun(
  "ultragrill",
  { goal: "Build a settings page", turnTimeoutMs: 60_000, maxTurns: 10 },
  auth as Parameters<typeof gateway.startRun>[2],
  RUN_ID,
  { resume: false },
);
await gateway.resumeRunIfNeeded(RUN_ID, "ultragrill", new SmithersDb((workflow as { db: unknown }).db), auth as never);

const port = Number(process.env.UG_PORT ?? "7360");
await gateway.listen({ port, host: "127.0.0.1" });
process.stdout.write(`ultragrill fixture listening on http://127.0.0.1:${port} (run ${RUN_ID})\n`);

async function shutdown() {
  try {
    await gateway.close();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await new Promise(() => undefined);
