// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Monitor Smithers
// smithers-description: Continuous watchdog over ALL Smithers runs across every project on this machine: detect stuck, blocked, failed, or over-budget runs and escalate.
// smithers-tags: ops, monitoring
/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createSmithers, Ralph, Timer } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import ClassifyPrompt from "../prompts/monitor-smithers-classify.mdx";
import TriagePrompt from "../prompts/monitor-smithers-triage.mdx";

const inputSchema = z.object({
  projects: z
    .array(z.string())
    .nullable()
    .default(null)
    .describe("Project directories to poll. Null auto-discovers every ~/<dir> with a .smithers store."),
  staleMinutes: z
    .number()
    .default(15)
    .describe("A run with no recent activity past this many minutes is treated as stale/stuck."),
  intervalMinutes: z
    .number()
    .default(5)
    .describe("Minutes between watchdog sweeps when iterations > 1."),
  iterations: z
    .number()
    .default(1)
    .describe("How many sweeps to run. 1 = one-shot; raise it to keep watching."),
});

// 1. The raw snapshot of currently-known runs, gathered by shelling out to `ps`
//    in every project directory that has a .smithers store.
const runSchema = z.looseObject({
  project: z.string().default(""),
  runId: z.string(),
  status: z.string(),
  ageMinutes: z.number().default(0),
  lastEvent: z.string().nullable().default(null),
});

const pollSchema = z.looseObject({
  projects: z.array(z.string()).default([]),
  runs: z.array(runSchema).default([]),
  summary: z.string(),
});

// 2. The same runs, sorted into health buckets by a cheap/fast agent.
const classifySchema = z.looseObject({
  buckets: z.looseObject({
    healthy: z.array(z.string()).default([]),
    stuck: z.array(z.string()).default([]),
    blocked: z.array(z.string()).default([]),
    failed: z.array(z.string()).default([]),
    overBudget: z.array(z.string()).default([]),
  }),
  summary: z.string(),
});

// 3. Concrete escalation actions for every non-healthy run.
const triageSchema = z.looseObject({
  actions: z
    .array(
      z.object({
        project: z.string().default(""),
        runId: z.string(),
        problem: z.string(),
        recommendedAction: z.string(),
      }),
    )
    .default([]),
  digest: z.string(),
});

// 4. What the medic actually did about the escalations. Sonnet-led: applies
//    only safe remediations, escalates the rest.
const fixSchema = z.looseObject({
  actionsTaken: z
    .array(
      z.object({
        project: z.string().default(""),
        runId: z.string(),
        action: z.string(),
        result: z.string(),
      }),
    )
    .default([]),
  escalatedToHuman: z.array(z.string()).default([]).describe("runIds needing a human decision"),
  summary: z.string(),
});

// 5. The concise, human-meaningful watchdog verdict per sweep.
const outputSchema = z.object({
  verdict: z.string().describe("healthy when nothing needs escalation, otherwise problems detected"),
  sweep: z.number().describe("1-based sweep number"),
  projectsSeen: z.number(),
  runsSeen: z.number(),
  staleThresholdMinutes: z.number(),
  healthyRuns: z.number(),
  unhealthyRuns: z.number(),
  escalations: z.number().describe("count of concrete escalation actions produced by triage"),
  fixesApplied: z.number().default(0),
  summary: z.string(),
});

const { Workflow, Task, Sequence, Branch, smithers, outputs } = createSmithers({
  input: inputSchema,
  poll: pollSchema,
  classify: classifySchema,
  triage: triageSchema,
  fix: fixSchema,
  output: outputSchema,
});

/** Every ~/<dir> holding a .smithers store, plus the current project. */
function discoverProjects(): string[] {
  const home = homedir();
  const found = new Set<string>([process.cwd()]);
  let entries: string[] = [];
  try {
    entries = readdirSync(home);
  } catch {
    return [...found];
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const dir = path.join(home, entry);
    const store = path.join(dir, ".smithers");
    try {
      if (existsSync(store)) found.add(dir);
    } catch {
      // unreadable dir: skip
    }
  }
  return [...found].sort();
}

/** Poll one project's run table via the CLI. Failures degrade to []. */
async function pollProject(dir: string) {
  const res = await $`bunx smithers-orchestrator ps --format json --all`.cwd(dir).nothrow().quiet();
  if (res.exitCode !== 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.toString());
  } catch {
    return [];
  }

  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { runs?: unknown }).runs)
      ? (parsed as { runs: unknown[] }).runs
      : [];

  return rawList.map((row) => {
    const r = row as Record<string, unknown>;
    const runId = String(r.id ?? r.runId ?? "unknown");
    const status = String(r.status ?? r.dbStatus ?? r.state ?? "unknown");
    const startedRaw = r.started ?? r.startedAt;
    const ageMatch = typeof startedRaw === "string" ? startedRaw.match(/(\d+)\s*([smhd])/) : null;
    let ageMinutes = 0;
    if (ageMatch) {
      const n = Number(ageMatch[1]);
      const unit = ageMatch[2];
      ageMinutes = unit === "m" ? n : unit === "h" ? n * 60 : unit === "d" ? n * 1440 : Math.round(n / 60);
    }
    const step = r.step ?? r.lastEvent;
    const lastEvent = step != null && String(step) !== "—" ? String(step) : null;
    return { project: path.basename(dir), runId, status, ageMinutes, lastEvent };
  });
}

/** Pull the live run tables from every project. Deterministic, no agent. */
async function pollFleet(projects: string[] | null, staleMinutes: number) {
  const dirs = projects && projects.length > 0 ? projects : discoverProjects();
  const perProject = await Promise.all(dirs.map((dir) => pollProject(dir)));
  // Live health only: keep non-terminal runs, plus failures fresh enough
  // (<60m) to still be actionable. Old terminal runs are history, not health —
  // without this the medic re-inspects months-dead runs on every sweep.
  const runs = perProject.flat().filter((run) => {
    if (run.status === "finished" || run.status === "cancelled") return false;
    if (run.status === "failed") return run.ageMinutes < 60;
    return true;
  });
  const active = runs.filter((run) => run.status === "running" || run.status === "continued");
  const staleCount = active.filter((run) => run.ageMinutes >= staleMinutes).length;
  return {
    projects: dirs.map((dir) => path.basename(dir)),
    runs,
    summary: `${dirs.length} project(s), ${runs.length} run(s) seen (${active.length} active); ${staleCount} active past the ${staleMinutes}m stale threshold.`,
  };
}

/**
 * A watchdog over Smithers itself, fleet-wide. Each sweep polls the live run
 * table of EVERY project with a .smithers store, has a cheap agent sort runs
 * into health buckets, and — only when something is wrong — has a review-grade
 * agent produce concrete escalation actions. With iterations > 1 it keeps
 * sweeping on an interval; each sweep is a durable loop iteration.
 */
export default smithers((ctx) => {
  const staleMinutes = ctx.input.staleMinutes ?? 15;
  const intervalMinutes = ctx.input.intervalMinutes ?? 5;
  const iterations = Math.max(1, ctx.input.iterations ?? 1);
  const projects = ctx.input.projects ?? null;

  const poll = ctx.latest(outputs.poll, "poll");
  const classify = ctx.latest(outputs.classify, "classify");
  const triage = ctx.latest(outputs.triage, "triage");
  const fix = ctx.latest(outputs.fix, "fix");
  const sweepsDone = ctx.outputs.output.length;

  // Anything not in the `healthy` bucket needs escalation.
  const buckets = classify?.buckets;
  const unhealthy = buckets
    ? [...buckets.stuck, ...buckets.blocked, ...buckets.failed, ...buckets.overBudget]
    : [];
  const hasProblems = unhealthy.length > 0;

  return (
    <Workflow name="monitor-smithers">
      <Ralph id="watch" until={sweepsDone >= iterations} maxIterations={iterations}>
        <Sequence>
          {/* 1 — Deterministically read every project's live run table. */}
          <Task id="poll" output={outputs.poll}>
            {async () => await pollFleet(projects, staleMinutes)}
          </Task>

          {/* 2 — Sort the runs into health buckets. Cheap/fast: pure classification. */}
          {poll ? (
            <Task id="classify" output={outputs.classify} agent={agents.cheapFast}>
              <ClassifyPrompt runs={poll.runs} summary={poll.summary} staleMinutes={staleMinutes} />
            </Task>
          ) : null}

          {/* 3 — Only escalate when something is actually wrong. */}
          <Branch
            if={classify !== undefined && hasProblems}
            then={
              <Task id="triage" output={outputs.triage} agent={agents.review}>
                <TriagePrompt buckets={classify?.buckets} runs={poll?.runs ?? []} summary={classify?.summary} />
              </Task>
            }
            else={null}
          />

          {/* 4 — The medic: Sonnet applies the smallest safe remediation for
              each escalation, and never guesses on anything destructive. */}
          {triage !== undefined && hasProblems && (triage.actions?.length ?? 0) > 0 ? (
            <Task id="fix" output={outputs.fix} agent={agents.cheapFast} timeoutMs={20 * 60_000}>
              {`You are the fleet medic for Smithers runs on this machine. Triage produced these escalations:

${JSON.stringify(triage.actions, null, 2)}

For each one, cd into the project directory (projects live under $HOME, e.g. /Users/williamcory/<project>; the 'project' field is the directory basename) and apply the SMALLEST safe remediation with the smithers CLI (use \`bunx smithers-orchestrator\` if \`smithers\` is missing):
- Stuck task / heartbeat timeout → \`smithers why <runId>\`, then the retry-task command it suggests.
- Orphaned run (no heartbeat) → resume it detached: \`smithers up <workflow file> --run-id <id> --resume true --force true --detach\`. If resume fails with RESUME_METADATA_MISMATCH, report it — do NOT delete or recreate anything.
- Stale leftover probe/test runs (e2e-*-probe, *-smoke leftovers superseded by a newer run) → \`smithers cancel <runId>\`.
- A run waiting on an approval or human question → do NOT decide it; list it in escalatedToHuman with the question.
NEVER: cancel a run doing real work, push/publish anything, edit workflow source files, or approve/deny gates. When unsure, escalate instead of acting.

Verify each remediation took effect (\`smithers ps\`) and report actionsTaken with results.`}
            </Task>
          ) : null}

          {/* 5 — Aggregate this sweep's verdict so `smithers output` prints
              something useful and the UI has one stable row per sweep. */}
          {classify ? (
            <Task id="output" output={outputs.output}>
              {() => ({
                verdict: hasProblems ? "problems detected" : "healthy",
                sweep: sweepsDone + 1,
                projectsSeen: poll?.projects.length ?? 0,
                runsSeen: poll?.runs.length ?? 0,
                staleThresholdMinutes: staleMinutes,
                healthyRuns: classify.buckets.healthy.length,
                unhealthyRuns: unhealthy.length,
                escalations: triage?.actions.length ?? 0,
                fixesApplied: fix?.actionsTaken?.length ?? 0,
                summary: fix?.summary ?? triage?.digest ?? classify.summary,
              })}
            </Task>
          ) : null}

          {/* 6 — Wait out the sweep interval before the next iteration. */}
          {iterations > 1 && sweepsDone + 1 < iterations ? (
            <Timer id="tick" duration={`${intervalMinutes}m`} />
          ) : null}
        </Sequence>
      </Ralph>
    </Workflow>
  );
});
