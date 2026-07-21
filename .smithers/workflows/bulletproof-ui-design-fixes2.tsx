// smithers-display-name: Bulletproof UI Design Fixes 2
/** @jsxImportSource smithers-orchestrator */
import { OpenCodeAgent as SmithersOpenCodeAgent, Sequence, Task, UI, Worktree, createSmithers } from "smithers-orchestrator";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";

// Round-based residual burner for the kimi HOLD verdict on the design-fix
// campaign: each round one sol worker fixes the current residual list in a
// fresh worktree, terra validates, it lands, the full gate runs isolated
// (now INCLUDING apps/review tests), and kimi re-verifies. Rounds repeat
// until kimi reports zero residuals or maxRounds is reached.
const solChain = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true },
  [providers.claude, providers.claudeSonnet],
);
const terraChain = codexFirst(
  { model: "gpt-5.6-terra", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true },
  [providers.claudeSonnet, providers.claude],
);
const kimiDesigner = new SmithersOpenCodeAgent({ model: "kimi-for-coding/k3" });

const SEED_RESIDUALS = [
  "R1 walkthroughCss fails its own contract tests on trunk: 12 surviving 12.5px declarations (apps/review/src/walkthrough/walkthroughCss.ts lines ~33,46,55,123,134,141,156,162,260,262,268,272) plus its second failing assertion; make apps/review tests genuinely green.",
  "R2 seeded pack UI ships the OLD failing contrast ramp: .smithers/ui/cw-theme.ts:15 declares --success:#0f8f78 --danger:#e5484d --warning:#bf7100 and a #0f8f78 border literal at :133, mirrored into the generated pack under apps/cli. Update the source theme to the corrected ramp and regenerate the shipped pack (scripts/generate-workflow-pack.ts output must be regenerated and committed, never hand-edited).",
  "R3 standaloneThemeCss dark blocks (BOTH the media-query and data-theme dark token sets) still carry --text-faint:#71717a (~3.8:1 on --surface #141417, fails AA); apply the corrected dark faint value consistently with the styleguide index.ts fix.",
  "R4 focus-ring blocker (a whole exhausted lane, all real): crepeTheme.generated.ts ships focus-visible{outline:none} with no replacement ring (regenerate via its generator with a house-token ring); gateway-ui NodeRow/RunList/ApprovalPanel interactive elements still inline-styled without focus-visible treatment (convert to class rules in their CSS strings); monitor tree/timeline buttons and walkthrough anchor links lack visible focus rings.",
  "R5 soft-tint leftovers: monitor.tsx (~lines 3341-3604) hand-rolls --tone color-mix percentages (6/8/9/10/12/30/40/45/55/60%) across pills/banners/toggles/tracks; gateway-ui StatusPill/NodeRow/RunList/NodeOutputCard similar. Migrate onto the shared *-soft/*-border tokens landed by the tokens-contrast lane (extend gateway-ui theme.ts with the soft tints if needed).",
  "R6 reduced-motion leftovers: terminal cursorBlink (packages/ui/src/adapters/terminal.tsx ~lines 144,221 xterm option) needs a prefers-reduced-motion guard (matchMedia at mount, no blink when reduced); crepeTheme.generated.ts has zero reduced-motion blocks (caret blink unguarded) — add via the generator.",
  "R7 diff color language: PierreDiffView (packages/ui/src/adapters/pierre-diff-view.tsx ~lines 34,144-145) maps onto Shiki github-light/github-dark theme names rather than house diff tokens. Align what is cheap (theme selection through resolveTheme, container chrome on house tokens); if full Shiki token authoring is invasive, document the deferral in the styleguide README/report instead and say so in your summary.",
].join("\n");

const fixSchema = z.object({
  round: z.number().int().min(0),
  status: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string().min(20),
  fixedResiduals: z.array(z.string()).min(1),
  deferredWithEvidence: z.array(z.string()).default([]),
  filesChanged: z.array(z.string()).min(1),
});
const validationSchema = z.object({
  round: z.number().int().min(0),
  allPassed: z.boolean(),
  branchDiffNonEmpty: z.boolean(),
  summary: z.string().min(20),
  commandsRun: z.array(z.string()).min(1),
  failingSummary: z.string().nullable().default(null),
});
const mergeSchema = z.object({
  round: z.number().int().min(0),
  mergedToMain: z.boolean(),
  summary: z.string().min(10),
});
const gateSchema = z.object({
  round: z.number().int().min(0),
  allPassed: z.boolean(),
  mainCommit: z.string().min(6),
  summary: z.string().min(20),
});
const reverifySchema = z.object({
  round: z.number().int().min(0),
  clean: z.boolean(),
  verdict: z.string().min(50),
  residuals: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  maxRounds: z.number().int().min(1).max(4).default(3),
  baseBranch: z.string().trim().min(1).default("main"),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  bpuiDf2Fix: fixSchema,
  bpuiDf2Validation: validationSchema,
  bpuiDf2Merge: mergeSchema,
  bpuiDf2Gate: gateSchema,
  bpuiDf2Reverify: reverifySchema,
});

type RawRow = Record<string, unknown>;

function rawRows(ctx: any, channel: string): RawRow[] {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(rows) ? rows.filter((row): row is RawRow => typeof row === "object" && row !== null) : [];
}

export function resolveRepoRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : process.cwd();
}

const GATE_COMMANDS = [
  "pnpm typecheck",
  "pnpm -C packages/ui test",
  "pnpm -C packages/ui-styleguide test",
  "pnpm -C packages/gateway-ui test",
  "pnpm -C apps/review test",
  "pnpm check:ui-architecture",
  "pnpm check:docs",
  "pnpm check:llms",
].join("; ");

export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxRounds: Number(ctx.input?.maxRounds ?? 3),
    baseBranch: String(ctx.input?.baseBranch ?? "main"),
  });
  const repoRoot = resolveRepoRoot();
  const runSlug = String((ctx as any).runId ?? "bpui-df2").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const round = ctx.iteration ?? 0;
  const branch = `bpui-df2/${runSlug}/round-${round}`;
  const worktreePath = join(repoRoot, ".smithers", "workflows", ".worktrees", runSlug, `round-${round}`);

  const reverifies = rawRows(ctx, "bpuiDf2Reverify");
  const latestReverify = reverifies.at(-1);
  const done = latestReverify?.clean === true;
  const currentResiduals = round === 0 || !latestReverify
    ? SEED_RESIDUALS
    : (() => {
        const rs = latestReverify.residuals;
        const list = Array.isArray(rs) ? rs : typeof rs === "string" ? (() => { try { return JSON.parse(rs); } catch { return [rs]; } })() : [];
        return list.map((r: unknown, i: number) => `R${i + 1} ${String(r)}`).join("\n");
      })();

  const roundRows = (channel: string) => rawRows(ctx, channel).filter((row) => Number(row.round) === round);
  const fix = roundRows("bpuiDf2Fix").at(-1);
  const validation = roundRows("bpuiDf2Validation").at(-1);
  const merge = roundRows("bpuiDf2Merge").at(-1);
  const gate = roundRows("bpuiDf2Gate").at(-1);

  return (
    <Workflow name="bulletproof-ui-design-fixes2">
      <UI entry="../ui/bulletproof-ui-design-fixes2.tsx" title="Bulletproof UI Design Fixes 2" />
      <Loop id="df2-rounds" until={done} maxIterations={input.maxRounds} onMaxReached="return-last">
        <Sequence>
          <Worktree path={worktreePath} branch={branch} baseBranch={input.baseBranch}>
            <Sequence>
              <Task id="df2-fix" output={outputs.bpuiDf2Fix} agent={solChain} retries={2} timeoutMs={90 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                {[
                  `Fix the design-system residuals below (round ${round}). Return round=${round} exactly.`,
                  "Each item was verified with file evidence by an independent design re-check; fix them all. R7 alone may be deferred with written evidence if truly invasive.",
                  currentResiduals,
                  "House rules: read packages/ui/src/README.md and .smithers/specs/bulletproof-ui-design-pass.md first; tokens-only colors; CSS as strings; fallbacks byte-equal to styleguide light values; generated files (crepeTheme.generated.ts, the shipped pack) change ONLY via their generators, regenerated and committed. Red-to-green tests for every fix (the WCAG contrast test must cover the dark faint pair; a focus-visible test per surface touched). Use jj; explicit pathspec commits; never git add -A / stash / amend; never edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/bulletproof-ui*.tsx.",
                  "Run the focused tests for every package you touch until green. Return implemented only when they pass; list fixedResiduals and deferredWithEvidence honestly.",
                ].join("\n\n")}
              </Task>
              <Task id="df2-validate" output={outputs.bpuiDf2Validation} agent={terraChain} retries={2} timeoutMs={40 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                {[
                  `Validate round ${round} in this worktree. Return round=${round} exactly.`,
                  `Fix report:\n${JSON.stringify(fix ?? null, null, 2)}`,
                  `Run, do not trust: 1) the BRANCH fork-point diff (jj diff --from "fork_point(main | ${branch})" --to ${branch} --stat; clean working copy expected); 2) for EACH claimed fixedResidual, verify the specific file evidence is gone (grep the exact hexes/lines); 3) focused tests for every touched package INCLUDING pnpm -C apps/review test; 4) pnpm check:ui-architecture and pnpm check:docs. Inherited failures outside the diff: name them, do not count against allPassed.`,
                ].join("\n\n")}
              </Task>
            </Sequence>
          </Worktree>

          {fix && validation && validation.allPassed === true && validation.branchDiffNonEmpty === true ? (
            <Task id="df2-merge" output={outputs.bpuiDf2Merge} agent={terraChain} retries={2} timeoutMs={45 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
              {[
                `Land round ${round} onto local ${input.baseBranch}. Worktree: ${worktreePath}; bookmark: ${branch}. Return round=${round} exactly.`,
                `Recipe: verify the fork-point diff is NON-EMPTY; jj rebase -b ${branch} -d ${input.baseBranch}; conflicts only in lane files; run the focused tests in the rebased tree; CAS the bookmark (confirm ${input.baseBranch} unmoved, else re-rebase); jj bookmark set ${input.baseBranch} -r <rebased-tip>; verify the delta contains ONLY this round's files; do NOT push to origin. jj only; never blanket-stage.`,
              ].join("\n\n")}
            </Task>
          ) : null}

          {merge && merge.mergedToMain === true ? (
            <Task id="df2-gate" output={outputs.bpuiDf2Gate} agent={terraChain} retries={2} timeoutMs={100 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
              {[
                `Run the full gate suite against ACTUAL local main in a pristine isolated worktree. Return round=${round} exactly.`,
                `Steps: MAIN=$(jj log -r ${input.baseBranch} -T commit_id --no-graph | head -c 12); git worktree add --detach /tmp/bpui-df2-gate-${round} $MAIN; cd there; pnpm install --frozen-lockfile (failure = gate failure); run: ${GATE_COMMANDS}; report mainCommit and allPassed with failing detail in summary; ALWAYS git worktree remove --force /tmp/bpui-df2-gate-${round}.`,
                "Report honestly; fix nothing here. If red, note the failures precisely: the next round's fixer consumes your summary.",
              ].join("\n\n")}
            </Task>
          ) : null}

          {gate && gate.allPassed === true ? (
            <Task id="df2-reverify" output={outputs.bpuiDf2Reverify} agent={kimiDesigner} retries={2} timeoutMs={40 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
              {[
                `Design re-verification, round ${round}. READ-ONLY: edit nothing. Return round=${round} exactly.`,
                "Verify ON THE CURRENT TREE that every residual below is genuinely resolved: grep the exact old hexes and outline:none, recompute the flagged contrast pairs, check the focus rules reach the named components, check reduced-motion guards exist where named, check the regenerated pack mirrors the fixed source.",
                currentResiduals,
                `Also honor legitimate documented deferrals from the fixer:\n${JSON.stringify(fix?.deferredWithEvidence ?? [], null, 2)}`,
                "Return clean=true ONLY if every item is fixed or legitimately deferred with written evidence. Otherwise clean=false with a precise residuals list (file:line evidence each) for the next round.",
              ].join("\n\n")}
            </Task>
          ) : null}
        </Sequence>
      </Loop>
    </Workflow>
  );
});
