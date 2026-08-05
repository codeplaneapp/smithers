// smithers-source: user
// smithers-display-name: N8n MVP Mission V2
// smithers-description: Zero-steering never-stop mission — every manual intervention from v1 encoded as structure: env preflight+remediation, lane timeouts, granularity/load/blocker rules in the planner, durable ask-human for owner decisions with auto-adopt fallback, self-relaunching via cron supervisor.
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { ClaudeCodeAgent, CodexAgent, OpenCodeAgent, createSmithers, Parallel, Sequence } from "smthrs";
import { z } from "zod/v4";

const APP = "/Users/williamcory/flows/ui";
const TODO = `${APP}/TODO.md`;

const laneSchema = z.looseObject({
  id: z.string().default("lane"),
  title: z.string().default("Lane"),
  instructions: z.string().default("Complete the assigned work."),
  uiHeavy: z.boolean().default(false),
  files: z.array(z.string()).default([]),
});

const planSchema = z.looseObject({
  summary: z.string().default(""),
  lanes: z.array(laneSchema).default([]),
  coreDone: z.boolean().default(false),
  notes: z.string().default(""),
});

const preflightSchema = z.looseObject({
  ok: z.boolean().default(false),
  freeDiskGb: z.number().default(0),
  load1: z.number().default(0),
  remediated: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),
});

const laneResultSchema = z.looseObject({
  laneId: z.string().default("lane"),
  status: z.enum(["success", "partial", "failed"]).default("partial"),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
});

const laneReviewSchema = z.looseObject({
  laneId: z.string().default("lane"),
  approved: z.boolean().default(false),
  feedback: z.string().default(""),
});

const integrateSchema = z.looseObject({
  checksPassed: z.boolean().default(false),
  summary: z.string().default(""),
  failing: z.array(z.string()).default([]),
  todoUpdated: z.boolean().default(false),
});

const inputSchema = z.object({
  prompt: z
    .string()
    .default("Work through TODO.md until everything is done, reviewed, and e2e-proven; then keep polishing."),
  maxLanes: z.number().int().min(1).max(8).default(4),
});

const { Workflow, Task, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  preflight: preflightSchema,
  plan: planSchema,
  laneResult: laneResultSchema,
  laneReview: laneReviewSchema,
  integrate: integrateSchema,
});

// v1 lesson: three lanes wedged with flat CPU and needed manual process kills.
const LANE_TIMEOUT_MS = 75 * 60 * 1000;

const fable = new ClaudeCodeAgent({ model: "claude-fable-5", cwd: APP });
const solPlanner = new CodexAgent({ model: "gpt-5.6-sol", cwd: APP });
const solImplementer = [
  new CodexAgent({ model: "gpt-5.6-sol", cwd: APP, timeoutMs: LANE_TIMEOUT_MS }),
  new ClaudeCodeAgent({ model: "claude-fable-5", cwd: APP, timeoutMs: LANE_TIMEOUT_MS }),
];
const kimiUi = [
  new OpenCodeAgent({ model: "kimi-for-coding/k3", cwd: APP, timeoutMs: LANE_TIMEOUT_MS }),
  new CodexAgent({ model: "gpt-5.6-sol", cwd: APP, timeoutMs: LANE_TIMEOUT_MS }),
];

const CONTEXT = `MISSION: build a true n8n competitor on jjhub infra in ${APP}. Source of truth: ${TODO}. Everything must be done, reviewed, high quality, and PROVEN by e2e tests against the REAL production jjhub backend (api.jjhub.tech) — twice consecutively green. NO MOCKS anywhere. GitHub e2e uses the sanctioned codeplanesmithers account (multi-test-github-account skill at ~/.claude/skills/). Specs: ${APP}/.oneshot-onboarding-goal.md, ${APP}/.oneshot-web-cloud-goal.md, /Users/williamcory/flows/docs/specs/Concepts/Connectors Repo.md. Commit completed work early and often; never commit broken state.`;

// v1 lesson: external blockers (tokens, quotas, allowlists, missing endpoints) were
// discovered serially at e2e time, and owner decisions (pricing) idled for hours.
// Zero-steering policy: the WORKFLOW asks will directly and never dead-ends.
const DECISION_POLICY = `OWNER-DECISION POLICY (zero-steering): when work needs something only will can provide (credentials, a paid account, a prod deploy approval, a pricing/product decision):
1. File or update a smithersai/ui issue with the exact ask and a researched recommendation.
2. Raise a durable human request via \`smithers ask-human\` with the recommendation as the default.
3. Do NOT block the round on the answer: if a recommendation exists and the decision is reversible (pricing tiers, copy, defaults), ADOPT THE RECOMMENDATION now, record "adopted-pending-will" in TODO.md, and keep building — will revises later. Only truly irreversible/paid actions (spending money, prod cluster changes, publishing externally) wait for the human response.
4. Blocked proof legs stay [~] in TODO.md with the blocking env var / endpoint / approval named exactly.`;

const PLAN_RULES = (
  maxLanes: number,
) => `Propose up to ${maxLanes} PARALLEL lanes of non-conflicting work (disjoint files/areas). Each lane: id (stable slug), title, precise instructions (what to build, what "done" means, WHICH e2e proves it), uiHeavy flag, files.
RULES (each one exists because its absence cost hours in v1):
- ROUND 1 IS RECONNAISSANCE: the first round's lanes must include a dependency-recon lane that enumerates EVERYTHING outside this repo the mission will need (credentials, API endpoints, quotas, OAuth allowlists, deploys), files issues, and raises the ask-human batch per the owner-decision policy — so nothing is discovered serially at e2e time.
- SMALL VERIFIABLE LANES: target under ~45 minutes of agent work each; split spec-sized efforts into sub-lanes with their own proofs. Never emit a mega-lane that serializes the round.
- LOAD RULE: the production e2e suite is only trustworthy at 1-minute load < 12, and parallel lanes ARE the load. When a prod-e2e proof leg is the top priority, emit a SOLO round: exactly one lane that checks \`uptime\`, waits for load to drain, then runs the full suite twice.
- Priorities: unblock-first (failing checks, integration breaks), then TODO order. Re-queue review-rejected lanes with the feedback folded into instructions.
- coreDone=true only when TODO sections 1-7 and 9 are all [x]. After coreDone DO NOT stop: emit polish lanes forever (motion quality, copy, perf, a11y, flake hunts, e2e depth). The mission never idles.`;

export default smithers((ctx) => {
  const plan = ctx.latest("plan", "mission:plan") as z.infer<typeof planSchema> | undefined;
  const lanes = (plan?.lanes ?? []).slice(0, ctx.input.maxLanes);
  const integrate = ctx.latest("integrate", "mission:integrate") as z.infer<typeof integrateSchema> | undefined;
  const preflight = ctx.latest("preflight", "mission:preflight");
  const round = ctx.iterationCount("plan", "mission:plan");

  const reviewFor = (laneId: string) =>
    (ctx.outputs.laneReview ?? []).filter((row) => Boolean(row) && row.laneId === laneId).at(-1) as
      | z.infer<typeof laneReviewSchema>
      | undefined;

  const planBody = (voice: string) =>
    [
      CONTEXT,
      DECISION_POLICY,
      `You are ${voice}, one of two INDEPENDENT panel planners (round ${round + 1}). Read ${TODO}, the specs, repo state (jj/git status, recent commits), the previous integrate result: ${JSON.stringify(integrate ?? null)}, and the environment preflight: ${JSON.stringify(preflight ?? null)}.`,
      PLAN_RULES(ctx.input.maxLanes),
      ctx.input.prompt,
    ].join("\n\n");

  return (
    <Workflow name="n8n-mvp-mission-v2">
      <UI entry="../ui/n8n-mvp-mission.tsx" title={"N8n MVP Mission V2"} />
      {/* Never-stop. Belt-and-braces against engine finish defects (smithers#1492):
          a cron supervisor relaunches this workflow if it is ever not running. */}
      <Loop until={false} maxIterations={Infinity}>
        <Sequence>
          {/* v1 lesson: ENOSPC orphaned a run mid-flight and load-80 made e2e
              untrustworthy. Rounds never fan out onto a sick machine. */}
          <Task id="mission:preflight" output={outputs.preflight} agent={solPlanner}>
            {`Environment preflight only — no repo work. Measure free disk GB on /System/Volumes/Data (df -g) and 1-minute load (uptime). If disk < 30GB: remediate (delete /private/tmp entries older than 7 days, .smithers logs older than 3 days, finished-run worktrees under .smithers/workflows/.worktrees whose campaigns are landed — NEVER live DBs or user repos) and re-measure; list what you removed in remediated[]. ok=false with issues[] only when disk < 15GB after remediation or 1-min load > 40 sustained across two 60s samples (then this round's planners should emit a single light lane instead of fanning out).`}
          </Task>
          <Parallel maxConcurrency={2}>
            {(
              [
                { node: "mission:plan-fable", agent: fable, voice: "Fable" },
                { node: "mission:plan-sol", agent: solPlanner, voice: "Codex Sol" },
              ] as const
            ).map((p) => (
              <Task key={p.node} id={p.node} output={outputs.plan} agent={p.agent}>
                {planBody(p.voice)}
              </Task>
            ))}
          </Parallel>
          <Task id="mission:plan" output={outputs.plan} agent={fable}>
            {[
              CONTEXT,
              DECISION_POLICY,
              `You are the plan JUDGE and synthesizer (round ${round + 1}). Two independent plans:\nFABLE:\n${JSON.stringify(ctx.latest("plan", "mission:plan-fable") ?? null)}\nSOL:\n${JSON.stringify(ctx.latest("plan", "mission:plan-sol") ?? null)}`,
              `Judge both critically (coverage, lane independence, verifiability, "done" quality), then SYNTHESIZE one superior plan of up to ${ctx.input.maxLanes} disjoint lanes — best lanes from each, merge overlaps, drop weak ones. Enforce every planning rule:`,
              PLAN_RULES(ctx.input.maxLanes),
            ].join("\n\n")}
          </Task>
          <Parallel maxConcurrency={ctx.input.maxLanes}>
            {lanes.map((lane) => {
              const review = reviewFor(lane.id);
              return (
                <Sequence key={lane.id}>
                  <Task
                    id={`mission:impl:${lane.id}`}
                    output={outputs.laneResult}
                    agent={lane.uiHeavy ? kimiUi : solImplementer}
                  >
                    {[
                      CONTEXT,
                      DECISION_POLICY,
                      `LANE ${lane.id}: ${lane.title}`,
                      lane.instructions,
                      lane.files.length ? `Stay within: ${lane.files.join(", ")}` : "",
                      review && !review.approved ? `Previous review feedback to address:\n${review.feedback}` : "",
                      `Run the checks relevant to your change before reporting. Report laneId="${lane.id}".`,
                    ]
                      .filter(Boolean)
                      .join("\n\n")}
                  </Task>
                  <Task id={`mission:review:${lane.id}`} output={outputs.laneReview} agent={fable}>
                    {[
                      `Review lane "${lane.id}" (${lane.title}) in ${APP}: inspect the diff (jj diff / git diff), run its checks, judge against the lane instructions and the quality bar in ${APP}/.oneshot-onboarding-goal.md (designed motion, no mocks, e2e-proven, both themes immaculate).`,
                      `approved=true only when it genuinely meets the bar; otherwise file-level actionable feedback. Review ONLY — never edit files. Report laneId="${lane.id}".`,
                    ].join("\n\n")}
                  </Task>
                </Sequence>
              );
            })}
          </Parallel>
          <Task id="mission:integrate" output={outputs.integrate} agent={fable}>
            {[
              CONTEXT,
              `Integrate round ${round + 1}: run the full gate — npm run typecheck && npm run test && npm run build. Run the e2e suite ONLY if 1-minute load < 12 (check uptime; otherwise record it deferred so the next plan emits a solo e2e round). Fix trivial integration breaks yourself; larger ones go into failing[] for the next planner. Update ${TODO} honestly ([x] strictly means done+reviewed+e2e-proven twice consecutively). Commit with clear messages; never commit broken state. Report checksPassed, failing[], todoUpdated, summary.`,
            ].join("\n\n")}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});
