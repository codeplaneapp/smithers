// smithers-source: authored
// smithers-display-name: Verify Push Safety
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { Review, reviewOutputSchema } from "../components/Review";

/**
 * Verify Push Safety — a short, push-SAFE smithers workflow that validates the
 * audit-burndown hardening and confirms nothing is broken on origin after the
 * earlier rogue-agent-push incident.
 *
 *   gate (compute, deterministic) → review (independent agent, read-only) → verdict (compute)
 *
 * - The gate runs real commands: confirms origin has NO `burndown/*` branches,
 *   that local `main` matches `origin/main` (no divergence), and that
 *   `pnpm typecheck` + `pnpm lint` are green. Agents cannot fake the exit codes.
 * - The reviewer independently reads `.smithers/workflows/audit-burndown.tsx`
 *   and the recent git history and judges whether the push ban + push fence are
 *   sound. It is READ-ONLY and is itself under an absolute push ban.
 *
 *   smithers up .smithers/workflows/verify-push-safety.tsx
 *   smithers node verdict -r RUN
 */

const gateSchema = z.object({
  originHasBurndownBranches: z.boolean().default(false),
  rogueBranches: z.string().default(""),
  localMainSha: z.string().default(""),
  originMainSha: z.string().default(""),
  mainInSync: z.boolean().default(false),
  typecheckGreen: z.boolean().default(false),
  lintGreen: z.boolean().default(false),
  cleanWorkingTree: z.boolean().default(false),
  summary: z.string().default(""),
  output: z.string().default(""),
});

const verdictSchema = z.object({
  pushStateClean: z.boolean().default(false),
  hardeningApproved: z.boolean().default(false),
  overallPass: z.boolean().default(false),
  summary: z.string().default(""),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  gate: gateSchema,
  review: reviewOutputSchema,
  verdict: verdictSchema,
});

const reviewPrompt = [
  `Independently review the push-safety hardening of \`.smithers/workflows/audit-burndown.tsx\` (READ-ONLY — do not modify anything, and under NO circumstances run git push / gh / any remote write).`,
  ``,
  `Context: an earlier unattended run of that workflow had an agent wander off its scoped item and push ~11 commits to shared origin/main. The workflow was hardened to prevent recurrence.`,
  ``,
  `Confirm by reading the file (and \`git log --oneline -15 origin/main\` for context):`,
  `1. Every agent prompt (the per-item implement prompt AND the merge prompt) carries an explicit, emphatic absolute push ban (never git push / gh pr create / touch origin) and a stay-strictly-scoped rule (no chasing unrelated bugs/tangents).`,
  `2. The workflow itself never pushes — it only merges to LOCAL main.`,
  `3. There is a deterministic PUSH FENCE: a baseline task captures origin/main at start, and the oracle re-checks every iteration for any \`burndown/*\` branch on origin or any origin/main drift, halting at an approval on detection; and "done" requires no rogue push.`,
  ``,
  `Approve only if all three hold and you see no remaining hole that would let an agent silently push to origin. Otherwise reject with the specific gap and a concrete fix.`,
].join("\n");

export default smithers((ctx) => {
  const gate = ctx.outputMaybe(outputs.gate, { nodeId: "gate" });
  const reviews = (ctx.outputs.review ?? []) as Array<z.infer<typeof reviewOutputSchema> & { nodeId?: string }>;
  const reviewApproved = reviews.some((r) => r.approved === true);
  const pushStateClean =
    gate !== undefined &&
    gate.originHasBurndownBranches === false &&
    gate.mainInSync === true &&
    gate.typecheckGreen === true &&
    gate.lintGreen === true &&
    gate.cleanWorkingTree === true;

  return (
    <Workflow name="verify-push-safety">
      <Sequence>
        {/* 1. DETERMINISTIC GATE — prove the push state is clean. */}
        <Task id="gate" output={outputs.gate}>
          {async () => {
            const { spawnSync } = await import("node:child_process");
            const run = (cmd: string, timeout = 600_000) => {
              const res = spawnSync("bash", ["-lc", cmd], {
                cwd: process.cwd(),
                encoding: "utf8",
                timeout,
                maxBuffer: 64 * 1024 * 1024,
                env: process.env,
              });
              return {
                code: typeof res.status === "number" ? res.status : null,
                out: `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim(),
              };
            };
            run("git fetch -q origin main");
            const rogue = run("git ls-remote --heads origin 'burndown/*'").out.trim();
            const localMain = run("git rev-parse main").out.trim();
            const originMain = run("git rev-parse origin/main").out.trim();
            const dirty = run("git status --porcelain").out.trim();
            const tc = run("pnpm typecheck", 600_000);
            const lint = run("pnpm lint", 600_000);
            const originHasBurndownBranches = rogue.length > 0;
            const mainInSync = localMain.length > 0 && localMain === originMain;
            const typecheckGreen = tc.code === 0;
            const lintGreen = lint.code === 0;
            return {
              originHasBurndownBranches,
              rogueBranches: rogue.slice(-2000),
              localMainSha: localMain,
              originMainSha: originMain,
              mainInSync,
              typecheckGreen,
              lintGreen,
              cleanWorkingTree: dirty.length === 0,
              summary: `origin burndown/* branches: ${originHasBurndownBranches ? "PRESENT ⚠️" : "none ✓"}; main↔origin: ${mainInSync ? "in sync ✓" : "DIVERGED ⚠️"}; typecheck ${typecheckGreen ? "✓" : "✗"}; lint ${lintGreen ? "✓" : "✗"}`,
              output: `typecheck(exit ${tc.code}):\n${tc.out.slice(-2500)}\n\nlint(exit ${lint.code}):\n${lint.out.slice(-2500)}`,
            };
          }}
        </Task>

        {/* 2. INDEPENDENT REVIEW — read-only agent judges the hardening. */}
        <Review idPrefix="hardening:review" prompt={reviewPrompt} agents={[agents.smart]} />

        {/* 3. VERDICT — combine the deterministic gate and the review. */}
        <Task id="verdict" output={outputs.verdict}>
          {{
            pushStateClean,
            hardeningApproved: reviewApproved,
            overallPass: pushStateClean && reviewApproved,
            summary: `push-state ${pushStateClean ? "CLEAN" : "NOT-CLEAN"} (${gate?.summary ?? "gate pending"}); hardening ${reviewApproved ? "APPROVED" : "not-yet-approved"} by review.`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
