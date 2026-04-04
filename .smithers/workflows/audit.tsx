// smithers-source: seeded
// smithers-display-name: Audit
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ForEachFeature, forEachFeatureMergeSchema, forEachFeatureResultSchema } from "../components/ForEachFeature";

const inputSchema = z.object({
  features: z.record(z.string(), z.string()).default({}),
  focus: z.string().default("code review"),
  additionalContext: z.string().nullable().default(null),
  maxConcurrency: z.number().int().default(5),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  auditFeature: forEachFeatureResultSchema,
  audit: forEachFeatureMergeSchema,
});

export default smithers((ctx) => (
  <Workflow name="audit">
    <ForEachFeature
      idPrefix="audit"
      agent={agents.smart}
      features={ctx.input.features}
      prompt={[
        `Audit for: ${ctx.input.focus}.`,
        "Evaluate the provided feature scope for gaps in testing, observability, error handling, operational safety, and maintainability.",
        "Use the repository as the source of truth and report concrete findings with actionable next steps.",
        ctx.input.additionalContext ? `Additional context:\n${ctx.input.additionalContext}` : null,
      ].filter(Boolean).join("\n\n")}
      maxConcurrency={ctx.input.maxConcurrency}
      mergeAgent={agents.smart}
    />
  </Workflow>
));
