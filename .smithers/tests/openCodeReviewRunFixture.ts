import { Gateway, mdxPlugin } from "smithers-orchestrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
const uiEntry = resolve(here, "../ui/open-code-review.tsx");
const mod = await import("../workflows/open-code-review.tsx");

const gateway = new Gateway({ heartbeatMs: 250 });
gateway.register("open-code-review", (mod as { default: Parameters<typeof gateway.register>[1] }).default, {
  ui: { entry: uiEntry, title: "Open Code Review" },
});

const auth = { triggeredBy: "e2e", scopes: ["*"], role: "operator", tokenId: null };
const runId = process.env.OCR_RUN_ID ?? "open-code-review-e2e";
const repo = process.env.OCR_REPO ?? process.cwd();
const ocrBin = process.env.OCR_BIN ?? "ocr";

await gateway.startRun(
  "open-code-review",
  { repo, ocrBin, runReview: true },
  auth as Parameters<typeof gateway.startRun>[2],
  runId,
  { resume: false },
);
const inflight = gateway.inflightRuns.get(runId);
if (inflight) await inflight;

const port = Number(process.env.OCR_PORT ?? "7352");
await gateway.listen({ port, host: "127.0.0.1" });
process.stdout.write(`open-code-review fixture listening on http://127.0.0.1:${port} (run ${runId})\n`);

async function shutdown() {
  try {
    await gateway.close();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await new Promise(() => undefined);
