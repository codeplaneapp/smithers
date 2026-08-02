// smithers-source: authored
// smithers-display-name: Build eliza-conventions wrapper
// smithers-description: Add @smthrs/agent-eliza/conventions — a TS wrapper over the normal Smithers API (createSmithers/Gateway) that matches elizaOS authoring+loading conventions (defineWorkflow/loadWorkflows/formatWorkflowsForPrompt, YAML frontmatter). Private repo workflow.
// smithers-tags: eliza, conventions, wrapper, private
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../../components/ValidationLoop";
import { reviewOutputSchema } from "../../components/Review";

const inputSchema = z.object({ prompt: z.string().default("") });

const SPEC = `
# Task: build an elizaOS-conventions wrapper over the normal Smithers TS API

Goal: let someone who knows **elizaOS conventions** author, load, and register
**Smithers workflows** using the SAME shapes and function names eliza uses for
its Skills/Plugins — a thin TypeScript wrapper over Smithers' normal TS API
(\`createSmithers\`, the JSX components, and the \`Gateway\`). This is NOT a CLI
change and NOT a change to Smithers' own workflow discovery; it is an additive
wrapper module.

## Home & packaging

Add it to the existing opt-in eliza package as a NEW subpath module:
- Files under \`packages/agent-eliza/src/conventions/\` (e.g. \`types.ts\`,
  \`frontmatter.ts\`, \`define.ts\`, \`loader.ts\`, \`formatter.ts\`, \`register.ts\`,
  \`index.ts\`).
- Export it as a SUBPATH \`@smthrs/agent-eliza/conventions\` — add
  an \`exports["./conventions"]\` entry in \`packages/agent-eliza/package.json\`
  pointing at \`./src/conventions/index.js\` + \`.d.ts\` (mirror how
  \`@smthrs/agents\` exposes subpaths like \`./BaseCliAgent\`).
- New deps this module needs, added to \`packages/agent-eliza/package.json\`
  \`dependencies\`: \`smthrs\` (\`workspace:*\` — for
  \`createSmithers\`, the JSX components, and \`Gateway\`) and \`yaml\`
  (\`^2.8.1\` — for frontmatter parsing; it is already a root dep). Keep
  \`@elizaos/core\` as-is (types only; do NOT add a hard runtime dep on
  \`@elizaos/skills\`, which is not published — mirror its conventions
  structurally instead).

## Match THESE elizaOS conventions (from @elizaos/skills, verified)

Mirror the names, shapes, and behavior of eliza's skills API, but for Smithers
workflows:

- **Types** (mirror eliza \`Skill\` / \`SkillFrontmatter\` / \`SkillEntry\` /
  \`LoadSkillsResult\` / \`LoadSkillsOptions\` / \`SkillDiagnostic\`):
  - \`WorkflowFrontmatter\`: YAML frontmatter keys — \`name?\`, \`description?\`,
    \`tags?: string[]\`, \`aliases?: string[]\`, \`disable-model-invocation?: boolean\`,
    \`user-invocable?: boolean\`, \`[key: string]: unknown\`. (Same kebab-case
    convention eliza uses.)
  - \`WorkflowDefinition\` (≈ eliza \`Skill\`): \`{ name, description,
    tags?, aliases?, version?, disableModelInvocation?, filePath?, baseDir?,
    source?, workflow: SmithersWorkflow }\` where \`workflow\` is the value returned
    by the normal Smithers author path (the default export of a \`smithers(ctx =>
    <Workflow/>)\` module). Import the real workflow type from
    \`smthrs\` (find the exported \`SmithersWorkflow\` / workflow type;
    read \`packages/smithers/src/create.js\` + index to get the correct type).
  - \`WorkflowEntry\` = \`{ workflow: WorkflowDefinition, frontmatter, metadata }\`.
  - \`LoadWorkflowsResult\` = \`{ workflows: WorkflowDefinition[], diagnostics:
    WorkflowDiagnostic[] }\`; \`WorkflowDiagnostic\` = \`{ type:
    "warning"|"error"|"collision", message, path, collision? }\` (mirror
    \`SkillDiagnostic\`).
  - \`LoadWorkflowsOptions\` = \`{ cwd?, workflowPaths?: string[], includeDefaults?,
    bundledDir?, managedDir? }\` (mirror \`LoadSkillsOptions\`
    \`{cwd,agentDir,skillPaths,includeDefaults,bundledSkillsDir,managedSkillsDir}\`).

- **Functions** (mirror eliza \`loadSkills\` / \`loadSkillsFromDir\` /
  \`parseFrontmatter\` / \`formatSkillsForPrompt\`):
  - \`defineWorkflow(def): WorkflowDefinition\` — the eliza-\`Skill\`-style
    authoring entry point. Accepts \`{ name, description, ...frontmatter fields,
    workflow }\` and returns a normalized \`WorkflowDefinition\`. Validate name/desc.
  - \`defineWorkflowPlugin({ name, description, workflows }): WorkflowPlugin\` —
    an eliza \`Plugin\`-shaped aggregator (\`workflows\` is the analog of a Plugin's
    \`actions\`/\`providers\`).
  - \`parseWorkflowFrontmatter(source): { frontmatter: WorkflowFrontmatter; body:
    string }\` and \`stripFrontmatter\` / \`serializeWorkflowFile\` — mirror eliza's
    frontmatter utils; parse a \`---\`-fenced YAML block using \`yaml\`.
  - \`loadWorkflowsFromDir({ dir, source }): LoadWorkflowsResult\` and
    \`loadWorkflows(options): LoadWorkflowsResult\` — mirror \`loadSkills\`:
    discover workflow files across precedence-ordered dirs (project
    \`<cwd>/.smithers/workflows\` shadows managed \`~/.smithers/workflows\` shadows
    bundled), parse optional companion \`---\` frontmatter (a sibling
    \`<name>.md\`/frontmatter block or a leading comment block in the \`.tsx\`),
    dynamically \`import()\` the default export as the workflow, and return
    \`{ workflows, diagnostics }\`. Later sources override earlier (record a
    \`collision\` diagnostic), exactly like eliza. Never throw on a bad file —
    push an \`error\` diagnostic and continue.
  - \`formatWorkflowsForPrompt(workflows): string\` — mirror
    \`formatSkillsForPrompt\`: skip \`disableModelInvocation\`, render a compact
    list an LLM can read.
  - \`registerWorkflows(gateway, workflows)\` — register each
    \`WorkflowDefinition\` on a Smithers \`Gateway\` via \`gateway.register(name,
    workflow)\` (read \`packages/server/src/gateway\` or the exported \`Gateway\`
    type for the real \`register\` signature).
  - \`toSkill(def): { name; description; ... }\` — adapt a \`WorkflowDefinition\`
    into an elizaOS-\`Skill\`-shaped object (structural; import \`type { Skill }\`
    from \`@elizaos/core\` if it exists there, else a local minimal type) so an
    Eliza agent's skill surface can list Smithers workflows.

## GROUND against real code (read before writing)

- eliza conventions to mirror: the shapes above are taken from
  \`@elizaos/skills\` (\`loadSkills\`, \`parseFrontmatter\`, \`formatSkillsForPrompt\`,
  \`Skill\`/\`SkillFrontmatter\`/\`LoadSkillsOptions\`/\`SkillDiagnostic\`). A clone
  exists at \`~/eliza/packages/skills/src/{types,loader,frontmatter,formatter}.ts\`
  — read it if reachable to match naming/behavior precisely; otherwise the
  shapes above are authoritative.
- Smithers API being wrapped: \`packages/smithers/src/create.js\` (\`createSmithers\`
  signature + returned \`{ smithers, Workflow, Task, outputs }\`), the components
  re-exported from \`smthrs\`, and the \`Gateway\` (\`register\`) from
  \`@smthrs/server/gateway\`. Use the REAL exported types — do not
  invent them.
- Convention parity reference: how Smithers already parses \`// smithers-*:\`
  workflow metadata lives in \`apps/cli/src/workflows.js\` (\`parseMetadata\`); your
  \`WorkflowFrontmatter\` is the YAML/eliza-flavored analog. You do NOT need to
  change that file.

## Tests (NO MOCKS; CI has no @elizaos runtime, no LLM, no network)

Add \`packages/agent-eliza/tests/conventions.test.ts\` (bun test, matching the
package's existing test style). Cover with deterministic real fixtures:
- \`parseWorkflowFrontmatter\` round-trips a \`---\` YAML block (name/description/
  tags/aliases/disable-model-invocation) and \`serializeWorkflowFile\` reverses it.
- \`defineWorkflow\` normalizes a definition (kebab frontmatter -> camel fields;
  validates required name/description).
- \`loadWorkflowsFromDir\` over a temp fixture dir with 2 workflow files (one with
  frontmatter, one without) returns both with correct metadata + a \`collision\`
  diagnostic when a name repeats across two source dirs; a malformed file yields
  an \`error\` diagnostic instead of throwing.
- \`formatWorkflowsForPrompt\` omits \`disableModelInvocation\` entries.
- \`toSkill\` maps name/description/tags through.
  Build a tiny real Smithers workflow via \`createSmithers\` for the
  define/register tests (no LLM, no agent execution — just constructing the
  workflow object and asserting \`registerWorkflows\` calls \`gateway.register\`
  with the right id, using a small real in-test Gateway-shaped object as a seam,
  NOT a mocking framework).

## Definition of done (HARD GATES — validate MUST confirm each)

- \`pnpm typecheck\` green at repo root.
- \`pnpm -C packages/agent-eliza test\` green (existing 23 ElizaAgent tests still
  pass + the new conventions tests).
- \`pnpm -C packages/agent-eliza build\` succeeds and the new \`./conventions\`
  subpath resolves (types + js).
- **\`pnpm install\` then \`pnpm install --frozen-lockfile\` BOTH succeed** — after
  adding \`smthrs\` + \`yaml\` deps, regenerate and commit
  \`pnpm-lock.yaml\`, or CI's frozen install fails with
  \`ERR_PNPM_OUTDATED_LOCKFILE\` (this bug already bit us once — do not repeat).
- \`pnpm test\` gate green: \`check-single-effect-version\`,
  \`check-dependency-boundaries\` (every import declared in
  \`packages/agent-eliza/package.json\`; no boundary violation, no dependency
  cycle — agent-eliza may depend on \`smthrs\` since
  \`smthrs\` does NOT depend on agent-eliza), \`check-docs\`,
  \`check-llms\`, \`check-smithers-test-script\`.

Follow repo CLAUDE.md: atomic commits, emoji + conventional-commit subjects
(e.g. \`✨ feat(agent-eliza): elizaOS-conventions wrapper for authoring/loading Smithers workflows\`),
work on main, explicit pathspecs (jj colocated — never \`git add -A\`). Do NOT
push; leave commits local and report status incl. the frozen-lockfile result.
`;

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
});

export default smithers((ctx) => {
  const prompt = ctx.input.prompt && ctx.input.prompt.trim().length > 0 ? ctx.input.prompt : SPEC;

  const validate = ctx.outputMaybe("validate", { nodeId: "conv:validate" });
  const reviews = ctx.outputs.review ?? [];

  const hasValidated = validate !== undefined;
  const validationPassed = hasValidated && validate.allPassed !== false;
  const anyApproved = reviews.length > 0 && reviews.some((r: any) => r.approved === true);
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
    <Workflow name="build-eliza-conventions">
      <ValidationLoop
        idPrefix="conv"
        prompt={prompt}
        implementAgents={agents.smart}
        validateAgents={agents.cheapFast}
        reviewAgents={agents.smart}
        feedback={feedback}
        done={done}
        maxIterations={5}
      />
    </Workflow>
  );
});
