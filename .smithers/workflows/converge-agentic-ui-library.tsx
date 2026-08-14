// smithers-display-name: Converge Agentic UI Library
/** @jsxImportSource smthrs */
import {
  ClaudeCodeAgent,
  MergeQueue,
  OpenCodeAgent,
  Parallel,
  Sequence,
  Task,
  UI,
  Worktree,
  createSmithers,
} from "smthrs";
import { join } from "node:path";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";
import {
  MULTI_ROOT,
  implSchema,
  laneState,
  resolveRepoRoot,
  reviewSchema,
  runSmithersCi,
  validationSchema,
  ciSchema,
} from "./build-agentic-ui-library";

// Final convergence round for the agentic UI program (parent runs
// run-1784654981789 and run-1784673778698). Four lanes remain rejected; their
// partial fixes sit on agui-fin/run-1784673778698/<lane> branches. Each lane
// below carries the CLOSED findings list assembled from the rejecting seats'
// final reviews. The review contract is scope-locked: a reviewer approves IFF
// every listed finding is closed and the lane diff introduces no new defects;
// anything else becomes a followUp note, never a rejection. This ends the
// scope-widening loop that exhausted the prior rounds while keeping the bar
// (every listed item genuinely fixed, with tests) intact.

const PRIOR_RUN = "run-1784673778698";

type Seat = "fable" | "sol";
type ConvergeLane = {
  id: string;
  seats: Seat[];
  priorBranch: string;
  closedFindings: string[];
};

// Round 2 (2026-07-22): the first converge run landed reasoning-tools,
// sandbox-previews, and approvals-checkpoints. Only workflow-canvas remains,
// scoped to Sol's two genuinely-open findings from that run (Fable already
// approved; the conv branch below carries everything else).
export const CONVERGE_LANES: ConvergeLane[] = [
  {
    id: "workflow-canvas",
    seats: ["fable", "sol"],
    priorBranch: "agui-conv/run-1784718901085/workflow-canvas",
    closedFindings: [
      "Wire mounted selection and editable mutations for real: in the DEFAULT mounted WorkflowGraph, node selection updates selection state truthfully and editable mutations (connect/drag) actually operate when editable; readOnly still disables them. Add a mounted (not SSR/source-string) test proving both paths.",
      'Fix the invalid ARIA role: WorkflowNode currently renders role="option" outside any listbox context. Use a valid rendered-context role structure (e.g. listbox on the container with option children, or button/group roles) and assert the accessible tree in a mounted test.',
    ],
  },
];

export const CLOSURE_ITEMS = [
  "1. check-ui-architecture is RED on committed main: packages/gateway-ui/src/MonitorButton.tsx flags 'compatibility-facade-file :: legacy facade implementation' plus an inventory uiImports gain. A prior 'sanction' commit updated the guard but the violation persists. Fix it properly: either make MonitorButton comply with the guard's facade rules (preferred — check how sibling gateway-ui files satisfy the compatibility-facade-file rule) or add the exact ratchet/baseline entries the guard requires (scripts/ui-architecture-baseline.json inventory adds). `node scripts/check-ui-architecture.mjs` must exit 0. Do NOT weaken the guard logic itself.",
  "2. tests/hookComponents.test.tsx 'RunEventLog > coalesces consecutive per-node heartbeats and toggles to show them all' fails (expects 3 event rows, gets 2) since commit 7d86e81e99 rewrote RunEventLog with structured severity-tinted rows. Read the NEW RunEventLog implementation and determine the intended heartbeat contract: if heartbeats are now intentionally hidden/folded differently, update the test to pin the NEW contract (including the show-heartbeats toggle behavior); if heartbeat coalescing genuinely regressed (heartbeat rows dropped where the UI intends to show a coalesced row), fix RunEventLog instead. Wrap state-updating interactions in act() to clear the warnings. `pnpm -C packages/gateway-ui test` must pass 145/145.",
  "3. Leave every gate green: pnpm -C packages/ui test, pnpm -C packages/gateway-ui test, node scripts/check-ui-architecture.mjs, node scripts/check-docs.mjs (the compute CI task after you re-runs the full set authoritatively).",
].join("\n");

const inputSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(4).default(2),
  perLaneIterations: z.number().int().min(1).max(3).default(2),
  baseBranch: z.string().trim().min(1).default("main"),
});

const mergeSchema = z.object({
  laneId: z.string().min(1),
  mergedToMain: z.boolean(),
  summary: z.string().min(10),
  commandsRun: z.array(z.string()).default([]),
});
const laneOutSchema = z.object({
  laneId: z.string().min(1),
  branch: z.string().min(1),
  worktreePath: z.string().min(1),
  lgtm: z.boolean(),
  exhausted: z.boolean(),
  attempts: z.number().int().min(0),
  summary: z.string().min(10),
  seatVerdicts: z.array(z.object({ seat: z.string(), approved: z.boolean(), reviewer: z.string() })).default([]),
});
const reportSchema = z.object({
  success: z.boolean(),
  lanesLgtm: z.number().int().min(0),
  lanesTotal: z.number().int().min(0),
  closureDone: z.boolean(),
  smithersCiGreen: z.boolean(),
  crossSeatApproved: z.boolean(),
  summary: z.string().min(20),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  aguiImpl: implSchema,
  aguiValidation: validationSchema,
  aguiReview: reviewSchema,
  aguiConvLane: laneOutSchema,
  aguiConvMerge: mergeSchema,
  aguiCi: ciSchema,
  aguiConvReport: reportSchema,
});

const kimiImplement = [new OpenCodeAgent({ model: "kimi-for-coding/k3" }), providers.claudeSonnet];
const fableChain = [providers.claude, providers.claudeOpus];
const solChain = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true },
  [providers.claude, providers.claudeSonnet],
);
const fableChainMulti = [new ClaudeCodeAgent({ model: "claude-fable-5", cwd: MULTI_ROOT })];
const solChainMulti = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true, cwd: MULTI_ROOT },
  [new ClaudeCodeAgent({ model: "claude-fable-5", cwd: MULTI_ROOT })],
);
const validateChain = [providers.claudeSonnet, providers.claude];
const mergeChain = [providers.claudeSonnet, providers.claude];

type RawRow = Record<string, unknown>;
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "item"
  );
}
function rawRows(ctx: any, channel: string): RawRow[] {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(rows) ? rows.filter((row): row is RawRow => typeof row === "object" && row !== null) : [];
}
function baseNodeId(row: RawRow): string {
  return String(row.nodeId ?? "").split("@@", 1)[0] ?? "";
}
function rowVersion(row: RawRow): [number, number] {
  const iteration = Number.isFinite(Number(row.iteration)) ? Number(row.iteration) : 0;
  const iterationCount = Number.isFinite(Number(row.iterationCount)) ? Number(row.iterationCount) : iteration;
  return [iterationCount, iteration];
}
function latestRaw(rows: RawRow[], nodeId: string): RawRow | undefined {
  return rows
    .filter((row) => baseNodeId(row) === nodeId)
    .reduce<RawRow | undefined>((best, row) => {
      if (!best) return row;
      const current = rowVersion(row);
      const previous = rowVersion(best);
      return current[0] > previous[0] || (current[0] === previous[0] && current[1] >= previous[1]) ? row : best;
    }, undefined);
}
function sameVersion(left: RawRow | undefined, right: RawRow | undefined): boolean {
  if (!left || !right) return false;
  const a = rowVersion(left);
  const b = rowVersion(right);
  return a[0] === b[0] && a[1] === b[1];
}

const SHARED_TREE_RULES =
  "Shared-tree rules: jj-colocated checkout shared with concurrent agents carrying unrelated uncommitted work. jj st / jj diff are truth; commit ONLY your own files with explicit pathspecs (`jj commit <paths> -m ...`); NEVER git add -A / commit -a / stash / rebase / --amend; never blanket-stage. NEVER edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/*agentic-ui-library*.tsx.";

function findingsBlock(lane: ConvergeLane): string {
  return lane.closedFindings.map((finding, index) => `${index + 1}. ${finding}`).join("\n");
}

function implementPrompt(lane: ConvergeLane, branch: string, feedback: string): string {
  return [
    `Convergence fix for lane ${lane.id}. Return laneId=${lane.id} exactly.`,
    `PRIOR WORK: branch ${lane.priorBranch} already carries a partial fix for this lane (unmerged). FIRST graft it into this worktree: in the PRIMARY checkout run \`jj diff --from "fork_point(main | ${lane.priorBranch})" --to ${lane.priorBranch} --git\` to a temp file, then \`git apply\` it here, resolving any drift against current main (the shared surface moved since). Then close whatever remains of the list below.`,
    `THE CLOSED FINDINGS LIST (fix exactly these, nothing else):\n${findingsBlock(lane)}`,
    "House rules: packages/ui architecture contract (data-slot anatomy, sui-* classes, tokens-only colors, CSS as TS strings, self-injection; light/dark/reduced-motion/keyboard/SR mandatory). Red-to-green tests per finding. `pnpm -C packages/ui test` (and gateway-ui if touched) green in THIS worktree before reporting. Do NOT edit shared integration files (packages/ui/src/index.ts, uiCss.ts, shadcn-provenance.json, manifests, lockfiles) EXCEPT where a finding explicitly requires export/provenance sync — keep such edits minimal and note them in summary.",
    "Work in this isolated jj worktree; commit only your files with explicit pathspecs.",
    feedback ? `Previous-attempt feedback (close ALL of it):\n${feedback}` : "",
    "Return status=implemented only when every listed finding is closed and focused checks pass here.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function validatePrompt(lane: ConvergeLane, branch: string, implementation: RawRow | undefined): string {
  return [
    `Validate convergence lane ${lane.id}. Return laneId=${lane.id} exactly.`,
    `Implementation report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    `The closed findings list:\n${findingsBlock(lane)}`,
    `Steps: 1. \`jj diff --from "fork_point(main | ${branch})" --to ${branch} --stat\` — diffNonEmpty=false if empty. 2. Per finding, verify a test exists that pins it (open the test; it must exercise the specific behavior). 3. pnpm -C packages/ui test (+ gateway-ui if touched). 4. Confirm no shared-file edits beyond what a finding required. 5. Inherited breakage (outside the branch diff) goes in summary, not allPassed.`,
    "allPassed=false if any listed finding remains open, a check fails, or a claimed test is missing.",
  ].join("\n");
}

function reviewPrompt(
  lane: ConvergeLane,
  seat: Seat,
  implementation: RawRow | undefined,
  validation: RawRow | undefined,
): string {
  return [
    `SCOPE-LOCKED ${seat}-seat convergence review of lane ${lane.id}. Do NOT edit files. Return laneId=${lane.id}, seat=${seat}, reviewer=<your model identity>.`,
    `THE CLOSED FINDINGS LIST:\n${findingsBlock(lane)}`,
    `Implementation:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    `Validation:\n${JSON.stringify(validation ?? null, null, 2)}`,
    "CONTRACT — read carefully. You approve IFF: (a) every finding on the list above is genuinely closed with a meaningful test, and (b) the lane's DIFF introduces no new defect (a regression created by this diff itself). Those are the ONLY grounds for rejection. Pre-existing issues outside the list — however real — are recorded in your `issues` array with severity but MUST NOT block approval; they become follow-up work. This is the program's final convergence round: the list is frozen, and scope-widening rejections are a contract violation.",
    "Verify (a) by reading the diff and running the pinning tests; verify (b) by reviewing the diff for correctness, accessibility, token compliance, and security ONLY as it concerns changed lines.",
  ].join("\n\n");
}

function mergePrompt(result: RawRow, baseBranch: string, repoRoot: string): string {
  return [
    `Land convergence lane ${String(result.laneId)} onto local ${baseBranch} at ${repoRoot}. Source worktree: ${String(result.worktreePath)}; branch: ${String(result.branch)}.`,
    `Return laneId=${String(result.laneId)} exactly.`,
    SHARED_TREE_RULES,
    `Recipe: 1. Verify non-empty via fork_point diff. 2. \`jj rebase -b ${String(result.branch)} -d ${baseBranch}\`, conflicts only in lane files (plus any finding-required barrel/provenance hunks — keep both sides). 3. Focused tests in the rebased tree. 4. CAS-move ${baseBranch} (\`git update-ref refs/heads/${baseBranch} <new> <expected-old>\`; on failure re-read/re-rebase/retry), then \`jj git import\`. 5. \`git show --name-only\` scope check + prior-landing ancestry check (\`git merge-base --is-ancestor\`). No pushes to origin.`,
  ].join("\n");
}

function closurePrompt(feedback: string): string {
  return [
    "Closure lane for the agentic UI program: final shared-surface items on the PRIMARY checkout (local main). Return laneId=closure exactly.",
    SHARED_TREE_RULES,
    CLOSURE_ITEMS,
    feedback ? `Previous-attempt feedback:\n${feedback}` : "",
    "Commit your files with explicit pathspecs. Return status=implemented only when check-ui-architecture and check-docs pass locally.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function crossSeatPrompt(target: "adopt-gateway" | "adopt-product", seat: Seat): string {
  const scope =
    target === "adopt-gateway"
      ? "Multi's gateway/run structured-output adoption (GatewayNodeDetail/GatewayRunInspector/NodeInspector/RunInspector rendering through shared AgentOutput/ActivityTimeline/Plan/Queue/Artifact/TestResults/StackTrace/CodeBlock/SchemaDisplay/Confirmation/Checkpoint/ContextUsage, raw fallbacks retained)"
      : "Multi's product-surface adoption (AgentCard/ModelSelector/ProviderBadge in the agent registry, Confirmation/ApprovalCard in approvals, Checkpoint actions in timeline, Commit/ChangeSummary/Artifact/OpenInChat in VCS/files, TestResults in evals, EnvironmentVariables/SecretField in BYOK, Sandbox anatomy, canvas anatomy in the flow editor)";
  return [
    `Missing cross-seat verdict: independent ${seat}-seat review of the ALREADY-LANDED ${target} lane in ${MULTI_ROOT}. Do NOT edit files. Return laneId=${target}, seat=${seat}, reviewer=<your model identity>.`,
    `Scope reviewed: ${scope}. The lane was implemented and approved by the other seat in run ${PRIOR_RUN}; find its commits via \`jj log\` in the Multi repo.`,
    "Review the landed commits at full strictness for: shared-component consumption without duplicate wrappers or new heavy deps, preserved store/imperative/persistence/streaming behavior, honest pending/error states and raw fallbacks, accessibility, and untouched unrelated work. Approve if production-ready; if not, itemize blocking issues.",
  ].join("\n\n");
}

export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxConcurrency: ctx.input.maxConcurrency ?? 2,
    perLaneIterations: ctx.input.perLaneIterations ?? 2,
    baseBranch: ctx.input.baseBranch ?? "main",
  });
  const repoRoot = resolveRepoRoot();
  const runSlug = slug(String((ctx as any).runId ?? "agui-conv"));

  const laneRows = rawRows(ctx, "aguiConvLane");
  const merges = rawRows(ctx, "aguiConvMerge");
  const lanesSettled = CONVERGE_LANES.every((lane) => laneRows.some((row) => row.laneId === lane.id));
  const lgtm = laneRows.filter((row) => CONVERGE_LANES.some((lane) => lane.id === row.laneId) && row.lgtm === true);
  const mergesSettled = lanesSettled && lgtm.every((row) => merges.some((merge) => merge.laneId === row.laneId));

  const closureRows = rawRows(ctx, "aguiImpl").filter(
    (row) => baseNodeId(row) === "closure-implement" && row.laneId === "closure",
  );
  const closureImpl = latestRaw(closureRows, "closure-implement");
  const ci = latestRaw(
    rawRows(ctx, "aguiCi").filter((row) => row.scope === "smithers"),
    "closure-ci",
  );
  const ciCurrent = sameVersion(closureImpl, ci);
  const closureDone = closureImpl?.status === "implemented" && ciCurrent && ci?.allPassed === true;
  const closureSettled = closureDone || (closureRows.length >= 3 && ciCurrent);

  const crossSeats: Array<{ target: "adopt-gateway" | "adopt-product"; seat: Seat }> = [
    { target: "adopt-gateway", seat: "fable" },
    { target: "adopt-product", seat: "sol" },
  ];
  const crossRows = crossSeats.map(({ target, seat }) =>
    latestRaw(
      rawRows(ctx, "aguiReview").filter((row) => row.laneId === target && row.seat === seat),
      `cross-${target}-${seat}`,
    ),
  );
  const crossSettled = crossRows.every((row) => row !== undefined);
  const crossApproved = crossSettled && crossRows.every((row) => row?.approved === true);

  return (
    <Workflow name="converge-agentic-ui-library">
      <UI entry="../ui/converge-agentic-ui-library.tsx" title="Converge Agentic UI Library" />
      <Sequence>
        <Parallel maxConcurrency={input.maxConcurrency}>
          {CONVERGE_LANES.map((lane) => {
            const branch = `agui-conv/${runSlug}/${lane.id}`;
            const worktreePath = join(repoRoot, ".smithers", "workflows", ".worktrees", "agui-conv", runSlug, lane.id);
            const state = laneState(ctx, lane as any, input.perLaneIterations, `conv-${lane.id}`);
            const feedback = [
              state.implementation && state.implementation.status !== "implemented"
                ? `IMPLEMENTATION ${String(state.implementation.status).toUpperCase()}:\n${String(state.implementation.summary ?? "")}`
                : "",
              state.validationCurrent && state.validation?.allPassed === false
                ? `VALIDATION FAILED:\n${String(state.validation.failingSummary ?? state.validation.summary ?? "")}`
                : "",
              ...state.reviews.map((entry) =>
                entry.current && entry.review?.approved === false
                  ? `REVIEW (${entry.seat}) NOT LGTM:\n${String(entry.review.feedback ?? "")}`
                  : "",
              ),
            ]
              .filter(Boolean)
              .join("\n\n");
            return (
              <Worktree key={lane.id} path={worktreePath} branch={branch} baseBranch={input.baseBranch}>
                <Sequence>
                  <Loop
                    id={`conv-${lane.id}-loop`}
                    until={state.done}
                    maxIterations={input.perLaneIterations}
                    onMaxReached="return-last"
                  >
                    <Sequence>
                      <Task
                        id={`conv-${lane.id}-implement`}
                        output={outputs.aguiImpl}
                        agent={kimiImplement}
                        retries={2}
                        timeoutMs={90 * 60_000}
                        heartbeatTimeoutMs={15 * 60_000}
                      >
                        {implementPrompt(lane, branch, feedback)}
                      </Task>
                      <Task
                        id={`conv-${lane.id}-validate`}
                        output={outputs.aguiValidation}
                        agent={validateChain}
                        retries={2}
                        timeoutMs={40 * 60_000}
                        heartbeatTimeoutMs={10 * 60_000}
                      >
                        {validatePrompt(lane, branch, state.implementation)}
                      </Task>
                      {state.validationCurrent &&
                      state.validation?.allPassed === true &&
                      state.validation?.diffNonEmpty === true ? (
                        <Parallel>
                          {lane.seats.map((seat) => (
                            <Task
                              key={seat}
                              id={`conv-${lane.id}-review-${seat}`}
                              output={outputs.aguiReview}
                              agent={seat === "fable" ? fableChain : solChain}
                              retries={2}
                              timeoutMs={40 * 60_000}
                              heartbeatTimeoutMs={10 * 60_000}
                            >
                              {reviewPrompt(lane, seat, state.implementation, state.validation)}
                            </Task>
                          ))}
                        </Parallel>
                      ) : null}
                    </Sequence>
                  </Loop>
                  <Task id={`conv-${lane.id}-result`} output={outputs.aguiConvLane}>
                    {{
                      laneId: lane.id,
                      branch,
                      worktreePath,
                      lgtm: state.done,
                      exhausted: state.exhausted,
                      attempts: state.attempts,
                      summary: state.done
                        ? `Convergence lane ${lane.id} LGTM after ${state.attempts} attempt(s).`
                        : `Convergence lane ${lane.id} settled without LGTM after ${state.attempts} attempt(s).`,
                      seatVerdicts: state.reviews.map((entry) => ({
                        seat: entry.seat,
                        approved: entry.current && entry.review?.approved === true,
                        reviewer: String(entry.review?.reviewer ?? "(none)"),
                      })),
                    }}
                  </Task>
                </Sequence>
              </Worktree>
            );
          })}
        </Parallel>

        <MergeQueue id="agui-conv-merge-queue" maxConcurrency={1}>
          {(lanesSettled
            ? lgtm.filter((row) => !merges.some((merge) => merge.laneId === row.laneId && merge.mergedToMain === true))
            : []
          ).map((row) => (
            <Task
              key={String(row.laneId)}
              id={`merge-${slug(String(row.laneId))}`}
              output={outputs.aguiConvMerge}
              agent={mergeChain}
              retries={2}
              timeoutMs={45 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {mergePrompt(row, input.baseBranch, repoRoot)}
            </Task>
          ))}
        </MergeQueue>

        {lanesSettled && mergesSettled ? (
          <Loop id="closure-loop" until={closureDone} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Task
                id="closure-implement"
                output={outputs.aguiImpl}
                agent={kimiImplement}
                retries={2}
                timeoutMs={60 * 60_000}
                heartbeatTimeoutMs={15 * 60_000}
              >
                {closurePrompt(
                  ciCurrent && ci?.allPassed === false ? `CI GATE FAILED:\n${String(ci?.summary ?? "")}` : "",
                )}
              </Task>
              <Task id="closure-ci" output={outputs.aguiCi} timeoutMs={150 * 60_000}>
                {() => runSmithersCi(repoRoot)}
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        {lanesSettled && mergesSettled && closureSettled ? (
          <Parallel>
            {crossSeats.map(({ target, seat }) => (
              <Task
                key={`${target}-${seat}`}
                id={`cross-${target}-${seat}`}
                output={outputs.aguiReview}
                agent={seat === "fable" ? fableChainMulti : solChainMulti}
                retries={2}
                timeoutMs={45 * 60_000}
                heartbeatTimeoutMs={10 * 60_000}
              >
                {crossSeatPrompt(target, seat)}
              </Task>
            ))}
          </Parallel>
        ) : null}

        {lanesSettled && mergesSettled && closureSettled && crossSettled ? (
          <Task id="agui-conv-report" output={outputs.aguiConvReport}>
            {{
              success: lgtm.length === CONVERGE_LANES.length && closureDone && crossApproved,
              lanesLgtm: lgtm.length,
              lanesTotal: CONVERGE_LANES.length,
              closureDone,
              smithersCiGreen: ci?.allPassed === true,
              crossSeatApproved: crossApproved,
              summary:
                lgtm.length === CONVERGE_LANES.length && closureDone && crossApproved
                  ? `Convergence complete: ${lgtm.length}/${CONVERGE_LANES.length} lanes LGTM and merged, closure items done, CI green, cross-seat verdicts approved.`
                  : `Convergence settled: ${lgtm.length}/${CONVERGE_LANES.length} lanes LGTM; closureDone=${closureDone}; crossSeatApproved=${crossApproved}.`,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
