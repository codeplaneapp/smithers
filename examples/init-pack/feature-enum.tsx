// Example only: feature-enum is preserved here instead of being installed by default.
// Inventory product features and classify their implementation status. It remains an example because the curated init pack installs only authoring and documentation workflows. Run `smithers graph examples/init-pack/feature-enum.tsx` after copying it into a project.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
// smithers-display-name: Feature Enum
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";
import { FeatureEnum, featureEnumOutputSchema } from "../components/FeatureEnum";

const inputSchema = z.object({
  refineIterations: z.number().int().default(1),
  existingFeatures: z.record(z.string(), z.array(z.string())).nullable().default(null),
  lastCommitHash: z.string().nullable().default(null),
  additionalContext: z.string().default(""),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  featureEnum: featureEnumOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="feature-enum">
    <UI entry="../ui/feature-enum.tsx" title={"Feature Enum"} />
    <FeatureEnum
      idPrefix="feature-enum"
      agent={agents.research}
      refineIterations={ctx.input.refineIterations}
      existingFeatures={ctx.input.existingFeatures}
      lastCommitHash={ctx.input.lastCommitHash}
      additionalContext={ctx.input.additionalContext}
    />
  </Workflow>
));
