// smithers-source: seeded
// smithers-system: true
// smithers-display-name: Post-Failure Autopsy
// smithers-description: Auto-launched when a run fails: investigate why, suggest the fix (retry / rewind / edit-and-reset), and — gated on approval — report suspected smithers bugs via `smithers bug`.
// smithers-tags: ops, debugging
/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import { createSmithers, Approval } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const inputSchema = z.object({
  // Named targetRunId (not runId): the engine reserves input.runId for this
  // run's own id; we are inspecting ANOTHER (failed) run.
  targetRunId: z.string().describe("The id of the failed run to autopsy."),
  workflowPath: z
    .string()
    .nullable()
    .default(null)
    .describe("Path to the failed run's workflow source, when the launcher knew it."),
});

// 1. Deterministic evidence pulled from the failed run.
const gatherSchema = z.looseObject({
  ok: z.boolean().default(false),
  state: z.string().default("unknown"),
  runError: z.string().default(""),
  workflowSource: z.string().default("").describe("The failed workflow's source, when workflowPath was readable."),
  lastEvents: z.array(z.string()).default([]),
  smithersVersion: z.string().default(""),
  summary: z.string(),
});

// 2. The investigator's verdict on why the run failed and what to do.
const investigateSchema = z.looseObject({
  rootCause: z.string().describe("One-paragraph narrative of why the run failed, grounded in the evidence."),
  failureClass: z
    .enum(["workflow-bug", "environment", "agent-flake", "smithers-bug", "unknown"])
    .describe(
      "workflow-bug = defect in the user's workflow script/prompts; environment = missing tool/auth/network; agent-flake = transient agent/provider fault; smithers-bug = defect in smithers itself (engine/CLI/components); unknown = evidence too thin.",
    ),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  evidence: z.array(z.string()).default([]).describe("Concrete lines from events/errors/source supporting the verdict."),
  suggestion: z
    .enum(["retry", "resume", "rewind", "edit-workflow-and-reset", "fix-environment", "escalate"])
    .describe("The single best next move for the user."),
  suggestionDetail: z
    .string()
    .describe("What to actually do: the edit to make, the env fix, or why to escalate."),
  commands: z.array(z.string()).default([]).describe("Exact CLI command(s) implementing the suggestion, in order."),
  bugTitle: z.string().default("").describe("When failureClass=smithers-bug: a one-line bug title."),
  bugBody: z.string().default("").describe("When failureClass=smithers-bug: the full bug report body (repro, expected vs actual, evidence)."),
});

const bugReportSchema = z.looseObject({
  filed: z.boolean().default(false),
  bugId: z.string().default(""),
  bugUrl: z.string().default(""),
  detail: z.string().default(""),
});

const approvalSchema = z.object({ approved: z.boolean() });

// 3. The stable final row `smithers output` prints.
const outputSchema = z.object({
  targetRunId: z.string(),
  failureClass: z.string(),
  confidence: z.string(),
  rootCause: z.string(),
  suggestion: z.string(),
  suggestionDetail: z.string(),
  commands: z.array(z.string()),
  bugFiled: z.boolean(),
  bugUrl: z.string(),
  summary: z.string(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  gather: gatherSchema,
  investigate: investigateSchema,
  bugApproval: approvalSchema,
  bugReport: bugReportSchema,
  output: outputSchema,
});

const MAX_EVENT_LINES = 80;
const MAX_SOURCE_CHARS = 20_000;

function tailLines(text: string, max: number): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-max);
}

export default smithers((ctx) => {
  const targetRunId = ctx.input.targetRunId;
  const workflowPath = ctx.input.workflowPath ?? null;

  const gather = ctx.outputMaybe("gather", { nodeId: "gather" });
  const investigate = ctx.outputMaybe("investigate", { nodeId: "investigate" });
  const bugApproval = ctx.outputMaybe("bugApproval", { nodeId: "approve-bug-report" });
  const bugReport = ctx.outputMaybe("bugReport", { nodeId: "report-bug" });

  const isSmithersBug = investigate?.failureClass === "smithers-bug";
  // The bug lane is settled when it isn't a smithers bug, when the human
  // denied, or when the report task has run.
  const bugLaneSettled =
    investigate !== undefined &&
    (!isSmithersBug || bugApproval?.approved === false || bugReport !== undefined);

  return (
    <Workflow name="post-failure">
      <Sequence>
        {/* 1 — Deterministically pull the failed run's state, events, and source. */}
        <Task id="gather" output={outputs.gather}>
          {async () => {
            const inspectRes = await $`bunx smithers-orchestrator inspect ${targetRunId} --format json`
              .nothrow()
              .quiet();
            const eventsRes = await $`bunx smithers-orchestrator events ${targetRunId}`.nothrow().quiet();
            const versionRes = await $`bunx smithers-orchestrator --version`.nothrow().quiet();

            const inspectText = inspectRes.stdout?.toString() ?? "";
            const eventsText = `${eventsRes.stdout?.toString() ?? ""}\n${eventsRes.stderr?.toString() ?? ""}`;

            let state = "unknown";
            let runError = "";
            const stateMatch = inspectText.match(/"status"\s*:\s*"([^"]+)"/);
            if (stateMatch?.[1]) state = stateMatch[1];
            const errorMatch = inspectText.match(/"error"\s*:\s*("(?:[^"\\]|\\.)*")/);
            if (errorMatch?.[1]) {
              try {
                runError = JSON.parse(errorMatch[1]) as string;
              } catch {
                runError = errorMatch[1];
              }
            }

            let workflowSource = "";
            if (workflowPath) {
              try {
                workflowSource = (await Bun.file(workflowPath).text()).slice(0, MAX_SOURCE_CHARS);
              } catch {
                workflowSource = "";
              }
            }

            const lastEvents = tailLines(eventsText, MAX_EVENT_LINES);
            const ok = inspectRes.exitCode === 0 && state !== "unknown";
            return {
              ok,
              state,
              runError,
              workflowSource,
              lastEvents,
              smithersVersion: versionRes.stdout?.toString().trim() ?? "",
              summary: ok
                ? `Run ${targetRunId} is "${state}"${runError ? ` with error: ${runError.slice(0, 200)}` : ""}; ${lastEvents.length} event line(s) gathered.`
                : `Could not fully read run ${targetRunId}; working from ${lastEvents.length} event line(s).`,
            };
          }}
        </Task>

        {/* 2 — Smart investigator WITH tools: dig until the cause is named. */}
        {gather ? (
          <Task id="investigate" output={outputs.investigate} agent={agents.smart} timeoutMs={30 * 60_000}>
            {`You are the investigator in a post-failure autopsy. Smithers run "${targetRunId}" failed and this autopsy was launched automatically. Find out WHY, classify the failure, and produce ONE concrete suggestion.

You have shell access — use it for READ-ONLY digging only: \`bunx smithers-orchestrator inspect ${targetRunId} --format json\`, \`bunx smithers-orchestrator events ${targetRunId}\`, \`bunx smithers-orchestrator output ${targetRunId} <nodeId>\`, reading workflow/prompt source files, checking tool availability (\`which\`, versions), and reading logs. Do NOT mutate anything: no retry, no rewind, no edits, no commits — you only diagnose and recommend.

Pre-gathered evidence (dig deeper yourself where it is thin):
${JSON.stringify({ state: gather.state, runError: gather.runError, smithersVersion: gather.smithersVersion, lastEvents: gather.lastEvents, workflowPath, workflowSourcePreview: gather.workflowSource.slice(0, 4000) }, null, 2)}

Classify failureClass strictly:
- "workflow-bug": the workflow script/prompts are at fault (bad schema, wrong deps/needs, a compute task throwing, a prompt asking the impossible).
- "environment": missing CLI/auth/network/disk on this machine; the workflow and smithers are fine.
- "agent-flake": a transient provider fault (rate limit/429, 5xx, timeout, truncated agent output that a re-run would likely clear).
- "smithers-bug": smithers itself misbehaved — an engine/CLI/component defect, e.g. a crash inside smithers-orchestrator code, a scheduler deadlock on a valid graph, state corruption, an error message pointing into smithers internals rather than the workflow. Be conservative: only pick this when the evidence points INTO smithers code, and say why the workflow/environment are exonerated.
- "unknown": evidence too thin to say; keep confidence low.

Choose suggestion (one):
- "retry" — transient; re-run the failed task (\`smithers retry-task\`) or the whole run.
- "resume" — the run can continue from where it stopped (\`smithers up <workflow> --run-id ${targetRunId} --resume true\`).
- "rewind" — state is bad but an earlier frame is good (\`smithers rewind\`).
- "edit-workflow-and-reset" — the workflow script needs a fix first; describe the exact edit in suggestionDetail, then the reset/re-run command. NOTE: never edit a script while its run is resumable — that causes RESUME_METADATA_MISMATCH; a fresh run is required after the edit.
- "fix-environment" — name the exact install/auth/config fix.
- "escalate" — a human must decide; say what to look at.

Put the exact command(s) in \`commands\`, runnable from the failed run's project directory.

If (and only if) failureClass is "smithers-bug", also write \`bugTitle\` (one line) and \`bugBody\` (markdown: what happened, minimal repro or the failing run's shape, expected vs actual, the evidence lines, smithers version "${gather.smithersVersion}"). A human will review these before anything is sent.`}
          </Task>
        ) : null}

        {/* 3 — Human gate: only file a smithers bug with explicit approval. */}
        {investigate && isSmithersBug && !bugApproval ? (
          <Approval
            id="approve-bug-report"
            output={outputs.bugApproval}
            onDeny="skip"
            request={{
              title: "Autopsy suspects a bug in smithers itself — report it to bug.smithers.sh?",
              summary: `While investigating failed run ${targetRunId}, the autopsy concluded (confidence: ${investigate.confidence}) this looks like a smithers bug, not a workflow or environment problem.\n\n${investigate.rootCause}\n\nProposed report: "${investigate.bugTitle}"\n\nApprove to file it via \`smithers bug\`; deny to skip reporting (the autopsy verdict is kept either way).`,
            }}
          />
        ) : null}

        {/* 4 — File the bug through the CLI once approved. */}
        {investigate && isSmithersBug && bugApproval?.approved ? (
          <Task id="report-bug" output={outputs.bugReport}>
            {async () => {
              const res = await $`bunx smithers-orchestrator bug --run ${targetRunId} --title ${investigate.bugTitle || "Smithers failure detected by post-failure autopsy"} --body ${investigate.bugBody || investigate.rootCause} --json`
                .nothrow()
                .quiet();
              const text = res.stdout?.toString() ?? "";
              let bugId = "";
              let bugUrl = "";
              try {
                const parsed = JSON.parse(text) as { id?: string; url?: string };
                bugId = parsed.id ?? "";
                bugUrl = parsed.url ?? "";
              } catch {
                // non-JSON output: keep the raw tail as detail below
              }
              return {
                filed: res.exitCode === 0,
                bugId,
                bugUrl,
                detail: res.exitCode === 0 ? text.trim().slice(-500) : (res.stderr?.toString() ?? text).trim().slice(-500),
              };
            }}
          </Task>
        ) : null}

        {/* 5 — Stable verdict row for `smithers output` and the trigger CTA. */}
        {gather && investigate && bugLaneSettled ? (
          <Task id="output" output={outputs.output}>
            {() => ({
              targetRunId,
              failureClass: investigate.failureClass,
              confidence: investigate.confidence,
              rootCause: investigate.rootCause,
              suggestion: investigate.suggestion,
              suggestionDetail: investigate.suggestionDetail,
              commands: investigate.commands,
              bugFiled: bugReport?.filed ?? false,
              bugUrl: bugReport?.bugUrl ?? "",
              summary: `${investigate.failureClass} (${investigate.confidence}): ${investigate.suggestion} — ${gather.summary}`,
            })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
