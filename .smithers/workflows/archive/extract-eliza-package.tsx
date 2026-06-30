// smithers-source: authored
// smithers-display-name: Extract Eliza into opt-in package
// smithers-description: Move the ElizaAgent harness out of packages/agents into its own opt-in package @smithers-orchestrator/agent-eliza so @elizaos/core is installable but not installed by default. Private repo workflow (archived).
// smithers-tags: agents, integration, eliza, refactor, private
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../../agents";
import {
  ValidationLoop,
  implementOutputSchema,
  validateOutputSchema,
} from "../../components/ValidationLoop";
import { reviewOutputSchema } from "../../components/Review";

const inputSchema = z.object({
  prompt: z.string().default(""),
});

const SPEC = `
# Task: extract ElizaAgent into its own opt-in package

The ElizaAgent harness currently lives in \`packages/agents\` with
\`@elizaos/core\` declared as an optional peer dependency. Problem: the pnpm
workspace has \`auto-install-peers\` on, so a clean \`pnpm install\` STILL
materializes \`@elizaos/core\` (and its ~779 lines of transitive deps) under
\`packages/agents\` → \`dependencies\` in \`pnpm-lock.yaml\`. Confirm with
\`pnpm why @elizaos/core\` (today it reports it under \`@smithers-orchestrator/agents\`).

Goal: make Eliza support **installable but not installed by default**. Move the
harness into a NEW standalone workspace package so \`@elizaos/core\` is a real
dependency of *that* package only. Downstream consumers of
\`@smithers-orchestrator/agents\` (and the published \`smithers-orchestrator\`)
must NOT pull elizaOS unless they explicitly install the new package.

## Ground truth (verified — do not re-derive)

- Package conventions: copy the shape of \`packages/errors\` — it has
  \`package.json\` (name \`@smithers-orchestrator/errors\`, \`exports\` map with
  \`.\` → \`./src/index.d.ts\` / \`./src/index.js\`, scripts \`test\` =
  \`bun test tests\`, \`typecheck\` = \`tsc -p tsconfig.json --noEmit\`,
  \`build\` = \`tsup --dts-only\`), \`tsconfig.json\`, \`tsup.config.ts\`,
  \`src/\`, \`tests/\`. Mirror it exactly.
- The workspace auto-discovers packages via \`pnpm-workspace.yaml\` globs
  (\`packages/*\`), so a new \`packages/agent-eliza\` is picked up automatically.
  \`scripts/check-dependency-boundaries.mjs\` also auto-discovers it and will
  FAIL if the new package imports something not declared in its \`package.json\`.
- The shared helpers ElizaAgent needs are PUBLICLY exported from the agents
  package subpath \`@smithers-orchestrator/agents/BaseCliAgent\`:
  \`export { extractPrompt }\` and \`export { buildGenerateResult }\`. The
  \`AgentLike\` / \`AgentGenerateOptions\` types are exported from
  \`@smithers-orchestrator/agents\` (typedef block in its \`index.js\`).
- Nothing in the repo references \`ElizaAgent\` yet except its own test, so
  removing it from \`packages/agents\` is safe.

## What to do

1. Create \`packages/agent-eliza/\` mirroring \`packages/errors\`:
   - \`package.json\`: name \`@smithers-orchestrator/agent-eliza\`; \`exports\`
     map \`.\` → src/index; scripts \`test\`/\`typecheck\`/\`build\` like errors.
     **dependencies**: \`@elizaos/core\`: \`~1.7.2\` (a REAL dependency now — this
     package is the opt-in that owns elizaOS) and
     \`@smithers-orchestrator/agents\`: \`workspace:*\` (for the shared helpers +
     types). Add \`zod\` if the code/tests need it. devDependencies:
     \`@types/bun\`, \`typescript\` (match errors). NO \`@elizaos/core\` as a peer
     anywhere now — it is a direct dep of this package only.
   - \`tsconfig.json\` and \`tsup.config.ts\`: copy from \`packages/errors\` and
     adjust as needed.

2. Move the three files (use \`git mv\` so history is preserved):
   - \`packages/agents/src/ElizaAgent.js\` → \`packages/agent-eliza/src/ElizaAgent.js\`
   - \`packages/agents/src/ElizaAgentOptions.ts\` → \`packages/agent-eliza/src/ElizaAgentOptions.ts\`
   - \`packages/agents/tests/ElizaAgent.test.ts\` → \`packages/agent-eliza/tests/ElizaAgent.test.ts\`
   Then rewrite imports inside the moved files:
   - \`./BaseCliAgent/buildGenerateResult.js\` and
     \`./BaseCliAgent/extractPrompt.js\` → import both from
     \`@smithers-orchestrator/agents/BaseCliAgent\`.
   - The \`AgentGenerateOptions\` type import → from
     \`@smithers-orchestrator/agents\` (typedef import path the package exposes).
   - Fix any other now-broken relative import in the test (the test injects a
     fake runtime factory — keep that seam, no mocking frameworks).

3. Add \`packages/agent-eliza/src/index.js\` exporting \`ElizaAgent\` plus the
   \`@smithers-type-exports\` typedef block for \`ElizaAgentOptions\` /
   \`ElizaCharacter\` / \`ElizaPlugin\` — mirror exactly how
   \`packages/agents/src/index.js\` does its export + typedef wiring. Add
   \`src/index.d.ts\` only if the package's \`tsup --dts-only\` build / typecheck
   needs it (match the errors package's approach).

4. Remove Eliza from \`packages/agents\`:
   - Delete \`export { ElizaAgent } from "./ElizaAgent.js";\` and the
     \`ElizaAgentOptions\` / \`ElizaCharacter\` / \`ElizaPlugin\` typedef lines from
     \`packages/agents/src/index.js\` AND \`packages/agents/src/index.d.ts\`.
   - Remove \`@elizaos/core\` from \`packages/agents/package.json\`
     \`peerDependencies\` AND \`peerDependenciesMeta\`.

5. Run \`pnpm install\` to update the lockfile, then VERIFY the key outcome:
   \`pnpm why @elizaos/core\` must NO LONGER list it under
   \`@smithers-orchestrator/agents\` — only under
   \`@smithers-orchestrator/agent-eliza\`. The agents importer block in
   \`pnpm-lock.yaml\` must have no \`@elizaos/core\` entry.

## Definition of done (hard gates — validate MUST confirm)

- \`pnpm typecheck\` green at repo root.
- \`pnpm -C packages/agent-eliza test\` green (the moved ElizaAgent tests pass
  in their new home, still WITHOUT requiring a real \`@elizaos/core\` at runtime —
  they inject a fake runtime factory).
- \`pnpm -C packages/agents test\` still green (Eliza tests are gone from here).
- \`pnpm test\` gate green: \`check-single-effect-version\`,
  \`check-dependency-boundaries\`, \`check-docs\`, \`check-llms\` all pass. The new
  package must not violate dependency boundaries (every import declared in its
  package.json).
- \`pnpm why @elizaos/core\` confirms it resolves ONLY through
  \`@smithers-orchestrator/agent-eliza\`, not \`@smithers-orchestrator/agents\`.

Follow repo CLAUDE.md: atomic commits with emoji + conventional-commit subjects
(e.g. \`✨ feat(agent-eliza): extract ElizaAgent into opt-in package\` and
\`♻️ refactor(agents): drop elizaOS optional peer, move to agent-eliza\`), work on
main, explicit pathspecs (never \`git add -A\`; this is a jj colocated repo —
commit with explicit paths). Do NOT push; leave commits local and report status.
`;

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
});

export default smithers((ctx) => {
  const prompt =
    ctx.input.prompt && ctx.input.prompt.trim().length > 0
      ? ctx.input.prompt
      : SPEC;

  const validate = ctx.outputMaybe("validate", { nodeId: "extract:validate" });
  const reviews = ctx.outputs.review ?? [];

  const hasValidated = validate !== undefined;
  const validationPassed = hasValidated && validate.allPassed !== false;
  const anyApproved =
    reviews.length > 0 && reviews.some((r: any) => r.approved === true);
  const done = validationPassed && anyApproved;

  const feedbackParts: string[] = [];
  if (validate && !validationPassed && validate.failingSummary) {
    feedbackParts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  for (const review of reviews) {
    if (review.approved === false) {
      feedbackParts.push(`REVIEWER REJECTED:\n${review.feedback}`);
      if (review.issues?.length) {
        for (const issue of review.issues) {
          feedbackParts.push(
            `  [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`,
          );
        }
      }
    }
  }
  const feedback = feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null;

  return (
    <Workflow name="extract-eliza-package">
      <ValidationLoop
        idPrefix="extract"
        prompt={prompt}
        implementAgents={agents.smart}
        validateAgents={agents.cheapFast}
        reviewAgents={agents.smart}
        feedback={feedback}
        done={done}
        maxIterations={4}
      />
    </Workflow>
  );
});
