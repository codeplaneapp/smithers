// smithers-source: user
// smithers-display-name: File-change contract
//
// Ship a standardized file-change capability across every CLI harness:
//   1. spec: design an optional agent-contract capability that normalizes
//      per-harness "file changed" output (paths + change kind + unified diff
//      when reconstructible) into one shared shape.
//   2. fixtures: harvest REAL raw transcripts (claude, codex, kimi, plus any
//      other engines with recorded runs in this workspace) into committed e2e
//      fixtures.
//   3. implement/validate/review loop: land the contract, per-harness
//      implementations, fixture-driven e2e tests, and the clickable diff UI.
//   4. polish + land when validation is green and the review panel approves.
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { createSmithers, Sequence, Task } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";
import { implementer, panelists, polishReviewer } from "../components/roles";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";

const inputSchema = z.object({
  prompt: z
    .string()
    .default(
      "Add an optional standardized file-change parsing capability to the agent contract, implement it in every CLI harness we can, back it with e2e tests built from real recorded transcripts, and make file changes clickable diffs in the run UI.",
    ),
});

const specSchema = z.object({
  specPath: z.string().describe("repo-relative path of the written spec document"),
  capabilityName: z.string().describe("the chosen contract-surface name, e.g. parseFileChanges"),
  harnesses: z
    .array(z.object({ engine: z.string(), support: z.enum(["full-diff", "paths-only", "none"]), notes: z.string() }))
    .describe("per-harness support assessment"),
  summary: z.string(),
});

const fixturesSchema = z.object({
  fixtures: z
    .array(z.object({ engine: z.string(), path: z.string(), source: z.string() }))
    .describe("committed fixture files and which real run they came from"),
  enginesMissing: z.array(z.string()).default([]).describe("engines we could not find real transcripts for"),
  summary: z.string(),
});

const polishSchema = z.object({
  polished: z.boolean().describe("true when the final pass found nothing left to fix"),
  changesMade: z.array(z.string()).default([]),
  summary: z.string(),
});

const landSchema = z.object({
  committed: z.boolean(),
  commitHashes: z.array(z.string()).default([]),
  summary: z.string(),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  spec: specSchema,
  fixtures: fixturesSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
  polish: polishSchema,
  land: landSchema,
});

const SPEC_PROMPT = `You are designing a cross-harness capability for the smithers repo (you are inside its source checkout).

GOAL: a STANDARDIZED, optional file-change surface on the agent contract so every CLI harness (Claude Code, Codex, Kimi, Cursor, Gemini, Amp, OpenCode/others where feasible) reports file edits in one normalized shape, rich enough for the run UI to render clickable per-file diffs.

Read the current reality first:
- packages/agents/src/agent-contract/ and packages/agents/src/capability-registry/ (how optional capabilities are declared today)
- packages/agents/src/BaseCliAgent/ (AgentCliActionKind, parseHelpers toolKindFromName)
- packages/agents/src/CodexAgent.js (file_change item -> changes[{path,kind}], no diff content)
- packages/agents/src/ClaudeCodeAgent.js (tool_use blocks carry full Edit/Write input -> diff is reconstructible)
- packages/agents/src/KimiAgent.js and the other *Agent.js adapters
- packages/gateway-ui/src/nodeChat.ts (describeFileChange collapses to a note) and NodeChatStream.tsx
- packages/ui/src/diff-hunks.tsx + diff.ts (existing unified-diff renderer; NOTE it may carry rename damage where the component/type is literally named "ln" - flag but do not depend on fixing it here)

Design and WRITE a spec document to research/file-change-contract.md covering:
1. The normalized type (e.g. AgentFileChange { path, kind: created|modified|deleted|renamed, oldPath?, unifiedDiff?, source: reported|reconstructed }) and where it lives.
2. The optional capability surface on the agent interface (how an adapter declares it can normalize file changes from its raw stream events; graceful absence for harnesses that cannot).
3. How normalized changes ride on the existing action event (detail.fileChanges) without breaking current consumers.
4. Per-harness plan: full-diff (reconstruct from tool input), paths-only (report paths, diff deferred to snapshot fallback), none.
5. e2e test strategy: committed REAL transcript fixtures per engine, replayed through each adapter, asserting the normalized output. Secrets must be scrubbed.
6. UI: nodeChat emits a file_change transcript item carrying files + optional patch; NodeChatStream renders a clickable chip expanding the shared diff renderer.
Keep the spec tight and implementation-ready. Return the structured output.`;

export default smithers((ctx) => {
  const spec = ctx.latest("spec", "fcc:spec") as z.infer<typeof specSchema> | undefined;
  const fixtures = ctx.latest("fixtures", "fcc:fixtures") as z.infer<typeof fixturesSchema> | undefined;
  const validate = ctx.latest("validate", "fcc:validate") as
    | { allPassed?: boolean; failingSummary?: string | null }
    | undefined;

  const hasValidated = validate !== undefined;
  const validationPassed = hasValidated && validate.allPassed !== false;
  const gate = reviewGate(ctx, "fcc:review-moderator");
  const validateRounds = ctx.iterationCount("validate", "fcc:validate");
  const reviewRounds = ctx.iterationCount("reviewSynthesis", "fcc:review-moderator");
  const latestRaw = (rows: unknown[] | undefined) =>
    rows?.filter((row): row is Record<string, unknown> => Boolean(row)).at(-1);
  const paired =
    validateRounds === reviewRounds &&
    validateRounds > 0 &&
    latestRaw(ctx.outputs.validate)?.iteration === latestRaw(ctx.outputs.reviewSynthesis)?.iteration;
  const done = paired && validationPassed && gate.approved;
  const polish = ctx.latest("polish", "fcc:polish") as z.infer<typeof polishSchema> | undefined;

  const feedbackParts: string[] = [];
  if (validate && !validationPassed && validate.failingSummary) {
    feedbackParts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  if (paired && gate.feedback) {
    feedbackParts.push(`REVIEW PANEL REJECTED:\n${gate.feedback}`);
  }
  const feedback = feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null;

  const implementPrompt =
    spec && fixtures
      ? `${ctx.input.prompt}

SPEC: read ${spec.specPath} first; it is the design of record (capability name: ${spec.capabilityName}).
Per-harness support assessment:
${spec.harnesses.map((h) => `- ${h.engine}: ${h.support} (${h.notes})`).join("\n")}

REAL TRANSCRIPT FIXTURES (already committed, use them to drive e2e tests; never fabricate transcript content):
${fixtures.fixtures.map((f) => `- ${f.engine}: ${f.path} (from ${f.source})`).join("\n")}
Engines with no real fixture available: ${fixtures.enginesMissing.join(", ") || "none"} - for these, implement the adapter path only if the vendor stream format is verifiable from the vendor binary/docs, otherwise leave it unimplemented with the capability absent.

DELIVERABLES:
1. The normalized type + optional capability on the agent contract (packages/agents), exported through the public surface.
2. Implementations in every harness the spec marks full-diff or paths-only. Do not guess undocumented stream formats.
3. Fixture-driven e2e tests in packages/agents replaying each real transcript through its adapter and asserting normalized file changes (paths, kinds, and diffs where support=full-diff).
4. packages/gateway-ui: nodeChat.ts emits a dedicated file_change transcript item (files + optional unified diff) instead of a bare note; NodeChatStream renders it clickable, expanding the shared diff renderer from smthrs/ui. Add/extend tests.
5. Run pnpm typecheck for touched packages, the touched package test suites, and pnpm docs checks if you touch public docs. Public surface changes need docs: update docs/ and run pnpm docs:llms.
Preserve unrelated working-copy changes; never blanket-stage.`
      : ctx.input.prompt;

  return (
    <Workflow name="file-change-contract">
      <UI entry="../ui/file-change-contract.tsx" title={"File-change contract"} />
      <Sequence>
        <Task id="fcc:spec" output={outputs.spec} agent={implementer}>
          {SPEC_PROMPT}
        </Task>

        {spec ? (
          <Task id="fcc:fixtures" output={outputs.fixtures} agent={implementer}>
            {`Harvest REAL CLI-agent transcripts from this workspace as e2e fixtures for the file-change contract spec at ${spec.specPath}.

Sources (this repo IS the smithers source checkout; run its CLI as \`bun apps/cli/src/index.js ...\`):
- \`bun apps/cli/src/index.js ps --all\` / \`list_runs\` to find recent runs per engine.
- \`bun apps/cli/src/index.js events <runId> --raw\` for raw agent chunks (AgentEvent payloads carry the original CLI stream lines).
- The workspace DB(s) under .smithers/ if the CLI view is insufficient.

REQUIREMENTS:
- At minimum one real transcript each for claude-code, codex, and kimi that contains file edits (Edit/Write tool_use for claude, file_change items for codex, kimi's equivalent). Add any other engines you find real data for (cursor, gemini, amp, ...). Record engines you could NOT find as enginesMissing.
- Trim each transcript to a focused window around the file-change events (keep enough surrounding turns to exercise the parser realistically; target < 200 lines per fixture).
- SCRUB secrets: API keys, tokens, absolute home paths can stay generic; verify with a grep for key-like strings before committing.
- Write fixtures under packages/agents/tests/fixtures/cli-transcripts/<engine>/<name>.jsonl with a small README noting provenance (run id, date, engine version if recorded).
- Commit nothing yet; just leave files in the working tree. Return the structured output listing every fixture and its source run.`}
          </Task>
        ) : null}

        {spec && fixtures ? (
          <ValidationLoop
            idPrefix="fcc"
            prompt={implementPrompt}
            implementAgents={implementer}
            validateAgents={agents.midTier}
            reviewAgents={panelists}
            synthesizeReview
            feedback={feedback}
            done={done}
            maxIterations={4}
          />
        ) : null}

        {done ? (
          <Task id="fcc:polish" output={outputs.polish} agent={polishReviewer}>
            {`The file-change contract feature is implemented: validation passed and the review panel approved. You are the FINAL polish reviewer.

Review every change end to end (jj st / jj diff). Check: contract naming and docs, fixture provenance README accuracy, secret scrubbing in fixtures, dead code, missing edge-case tests (renames, deletes, binary files, empty diffs), UI diff rendering in both themes. Apply small safe polish edits directly and re-run the relevant tests. Do NOT restructure.

Return polished=true when nothing is left.`}
          </Task>
        ) : null}

        {done && polish?.polished ? (
          <Task id="fcc:land" output={outputs.land} agent={implementer}>
            {`Land the file-change contract work. Use jj st / jj diff to see exactly what this feature touched; commit ONLY those files (spec doc, fixtures + README, packages/agents, packages/gateway-ui, packages/ui if touched, docs). Preserve unrelated concurrent changes; never blanket-stage. Use atomic emoji conventional commits. Run the touched-package tests once more before committing. Do NOT push. Return commit hashes.`}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
