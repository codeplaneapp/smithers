/** @jsxImportSource smithers-orchestrator */
// new-eval — turn a reported friction/issue into a runnable fluency eval.
//
//   bunx smithers-orchestrator up evals/new-eval.tsx \
//     --input '{"issue":"Agent guessed <Human> for a human approval gate; that component does not exist.","area":"approvals"}'
//
// 1) draft  — a strong model turns the issue into ONE well-formed eval task
//             (kind/verify/tier + a precise instruction + canonicalAnswer/rubric)
// 2) wire   — append it to evals/_inventory/curated-tasks.jsonl and regenerate
//             cases, reporting the suite it landed in + the command to run it.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { models } from "./agents.js";
import { type Task as GenTask, routeSuite } from "./harness/generate-cases.js";
import { repoRoot } from "./lib/paths.js";

const ROOT = repoRoot();
const CURATED = join(ROOT, "evals/_inventory/curated-tasks.jsonl");

const inputSchema = z.object({
  issue: z.string().nullable().default(null).describe("The Smithers friction/struggle to turn into an eval."),
  // Accept `friction` as an alias for `issue` (the README + intuition use either).
  friction: z.string().nullable().default(null).describe("Alias for `issue`."),
  area: z.string().nullable().default(null).describe("Optional feature-area hint."),
  tier: z.enum(["weak", "sota"]).nullable().default(null).describe("Optional tier override."),
});

const draftSchema = z.object({
  id: z.string().describe("kebab-case id, prefixed 'issue-'."),
  feature: z.string(),
  area: z.string().describe("feature-area bucket (e.g. concepts, cli, components-control-flow, sandboxing, scorers)."),
  kind: z.enum(["knowledge", "authoring"]).describe("knowledge=name/answer a thing; authoring=write code."),
  tier: z.enum(["weak", "sota"]).describe("weak unless it requires authoring a genuinely complex multi-feature workflow."),
  verify: z.enum(["equals", "contains", "graph", "judge"]).describe("equals/contains for short knowledge answers; graph for authoring (must render); judge for open-ended."),
  task: z.string().describe("The exact instruction handed to the candidate agent."),
  canonicalAnswer: z.string().nullable().default(null).describe("For equals/contains/graph: the token the verifier greps for (a CLI verb, a <Component tag, a keyword)."),
  mustNot: z.array(z.string()).default([]).describe("Forbidden tokens (e.g. a hallucinated API the candidate must NOT use)."),
  notes: z.string().nullable().default(null).describe("For judge verify: the grading rubric — what a correct answer must contain/do."),
});

const wiredSchema = z.object({
  appended: z.boolean(),
  suite: z.string(),
  casesPath: z.string(),
  runCommand: z.string(),
  note: z.string(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers(
  { input: inputSchema, draft: draftSchema, wired: wiredSchema },
  { dbPath: join(ROOT, ".smithers/state/evals.db") },
);

const DRAFT_PROMPT = (issue: string, area: string | null, tier: string | null) =>
  [
    "You convert a reported friction/struggle with Smithers into ONE well-formed fluency-eval task.",
    "A fluency eval hands a (usually weak) model a Smithers task and checks it can one-shot it from the docs.",
    "",
    `REPORTED ISSUE:\n${issue}`,
    area ? `AREA HINT: ${area}` : "",
    tier ? `TIER HINT: ${tier}` : "",
    "",
    "Consult the Smithers docs/skill (skills/smithers/llms-full.txt, docs/llms-*.txt) to ground the CORRECT answer.",
    "Decide kind + verify + tier and write a precise `task` instruction. Verify mapping:",
    "  • equals/contains → a short knowledge answer; put the exact correct token in canonicalAnswer.",
    "  • graph → authoring; the candidate writes a self-contained workflow that must render; put the required <Component tag in canonicalAnswer, and any hallucinated API to forbid in mustNot.",
    "  • judge → open-ended; put the grading rubric (what a correct answer MUST contain/do) in notes.",
    "Prefer weak tier. Use an id prefixed 'issue-'.",
  ]
    .filter(Boolean)
    .join("\n");

export default smithers((ctx) => {
  const issue = ctx.input.issue ?? ctx.input.friction ?? "Describe the Smithers friction to turn into an eval.";
  const area = ctx.input.area ?? null;
  const tier = ctx.input.tier ?? null;
  const draft = ctx.outputMaybe("draft", { nodeId: "draft" }) as z.infer<typeof draftSchema> | undefined;

  return (
    <Workflow name="new-eval">
      <Sequence>
        <Task id="draft" output={outputs.draft} agent={models.opus} heartbeatTimeoutMs={600_000}>
          {DRAFT_PROMPT(issue, area, tier)}
        </Task>

        {draft ? (
          <Task id="wire" output={outputs.wired}>
            {() => {
              const taskObj: GenTask = {
                id: draft.id,
                feature: draft.feature,
                area: draft.area,
                kind: draft.kind,
                tier: draft.tier,
                verify: draft.verify === "graph" || draft.verify === "judge" ? draft.verify : "deterministic",
                task: draft.task,
                canonicalAnswer: draft.canonicalAnswer ?? "",
                mustNot: draft.mustNot ?? [],
                notes: draft.notes ?? "",
                source: "issue",
              };
              // Avoid duplicate ids.
              const existing = readFileSync(CURATED, "utf8");
              const already = existing.split(/\r?\n/).some((l) => {
                try {
                  return JSON.parse(l)?.id === taskObj.id;
                } catch {
                  return false;
                }
              });
              if (!already) appendFileSync(CURATED, `${JSON.stringify(taskObj)}\n`);
              const suite = routeSuite(taskObj) ?? "real-usage";
              spawnSync("bun", [join(ROOT, "evals/harness/generate-cases.ts")], { cwd: ROOT, encoding: "utf8" });
              return {
                appended: !already,
                suite,
                casesPath: `evals/suites/${suite}/cases.jsonl`,
                runCommand: `bun evals/harness/run-suite.ts ${suite}`,
                note: already ? `Task id ${taskObj.id} already existed; regenerated cases.` : `Added "${taskObj.id}" to ${suite} and regenerated cases.`,
              };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
