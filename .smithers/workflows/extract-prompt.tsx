// smithers-source: seeded
// smithers-display-name: Extract Prompt
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import {
  ExtractPrompt,
  MarkdownPromptCache,
  rctfPromptSchema,
} from "../components/extract-prompt";
import type { RctfPromptOutput } from "../components/extract-prompt";

const WORKFLOW_ID = "extract-prompt";

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({
    prompt: z.string().nullable().default(null),
    cacheKey: z.string().nullable().default(null),
    stakes: z.enum(["high", "low"]).default("low"),
    maxTurns: z.number().int().default(10),
    context: z.string().default(""),
  }),
  draft: rctfPromptSchema,
});

const cache = new MarkdownPromptCache();

export default smithers((ctx) => {
  const cacheKey = ctx.input.cacheKey ?? "";
  const cached = cacheKey ? cache.getSync(cacheKey) : undefined;
  const latestRow = ctx.latest("draft", `${WORKFLOW_ID}:extract:draft`);
  const latest = latestRow as RctfPromptOutput | null | undefined;

  if (latest && ctx.input.cacheKey && latest.score >= 0.7 && latest.resolved) {
    cache.setSync(ctx.input.cacheKey, {
      key: ctx.input.cacheKey,
      prompt: latest.prompt,
      structured: latest.structured as Record<string, unknown>,
      schema: "rctf",
      stakes: ctx.input.stakes,
      score: latest.score,
      scoreReason: latest.scoreReason,
      createdAt: new Date().toISOString(),
      source: "extracted",
      overridden: latest.overridden ?? false,
    });
  }

  return (
    <Workflow name={WORKFLOW_ID}>
      <ExtractPrompt
        idPrefix={WORKFLOW_ID}
        prompt={ctx.input.prompt ?? undefined}
        cached={cached}
        output={outputs.draft}
        agent={agents.smart}
        stakes={ctx.input.stakes}
        maxTurns={ctx.input.maxTurns}
        currentScore={latest?.score ?? null}
        latestDraft={latest ?? null}
        context={ctx.input.context}
      />
    </Workflow>
  );
});
