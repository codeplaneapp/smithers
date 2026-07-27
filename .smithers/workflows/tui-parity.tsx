// smithers-source: authored
// smithers-display-name: TUI Parity Program
// smithers-description: Bring multi's product UX to the terminal: extract isomorphic ui-core, build tui-ui + the TUI shell on opentui, zmux e2e everything. Phase-by-phase worktree lanes with real check oracles, review, and human gates.
// smithers-tags: tui, opentui, ui-core, zmux, parity, program
/** @jsxImportSource smithers-orchestrator */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Approval, Sequence, Task, Worktree, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

/**
 * TUI Parity Program
 *
 * Implements research/tui-parity/ (the spec set, committed on main) phase by
 * phase. Each phase runs in ONE isolated <Worktree> lane:
 *
 *   implement (agent) -> checks (compute oracle, cwd = the lane worktree)
 *   -> review (agent, branch-diff scoped)  ... looped until green+approved
 *   -> merge to main (agent, repo root)    -> human gate before the next phase
 *
 * WHY THIS SHAPE
 * - The compute oracle runs the REAL gates (typecheck, tests, arch-check) with
 *   cwd pinned to the lane's worktree path; agents cannot fake its exit codes.
 *   (A bare compute task inside <Worktree> runs at the launch root, so every
 *   check here sets cwd explicitly.)
 * - Reviews diff the BRANCH (`jj diff --from "fork_point(main | branch)"`),
 *   never the working copy, so committed lane work is never read as empty.
 * - Phases are strictly sequential: each builds on the previous phase's merged
 *   result, and a durable <Approval> gate sits between phases.
 * - Push safety: no agent ever pushes; merging to the LOCAL main is the last
 *   automated step, verified by a deterministic post-merge oracle.
 */

const SPEC_DIR = "research/tui-parity";

type PhaseDef = {
  id: string;
  title: string;
  specFiles: string[];
  detail: string;
  checks: Array<[string, string[], number]>;
};

// Gate commands shared by most phases. Package-scoped so a phase's oracle is
// fast; the merge oracle re-runs the same set on main after landing.
const CORE_CHECKS: Array<[string, string[], number]> = [
  ["pnpm", ["-C", "packages/ui-core", "typecheck"], 15 * 60_000],
  ["pnpm", ["-C", "packages/ui-core", "test"], 15 * 60_000],
  ["pnpm", ["-C", "packages/tui-ui", "typecheck"], 15 * 60_000],
  ["pnpm", ["-C", "packages/tui-ui", "test"], 15 * 60_000],
  ["pnpm", ["-C", "packages/tui", "typecheck"], 15 * 60_000],
  ["pnpm", ["-C", "packages/tui", "test"], 15 * 60_000],
  ["node", ["scripts/check-ui-architecture.mjs"], 5 * 60_000],
  ["node", ["scripts/check-dependency-boundaries.mjs"], 5 * 60_000],
];

const PHASES: PhaseDef[] = [
  {
    id: "boilerplate",
    title: "Phase 1 - Boilerplate + rails",
    specFiles: ["00-overview.md", "01-packages.md", "06-zmux-harness.md"],
    detail: `Land the program rails, spec-first, nothing product-visible yet:
1. Scaffold packages/ui-core (@smithers-orchestrator/ui-core): the isomorphic
   headless product layer. Zero DOM, zero opentui, zero react-dom. Seed it with
   the Platform DI interface module (see 02-platform-di.md), a first extracted
   pure-domain module + its tests, and package.json/tsconfig/test scripts
   matching sibling packages (raw-source shipping like gateway-react).
2. Scaffold packages/tui-ui (@smithers-orchestrator/tui-ui): the opentui leaf
   component library (props-in/callbacks-out). jsxImportSource "@opentui/react"
   like packages/tui. Seed with StatusPill, EmptyState, Keybar leaf components
   + pure-function tests (no TTY needed).
3. EXTEND the existing scripts/check-ui-architecture.mjs (exact-ratchet
   baseline in scripts/ui-architecture-baseline.json) with the new TUI
   boundary rules: ui-core must not import opentui/react-dom/DOM globals;
   tui-ui must not import gateway-client/gateway-react or business logic.
   Update the baseline inventories for the two new packages (@opentui is
   already a tracked visual-dependency prefix). Keep check:ui-architecture,
   check:deps (dependency boundaries), and its own test
   (scripts/check-ui-architecture.test.mjs) green.
4. Build the zmux e2e rig in e2e/tui/: a Bun TS client for zmuxd's
   newline-delimited JSON-RPC over the unix socket (session.create/send/
   sendKey/capture/resize + notification demux), waitForCaptureContains +
   waitForSessionExited helpers (poll ~50ms with deadline), daemon boot fixture
   (spawn zmuxd --socket <tmp> --idle-seconds 0, poll for socket). First green
   e2e: boot smithers-mon under a fixed 80x24 pty with NO_COLOR=1 against a
   seeded local gateway run and assert the header renders. The suite MUST
   describe.skipIf cleanly when no zmuxd binary is found (env
   SMITHERS_ZMUXD_BIN or PATH lookup or ../zmux/zig-out/bin fallback).
5. Repo rules: docs/reference/package-configuration.mdx rows for both new
   packages (check:docs machine-diffs the table against workspace packages),
   root package.json workspace:* devDependency entries, pnpm docs:llms regen,
   BOTH pnpm-lock.yaml and bun.lock refreshed in the same commit as the
   manifest changes.`,
    checks: [...CORE_CHECKS, ["pnpm", ["-C", "e2e", "test", "--", "tui"], 20 * 60_000]],
  },
  {
    id: "runs",
    title: "Phase 2 - Runs list + run inspector on ui-core",
    specFiles: ["01-packages.md", "03-tui-screens.md"],
    detail: `Extract multi's runs/run-inspector logic into ui-core and refactor the
existing packages/tui modes onto it:
1. Extract (move, do not fork) the runs pure-domain modules from
   /Users/williamcory/multi (runsList/runProgress/statusMeta per
   01-packages.md), their stores and headless bridges, into ui-core, and add
   view-model hooks useRunsListVm + useRunInspectorVm over gateway-react.
2. Update multi to import these from @smithers-orchestrator/ui-core (its pnpm
   link overrides make the loop same-day); multi's own checks must stay green
   (pnpm -C /Users/williamcory/multi typecheck if reachable, else note it in
   the report for the merge step).
3. Refactor packages/tui TreeMode/GraphMode/LogMode/TimelineMode to consume the
   ui-core view models; move their pure *Utils logic into ui-core where it
   duplicates multi domain logic. Keep smithers-mon behavior identical.
4. New tui-ui leaf components as needed (RunTree, RunEventLog rows, StatusGlyph).
5. zmux e2e: runs list renders + navigating into a run shows the tree.`,
    checks: [...CORE_CHECKS, ["pnpm", ["-C", "e2e", "test", "--", "tui"], 20 * 60_000]],
  },
  {
    id: "approvals",
    title: "Phase 3 - Approvals queue + human requests",
    specFiles: ["01-packages.md", "03-tui-screens.md"],
    detail: `Extract multi's approvals exemplar (pure domain + store + bridge +
decision execution port) into ui-core as useApprovalsVm; build the TUI
approvals mode on it (list, detail, [a]approve/[d]deny with note entry) plus
human-request resolution. tui-ui gains ApprovalCard/DecisionBar leaves.
zmux e2e: a real paused run's gate is approved through the TUI and the run
proceeds (seeded gateway fixture workflow with an <Approval>).`,
    checks: [...CORE_CHECKS, ["pnpm", ["-C", "e2e", "test", "--", "tui"], 20 * 60_000]],
  },
  {
    id: "chat",
    title: "Phase 4 - Chat concierge home",
    specFiles: ["03-tui-screens.md", "01-packages.md"],
    detail: `The chat-first home: transcript + composer + slash-command autocomplete
over the flow catalog, embeds opening as panes/modes. Extract multi's chat
transcript view-model (useChatTranscriptVm) and the portable flow/command
descriptor protocol into ui-core (per 01-packages.md; the XState chat machine
modules port as-is, they are already DOM-free). tui-ui gains ChatTranscript,
Composer, AutocompletePopup leaves. Embeds: runs/approvals modes open from
chat commands. zmux e2e: type a slash command, autocomplete appears, invoking
/runs opens the runs mode.`,
    checks: [...CORE_CHECKS, ["pnpm", ["-C", "e2e", "test", "--", "tui"], 20 * 60_000]],
  },
  {
    id: "thin-modes",
    title: "Phase 5 - VCS/diff, tickets, memory, prompts, scores, crons",
    specFiles: ["03-tui-screens.md"],
    detail: `One thin mode each over their gateway-react hooks + ui-core view models
(useDiffVm and simple list VMs): vcs/diff view (unified diff text), tickets,
memory facts, prompts, scores, crons. Each mode is a small opentui view over a
pure sibling utils module (existing packages/tui pattern). tui-ui gains
DiffView + ListTable leaves. zmux e2e: each mode opens and renders seeded data
(one representative assertion per mode).`,
    checks: [...CORE_CHECKS, ["pnpm", ["-C", "e2e", "test", "--", "tui"], 20 * 60_000]],
  },
  {
    id: "palette",
    title: "Phase 6 - Palette",
    specFiles: ["03-tui-screens.md", "01-packages.md"],
    detail: `The cmd-K analog: extract multi's paletteDomain.ts into ui-core with a
usePaletteVm; a TUI palette overlay (fuzzy match over surfaces, runs,
workflows, flow commands) opened with ctrl-k / ":" from any mode. zmux e2e:
open palette, type a query, select a result, the target mode opens.`,
    checks: [...CORE_CHECKS, ["pnpm", ["-C", "e2e", "test", "--", "tui"], 20 * 60_000]],
  },
  {
    id: "hijack",
    title: "Phase 7 - Hijack generalized",
    specFiles: ["05-hijack.md"],
    detail: `Generalize packages/tui hijack (startHijackSession) from
"spawn smithers hijack" into "run any TUI command": arbitrary argv + cwd/env,
suspend renderer -> inherited stdio -> resume on exit, error banner on spawn
failure. Keep the agent-session hijack as one preset. Add a hijack picker
(claude, codex, htop, lazygit, shell, custom command) and a per-run "open
agent session" action from the run inspector. Pure argv/preset logic in
hijackUtils stays TTY-free tested. zmux e2e: hijack into a trivial TUI
(e.g. "bash -c 'read'"), capture shows the child took the pty, exit resumes
smithers-mon (poll for the overlay to disappear).`,
    checks: [...CORE_CHECKS, ["pnpm", ["-C", "e2e", "test", "--", "tui"], 20 * 60_000]],
  },
  {
    id: "custom-tuis",
    title: "Phase 8 - Custom TUIs (.smithers/tui contract)",
    specFiles: ["04-custom-tuis.md"],
    detail: `The .smithers/tui/<id>.tsx contract, exactly parallel to
.smithers/ui/<id>.tsx: self-contained modules (relative imports must not
escape .smithers/tui/), loaded by a new "smithers tui <runId|workflow>"
CLI command and from smithers up interactive; seeded TUI twins for every
seeded GUI via scripts/generate-workflow-pack.ts; a user preference
(smithers.config + per-invocation --ui/--tui flag) choosing GUI vs TUI as the
default open surface. New CLI command means docs page + check-docs counts +
pnpm docs:llms in the same change. zmux e2e: smithers tui opens a seeded
custom TUI for a run.`,
    checks: [
      ...CORE_CHECKS,
      ["pnpm", ["-C", "apps/cli", "test"], 25 * 60_000],
      ["pnpm", ["-C", "e2e", "test", "--", "tui"], 20 * 60_000],
    ],
  },
];

const inputSchema = z.object({
  startPhase: z.number().int().min(1).max(8).default(1),
  endPhase: z.number().int().min(1).max(8).default(1),
  review: z.boolean().default(true).describe("Human approval gate after each phase lands."),
  baseBranch: z.string().default("main"),
  maxIterationsPerPhase: z.number().int().min(1).max(8).default(4),
});

const implementationSchema = z.object({
  phase: z.string().min(1),
  attempt: z.string().min(1),
  status: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  notesForReview: z.string().default(""),
});

const checkSchema = z.object({
  phase: z.string().min(1),
  allPassed: z.boolean(),
  summary: z.string().min(1),
  commands: z
    .array(
      z.object({
        command: z.string(),
        exitCode: z.number().nullable(),
        tail: z.string(),
      }),
    )
    .default([]),
});

const reviewSchema = z.object({
  phase: z.string().min(1),
  attempt: z.string().min(1),
  approved: z.boolean(),
  feedback: z.string().min(10),
  blockers: z.array(z.string()).default([]),
});

const mergeSchema = z.object({
  phase: z.string().min(1),
  mergedToMain: z.boolean(),
  branch: z.string().min(1),
  summary: z.string().min(10),
  commandsRun: z.array(z.string()).default([]),
});

const postMergeSchema = z.object({
  phase: z.string().min(1),
  allPassed: z.boolean(),
  summary: z.string().min(1),
  commands: z
    .array(
      z.object({
        command: z.string(),
        exitCode: z.number().nullable(),
        tail: z.string(),
      }),
    )
    .default([]),
});

const gateSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable().default(null),
});

const resultSchema = z.object({
  status: z.string().min(1),
  summary: z.string().min(1),
  phasesLanded: z.array(z.string()).default([]),
  phasesAttempted: z.array(z.string()).default([]),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  tuiParityImplementation: implementationSchema,
  tuiParityCheck: checkSchema,
  tuiParityReview: reviewSchema,
  tuiParityMerge: mergeSchema,
  tuiParityPostMerge: postMergeSchema,
  tuiParityGate: gateSchema,
  tuiParityResult: resultSchema,
});

type RawRow = Record<string, unknown>;

function asInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
function asStr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function rawRows(ctx: any, channel: string): RawRow[] {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(rows) ? rows.filter((row): row is RawRow => typeof row === "object" && row !== null) : [];
}

function baseNodeId(row: RawRow): string {
  return String(row.nodeId ?? "").split("@@", 1)[0] ?? "";
}

function latestFor(rows: RawRow[], nodeId: string): RawRow | undefined {
  const matching = rows.filter((row) => baseNodeId(row) === nodeId);
  return matching.reduce<RawRow | undefined>((best, row) => {
    if (!best) return row;
    return asInt(row.iteration, 0) >= asInt(best.iteration, 0) ? row : best;
  }, undefined);
}

function runChecks(phase: string, checks: Array<[string, string[], number]>, cwd: string) {
  const results = checks.map(([command, args, timeout]) => {
    const res = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env }, timeout });
    return {
      command: [command, ...args].join(" "),
      exitCode: typeof res.status === "number" ? res.status : null,
      tail: `${res.stdout ?? ""}\n${res.stderr ?? res.error?.message ?? ""}`.slice(-6_000),
    };
  });
  const failed = results.filter((r) => r.exitCode !== 0);
  return {
    phase,
    allPassed: failed.length === 0,
    summary:
      failed.length === 0
        ? `All ${results.length} checks green.`
        : `${failed.length}/${results.length} checks red: ${failed.map((f) => f.command).join("; ")}`,
    commands: results,
  };
}

function repoRoot(): string {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : process.cwd();
}

const SHARED_RULES = (specFiles: string[]) => `
GROUND RULES (non-negotiable):
- Read the spec first: ${specFiles.map((f) => `${SPEC_DIR}/${f}`).join(", ")} (committed
  in this worktree). Where spec and code disagree, the code wins; note the
  discrepancy in your report.
- You are in an isolated jj/git worktree lane on your own branch. Run
  "pnpm install --no-frozen-lockfile" here if node_modules is missing. NEVER
  symlink node_modules from another checkout. NEVER push to origin (neither
  here nor in multi). Do not touch files outside this worktree, with ONE
  exception: /Users/williamcory/multi, when this phase explicitly extracts
  modules from it. Commit multi edits in multi's own repo on a branch named
  after this lane, with explicit pathspecs.
- Commit your work IN THIS LANE with explicit pathspecs as you go (jj commit
  <paths> or git add <paths> && git commit); never blanket-stage.
- Dependency/manifest changes must refresh BOTH pnpm-lock.yaml and bun.lock in
  the same commit. New packages need a docs/reference/package-configuration.mdx
  row, a root package.json workspace:* devDependency, and "pnpm docs:llms"
  regen (check:docs / check:llms gate CI).
- Real backends only: no mocked gateway data in product code or e2e. TTY-free
  unit tests exercise pure *Utils/view-model modules; full-screen behavior is
  zmux e2e (skip cleanly when zmuxd is absent).
- opentui stays pinned at ^0.4.2. ui-core must not import opentui, react-dom,
  or DOM globals; tui-ui must not import business logic (the arch-check
  enforces this; keep scripts/check-tui-architecture.mjs green).
- Extraction from /Users/williamcory/multi is move-and-reimport, never
  copy-paste-fork: after extracting a module into ui-core, update multi to
  import it from @smithers-orchestrator/ui-core.`;

export default smithers((ctx) => {
  const startPhase = asInt(ctx.input.startPhase, 1);
  const endPhase = asInt(ctx.input.endPhase, 1);
  const review = asBool(ctx.input.review, true);
  const baseBranch = asStr(ctx.input.baseBranch, "main");
  const maxIterations = asInt(ctx.input.maxIterationsPerPhase, 4);
  const root = repoRoot();

  const implementationRows = rawRows(ctx, "tuiParityImplementation");
  const checkRows = rawRows(ctx, "tuiParityCheck");
  const reviewRows = rawRows(ctx, "tuiParityReview");
  const mergeRows = rawRows(ctx, "tuiParityMerge");
  const postMergeRows = rawRows(ctx, "tuiParityPostMerge");
  const gateRows = rawRows(ctx, "tuiParityGate");

  const active = PHASES.filter((_, index) => index + 1 >= startPhase && index + 1 <= endPhase);

  type PhaseState = {
    def: PhaseDef;
    branch: string;
    worktreePath: string;
    implementation: RawRow | undefined;
    check: RawRow | undefined;
    reviewRow: RawRow | undefined;
    attempts: number;
    done: boolean;
    merged: boolean;
    postMergeGreen: boolean;
    gateApproved: boolean;
    landed: boolean;
  };

  const states: PhaseState[] = active.map((def) => {
    const implementation = latestFor(implementationRows, `${def.id}-implement`);
    const check = latestFor(checkRows, `${def.id}-check`);
    const reviewRow = latestFor(reviewRows, `${def.id}-review`);
    const attempts = implementationRows.filter((row) => baseNodeId(row) === `${def.id}-implement`).length;
    // A review row is only trusted for the attempt it reviewed.
    const checkCurrent =
      implementation !== undefined && check !== undefined && asInt(check.iteration, 0) >= asInt(implementation.iteration, 0);
    const reviewCurrent =
      checkCurrent && reviewRow !== undefined && asInt(reviewRow.iteration, 0) >= asInt(check.iteration, 0);
    const done =
      implementation?.status === "implemented" &&
      checkCurrent &&
      check?.allPassed === true &&
      reviewCurrent &&
      reviewRow?.approved === true;
    const merge = latestFor(mergeRows, `${def.id}-merge`);
    const postMerge = latestFor(postMergeRows, `${def.id}-post-merge`);
    const gate = latestFor(gateRows, `gate-${def.id}`);
    const merged = merge?.mergedToMain === true;
    const postMergeGreen = postMerge?.allPassed === true;
    const gateApproved = !review || gate?.approved === true;
    return {
      def,
      branch: `tui-parity/${def.id}`,
      worktreePath: join(root, ".smithers", "workflows", ".worktrees", "tui-parity", def.id),
      implementation,
      check,
      reviewRow,
      attempts,
      done,
      merged,
      postMergeGreen,
      gateApproved,
      landed: merged && postMergeGreen && gateApproved,
    };
  });

  const landed = states.filter((s) => s.landed).map((s) => s.def.id);
  const attempted = states.filter((s) => s.attempts > 0).map((s) => s.def.id);
  const allLanded = states.length > 0 && states.every((s) => s.landed);
  const anyDenied = review && states.some((s) => latestFor(gateRows, `gate-${s.def.id}`)?.approved === false);

  return (
    <Workflow name="tui-parity">
      <Sequence>
        {states.map((state, index) => {
          const prior = states[index - 1];
          // Phase N mounts once phase N-1 fully landed (or it is the first active phase).
          if (prior && !prior.landed) return null;
          const { def } = state;
          const feedback = [
            state.implementation && state.implementation.status !== "implemented"
              ? `PREVIOUS ATTEMPT ${String(state.implementation.status).toUpperCase()}: ${String(state.implementation.summary ?? "")}`
              : "",
            state.check && state.check.allPassed === false ? `CHECKS RED: ${String(state.check.summary ?? "")}` : "",
            state.reviewRow && state.reviewRow.approved === false
              ? `REVIEW NOT APPROVED: ${String(state.reviewRow.feedback ?? "")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n\n");

          return (
            <Sequence key={def.id}>
              <Worktree path={state.worktreePath} branch={state.branch} baseBranch={baseBranch}>
                <Sequence>
                  <Loop
                    id={`${def.id}-loop`}
                    until={state.done}
                    maxIterations={maxIterations}
                    onMaxReached="return-last"
                  >
                    <Sequence>
                      <Task
                        id={`${def.id}-implement`}
                        output={outputs.tuiParityImplementation}
                        agent={agents.implement}
                        retries={2}
                        timeoutMs={90 * 60_000}
                        heartbeatTimeoutMs={15 * 60_000}
                      >
                        {`${def.title}.

${def.detail}
${SHARED_RULES(def.specFiles)}

Return phase="${def.id}" and attempt="${def.id}:${ctx.iteration}" exactly.
${feedback ? `\nFix this feedback from the previous attempt first:\n${feedback}` : ""}

Report status honestly: "implemented" only when your own package-scoped checks
pass locally; otherwise "partial" or "blocked" with the reason in summary.`}
                      </Task>
                      <Task id={`${def.id}-check`} output={outputs.tuiParityCheck} timeoutMs={60 * 60_000}>
                        {() => runChecks(def.id, def.checks, state.worktreePath)}
                      </Task>
                      {state.check?.allPassed === true &&
                      asInt(state.check.iteration, 0) >= asInt(state.implementation?.iteration, 0) ? (
                        <Task
                            id={`${def.id}-review`}
                            output={outputs.tuiParityReview}
                            agent={agents.review}
                            retries={2}
                            timeoutMs={45 * 60_000}
                            heartbeatTimeoutMs={10 * 60_000}
                          >
                            {`Strictly review phase "${def.id}" of the TUI parity program. Do not edit files.

Scope: the branch diff only. In the worktree at ${state.worktreePath}, run
jj diff --from "fork_point(${baseBranch} | ${state.branch})" --to ${state.branch}
(fall back to git diff ${baseBranch}...${state.branch}) and review that diff
against ${def.specFiles.map((f) => `${SPEC_DIR}/${f}`).join(", ")} and this phase contract:

${def.detail}

Checks are already green (the compute oracle ran them); focus on: spec
conformance, the ui-core/tui-ui boundary (no DOM or opentui leaks into
ui-core, no business logic in tui-ui), move-not-fork extraction (multi
re-imports what moved), test substance (real backends, no mocks), and repo
rules (both lockfiles, docs rows + regen for new packages/commands).

Return phase="${def.id}" and attempt="${def.id}:${ctx.iteration}" exactly.
Approve only a landable diff; otherwise list concrete blockers.`}
                        </Task>
                      ) : null}
                    </Sequence>
                  </Loop>
                </Sequence>
              </Worktree>

              {state.done && !state.merged ? (
                <Task
                  id={`${def.id}-merge`}
                  output={outputs.tuiParityMerge}
                  agent={agents.implement}
                  retries={2}
                  timeoutMs={60 * 60_000}
                  heartbeatTimeoutMs={10 * 60_000}
                >
                  {`Land phase "${def.id}" of the TUI parity program onto local ${baseBranch}.

Source branch: ${state.branch}
Source worktree: ${state.worktreePath}
You are at the repo root (${root}).

Rules: preserve unrelated concurrent changes (jj st first; never blanket-stage);
merge or rebase the lane branch onto ${baseBranch} resolving conflicts only
within the phase's scope; if lockfiles conflict, regenerate them
(pnpm install, then bun install) rather than hand-merging. Do NOT push to any
remote. After landing, leave ${baseBranch} checked out clean.

Return phase="${def.id}", branch="${state.branch}", mergedToMain=true only if
${baseBranch} now contains the phase's commits (verify with
git merge-base --is-ancestor or jj log), plus the commands you ran.`}
                </Task>
              ) : null}

              {state.merged && !state.postMergeGreen ? (
                <Task id={`${def.id}-post-merge`} output={outputs.tuiParityPostMerge} timeoutMs={60 * 60_000}>
                  {() => runChecks(def.id, def.checks, root)}
                </Task>
              ) : null}

              {review && state.merged && state.postMergeGreen ? (
                <Approval
                  id={`gate-${def.id}`}
                  output={outputs.tuiParityGate}
                  request={{
                    title: `TUI parity: "${def.id}" landed on ${baseBranch}. Continue to the next phase?`,
                    summary: String(state.implementation?.summary ?? def.title),
                  }}
                  onDeny="continue"
                />
              ) : null}
            </Sequence>
          );
        })}

        <Task id="tui-parity-result" output={outputs.tuiParityResult}>
          {{
            status: anyDenied ? "gate-denied" : allLanded ? "landed" : attempted.length > 0 ? "in-progress" : "pending",
            summary:
              landed.length > 0
                ? `Landed phase(s): ${landed.join(", ")} (of ${active.map((p) => p.id).join(", ")}).`
                : `No phase landed yet; attempted: ${attempted.join(", ") || "none"}.`,
            phasesLanded: landed,
            phasesAttempted: attempted,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
