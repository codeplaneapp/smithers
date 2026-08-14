import { Gateway, mdxPlugin } from "smthrs";
import type { AgentLike } from "smthrs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
const uiEntry = resolve(here, "../ui/open-code-review.tsx");
const mod = await import("../workflows/open-code-review.tsx");

const fakeReviewAgent: AgentLike = {
  id: "open-code-review-e2e-agent",
  tools: {},
  generate: async (args) => {
    const prompt = args?.prompt;
    if (typeof prompt !== "string" || !prompt.includes("src/app.ts")) {
      throw new Error("native review prompt did not include src/app.ts");
    }
    return {
      output: {
        status: "success",
        message: "Reviewed 1 file and produced 1 comment.",
        summary: { filesReviewed: 1, comments: 1, totalTokens: 321, inputTokens: 300, outputTokens: 21, elapsed: "1s" },
        comments: [
          {
            content: "Guard against null before trimming.",
            existingCode: "return value!.trim().toUpperCase();",
            suggestionCode: 'if (value == null) return "";\nreturn value.trim().toUpperCase();',
            startLine: 2,
            endLine: 2,
            severity: "major",
            category: "correctness",
            confidence: "confirmed",
          },
        ],
        warnings: [],
      },
    };
  },
};

const gateway = new Gateway({ heartbeatMs: 250 });
const workflow = (
  mod as { createOpenCodeReviewWorkflow: (agents: AgentLike[]) => Parameters<typeof gateway.register>[1] }
).createOpenCodeReviewWorkflow([fakeReviewAgent]);
gateway.register("open-code-review", workflow, {
  ui: { entry: uiEntry, title: "Open Code Review" },
});

const auth = { triggeredBy: "e2e", scopes: ["*"], role: "operator", tokenId: null };
const runId = process.env.OCR_RUN_ID ?? "open-code-review-e2e";
const repo = process.env.OCR_REPO ?? process.cwd();

await gateway.startRun(
  "open-code-review",
  { repo, runReview: true },
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
