// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Triage Run
// smithers-description: Diagnose one failed or stuck Smithers run: pull events/logs, find the root cause, propose a fix/rewind/retry.
// smithers-tags: ops, debugging
/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import DiagnosePrompt from "../prompts/triage-run-diagnose.mdx";
import RecommendPrompt from "../prompts/triage-run-recommend.mdx";

const inputSchema = z.object({
  // Named targetRunId (not runId): the engine reserves input.runId for the
  // run's own id, so a workflow that inspects ANOTHER run must use a
  // different field name.
  targetRunId: z
    .string()
    .describe("The id of the failed or stuck Smithers run to triage."),
});

// 1. Deterministic evidence pulled straight from the run's state + event log.
const gatherSchema = z.looseObject({
  ok: z
    .boolean()
    .default(false)
    .describe("True when inspect returned readable run state; false means the evidence below is degraded."),
  state: z
    .string()
    .describe("The run's overall status (running | waiting-approval | failed | completed | unknown)."),
  runError: z
    .string()
    .default("")
    .describe("The run-level error message, when the run recorded one."),
  failingNodes: z
    .array(z.object({ id: z.string(), reason: z.string().default("") }))
    .default([])
    .describe("Nodes that errored, are stuck, or are blocking progress."),
  pendingApprovals: z
    .array(z.object({ nodeId: z.string(), status: z.string().default("") }))
    .default([])
    .describe("Approval gates the run is still waiting on; non-empty means the run is suspended on a human."),
  lastEvents: z
    .array(z.string())
    .default([])
    .describe("The tail of the run's event log, most recent last."),
  summary: z
    .string()
    .describe("One line describing what the run state + events show."),
});

// 2. The agent's root-cause read of the gathered evidence.
const diagnoseSchema = z.looseObject({
  rootCauseHypothesis: z
    .string()
    .describe("The single most likely reason the run failed or stalled."),
  evidence: z
    .array(z.string())
    .default([])
    .describe("Concrete observations from state/events that support the hypothesis."),
  confidence: z
    .enum(["low", "medium", "high"])
    .default("medium")
    .describe("How strongly the evidence supports the hypothesis."),
});

// 3. The recommended next move, with the exact command to run.
const recommendSchema = z.looseObject({
  recommendedAction: z
    .enum(["fix", "rewind", "retry", "escalate"])
    .describe("fix code, rewind to an earlier frame, retry the failing task, or escalate to a human."),
  command: z
    .string()
    .describe("The exact CLI command to run next (e.g. a smithers rewind / retry-task invocation)."),
  rationale: z
    .string()
    .describe("Why this action over the alternatives, grounded in the diagnosis."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  gather: gatherSchema,
  diagnose: diagnoseSchema,
  recommend: recommendSchema,
});

const MAX_EVENT_LINES = 60;

function tailLines(text: string, max: number): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-max);
}

// CLI commands append a CTA payload after the JSON document, so a bare
// JSON.parse of the full stdout fails. Parse just the first top-level object.
function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export default smithers((ctx) => {
  const runId = ctx.input.targetRunId;

  // Gate each AI stage on the previous one's persisted output so a resumed run
  // re-renders from exactly where it left off.
  const gather = ctx.outputMaybe("gather", { nodeId: "gather" });
  const diagnose = ctx.outputMaybe("diagnose", { nodeId: "diagnose" });

  return (
    <Workflow name="triage-run">
      <Sequence>
        {/* 1 — Deterministically pull run state + the recent event log. */}
        <Task id="gather" output={outputs.gather}>
          {async () => {
            const inspectRes = await $`bunx smithers-orchestrator inspect ${runId} --format json`
              .nothrow()
              .quiet();
            const eventsRes = await $`bunx smithers-orchestrator events ${runId}`
              .nothrow()
              .quiet();

            const inspectText = inspectRes.stdout?.toString() ?? "";
            const eventsText = `${eventsRes.stdout?.toString() ?? ""}\n${eventsRes.stderr?.toString() ?? ""}`;

            let state = "unknown";
            let runError = "";
            const failingNodes: Array<{ id: string; reason: string }> = [];
            const pendingApprovals: Array<{ nodeId: string; status: string }> = [];

            const parsed = parseFirstJsonObject(inspectText);
            if (parsed) {
              // inspect nests the run record; older shapes had state at the top
              // level — read both so the evidence survives CLI evolution.
              const run = asRecord(parsed.run);
              const runState = asRecord(parsed.runState);
              const rawState = run?.status ?? runState?.state ?? parsed.state ?? parsed.status;
              if (typeof rawState === "string") state = rawState;

              const error = asRecord(run?.error) ?? asRecord(parsed.error);
              if (typeof error?.message === "string") runError = error.message;
              else if (typeof run?.error === "string") runError = run.error;

              const nodes = parsed.nodes ?? parsed.steps;
              if (Array.isArray(nodes)) {
                for (const node of nodes) {
                  const n = asRecord(node);
                  if (!n) continue;
                  const nodeState = typeof n.state === "string" ? n.state : typeof n.status === "string" ? n.status : "";
                  if (nodeState === "failed" || nodeState === "error" || nodeState === "stuck") {
                    const id = typeof n.id === "string" ? n.id : typeof n.nodeId === "string" ? n.nodeId : "(unknown)";
                    const reason = typeof n.error === "string" ? n.error : typeof n.reason === "string" ? n.reason : nodeState;
                    failingNodes.push({ id, reason });
                  }
                }
              }

              if (Array.isArray(parsed.approvals)) {
                for (const approval of parsed.approvals) {
                  const a = asRecord(approval);
                  if (!a) continue;
                  const status = typeof a.status === "string" ? a.status : "";
                  if (status === "approved" || status === "denied") continue;
                  const nodeId = typeof a.nodeId === "string" ? a.nodeId : "(unknown)";
                  pendingApprovals.push({ nodeId, status });
                }
              }
            }

            const lastEvents = tailLines(eventsText, MAX_EVENT_LINES);
            const ok = inspectRes.exitCode === 0 && state !== "unknown";

            const summary = ok
              ? `Run ${runId} is "${state}" with ${failingNodes.length} failing/stuck node(s), ${pendingApprovals.length} pending approval(s), and ${lastEvents.length} recent event line(s).`
              : `Could not read full state for run ${runId}; triaging from ${lastEvents.length} recent event line(s).`;

            return { ok, state, runError, failingNodes, pendingApprovals, lastEvents, summary };
          }}
        </Task>

        {/* 2 — Agent reads the evidence and names the most likely root cause. */}
        {gather ? (
          <Task id="diagnose" output={outputs.diagnose} agent={agents.smart}>
            <DiagnosePrompt runId={runId} evidence={gather} />
          </Task>
        ) : null}

        {/* 3 — Agent proposes the concrete next action + the exact command. */}
        {gather && diagnose ? (
          <Task id="recommend" output={outputs.recommend} agent={agents.smart}>
            <RecommendPrompt runId={runId} evidence={gather} diagnosis={diagnose} />
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
