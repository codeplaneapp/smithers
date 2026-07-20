// smithers-source: authored
// smithers-display-name: Build plugin-smithers (Eliza -> Smithers)
// smithers-description: Implement packages/eliza-plugin — an ElizaOS plugin (plugin-smithers) that drives the Smithers Gateway (launch/watch/approve/cancel runs, proactive chat updates). Private repo workflow. Grounded in .smithers/workflows/archive/plugin-smithers-DESIGN.md.
// smithers-tags: eliza, plugin, integration, private
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

const inputSchema = z.object({ prompt: z.string().default("") });

const SPEC = `
# Task: implement \`plugin-smithers\` — an ElizaOS plugin that drives Smithers

Build the NEW package **\`packages/eliza-plugin\`** (internal name
\`@smithers-orchestrator/eliza-plugin\`): a first-class ElizaOS v1.x plugin that
lets an Eliza agent drive the Smithers durable control plane — launch workflows,
watch them, answer approval gates, and report progress back into chat. This is
the mirror image of the already-shipped \`agent-eliza\` package (Smithers ->
Eliza); this is Eliza -> Smithers.

## READ FIRST (authoritative build plan — follow it closely)

- **\`.smithers/workflows/archive/plugin-smithers-DESIGN.md\`** — the concrete
  design proposal with full code skeletons for the Service, Actions, Provider,
  Evaluator, routes, config, the assembled Plugin object, package.json (incl.
  \`agentConfig.pluginParameters\`), packaging, and the phased plan. IMPLEMENT
  THIS. Read the whole file before writing code.
- **\`.smithers/workflows/archive/plugin-smithers-RESEARCH.md\`** — the
  authoritative ElizaOS-plugin reference (Service/Action/Provider/Evaluator
  contracts for @elizaos/core ^1.7.2). Consult it for exact elizaOS type shapes.

## GROUND AGAINST REAL CODE — do NOT trust illustrative names in the design

The design explicitly warns that some event \`type\`/field names in its reducer
are illustrative. You MUST wire against the REAL Smithers APIs by reading:

- **\`packages/pi-plugin/\`** — the precedent to mirror for monorepo conventions
  (package.json, tsup.config.ts, tsconfig.json, tests layout, how it talks to
  Smithers, how it reuses \`@smithers-orchestrator/agents/agent-contract\`).
  Match its structure and build/test setup.
- **\`packages/gateway-client/src/SmithersGatewayClient.ts\`** and
  **\`packages/gateway-client/src/GatewayRpcTypeMap.ts\`** — the REAL client.
  Confirmed methods: \`launchRun\`, \`getRun\`, \`listRuns\`, \`cancelRun\`,
  \`submitApproval\`, \`submitSignal\`, \`streamRunEvents\`, \`listWorkflows\`,
  \`streamRunEventsResilient\`. Use the exact \`GatewayRpcParams<...>\` param
  shapes and the real constructor options (read the file — do not guess the
  constructor/url/apiKey shape). \`streamRunEvents\` yields
  \`GatewayEventFrame<StreamRunEventPayload>\`.
- **\`packages/protocol/\`** (+ gateway) — the REAL \`SmithersEvent\` / gateway
  frame / \`StreamRunEventPayload\` schema. Wire the Service's event reducer
  (status change / approval-needed / ask_human / error / completion) to these
  ACTUAL frame shapes, not the placeholder \`ev.type === 'run.status'\` names.

## What to build (per DESIGN §5–§8, Phases 1–4)

A complete, working plugin — read + write + human-in-the-loop + polish:

1. \`packages/eliza-plugin/src/service.ts\` — **\`SmithersService\`** extends
   elizaOS \`Service\` (serviceType \`'smithers'\`). Owns the
   \`SmithersGatewayClient\`, the \`Map<runId, TrackedRun>\` registry, and live
   \`streamRunEvents\` subscriptions. Implements \`launch\`, \`getRun\`,
   \`listRuns\`, \`cancel\`, \`approve\`, \`deny\`, \`answerHuman\`, \`snapshot\`,
   \`watch\` (background stream), \`report\` (emit synthetic
   \`MESSAGE_RECEIVED\` for proactive chat updates), and \`reduce\` (event ->
   registry update + chat message, wired to REAL frame schema). \`stop()\`
   aborts all subscriptions.
2. \`packages/eliza-plugin/src/actions.ts\` — the ~7 intent-shaped Actions:
   \`RUN_SMITHERS_WORKFLOW\`, \`CHECK_SMITHERS_RUN\`, \`LIST_SMITHERS_RUNS\`,
   \`APPROVE_SMITHERS_NODE\`, \`DENY_SMITHERS_NODE\`, \`CANCEL_SMITHERS_RUN\`,
   \`ANSWER_SMITHERS_HUMAN\` (each with name/similes/description/validate/handler/
   examples per the v1.x \`Action\` contract; extract args with
   \`useModel(ModelType.OBJECT_SMALL, …)\`).
3. \`packages/eliza-plugin/src/providers.ts\` — **\`SMITHERS_RUNS\`** dynamic
   provider injecting the live run table; must NEVER throw (return empty on
   failure).
4. \`packages/eliza-plugin/src/evaluators.ts\` — **\`SMITHERS_RUN_OUTCOME\`**
   evaluator persisting terminal-run summaries to \`facts\` memory.
5. \`packages/eliza-plugin/src/routes.ts\` — optional \`/smithers/runs\` (GET
   JSON) + \`/smithers/callback\` (POST webhook) routes.
6. \`packages/eliza-plugin/src/config.ts\` — \`init\` reading \`SMITHERS_URL\` /
   \`SMITHERS_API_KEY\` via \`runtime.getSetting\`.
7. \`packages/eliza-plugin/src/plugin.ts\` + \`src/index.ts\` — assemble and
   export the \`Plugin\` object (\`name: 'plugin-smithers'\`, wire
   services/actions/providers/evaluators/routes/init, \`dependencies:
   ['@elizaos/plugin-sql']\`). Default export + named \`smithersPlugin\`.
8. \`packages/eliza-plugin/package.json\` per DESIGN §8: internal name
   \`@smithers-orchestrator/eliza-plugin\`, \`keywords\`
   \`["elizaos","plugin","smithers","orchestration"]\`, \`agentConfig.pluginParameters\`
   for SMITHERS_URL / SMITHERS_API_KEY, deps \`@elizaos/core\` (^1.7.2, a real
   dep — externalized by tsup) + \`@smithers-orchestrator/gateway-client\`
   (\`workspace:*\`), tsup build externalizing @elizaos/core. Add
   \`tsconfig.json\` + \`tsup.config.ts\` mirroring pi-plugin.

Reuse where the design says to: \`@smithers-orchestrator/agents/agent-contract\`
(\`renderSmithersAgentPromptGuidance\`) folded into the provider text, and
\`SmithersError\` from \`@smithers-orchestrator/errors\` for error shapes.

## Tests (NO MOCKS — repo policy; CI has no @elizaos/core, no LLM, no browsers)

Design §11. Keep the package test gate deterministic and CI-safe:
- Unit-test the pure **event reducer** and the Service registry logic with a
  deterministic in-test **fake gateway client** injected as a test seam (a real
  local object, NOT a mocking framework — same discipline agent-eliza used).
- Assert the **plugin wiring** (\`smithersPlugin\` exposes the expected
  actions/providers/services/evaluators names).
- Do NOT require a real \`@elizaos/core\` runtime or a real LLM in the default
  \`test\` gate (import types only where possible; guard anything needing the
  runtime behind an opt-in env like the \`SMITHERS_RUN_AGENT_E2E\`/e2e pattern).
  Match how \`packages/pi-plugin/tests\` is structured and what its \`test\`
  script runs.

## Definition of done (HARD GATES — validate MUST confirm every one)

- \`pnpm typecheck\` green at repo root.
- \`pnpm -C packages/eliza-plugin test\` green.
- \`pnpm -C packages/eliza-plugin build\` succeeds (tsup ESM + d.ts, @elizaos/core
  externalized — nothing from @elizaos/core bundled into dist).
- **\`pnpm install\` then \`pnpm install --frozen-lockfile\` BOTH succeed** — if
  you add the package to the root \`package.json\`, you MUST regenerate and
  commit \`pnpm-lock.yaml\` so the ROOT importer includes
  \`@smithers-orchestrator/eliza-plugin\`; otherwise CI's frozen install fails
  with \`ERR_PNPM_OUTDATED_LOCKFILE\`. (This exact bug bit the last package —
  do not repeat it.)
- \`pnpm test\` gate green: \`check-single-effect-version\`,
  \`check-dependency-boundaries\` (every import declared in package.json),
  \`check-docs\`, \`check-llms\`, \`check-smithers-test-script\`.
- No dependency-boundary violations; no \`@elizaos/core\` leaking into
  \`packages/gateway-client\` or other core packages (it stays a dep of
  \`eliza-plugin\` only, like \`agent-eliza\`).

Follow repo CLAUDE.md: atomic commits with emoji + conventional-commit subjects
(e.g. \`✨ feat(eliza-plugin): scaffold plugin-smithers Service + config\`,
\`✨ feat(eliza-plugin): actions + provider + evaluator\`), work on main, explicit
pathspecs (jj colocated repo — never \`git add -A\`). Do NOT push; leave commits
local and report status, including the frozen-lockfile check result.
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

  const validate = ctx.outputMaybe("validate", { nodeId: "plugin:validate" });
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
    <Workflow name="build-plugin-smithers">
      <ValidationLoop
        idPrefix="plugin"
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
