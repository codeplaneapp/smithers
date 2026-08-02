// smithers-source: authored
// smithers-display-name: Add Eliza Agent Harness
// smithers-description: Implement an ElizaAgent harness in packages/agents that wraps the elizaOS AgentRuntime as a Smithers AgentLike, with pass-through access to all elizaOS plugins. Durable implement -> validate -> review loop.
// smithers-tags: agents, integration, eliza
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../../components/ValidationLoop";
import { reviewOutputSchema } from "../../components/Review";

const inputSchema = z.object({
  // Default carries the full spec so `workflow run add-eliza-harness` works with
  // no args. Input fields arrive null when unsupplied, so we coalesce below.
  prompt: z.string().default(""),
});

const SPEC = `
# Task: add an Eliza (elizaOS) agent harness to packages/agents

Add a new first-class Smithers agent harness, **ElizaAgent**, that wraps the
in-process **elizaOS \`AgentRuntime\`** (npm package \`@elizaos/core\`, current
version ~1.7.2) so Smithers workflows can use Eliza as an agent backend and,
through it, ANY elizaOS plugin (e.g. \`@elizaos/plugin-slack\`,
\`@elizaos/plugin-discord\`, \`@elizaos/plugin-telegram\`, model-provider and
sql plugins). Eliza connectors/plugins are NOT standalone — they are elizaOS
\`Service\`s bolted onto an \`AgentRuntime\`, so the harness must own a runtime
and let callers pass plugins straight through.

## Ground truth about the contract (already verified — do not re-litigate)

- The agent contract is \`AgentLike\` in \`packages/agents/src/AgentLike.ts\`:
  an object with an async \`generate(args?: AgentGenerateOptions)\`, plus
  optional \`id\`, \`tools\`, \`capabilities\`,
  \`supportsNativeStructuredOutput\`, and \`preflight\`.
- \`AgentGenerateOptions\` is in
  \`packages/agents/src/BaseCliAgent/AgentGenerateOptions.ts\`: notably
  \`prompt\`, \`abortSignal\`, \`outputSchema\`, \`onStdout\`/\`onStderr\`,
  \`taskContext\`.
- \`generate\` must return an AI-SDK \`GenerateTextResult\`-shaped object. Use
  the existing helper \`buildGenerateResult(text, output, modelId, usage)\` in
  \`packages/agents/src/BaseCliAgent/buildGenerateResult.js\` to build it (see
  how the CLI agents use it). Do NOT invent a new result shape.
- Eliza is an in-process SDK, NOT a subprocess CLI. So model the new harness on
  the SDK-style agents (\`AnthropicAgent.js\` / \`OpenAIAgent.js\`), NOT on
  \`BaseCliAgent\`. Follow the repo convention: implementation in a \`.js\`
  file with JSDoc types + a sibling \`*Options.ts\` type file.

## What to build

1. \`packages/agents/src/ElizaAgentOptions.ts\` — the options type:
   - \`character\`: the elizaOS \`Character\` (or a minimal compatible object).
   - \`plugins\`: array of elizaOS \`Plugin\` objects to register on the runtime
     (this is how callers get Slack/Discord/etc.). Pass-through, untouched.
   - \`settings\`/\`env\`: optional record of strings forwarded to the runtime so
     plugin params (e.g. \`SLACK_BOT_TOKEN\`) can be supplied programmatically.
   - \`model\`/\`modelId\`: optional label used for the \`modelId\` in results and
     diagnostics.
   - Keep \`@elizaos/core\` types imported as \`import type\` only, so the type
     compiles even when the optional dep is absent (use a local minimal
     interface if a hard \`import type\` would break typecheck when the package
     is not installed — prefer structural/minimal types over a hard dependency).

2. \`packages/agents/src/ElizaAgent.js\` — the harness implementing \`AgentLike\`:
   - Constructor takes \`ElizaAgentOptions\`.
   - \`preflight()\`: deterministically verify \`@elizaos/core\` can be resolved
     (dynamic import) and that the configured character/plugins are coherent;
     reject with a clear, actionable error if \`@elizaos/core\` is not installed
     ("install @elizaos/core to use ElizaAgent"). A rejected preflight fails the
     task without retry — that is the intended behavior.
   - Lazily construct + \`initialize()\` the \`AgentRuntime\` once (memoize across
     calls; guard against concurrent init). Plugins and settings come from
     options. Respect \`abortSignal\`.
   - \`generate({ prompt, abortSignal, outputSchema, onStdout })\`: feed the
     prompt into the runtime to get the agent's text response. Use the most
     direct supported path (e.g. \`runtime.useModel(...)\` for a text/structured
     completion, or composing a message + the runtime's message handling, then
     read back the produced text). Stream partial text to \`onStdout\` when
     available. If \`outputSchema\` is provided, parse/validate the text into the
     structured object and set it as \`output\` via \`buildGenerateResult\`.
   - Set \`supportsNativeStructuredOutput\` correctly (likely \`false\` unless you
     wire a native structured path).
   - Clean up / allow \`stop()\` of the runtime; ensure no leaked timers/sockets.

3. Wire exports: add \`export { ElizaAgent } from "./ElizaAgent.js";\` to
   \`packages/agents/src/index.js\`, and add the
   \`ElizaAgentOptions\` typedef to the \`@smithers-type-exports\` block exactly
   like the other \`*Options\` entries. Keep the generated \`.d.ts\` consistent
   with how the package builds types (mirror an existing agent precisely).

4. \`packages/agents/package.json\`: add \`@elizaos/core\` as an
   **optional peer dependency** — list it under \`peerDependencies\` with a
   matching \`peerDependenciesMeta\`: \`{ "@elizaos/core": { "optional": true } }\`,
   and/or \`optionalDependencies\`, so the agents package still installs and
   builds WITHOUT elizaOS present (CI has no elizaOS, no agent CLIs, no
   browsers). Do NOT add it as a hard \`dependencies\` entry.

## Tests (MANDATORY — CI runs on a clean box: no agent CLIs, no browsers, no network, no API keys)

Add \`packages/agents/tests/ElizaAgent.test.ts\` (bun test, mirror existing tests
in that dir). Cover, with NO network and NO real \`@elizaos/core\` required:
- \`preflight()\` rejects with the actionable message when \`@elizaos/core\`
  cannot be resolved.
- Option pass-through: plugins/settings/character given to the constructor reach
  the runtime construction (use a fake/injected runtime factory — design the
  class so a runtime factory can be injected for tests, e.g. an internal
  \`_createRuntime\` hook or constructor-injected factory; NO mocking frameworks,
  use a real local fake object per the repo "No mocks" rule for PRODUCT code —
  here a deterministic in-test fake runtime is acceptable as a test seam, keep it
  real and explicit).
- \`generate()\` maps a runtime text response through \`buildGenerateResult\`:
  returns \`.text\`, and when an \`outputSchema\` is passed, validates into
  \`.output\`.
Design the class so these are testable WITHOUT installing elizaOS (dependency
injection of the runtime/factory, dynamic import only behind preflight/lazy init).

## Definition of done (hard gates — the validate step MUST confirm these pass)

- \`pnpm typecheck\` is green at repo root.
- \`pnpm -C packages/agents test\` is green.
- The agents package still builds/installs with \`@elizaos/core\` ABSENT (no hard
  dependency); the only place that touches elizaOS is behind a dynamic import +
  type-only imports.
- New code matches the surrounding file conventions (\`.js\` + JSDoc, sibling
  \`*Options.ts\`, export wiring, no \`any\` where the codebase avoids it).

Follow repo CLAUDE.md: atomic commit(s) with emoji + conventional-commit subject
(e.g. \`✨ feat(agents): add ElizaAgent harness wrapping elizaOS AgentRuntime\`),
work on main, explicit pathspecs (never \`git add -A\`). Do NOT push unless the
gates are green; leave the commit staged/made locally and report status.
`;

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
});

export default smithers((ctx) => {
  const prompt = ctx.input.prompt && ctx.input.prompt.trim().length > 0 ? ctx.input.prompt : SPEC;

  const validate = ctx.outputMaybe("validate", { nodeId: "eliza:validate" });
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
    <Workflow name="add-eliza-harness">
      <ValidationLoop
        idPrefix="eliza"
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
