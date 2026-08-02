// smithers-source: authored
// smithers-display-name: Crash Recovery
/** @jsxImportSource smthrs */
/**
 * Finish the work interrupted by the 2026-07-01 ~23:55 machine crash, in
 * parallel lanes with approval gates on anything irreversible:
 *
 *  A. smithers repo (serialized: shared working tree):
 *     verify+commit the CLI next-steps guidance work, then assess the tsync
 *     branch state and (gated) push it.
 *  B. smithers4: verify + commit the Panel.js moderator fix (tests were green
 *     when the implementer died mid-typecheck).
 *  C. browser: resume the ddd (browser SDK) smithers run, babysit the wave.
 *  D. vercel-example: resume the smoke-fix-verify-1 run, babysit it.
 *  E. fable-review-smithers: find the detached review run, resume/summarize.
 *  F. plue CLI: assess the extracted repo, gate on "publish to npm?".
 */
import { createSmithers, Approval, Parallel, Sequence, Task } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

const reportSchema = z.object({
  lane: z.string(),
  ok: z.boolean(),
  summary: z.string(),
});

const pushPlanSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  pushCommands: z.array(z.string()),
});

const approvalSchema = z.object({ approved: z.boolean() });

const { Workflow, smithers, outputs } = createSmithers({
  report: reportSchema,
  tsyncPlan: pushPlanSchema,
  tsyncApproval: approvalSchema,
  plueApproval: approvalSchema,
});

const COMMON = [
  "You are one lane of a crash-recovery workflow. The machine crashed at 2026-07-01 23:55 local and killed every running agent; you are finishing one interrupted piece of work.",
  'Ground rules: never guess on ambiguous or destructive decisions — run `smithers ask-human "<question>"` and wait. Commit with explicit pathspecs only (never `git add -A`); the smithers repo working tree is shared. Commit messages: emoji + conventional commit + Co-Authored-By trailer.',
  "If a `smithers` binary is missing in a directory, use `bunx smthrs` there instead.",
].join("\n");

const latest = <T,>(rows: readonly T[]): T | undefined => (rows.length > 0 ? rows[rows.length - 1] : undefined);

export default smithers((ctx) => {
  const tsyncPlan = latest(ctx.outputs.tsyncPlan);
  const tsyncApproval = latest(ctx.outputs.tsyncApproval);
  const plueReport = latest(ctx.outputs.report.filter((r) => r.lane === "plue-assess"));
  const plueApproval = latest(ctx.outputs.plueApproval);

  return (
    <Workflow name="crash-recovery">
      <Parallel>
        {/* Lane A: smithers repo — serialized because both steps share the working tree */}
        <Sequence>
          <Task id="cli-suggestions-verify" output={outputs.report} agent={agents.midTier} timeoutMs={45 * 60_000}>
            {`${COMMON}

Lane "cli-suggestions": In /Users/williamcory/smithers a session had finished implementing "every CLI command emits what-to-suggest-next guidance" and died while its apps/cli test suite verification ran.
1. cd /Users/williamcory/smithers, run \`jj st\` to see the uncommitted changes. If there are no relevant uncommitted changes, report that and stop (ok=true).
2. Run \`pnpm typecheck\` and \`pnpm -C apps/cli test\`.
3. If green: commit ONLY the files belonging to this feature (explicit pathspecs) as an atomic commit, e.g. "✨ feat(cli): suggest next steps after every command", and push main (git pull --rebase first). If red: fix the failures if small, else report what is broken and do NOT commit.
Return lane="cli-suggestions".`}
          </Task>

          <Task id="tsync-assess" output={outputs.tsyncPlan} agent={agents.planning} timeoutMs={60 * 60_000}>
            {`${COMMON}

Lane "tsync": In /Users/williamcory/smithers the tsync orchestrator (TanStack sync REST+SSE integration, PR #485, bookmark tsync/integrate) died mid-verification. It had rebuilt its commit chain with \`git reset --hard b174f764b6\` plus an amended feat(sync)! commit and was running pnpm install + the CLI suite as the gate BEFORE a force-push that never happened.
1. cd /Users/williamcory/smithers. Map the current state: \`jj log -n 20\`, \`git log --oneline -15\`, where the tsync/integrate bookmark and PR #485 branch point, and whether the local rebuilt chain is intact.
2. Run the verification the orchestrator intended: \`pnpm install\`, \`pnpm typecheck\`, \`pnpm -C apps/cli test\` (plus package tests for the sync packages it touched).
3. Do NOT push anything. Return ok=true only if verification is green, a summary of the branch state and test results, and pushCommands = the exact commands a follow-up task should run to publish the branch (force-push of the bookmark / branch, NOT main unless that is genuinely what the chain is).`}
          </Task>

          {tsyncPlan && !tsyncApproval ? (
            <Approval
              id="approve-tsync-push"
              output={outputs.tsyncApproval}
              onDeny="skip"
              request={{
                title: "Force-push the rebuilt tsync branch?",
                summary: `${tsyncPlan.ok ? "Verification GREEN." : "Verification NOT green."} ${tsyncPlan.summary}\n\nPlanned commands:\n${tsyncPlan.pushCommands.join("\n")}`,
              }}
            />
          ) : null}

          {tsyncApproval?.approved && tsyncPlan?.ok ? (
            <Task id="tsync-push" output={outputs.report} agent={agents.implement} timeoutMs={20 * 60_000}>
              {`${COMMON}

Lane "tsync-push": The human approved publishing the rebuilt tsync branch. cd /Users/williamcory/smithers and execute exactly this plan, verifying each step:
${tsyncPlan.pushCommands.join("\n")}
Then confirm the remote state (gh pr view 485 if applicable). Return lane="tsync-push".`}
            </Task>
          ) : null}
        </Sequence>

        {/* Lane B: smithers4 Panel.js fix */}
        <Task id="panel-fix-commit" output={outputs.report} agent={agents.implement} timeoutMs={45 * 60_000}>
          {`${COMMON}

Lane "panel-fix": In /Users/williamcory/smithers4 a workflow agent had fixed a real smithers-core bug — <Panel>/<ReviewPanel> moderators synthesize blind when panelists are gated without deps / string children — in packages/components/src/components/Panel.js plus packages/components/tests/composite-coverage.test.jsx. Tests were green; it died during the final \`bunx tsc --noEmit\`.
1. cd /Users/williamcory/smithers4, \`jj st\` / \`git status\` to confirm the edits are still there.
2. Run \`pnpm -C packages/components test\` and the repo typecheck.
3. If green: commit ONLY those files (explicit pathspecs), e.g. "🐛 fix(components): Panel moderator no longer synthesizes without panelist outputs", pull --rebase, and push main. If anything is red, report and do not commit.
Return lane="panel-fix".`}
        </Task>

        {/* Lane C: browser DDD run */}
        <Task id="browser-ddd-resume" output={outputs.report} agent={agents.implement} timeoutMs={120 * 60_000}>
          {`${COMMON}

Lane "browser-ddd": In /Users/williamcory/browser a smithers DDD run was building an agentic-browser SDK. Wave-3 tickets (sdk-events, sdk-browser-api) plus three fresh Codex ticket workers were killed mid-implementation.
1. cd /Users/williamcory/browser, run \`smithers ps\` to find the run, then \`smithers inspect <run-id>\` to see its state.
2. Resume it: \`smithers up <workflow file> --run-id <id> --resume true --detach\` (find the workflow file under .smithers/workflows/). Completed nodes will be skipped; the two in-flight tickets re-attempt.
3. Babysit: poll \`smithers inspect\`/\`smithers tree\` every few minutes until the current wave finishes, the run completes, or it pauses on a gate. If it pauses on an approval or human question, use \`smithers ask-human\` to relay it.
Return lane="browser-ddd" with the run id and final/current status.`}
        </Task>

        {/* Lane D: vercel-example smoke run */}
        <Task id="vercel-smoke-resume" output={outputs.report} agent={agents.implement} timeoutMs={120 * 60_000}>
          {`${COMMON}

Lane "vercel-smoke": In /Users/williamcory/vercel-example a fixer agent had relaunched smoke run "smoke-fix-verify-1" (workflow .smithers/workflows/smithering-impl.tsx) with --detach and died while polling it; a just-spawned ticket implementer (walking-skeleton-summary-slice) also died.
1. cd /Users/williamcory/vercel-example, \`smithers ps\` — find smoke-fix-verify-1 (and any related runs).
2. If the run is resumable, resume it detached; if it is gone/corrupt, relaunch the same smoke run the fixer used.
3. Babysit to completion or a gate, same rules as other lanes. Report whether the smithering-impl smoke verification ultimately passes.
Return lane="vercel-smoke".`}
        </Task>

        {/* Lane E: fable-review-smithers detached run */}
        <Task id="fable-review-check" output={outputs.report} agent={agents.review} timeoutMs={30 * 60_000}>
          {`${COMMON}

Lane "fable-review": A session launched a detached smithers dynamic workflow "fable-review-smithers" (27 reviewer agents over disjoint package scopes) in /Users/williamcory/smithers, then died on a session limit before the crash.
1. cd /Users/williamcory/smithers, \`smithers ps\` — find that run.
2. If it finished: summarize its findings (smithers inspect / outputs). If it is paused/resumable: resume it detached and report. If it is dead beyond resume: say so — do NOT relaunch 27 reviewers without asking via \`smithers ask-human\`.
Return lane="fable-review".`}
        </Task>

        {/* Lane F: plue CLI publish decision */}
        <Sequence>
          <Task id="plue-assess" output={outputs.report} agent={agents.planning} timeoutMs={30 * 60_000}>
            {`${COMMON}

Lane "plue-assess": A session had extracted the plue CLI into a standalone repo (in a Claude scratchpad directory under /private/tmp/claude-501/, via an extract-cli-repo.ts script; an \`npm publish --dry-run\` of plue@0.1.0 had already passed in earlier work). It was waiting on the human to decide about making the repo public and publishing before it died.
1. Locate the extracted repo (search /private/tmp/claude-501/ and /Users/williamcory/plue for the extraction output; check /Users/williamcory/smithers4 session artifacts if needed).
2. Verify its state: package.json (name/version), does \`npm publish --dry-run\` still pass, secret scan clean.
3. Report ok=true if it is publish-ready, with its exact path. Do NOT publish anything.
Return lane="plue-assess".`}
          </Task>

          {plueReport && !plueApproval ? (
            <Approval
              id="approve-plue-publish"
              output={outputs.plueApproval}
              onDeny="skip"
              request={{
                title: "Publish plue CLI to npm (and make the repo public)?",
                summary: plueReport.summary,
              }}
            />
          ) : null}

          {plueApproval?.approved && plueReport?.ok ? (
            <Task id="plue-publish" output={outputs.report} agent={agents.implement} timeoutMs={30 * 60_000}>
              {`${COMMON}

Lane "plue-publish": The human approved publishing the extracted plue CLI. Using the repo located by the previous step (${plueReport.summary}), run \`npm publish\` (and push/make the repo public if a remote is configured). Verify the published package with \`npm view plue\`. Return lane="plue-publish".`}
            </Task>
          ) : null}
        </Sequence>
      </Parallel>
    </Workflow>
  );
});
