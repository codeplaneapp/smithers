// smithers-source: user
// smithers-display-name: Finish Campaigns
/** @jsxImportSource smithers-orchestrator */
import { OpenCodeAgent, UI, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";

// Lane agents. The shared-UI lane runs OpenCode with Kimi K3 (explicit operator
// choice, overriding the standing no-kimi default); Sonnet is a runtime
// fallback invoked only if every Kimi attempt fails. The testing-framework lane
// is Codex sol-first; while codex-paused.json is active (weekly quota, resets
// 2026-07-25T03:30Z) the chain is Fable alone, per the sol->fable seat rule.
const opencodeKimi = new OpenCodeAgent({ model: "kimi-for-coding/k3", yolo: true });
const uiLaneAgents = [opencodeKimi, providers.claudeSonnet];
const tfLaneAgents = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true },
  [providers.claude],
);
const pushAgents = [providers.claude];
const reportAgents = [providers.claudeSonnet];

export const inputSchema = z.object({
  tfRunId: z.string().trim().min(1).default("tf-final-replay-identity-20260718"),
  uiRunId: z.string().trim().min(1).default("run-1784453941803"),
  maxIterations: z.number().int().min(1).max(30).default(12),
});

const workSchema = z.object({
  summary: z.string(),
  actionsTaken: z.array(z.string()).default([]),
  blocked: z.boolean().default(false),
  blockReason: z.string().nullable().default(null),
});

const verifySchema = z.object({
  done: z.boolean(),
  remaining: z.array(z.string()).default([]),
  evidence: z.string(),
});

const pushApprovalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable().default(null),
});

const pushSchema = z.object({
  pushed: z.boolean(),
  summary: z.string(),
});

const reportSchema = z.object({
  summary: z.string(),
  tfDone: z.boolean(),
  uiDone: z.boolean(),
  followUps: z.array(z.string()).default([]),
});

const { Workflow, Task, Sequence, Parallel, Loop, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  tfWork: workSchema,
  tfVerify: verifySchema,
  uiWork: workSchema,
  uiVerify: verifySchema,
  pushApproval: pushApprovalSchema,
  push: pushSchema,
  report: reportSchema,
});

const OPS_CONTRACT = `
OPERATING CONTRACT (both lanes of this workflow share the repo — follow exactly):
- Repo: /Users/williamcory/smithers, jj-colocated with git. Use "jj st" / "jj diff" for working-copy truth.
- A sibling lane works this repo concurrently. Touch only files in your campaign's scope. Never rebase or rewrite history you did not create this iteration.
- Commit only files you yourself changed, with explicit paths; afterwards verify with "git show --name-only HEAD" that no stale index entries were swept in.
- Main moves are CAS-only: "git update-ref refs/heads/main <new-sha> <expected-old-sha>". After every main move, re-verify every prior landing with "git merge-base --is-ancestor <sha> main". Recover an orphaned landing via linear-chain cherry-pick in a scratch worktree, then CAS update-ref, then "jj git import".
- NEVER run "smithers down" or "smithers gateway stop" — the gateway is shared and that kills sibling runs. Use "smithers cancel <specific-run-id>" only if you must stop something you started.
- Resume quota-parked runs with the "env -u ANTHROPIC_API_KEY" prefix (an unfunded env key silently breaks claude agents).
- Do NOT push to origin. Pushing is a separate human-approved step of this workflow.
- todo.md at the repo root is the living checklist. Tick "[ ]" -> "[x]" ONLY inside YOUR campaign's section, via surgical single-line edits. Never rewrite the whole file.
- If blocked, uncertain, or about to do anything irreversible: run "smithers ask-human \\"<question>\\"" and wait for the answer. Never guess.
- This task re-runs in a loop. Do the highest-value next chunk well instead of everything at once; a verifier decides when the campaign is done. If the ONLY remaining work is waiting on a parked or mid-flight run, poll "smithers status <run-id>" every ~5 minutes for up to ~40 minutes inside this task, then return with blocked=true and the reason.
`.trim();

function remainingBlock(remaining: string[] | undefined): string {
  if (!remaining || remaining.length === 0) {
    return "First iteration: start from the top of your campaign section in todo.md.";
  }
  return `The previous verification pass left these items open — work them first:\n${remaining.map((item) => `- ${item}`).join("\n")}`;
}

function tfWorkPrompt(tfRunId: string, remaining: string[] | undefined): string {
  return `
You are the operator lane finishing campaign 1, the "Testing-framework campaign" section of todo.md.
Read it first: sed -n '1,51p' /Users/williamcory/smithers/todo.md

${remainingBlock(remaining)}

The work, in priority order:
1. Drive run ${tfRunId} (workflow implement-testing-framework-e2e) to completion. Check "smithers status ${tfRunId}". If it is quota-parked with a dead engine, resume it exactly like this:
   env -u ANTHROPIC_API_KEY smithers up .smithers/workflows/implement-testing-framework-e2e.tsx --run-id ${tfRunId} --resume true --force true -d
   Remaining in-run path: fable-as-sol readiness re-review -> improvement rounds as needed -> consensus reviews -> assess -> final-verify-and-summarize.
2. The last substantive blocker sol raised: root "pnpm test" is red in 8 workspaces (including the apps/kimi-benchmarks-site UI-inventory gate entry and the missing @smithers-orchestrator/microsandbox workspace link, both judged outside the target diff). If the run's improvement rounds don't clear them, fix and land these root-gate failures directly.
3. After the run finishes: verify the final summarize output and jj log; confirm every accepted round is committed (no uncommitted packages/testing or e2e/testing-framework work). Then commit the workflow-file improvements in .smithers/workflows/implement-testing-framework-e2e.tsx (UI wiring + import, reusePlanRunId regex fix, IMPL_LONG 60m lane timeouts, ?.issues?.some guards, luna->fable implementation lanes). Before landing workflow-file changes, run "pnpm typecheck" and the .smithers workflow tests (implement-testing-framework-e2e-workflow.test.ts must pass).
4. The temporary sol->fable reviewer swap in that workflow file reverts only when the codex weekly window resets on 2026-07-25. If today is earlier, leave that item unchecked and add a dated note instead.
5. Smithers defects surfaced by the campaign (work these only when nothing above is actionable, one at a time, root-cause fix + tests, each committed separately): quota-park leaves a dead engine so nothing auto-resumes at window reset; issue #1348 snapshot input recorded pre-validation; issue #1349 control-plane DB unbounded growth; the DB-swap operational trap (open handles pin a renamed DB); gateway mounts workflow UIs only at boot.

${OPS_CONTRACT}

Return: summary of what you did this iteration, actionsTaken (one string per concrete action), blocked (true only if you can make no progress at all), blockReason.
`.trim();
}

function tfVerifyPrompt(tfRunId: string, lastWork: unknown): string {
  return `
You are the verifier for campaign 1, the "Testing-framework campaign" section of /Users/williamcory/smithers/todo.md (lines 1-51). The worker just reported: ${JSON.stringify(lastWork ?? null)}

Independently verify the repo and run state — do not trust the report. For each item in that todo section, check with real commands ("smithers status ${tfRunId}", "smithers output", git/jj log, running the named tests). Tick verified items in todo.md if the worker forgot.

done=true ONLY when every item in the section is complete, with these allowed deferrals:
- the sol->fable reviewer-swap revert may stay open until 2026-07-25 if a dated note is in place;
- a defect item counts as complete only when a root-cause fix with tests is landed on local main; if genuinely feature-sized, a filed issue with root-cause analysis plus an explicit deferral note in todo.md may substitute — call that out in evidence.

Return: done, remaining (actionable, specific items still open — empty when done), evidence (the commands you ran and what they showed).
`.trim();
}

function uiWorkPrompt(uiRunId: string, remaining: string[] | undefined): string {
  return `
You are the operator lane finishing campaign 2, the "Shared UI library campaign" section of todo.md.
Read it first: sed -n '52,111p' /Users/williamcory/smithers/todo.md

${remainingBlock(remaining)}

The work, in priority order:
1. Finish the merge train, run ${uiRunId} (workflow land-shared-ui). Check "smithers status ${uiRunId}". The last lane merge-run-1784418919774-0-workflow-graph was quota-parked until 2026-07-19T20:50Z. If the engine died with the park, resume:
   smithers up .smithers/workflows/land-shared-ui.tsx --run-id ${uiRunId} --resume true -d
   (prefix env -u ANTHROPIC_API_KEY). After it lands, the run auto-runs the land-ci gate (typecheck + both UI package suites + check-ui-architecture/docs/llms), an opus fix pass if red, and a landing report. Watch it to completion.
2. End-of-train verification: re-run "git merge-base --is-ancestor <sha> main" for ALL 10 component landings (CollapsiblePanel, DiffHunks + diff domain, FileTree, Markdown, MarkdownEditor, NodeOutputCard, PierreDiffView, StageStrip, Terminal, WorkflowGraph — get the SHAs from the landing report / run outputs). Recover any orphan per the CAS recipe in the operating contract.
3. Verify the dependency-adding lanes (@xterm/xterm, xyflow/dagre, @pierre/diffs, milkdown) refreshed BOTH pnpm-lock.yaml and bun.lock, and that "pnpm docs:llms" ran (check-llms green).
4. RECOVERY REQUIRED — the campaign's own tooling is MISSING from the working copy and from main's tree, although todo.md says it existed uncommitted: .smithers/workflows/shared-ui-library.tsx, .smithers/workflows/land-shared-ui.tsx, their .smithers/ui/*.tsx counterparts, .smithers/tests/*.test.tsx, and the .smithers/package.json test registration. Commits touching those paths exist off-main: 8368bae5b3, 46e412d779, fc41f8ab2c (find more with git log --all). Inspect them with "git show <sha> --stat", recover the newest good versions, make the tests green (cd .smithers && bun test --preload ./preload.ts <files>; node scripts/check-smithers-test-script.mjs at the root), and commit them.
5. In the recovered shared-ui-library.tsx, fix the two workflow defects batch 1 exposed: (a) the batch loop advanced to merge/audit while lanes were still pending or parked, and discovery in later batches returned zero tickets instead of re-ticketing unfinished lanes — gate the merge queue and audit on all lanes settled, or make discovery re-ticket unlanded work; (b) both workflows' merge prompts must require CAS main moves and prior-landing ancestry re-verification before advancing main.
6. Make sure the "Batch 2+ mission gaps" subsection accurately reflects reality (consumer migration counts, missing primitives, facade drift, the 94 allowlisted baseline violations). Do NOT launch a batch-2 shared-ui-library run without asking first via "smithers ask-human".
7. The push item stays unchecked — pushing to origin is a separate approved step of this workflow.

${OPS_CONTRACT}

Return: summary, actionsTaken, blocked, blockReason.
`.trim();
}

function uiVerifyPrompt(uiRunId: string, lastWork: unknown): string {
  return `
You are the verifier for campaign 2, the "Shared UI library campaign" section of /Users/williamcory/smithers/todo.md (lines 52-111). The worker just reported: ${JSON.stringify(lastWork ?? null)}

Independently verify — do not trust the report. Check with real commands: "smithers status ${uiRunId}" and its landing report; "git merge-base --is-ancestor <sha> main" for all 10 component landings; both lockfiles touched by the dependency-adding lanes; check-llms/docs state; the recovered tooling files exist on main with their tests registered and green (node scripts/check-smithers-test-script.mjs); the two workflow-defect fixes are present in the recovered workflow sources. Tick verified items in todo.md if the worker forgot.

done=true ONLY when the merge train has landed and been ancestry-verified, lockfiles and docs bundles check out, the campaign tooling is recovered/committed with green registered tests, and both workflow defects are fixed. Allowed deferrals: the origin push (gated by this workflow) and the batch-2 relaunch (needs human approval).

Return: done, remaining (actionable specifics — empty when done), evidence (commands run and results).
`.trim();
}

function pushPrompt(): string {
  return `
Local main in /Users/williamcory/smithers is ahead of origin/main and a human just approved pushing it. Push safely:
1. Review "git log origin/main..main --oneline" and "git log origin/main..main --stat | head -200". If you see commits that look contaminated (mass unrelated file sweeps) or unfinished work, DO NOT push — return pushed=false with the reason.
2. Re-verify the 10 shared-UI landing SHAs (from the land-shared-ui landing report / todo.md) are ancestors of main: git merge-base --is-ancestor <sha> main.
3. Push with "git push origin main". Never force-push.
Return pushed (boolean) and a summary of what was pushed or why you refused.
`.trim();
}

export default smithers((ctx) => {
  const tfRunId = ctx.input?.tfRunId?.trim() || "tf-final-replay-identity-20260718";
  const uiRunId = ctx.input?.uiRunId?.trim() || "run-1784453941803";
  const maxIterations = ctx.input?.maxIterations ?? 12;

  const tfVerify = ctx.latest("tfVerify", "tf-verify") as z.infer<typeof verifySchema> | undefined;
  const uiVerify = ctx.latest("uiVerify", "ui-verify") as z.infer<typeof verifySchema> | undefined;
  const tfWork = ctx.latest("tfWork", "tf-work") as z.infer<typeof workSchema> | undefined;
  const uiWork = ctx.latest("uiWork", "ui-work") as z.infer<typeof workSchema> | undefined;
  const approval = (ctx.outputs.pushApproval ?? []).at(-1) as z.infer<typeof pushApprovalSchema> | undefined;
  const pushRow = (ctx.outputs.push ?? []).at(-1) as z.infer<typeof pushSchema> | undefined;

  const tfDone = tfVerify?.done === true;
  const uiDone = uiVerify?.done === true;

  const laneState = (label: string, done: boolean, verify: z.infer<typeof verifySchema> | undefined) =>
    `${label}: ${done ? "DONE" : verify ? `not done — remaining: ${verify.remaining.join("; ") || "(unspecified)"}` : "no verification yet"}`;

  return (
    <Workflow name="finish-campaigns">
      <UI entry="../ui/finish-campaigns.tsx" title={"Finish Campaigns"} />
      <Sequence>
        <Parallel>
          <Sequence>
            <Loop id="tf-loop" until={tfDone} maxIterations={maxIterations}>
              <Sequence>
                <Task id="tf-work" output={outputs.tfWork} agent={tfLaneAgents} timeoutMs={150 * 60_000}>
                  {tfWorkPrompt(tfRunId, tfVerify?.remaining)}
                </Task>
                <Task id="tf-verify" output={outputs.tfVerify} agent={tfLaneAgents} timeoutMs={60 * 60_000}>
                  {tfVerifyPrompt(tfRunId, tfWork)}
                </Task>
              </Sequence>
            </Loop>
          </Sequence>
          <Sequence>
            <Loop id="ui-loop" until={uiDone} maxIterations={maxIterations}>
              <Sequence>
                <Task id="ui-work" output={outputs.uiWork} agent={uiLaneAgents} timeoutMs={150 * 60_000}>
                  {uiWorkPrompt(uiRunId, uiVerify?.remaining)}
                </Task>
                <Task id="ui-verify" output={outputs.uiVerify} agent={uiLaneAgents} timeoutMs={60 * 60_000}>
                  {uiVerifyPrompt(uiRunId, uiWork)}
                </Task>
              </Sequence>
            </Loop>
          </Sequence>
        </Parallel>
        <Approval
          id="push-approval"
          output={outputs.pushApproval}
          request={{
            title: "Push local main to origin?",
            summary: [
              laneState("Testing-framework lane", tfDone, tfVerify),
              laneState("Shared-UI lane", uiDone, uiVerify),
              "Approving pushes local main (15+ commits of shared-UI landings and campaign fixes) to origin/main after a final ancestry and contamination check. Denying skips the push; everything stays local.",
            ].join("\n"),
          }}
          onDeny="skip"
        />
        {approval?.approved === true ? (
          <Task id="push-main" output={outputs.push} agent={pushAgents} timeoutMs={20 * 60_000}>
            {pushPrompt()}
          </Task>
        ) : null}
        <Task id="final-report" output={outputs.report} agent={reportAgents} timeoutMs={10 * 60_000}>
          {`
Write the closing report for the finish-campaigns run over /Users/williamcory/smithers/todo.md.
Lane outcomes as recorded by the workflow:
- ${laneState("Testing-framework (campaign 1)", tfDone, tfVerify)}
- ${laneState("Shared-UI (campaign 2)", uiDone, uiVerify)}
- Push step: ${pushRow ? JSON.stringify(pushRow) : approval ? (approval.approved ? "approved, no result row" : "denied/skipped") : "not reached"}
Read todo.md and cross-check which boxes are actually ticked. Summarize what landed, what remains, and list concrete followUps (include the sol->fable reviewer-swap revert due 2026-07-25, the origin push if it was skipped, and the batch-2 shared-ui-library relaunch if still pending).
Return: summary, tfDone, uiDone, followUps.
`.trim()}
        </Task>
      </Sequence>
    </Workflow>
  );
});
