// Example only: audit is preserved here instead of being installed by default.
// It remains an example because the default init pack is deliberately curated; run `smithers graph examples/init-pack/audit.tsx` after copying its imports.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
// smithers-display-name: Audit
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ForEachFeature, forEachFeatureMergeSchema, forEachFeatureResultSchema } from "../components/ForEachFeature";
import AuditPrompt from "../prompts/audit.mdx";

const agentTierSchema = z.enum(["cheapFast", "smart", "smartTool", "planning", "review", "implement"]);

const inputSchema = z.object({
  features: z.record(z.string(), z.array(z.string())).default({}),
  focus: z.string().default("code review"),
  additionalContext: z.string().nullable().default(null),
  maxConcurrency: z.number().int().default(5),
  agentTier: agentTierSchema.nullable().default(null),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  auditFeature: forEachFeatureResultSchema,
  audit: forEachFeatureMergeSchema,
});

export default smithers((ctx) => {
  const tier = ctx.input.agentTier ?? "smart";
  return (
    <Workflow name="audit">
      <UI entry="../ui/audit.tsx" title={"Audit"} />
      <ForEachFeature
        idPrefix="audit"
        agent={agents[tier]}
        features={ctx.input.features}
        prompt={<AuditPrompt focus={ctx.input.focus} additionalContext={ctx.input.additionalContext} />}
        maxConcurrency={ctx.input.maxConcurrency}
        mergeAgent={agents[tier]}
      />
    </Workflow>
  );
});
