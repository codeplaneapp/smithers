// smithers-display-name: Agentic UI adopt-product Fix Round
/** @jsxImportSource smthrs */
import { ClaudeCodeAgent, OpenCodeAgent, Sequence, Task, UI, createSmithers } from "smthrs";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";
import { MULTI_ROOT, reviewSchema, validationSchema } from "./build-agentic-ui-library";

// Close Sol's five cross-seat findings on Multi's adopt-product lane under the
// program's scope-locked convergence contract, then obtain Sol's re-approval.
// This is the final open item of the agentic UI program.

const FROZEN_FINDINGS = [
  "[major] Declared adoption scope is incomplete — the landed diff leaves src/files and src/byok untouched, uses Artifact only in HtmlPageCard and OpenInChat only in notifications/approvals, and adopts TestStatus rather than TestResults; the Commit deferral overlooks the real file-draft commit result (a commit SHA with known message/path). Implement the named surface adoptions or explicitly justify each incompatible surface in your summary with concrete evidence a reviewer can verify.",
  "[major] Eval lifecycle states lose their honest raw meaning — src/evals/EvalsCanvas.tsx maps queued/waiting to todo and cancelled to skipped, and the raw fallback label was removed. Restore honest states: distinct presentations (or preserved raw labels) for queued vs waiting vs cancelled.",
  "[major] Terminal transport states are presented as false sandbox states — src/terminal/TerminalSession.tsx maps idle→ready, replaying→provisioning, reconnecting→disconnected, closed→destroyed. Preserve the precise socket status alongside the shared anatomy or map only semantically equivalent states; never claim sandbox lifecycle facts from transport changes.",
  "[major] Approval submission state is not bound to Confirmation — src/approvals/ApprovalsCanvas.tsx renders state=requested even while actingId marks an approve/deny RPC in flight, the live region keeps announcing 'Waiting for approval' instead of Approving/Denying, and there is no failed-submission state. Bind the shared Confirmation state machine to the real mutation direction and failure state.",
  "[minor] ChangeSummary jj accessibility semantics — both VCS surfaces omit vcs={tree.backend} so jj changes announce as git diffs, and VcsCanvas nests ChangeSummary's div root inside a span (invalid HTML). Pass the backend and use a valid parent element.",
].join("\n\n");

const inputSchema = z.object({
  maxIterations: z.number().int().min(1).max(3).default(2),
});

const reportSchema = z.object({
  success: z.boolean(),
  solApproved: z.boolean(),
  attempts: z.number().int().min(0),
  summary: z.string().min(20),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  aguiImplFix: z.object({
    laneId: z.literal("adopt-product"),
    status: z.enum(["implemented", "partial", "blocked"]),
    summary: z.string().min(20),
    filesChanged: z.array(z.string()).min(1),
    commandsRun: z.array(z.string()).default([]),
  }),
  aguiValidation: validationSchema,
  aguiReview: reviewSchema,
  aguiFixReport: reportSchema,
});

const kimiImplementMulti = [
  new OpenCodeAgent({ model: "kimi-for-coding/k3", cwd: MULTI_ROOT }),
  new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: MULTI_ROOT }),
];
const validateChainMulti = [
  new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: MULTI_ROOT }),
  new ClaudeCodeAgent({ model: "claude-fable-5", cwd: MULTI_ROOT }),
];
const solChainMulti = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true, cwd: MULTI_ROOT },
  [new ClaudeCodeAgent({ model: "claude-fable-5", cwd: MULTI_ROOT })],
);

type RawRow = Record<string, unknown>;
function rows(ctx: any, channel: string): RawRow[] {
  const value = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(value) ? value.filter((row): row is RawRow => typeof row === "object" && row !== null) : [];
}
function version(row: RawRow): number {
  const iteration = Number(row.iteration);
  return Number.isFinite(iteration) ? iteration : 0;
}
function latest(list: RawRow[]): RawRow | undefined {
  return list.reduce<RawRow | undefined>(
    (best, row) => (!best || version(row) >= version(best) ? row : best),
    undefined,
  );
}

export default smithers((ctx) => {
  const input = inputSchema.parse({ maxIterations: ctx.input.maxIterations ?? 2 });
  const impl = latest(rows(ctx, "aguiImplFix"));
  const validation = latest(rows(ctx, "aguiValidation").filter((row) => row.laneId === "adopt-product"));
  const review = latest(rows(ctx, "aguiReview").filter((row) => row.laneId === "adopt-product" && row.seat === "sol"));
  const validationCurrent = impl !== undefined && validation !== undefined && version(validation) === version(impl);
  const reviewCurrent = validationCurrent && review !== undefined && version(review) === version(validation);
  const done =
    impl?.status === "implemented" &&
    validationCurrent &&
    validation?.allPassed === true &&
    reviewCurrent &&
    review?.approved === true;
  const attempts = rows(ctx, "aguiImplFix").length;

  const feedback = [
    impl && impl.status !== "implemented"
      ? `IMPLEMENTATION ${String(impl.status).toUpperCase()}:\n${String(impl.summary ?? "")}`
      : "",
    validationCurrent && validation?.allPassed === false
      ? `VALIDATION FAILED:\n${String(validation.failingSummary ?? validation.summary ?? "")}`
      : "",
    reviewCurrent && review?.approved === false ? `SOL RE-REVIEW NOT LGTM:\n${String(review.feedback ?? "")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <Workflow name="agui-adopt-product-fix">
      <UI entry="../ui/agui-adopt-product-fix.tsx" title="adopt-product Fix Round" />
      <Sequence>
        <Loop id="fix-loop" until={done} maxIterations={input.maxIterations} onMaxReached="return-last">
          <Sequence>
            <Task
              id="fix-implement"
              output={outputs.aguiImplFix}
              agent={kimiImplementMulti}
              retries={2}
              timeoutMs={90 * 60_000}
              heartbeatTimeoutMs={15 * 60_000}
            >
              {[
                `Close Sol's cross-seat findings on Multi's adopt-product lane in ${MULTI_ROOT}. Return laneId=adopt-product exactly.`,
                `THE FROZEN FINDINGS LIST (fix exactly these; anything else is out of scope):\n${FROZEN_FINDINGS}`,
                `Shared-tree rules for ${MULTI_ROOT} (jj-colocated, carries unrelated uncommitted work that MUST be preserved): jj st / jj diff are truth; commit ONLY your own files with explicit pathspecs; NEVER git add -A / commit -a / stash / rebase / --amend. Multi must not add new heavy deps or duplicate wrappers; Zustand-only state; honest pending/error states; real tests.`,
                "Definition of done: every finding closed with focused tests (red before, green after), pnpm check:ui-architecture + pnpm typecheck green, the focused adoption suite green, work committed via jj with explicit pathspecs.",
                feedback ? `Previous-attempt feedback (close ALL of it):\n${feedback}` : "",
                "Return status=implemented only when the checks pass.",
              ]
                .filter(Boolean)
                .join("\n\n")}
            </Task>
            <Task
              id="fix-validate"
              output={outputs.aguiValidation}
              agent={validateChainMulti}
              retries={2}
              timeoutMs={40 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {[
                "Validate the adopt-product fix round in the Multi repo. Return laneId=adopt-product exactly.",
                `Implementation report:\n${JSON.stringify(impl ?? null, null, 2)}`,
                `The frozen findings that must be closed:\n${FROZEN_FINDINGS}`,
                "Steps: 1. `jj log` + `jj st`: fix commits exist with ONLY lane-relevant files; unrelated dirty work untouched (diffNonEmpty=false if no fix commits). 2. Per finding, open the change and its test; verify the test pins the specific behavior. 3. Run pnpm check:ui-architecture, pnpm typecheck, and the focused tests for touched surfaces. 4. Inherited breakage (outside the fix commits) goes in summary, not allPassed.",
                "allPassed=false if any finding remains open, a check fails, or a claimed test is missing.",
              ].join("\n\n")}
            </Task>
            {validationCurrent && validation?.allPassed === true && validation?.diffNonEmpty === true ? (
              <Task
                id="fix-review-sol"
                output={outputs.aguiReview}
                agent={solChainMulti}
                retries={2}
                timeoutMs={40 * 60_000}
                heartbeatTimeoutMs={10 * 60_000}
              >
                {[
                  "SCOPE-LOCKED sol-seat re-review of Multi's adopt-product lane after the fix round. Do NOT edit files. Return laneId=adopt-product, seat=sol, reviewer=<your model identity>.",
                  `THE FROZEN FINDINGS LIST (your prior findings):\n${FROZEN_FINDINGS}`,
                  `Implementation report:\n${JSON.stringify(impl ?? null, null, 2)}`,
                  `Validation report:\n${JSON.stringify(validation ?? null, null, 2)}`,
                  "CONTRACT: approve IFF (a) every finding above is genuinely closed with a meaningful test, and (b) the fix diff introduces no new defect. Those are the ONLY rejection grounds; other pre-existing issues go in your issues array as followUps without blocking. This is the program's final round.",
                ].join("\n\n")}
              </Task>
            ) : null}
          </Sequence>
        </Loop>
        <Task id="fix-report" output={outputs.aguiFixReport}>
          {{
            success: done,
            solApproved: reviewCurrent && review?.approved === true,
            attempts,
            summary: done
              ? `adopt-product findings closed and Sol re-approved after ${attempts} attempt(s). The agentic UI program's review coverage is complete.`
              : `adopt-product fix round settled without Sol approval after ${attempts} attempt(s); see review feedback.`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
