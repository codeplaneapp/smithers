// smithers-display-name: Rename npm package
// smithers-source: one-off — rename the published facade `smthrs` → `smthrs`
// via parallel Codex Luna sweep lanes over disjoint path scopes, then a sequential finalize
// lane (compat alias package, lockfiles, regenerated bundles, repo checks).
/** @jsxImportSource smthrs */
import { ClaudeCodeAgent, UI, createSmithers } from "smthrs";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

// Intentionally the literal old name — this is the string being renamed away.
const OLD_NAME = "smthrs";
const NEW_NAME = "smthrs";

// ── Schemas ──────────────────────────────────────────────────────────────────
const sweepSchema = z.object({
  lane: z.string(),
  status: z.enum(["done", "partial", "blocked"]).default("done"),
  filesChanged: z.number().int().default(0),
  residualHits: z.array(z.string()).default([]),
  notes: z.string().default(""),
});

const finalizeSchema = z.object({
  status: z.enum(["green", "residuals", "blocked"]).default("green"),
  checksPassed: z.array(z.string()).default([]),
  checksFailed: z.array(z.string()).default([]),
  residualHits: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const inputSchema = z.object({
  newName: z.string().default(NEW_NAME),
  maxConcurrency: z.number().int().min(1).max(6).default(4),
});

const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers({
  input: inputSchema,
  sweep: sweepSchema,
  finalize: finalizeSchema,
});

// ── Agents: Codex Luna primary (mechanical sweep work), Sonnet failover ──────
const luna = codexFirst(
  {
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [new ClaudeCodeAgent({ model: "claude-sonnet-5" })],
);

const SWEEP_TIMEOUT_MS = 30 * 60_000;
const FINALIZE_TIMEOUT_MS = 60 * 60_000;

const COMMON = (newName: string) =>
  `
We are renaming the published npm facade package "${OLD_NAME}" to "${newName}".
Repo root: this working tree. HARD SCOPE RULES for every lane:
- ONLY rename the facade specifier "${OLD_NAME}" (bare name and subpaths like "${OLD_NAME}/gateway-ui", "${OLD_NAME}/ui", "${OLD_NAME}/gateway-react", "${OLD_NAME}/jsx-runtime", "@jsxImportSource ${OLD_NAME}") to "${newName}"/same subpath.
- Do NOT touch the internal workspace scope "@${OLD_NAME}/*" (e.g. @smthrs/agents) — it stays as-is everywhere.
- Do NOT edit: node_modules, pnpm-lock.yaml, bun.lock, .smithers/worktrees/**, .smithers/workflows/.worktrees/**, apps/cli/ui-dist/**, any *.log, generated llms*.txt bundles (docs/generated output — they get regenerated later), dist/ or build artifacts.
- The CLI bin name "smithers" and the product name "Smithers" in prose stay unchanged. Only the npm package identifier changes. Prose like "npm install ${OLD_NAME}" or "bunx ${OLD_NAME}" DOES change to use "${newName}".
- Use \`rg -l --hidden -g '!node_modules' -g '!*.lock' '${OLD_NAME}'\` scoped to YOUR paths to find hits; verify with the same rg afterwards that only "@${OLD_NAME}/" scope hits remain in your scope.
- Do not run pnpm/bun install, generators, typecheck, or tests — a finalize lane handles all of that.
- Do not commit; leave changes in the working copy.
Return residualHits as the file paths in your scope that still contain the bare old specifier for a documented reason (with the reason in notes).
`.trim();

const LANES: Array<{ key: string; paths: string; extra: string }> = [
  {
    key: "packages",
    paths: "packages/**",
    extra: [
      `Additionally, in packages/smithers/package.json change "name" to the new name (keep the "smithers" bin key).`,
      `Do NOT create the compat alias package — the finalize lane does that.`,
    ].join("\n"),
  },
  {
    key: "apps-plugin",
    paths: "apps/** and claude-plugin/**",
    extra: `Includes agent prompts, session-hook text, and claude-plugin/lib/resolve-smithers-cli.mjs copies — keep all resolve-smithers-cli.mjs copies byte-identical to each other (check:local-smithers enforces this).`,
  },
  {
    key: "pack-examples",
    paths:
      ".smithers/** (excluding worktrees), examples/**, skills/**, scripts/**, e2e/**, benchmarks/**, and the root package.json",
    extra: `In .smithers/ui/*.tsx and workflow files, rewrite import specifiers only; behavior must be unchanged. Root package.json: update any scripts/text referencing the old facade name, not the repo name.`,
  },
  {
    key: "docs",
    paths:
      "docs/** (Mintlify source only), README.md, and research/** where they instruct installing/importing the package",
    extra: `Edit only docs SOURCE (.mdx/.md); never the generated llms bundles. Keep prose style; no em-dashes (check-docs gates on this).`,
  },
];

const FINALIZE = (newName: string) =>
  `
All parallel sweep lanes are done renaming "${OLD_NAME}" → "${newName}" in their scopes. Finish the migration:

1. Create a compat alias package at packages/smthrs-compat with "name": "${OLD_NAME}", version matching packages/smithers, that depends on "${newName}" (workspace:*) and re-exports its exact exports map (thin re-export files per subpath) plus the same bin. Add it to pnpm-workspace.yaml if needed. Its README should say it is a deprecated alias for "${newName}".
2. Follow the new-workspace-package checklist: add the package-configuration.mdx row, and any ui-architecture baseline additions the checks demand.
3. Refresh BOTH lockfiles: \`pnpm install\` then \`bun install --lockfile-only\`.
4. Regenerate: \`pnpm docs:llms\` and \`pnpm generate:init-pack\`.
5. Run and make green: \`pnpm check:local-smithers\`, \`pnpm typecheck\` (per-package if the recursive run masks failures), \`pnpm lint\`, and the docs checks. Fix residual bare "${OLD_NAME}" specifiers anywhere they break checks (never touching the "@${OLD_NAME}/*" scope).
6. Final audit: \`rg -l '${OLD_NAME}' -g '!node_modules' -g '!*.lock'\` and classify every remaining hit (scope package = fine, compat package = intentional, generated = regenerate, else fix).
Do NOT publish to npm and do NOT commit. Report checksPassed/checksFailed honestly.
`.trim();

export default smithers((ctx) => {
  const newName = ctx.input.newName;
  const sweeps = LANES.map((lane) => ctx.outputMaybe(outputs.sweep, { nodeId: `sweep-${lane.key}` }));
  const allSwept = sweeps.every((s) => s !== undefined);

  return (
    <Workflow name="rename-package">
      <UI entry="../ui/rename-package.tsx" title={"Rename npm package"} />
      <Sequence>
        <Parallel maxConcurrency={ctx.input.maxConcurrency}>
          {LANES.map((lane) => (
            <Task
              key={lane.key}
              id={`sweep-${lane.key}`}
              output={outputs.sweep}
              agent={luna}
              retries={2}
              timeoutMs={SWEEP_TIMEOUT_MS}
            >
              {[
                COMMON(newName),
                `YOUR LANE: "${lane.key}". Your path scope: ${lane.paths}. Touch nothing outside it.`,
                lane.extra,
                `Set lane="${lane.key}" in your output.`,
              ].join("\n\n")}
            </Task>
          ))}
        </Parallel>
        {allSwept ? (
          <Task id="finalize" output={outputs.finalize} agent={luna} retries={2} timeoutMs={FINALIZE_TIMEOUT_MS}>
            {[
              FINALIZE(newName),
              `Sweep lane reports:`,
              ...sweeps.map(
                (s, i) =>
                  `- ${LANES[i]!.key}: ${s?.status}; residuals: ${(s?.residualHits ?? []).join(", ") || "none"}; ${s?.notes ?? ""}`,
              ),
            ].join("\n")}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
