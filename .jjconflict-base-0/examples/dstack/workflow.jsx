/** @jsxImportSource smithers-orchestrator */
/**
 * Smithers workflow that consumes a Kimi K2 endpoint hosted on GCP via dstack.
 *
 * dstack provisions an 8x H100 GCP box and runs vLLM as an OpenAI-compatible
 * service. This workflow points the AI SDK at that endpoint and runs a two-step
 * code review: critique the input snippet, then propose a concrete patch.
 *
 * Required env (see README for how to populate):
 *   KIMI_BASE_URL  — e.g. https://kimi-k2.<gateway>.example.com/v1
 *   KIMI_API_KEY   — dstack user token
 */
import { Sequence, Task, Workflow } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { createExampleSmithers } from "../_example-kit.js";

const baseURL = process.env.KIMI_BASE_URL;
const apiKey = process.env.KIMI_API_KEY;

if (!baseURL || !apiKey) {
  throw new Error(
    "Set KIMI_BASE_URL and KIMI_API_KEY (run scripts/print-env.sh after `dstack apply -f kimi.dstack.yml -y -d`).",
  );
}

const kimiProvider = createOpenAI({ baseURL, apiKey, name: "kimi" });
const kimi = kimiProvider("kimi-k2");

const reviewSchema = z.object({
  summary: z.string(),
  issues: z.array(
    z.object({
      severity: z.enum(["low", "medium", "high"]),
      area: z.string(),
      description: z.string(),
    }),
  ),
  overallScore: z.number().min(0).max(100),
});

const patchSchema = z.object({
  rationale: z.string(),
  unifiedDiff: z.string(),
});

const { smithers: build, outputs: out } = createExampleSmithers({
  review: reviewSchema,
  patch: patchSchema,
});

const reviewer = new Agent({
  model: kimi,
  instructions: `You are a senior code reviewer. Given a code snippet, identify
real bugs, design issues, and obvious smells. Be specific. Score 0-100 where 100
is production-ready.`,
});

const fixer = new Agent({
  model: kimi,
  instructions: `You are a careful refactorer. Given a snippet and a list of
issues, produce a single unified diff that addresses the highest-severity
issues. Keep the diff minimal — do not rewrite unrelated code.`,
});

export default build((ctx) => (
  <Workflow name="kimi-code-review">
    <Sequence>
      <Task id="review" output={out.review} agent={reviewer}>
        {`Review this code snippet from ${ctx.input.filename ?? "input.ts"}:

\`\`\`
${ctx.input.code}
\`\`\``}
      </Task>

      <Task
        id="patch"
        output={out.patch}
        agent={fixer}
        deps={{ review: out.review }}
      >
        {(deps) => `Original snippet (${ctx.input.filename ?? "input.ts"}):

\`\`\`
${ctx.input.code}
\`\`\`

Issues to address (highest severity first):
${deps.review.issues
  .filter((i) => i.severity !== "low")
  .map((i) => `- [${i.severity}] ${i.area}: ${i.description}`)
  .join("\n")}

Return a minimal unified diff.`}
      </Task>
    </Sequence>
  </Workflow>
));
