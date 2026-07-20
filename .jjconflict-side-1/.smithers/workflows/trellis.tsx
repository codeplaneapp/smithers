// smithers-display-name: Trellis
/** @jsxImportSource smithers-orchestrator */
import { Trellis, UI, createSmithers, delegationV2Schemas } from "smithers-orchestrator";
import { z } from "zod/v4";
import { fableAuthor, implementer, synthesizer, validator } from "../components/roles";

const inputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(12_000).default("Build the requested result and prove it works."),
  role: z.enum(["sol", "fable"]).default("sol"),
  work: z.enum([
    "refine_goal",
    "plan",
    "research",
    "poc",
    "execute",
    "review",
    "preview",
    "synthesize",
  ]).default("synthesize"),
  maxConcurrency: z.number().int().min(1).max(16).default(4),
  maxAuthorGenerations: z.number().int().min(1).max(12).default(4),
  maxAuthorDepth: z.number().int().min(1).max(8).default(4),
  maxTotalAuthorTurns: z.number().int().min(1).max(256).default(32),
  criticalExecutionPolicy: z.strictObject({
    allowedCategories: z.array(z.enum([
      "security_boundary",
      "data_integrity",
      "concurrency_invariant",
      "protocol_core",
      "irreversible_migration",
    ])).min(1).max(5),
    allowedPathPrefixes: z.array(z.string().trim().min(1).max(512)).min(1).max(32),
    maxChangedLines: z.number().int().min(1).max(500),
  }).optional(),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  ...delegationV2Schemas,
});

export default smithers((ctx) => {
  // Static graph rendering does not pass through input-schema defaults, so the
  // workflow repeats them here to keep `smithers graph trellis.tsx` truthful.
  const prompt = ctx.input.prompt?.trim() || "Build the requested result and prove it works.";
  const role = ctx.input.role ?? "sol";
  const work = ctx.input.work ?? "synthesize";
  const maxConcurrency = ctx.input.maxConcurrency ?? 4;
  return (
    <Workflow name="trellis">
      <UI entry="../ui/trellis.tsx" title="Smithers Trellis" />
      <Trellis
        prompt={prompt}
        role={role}
        work={work}
        agents={{
          sol: synthesizer,
          fable: fableAuthor,
          terra: validator,
          luna: implementer,
        }}
        outputs={outputs}
        maxConcurrency={maxConcurrency}
        criticalExecutionPolicy={ctx.input.criticalExecutionPolicy}
        limits={{
          maxAuthorGenerations: ctx.input.maxAuthorGenerations ?? 4,
          maxAuthorDepth: ctx.input.maxAuthorDepth ?? 4,
          maxTotalAuthorTurns: ctx.input.maxTotalAuthorTurns ?? 32,
        }}
      />
    </Workflow>
  );
});
