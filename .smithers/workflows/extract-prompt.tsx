// smithers-source: user
// smithers-display-name: Extract Prompt
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import {
  ExtractPrompt,
  MarkdownPromptCache,
  rctfPromptSchema,
  stakesToThreshold,
} from "../components/extract-prompt";
import type { RctfPromptOutput } from "../components/extract-prompt";

const WORKFLOW_ID = "extract-prompt";

export const inputSchema = z.object({
  prompt: z.string().nullable().default(null),
  cacheKey: z.string().nullable().default(null),
  stakes: z.enum(["high", "low"]).default("low"),
  maxTurns: z.number().int().min(1).max(100).default(10),
  context: z.string().default(""),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  draft: rctfPromptSchema,
});

const cache = new MarkdownPromptCache();

export default smithers((ctx) => {
  const cacheKey = ctx.input.cacheKey ?? "";
  const cached = cacheKey ? cache.getSync(cacheKey) : undefined;
  const threshold = stakesToThreshold(ctx.input.stakes);
  const eligibleCached = cached && (cached.overridden || cached.score >= threshold) ? cached : undefined;
  const latestRow = ctx.latest("draft", `${WORKFLOW_ID}:draft`);
  const latest = latestRow as RctfPromptOutput | null | undefined;

  if (latest && ctx.input.cacheKey && latest.resolved && (latest.overridden || latest.score >= threshold)) {
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
      overrideReason: latest.overrideReason ?? null,
    });
  }

  const currentScore = (latest?.overridden ?? false) ? threshold : (latest?.score ?? null);

  return (
    <Workflow name={WORKFLOW_ID}>
      <ExtractPrompt
        idPrefix={WORKFLOW_ID}
        prompt={ctx.input.prompt ?? undefined}
        cached={eligibleCached}
        output={outputs.draft}
        agent={agents.research}
        stakes={ctx.input.stakes}
        maxTurns={ctx.input.maxTurns}
        currentScore={currentScore}
        latestDraft={latest ?? null}
        context={ctx.input.context}
      />
    </Workflow>
  );
});
