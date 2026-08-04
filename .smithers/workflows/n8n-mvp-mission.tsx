// smithers-source: user
// smithers-display-name: N8n MVP Mission
// smithers-description: Never-stop mission loop building the n8n competitor in ~/flows/ui — Fable plans/orchestrates/reviews, Codex Sol implements, Kimi K3 takes UI-heavy lanes, parallel lanes per round, e2e against real jjhub.
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
  plan: planSchema,
  laneResult: laneResultSchema,
  laneReview: laneReviewSchema,
  integrate: integrateSchema,
});

const fablePlanner = new ClaudeCodeAgent({ model: "claude-fable-5", cwd: APP });
const fableReviewer = new ClaudeCodeAgent({ model: "claude-fable-5", cwd: APP });
const solPlanner = new CodexAgent({ model: "gpt-5.6-sol", cwd: APP });
const solImplementer = [
  new CodexAgent({ model: "gpt-5.6-sol", cwd: APP }),
  new ClaudeCodeAgent({ model: "claude-fable-5", cwd: APP }), // codex rate-limit fallback
];
const kimiUi = [
  new OpenCodeAgent({ model: "kimi-for-coding/k3", cwd: APP }),
  new CodexAgent({ model: "gpt-5.6-sol", cwd: APP }),
];

const MISSION_CONTEXT = `MISSION: build a true n8n competitor on jjhub infra in ${APP}. The source of truth is ${TODO}. Everything must be done, reviewed, high quality, and PROVEN by e2e tests against the REAL production jjhub backend (api.jjhub.tech). NO MOCKS anywhere. GitHub e2e flows use the sanctioned codeplanesmithers e2e account (persistent Playwright profile documented in the multi-test-github-account skill at ~/.claude/skills/). Detailed specs live at ${APP}/.oneshot-onboarding-goal.md, ${APP}/.oneshot-web-cloud-goal.md, and /Users/williamcory/flows/docs/specs/Concepts/Connectors Repo.md. Another background run (oneshot-mse12bmn-e2cdc24f) may still be executing the web-cloud refactor — check \`cd ${APP} && bun /Users/williamcory/smithers/apps/cli/src/index.js status oneshot-mse12bmn-e2cdc24f\` and NEVER work on files that run is mid-flight on; plan around it until it finishes.`;

export default smithers((ctx) => {
  const plan = ctx.latest("plan", "mission:plan") as z.infer<typeof planSchema> | undefined;
  const lanes = (plan?.lanes ?? []).slice(0, ctx.input.maxLanes);
  const integrate = ctx.latest("integrate", "mission:integrate") as z.infer<typeof integrateSchema> | undefined;
  const round = ctx.iterationCount("plan", "mission:plan");

  const reviewFor = (laneId: string) =>
    (ctx.outputs.laneReview ?? [])
      .filter((row): row is Record<string, unknown> => Boolean(row))
      .filter((row) => row.laneId === laneId)
      .at(-1) as z.infer<typeof laneReviewSchema> | undefined;

  return (
    <Workflow name="n8n-mvp-mission">
      <UI entry="../ui/n8n-mvp-mission.tsx" title={"N8n MVP Mission"} />
      {/* Never-stop: no `until`. Will stops the run; each round replans, and once coreDone the planner emits polish lanes. */}
      <Loop until={false} maxIterations={Infinity}>
        <Sequence>
          {/* Plan panel: Fable and Sol plan independently; Fable judges + synthesizes the single plan Sol implements. */}
          <Parallel maxConcurrency={2}>
            {(
              [
                { node: "mission:plan-fable", agent: fablePlanner, voice: "Fable" },
                { node: "mission:plan-sol", agent: solPlanner, voice: "Codex Sol" },
              ] as const
            ).map((p) => (
              <Task key={p.node} id={p.node} output={outputs.plan} agent={p.agent}>
                {[
                  MISSION_CONTEXT,
                  `You are ${p.voice}, one of two INDEPENDENT planners on a panel (round ${round + 1}). Read ${TODO}, the specs, current repo state (jj/git status, recent commits), and the previous round's integrate result: ${JSON.stringify(integrate ?? null)}.`,
                  `Propose up to ${ctx.input.maxLanes} PARALLEL lanes of work that do not conflict with each other (disjoint files/areas). Each lane: id (stable slug), title, precise instructions (what to build, what "done" means, which e2e proves it), uiHeavy=true when the lane is primarily UI/visual/motion work, files it will touch.`,
                  `Prioritize: unblock-first (failing checks, integration breaks), then TODO order. Plan for HIGH QUALITY: smaller, verifiable lanes over sprawling ones; every lane names its proof.`,
                  `coreDone=true only when EVERY TODO.md item in sections 1-7 and 9 is [x]. When coreDone, emit polish lanes — the mission never idles.`,
                  ctx.input.prompt,
                ].join("\n\n")}
              </Task>
            ))}
          </Parallel>
          <Task id="mission:plan" output={outputs.plan} agent={fablePlanner}>
            {[
              MISSION_CONTEXT,
              `You are the plan JUDGE and synthesizer (round ${round + 1}). Two independent plans were proposed:`,
              `FABLE'S PLAN:\n${JSON.stringify(ctx.latest("plan", "mission:plan-fable") ?? null)}`,
              `SOL'S PLAN:\n${JSON.stringify(ctx.latest("plan", "mission:plan-sol") ?? null)}`,
              `Judge both critically (coverage, lane independence, verifiability, quality of "done" definitions), then SYNTHESIZE a single superior plan of up to ${ctx.input.maxLanes} non-conflicting lanes — take the best lanes from each, merge overlapping ones, drop weak ones. If a lane failed review last round, re-queue it with the reviewer's feedback folded into its instructions. Sanity-check lane file sets are disjoint. Emit the final plan (same schema).`,
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
                      MISSION_CONTEXT,
                      `LANE ${lane.id}: ${lane.title}`,
                      lane.instructions,
                      lane.files.length ? `Stay within these areas: ${lane.files.join(", ")}` : "",
                      review && !review.approved ? `Previous review feedback to address:\n${review.feedback}` : "",
                      `Work in ${APP}. Real backends only — no mocks. Run the checks relevant to your change (typecheck, tests, build) before reporting. Report laneId="${lane.id}".`,
                    ]
                      .filter(Boolean)
                      .join("\n\n")}
                  </Task>
                  <Task id={`mission:review:${lane.id}`} output={outputs.laneReview} agent={fableReviewer}>
                    {[
                      `Review lane "${lane.id}" (${lane.title}) in ${APP}: inspect the diff (jj diff / git diff), run its checks, judge against the lane instructions and the quality bar in ${APP}/.oneshot-onboarding-goal.md (designed motion, no mocks, e2e-proven, both themes immaculate).`,
                      `approved=true only when the work genuinely meets the bar. Otherwise approved=false with file-level, actionable feedback. Report laneId="${lane.id}". Review ONLY — do not edit files.`,
                    ].join("\n\n")}
                  </Task>
                </Sequence>
              );
            })}
          </Parallel>
          <Task id="mission:integrate" output={outputs.integrate} agent={fableReviewer}>
            {[
              MISSION_CONTEXT,
              `Integrate round ${round + 1}: in ${APP} run the full gate — npm run typecheck && npm run test && npm run build, plus the e2e suite if it exists. Resolve trivial integration breaks yourself; larger breaks go into "failing" for next round's planner.`,
              `Update ${TODO}: flip checkboxes that are now genuinely done+reviewed+e2e-proven ([x]), mark in-progress ([~]). Commit completed work with clear messages (jj or git, matching the repo's convention). Never commit broken state.`,
              `Report checksPassed, failing[], todoUpdated, and a concise round summary.`,
            ].join("\n\n")}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});
