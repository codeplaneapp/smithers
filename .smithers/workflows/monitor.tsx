// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Monitor
// smithers-description: Watch, diagnose, optionally self-fix, and report (HTML) on a single running Smithers workflow.
// smithers-tags: ops, monitoring, reporting
/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import DiagnosePrompt from "../prompts/monitor-diagnose.mdx";
import FixPrompt from "../prompts/monitor-fix.mdx";
import ReportPrompt from "../prompts/monitor-report.mdx";

const inputSchema = z.object({
  // Named targetRunId (not runId): the engine reserves input.runId for the
  // monitor run's own id, so a workflow that watches ANOTHER run uses a
  // different field. Null lets the gather step auto-pick the latest active run.
  targetRunId: z
    .string()
    .nullable()
    .default(null)
    .describe("Run id to monitor. Null auto-selects the most recent active run."),
  title: z
    .string()
    .nullable()
    .default(null)
    .describe("Optional report title. Null derives one from the run."),
  autofix: z
    .boolean()
    .default(false)
    .describe("Let the monitor apply the smallest safe self-fix and resume the run."),
  requireApproval: z
    .boolean()
    .default(true)
    .describe("With autofix, pause for a human approval gate before applying any fix."),
  staleMinutes: z
    .number()
    .default(15)
    .describe("A non-terminal run with no activity past this many minutes is treated as stuck."),
});

// 1. Deterministic capture of the target run's state (no agent).
const gatherSchema = z.looseObject({
  targetRunId: z.string().default("").describe("The resolved target run id."),
  ok: z.boolean().default(false).describe("Whether `smithers inspect` returned usable JSON."),
  state: z.string().default("unknown").describe("Run status: running | completed | failed | unknown."),
  summary: z.string().default("").describe("One-line human summary of the capture."),
  ageMinutes: z.number().default(0).describe("Minutes since the run started, when known."),
  nodes: z
    .array(
      z.looseObject({
        id: z.string().default(""),
        type: z.string().default(""),
        status: z.string().default(""),
        summary: z.string().default(""),
      }),
    )
    .default([])
    .describe("One row per workflow node, flattened from inspect."),
  why: z.string().default("").describe("Raw `smithers why --json` output, truncated."),
  events: z
    .looseObject({
      count: z.number().default(0),
      approval: z.array(z.looseObject({})).default([]),
      human: z.array(z.looseObject({})).default([]),
      failed: z.array(z.looseObject({})).default([]),
      recent: z.array(z.looseObject({})).default([]),
    })
    .default({ count: 0, approval: [], human: [], failed: [], recent: [] })
    .describe("Categorized slice of recent run events."),
  scoresRaw: z.string().default("").describe("Raw `smithers scores` output, truncated."),
  humanInboxRaw: z.string().default("").describe("Raw `smithers human inbox` output, truncated."),
  raw: z.string().default("").describe("Truncated raw inspect JSON for the agents to mine."),
});

// 2. The diagnosis: health bucket plus answers to the operator's standing
//    questions (questions/answers, approval decisions, outputs, diffs) and
//    concrete recommended actions.
const diagnoseSchema = z.looseObject({
  health: z.enum(["healthy", "blocked", "stuck", "failed", "overBudget"]).default("healthy"),
  summary: z.string().default(""),
  waitingOn: z.string().nullable().default(null),
  rootCause: z.string().default(""),
  questions: z
    .array(
      z.looseObject({
        nodeId: z.string().default(""),
        prompt: z.string().default(""),
        answer: z.string().nullable().default(null),
        answeredBy: z.string().nullable().default(null),
        pending: z.boolean().default(false),
      }),
    )
    .default([]),
  approvals: z
    .array(
      z.looseObject({
        nodeId: z.string().default(""),
        approved: z.boolean().nullable().default(null),
        note: z.string().nullable().default(null),
        decidedBy: z.string().nullable().default(null),
        decidedAt: z.string().nullable().default(null),
        pending: z.boolean().default(false),
      }),
    )
    .default([]),
  keyOutputs: z
    .array(
      z.looseObject({
        nodeId: z.string().default(""),
        summary: z.string().default(""),
        value: z.string().nullable().default(null),
      }),
    )
    .default([]),
  diffs: z
    .array(
      z.looseObject({
        nodeId: z.string().default(""),
        summary: z.string().default(""),
        files: z.array(z.string()).default([]),
        excerpt: z.string().default(""),
      }),
    )
    .default([]),
  recommendedActions: z
    .array(
      z.looseObject({
        problem: z.string().default(""),
        command: z.string().default(""),
        needsHuman: z.boolean().default(true),
        selfFixable: z.boolean().default(false),
      }),
    )
    .default([]),
  anySelfFixable: z.boolean().default(false),
});

// Durable human approval decision (matches the Approval component output shape).
const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

// 3. What the gated fix step actually did.
const fixSchema = z.looseObject({
  applied: z.boolean().default(false),
  actionsTaken: z
    .array(z.looseObject({ command: z.string().default(""), result: z.string().default("") }))
    .default([]),
  resumed: z.boolean().default(false),
  stillNeedsHuman: z.string().nullable().default(null),
  summary: z.string().default(""),
});

// 4. The self-contained HTML report.
const reportSchema = z.looseObject({
  title: z.string().default(""),
  html: z.string().default(""),
  health: z.string().default("healthy"),
  sectionCount: z.number().default(0),
});

// 5. Where the report landed on disk.
const artifactSchema = z.looseObject({
  path: z.string().default(""),
  bytes: z.number().default(0),
  digest: z.string().default(""),
});

// 6. The run's terminal summary — the at-a-glance result an operator wants
//    when this monitor run finishes. Aggregated deterministically from the
//    steps above so the printed run output is meaningful, not empty.
const outputSchema = z.object({
  targetRunId: z.string(),
  state: z.string(),
  health: z.string(),
  summary: z.string(),
  waitingOn: z.string().nullable(),
  rootCause: z.string(),
  recommendedActionCount: z.number(),
  topRecommendation: z.string().nullable(),
  fixApplied: z.boolean(),
  reportPath: z.string().nullable(),
  nodeCount: z.number(),
  eventCount: z.number(),
});

const { Workflow, Task, Sequence, Branch, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  gather: gatherSchema,
  diagnose: diagnoseSchema,
  approval: approvalSchema,
  fix: fixSchema,
  report: reportSchema,
  artifact: artifactSchema,
  output: outputSchema,
});

// --- Deterministic helpers for the gather + artifact steps (no agent). ---
const MAX_RAW = 60_000;
const MAX_NODES = 60;

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function pickArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseNdjson(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
    } catch {
      // tolerate non-JSON lines (headers, blanks)
    }
  }
  return out;
}

function eventType(ev: Record<string, unknown>): string {
  return asString(ev.type ?? ev.event ?? ev.kind);
}

/**
 * Flatten whatever the inspect payload calls its node list into minimal rows.
 * The shape varies by version, so probe a few likely keys and fall back to an
 * empty list rather than throwing.
 */
function flattenNodes(parsed: Record<string, unknown>): Array<{ id: string; type: string; status: string; summary: string }> {
  const candidates = [parsed.nodes, parsed.steps, parsed.tasks];
  const list = candidates.find((c) => Array.isArray(c) && c.length > 0);
  return pickArray(list)
    .slice(0, MAX_NODES)
    .map((n) => {
      const node = (n ?? {}) as Record<string, unknown>;
      return {
        id: asString(node.id ?? node.nodeId ?? node.name),
        type: asString(node.type ?? node.kind ?? node.component),
        status: asString(node.status ?? node.state ?? node.phase),
        summary: asString(node.summary ?? node.title ?? node.label).slice(0, 400),
      };
    });
}

const TERMINAL = new Set(["finished", "completed", "failed", "cancelled", "succeeded"]);

/** Pick the run to monitor: the explicit id, else the most recent active run. */
async function resolveRunId(explicit: string | null): Promise<string> {
  if (explicit) return explicit;
  const res = await $`bunx smithers-orchestrator ps --format json --all`.nothrow().quiet();
  if (res.exitCode !== 0) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.toString());
  } catch {
    return "";
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { runs?: unknown }).runs)
      ? (parsed as { runs: unknown[] }).runs
      : [];
  if (list.length === 0) return "";
  const isActive = (row: unknown) => {
    const r = row as Record<string, unknown>;
    return !TERMINAL.has(asString(r.status ?? r.state ?? r.dbStatus).toLowerCase());
  };
  // Never auto-target another monitor run (or this one): with no explicit id,
  // "latest active run" would otherwise resolve to whichever monitor launched
  // last, and monitors end up monitoring each other / themselves.
  const isMonitor = (row: unknown) => {
    const r = row as Record<string, unknown>;
    return asString(r.workflowId ?? r.workflow) === "monitor";
  };
  const candidates = list.filter((row) => !isMonitor(row));
  if (candidates.length === 0) return "";
  const pick = (candidates.find(isActive) ?? candidates[0]) as Record<string, unknown>;
  return asString(pick.id ?? pick.runId);
}

/** Capture a resilient snapshot of one run by shelling out to the CLI. */
async function gatherSnapshot(explicitRunId: string | null, staleMinutes: number): Promise<z.infer<typeof gatherSchema>> {
  const runId = await resolveRunId(explicitRunId);
  if (!runId) {
    return {
      targetRunId: "",
      ok: false,
      state: "unknown",
      summary: "No target run found. Pass a run id, or start a run first.",
      ageMinutes: 0,
      nodes: [],
      why: "",
      events: { count: 0, approval: [], human: [], failed: [], recent: [] },
      scoresRaw: "",
      humanInboxRaw: "",
      raw: "",
    };
  }

  const inspectRes = await $`bunx smithers-orchestrator inspect ${runId} --format json --full-output`
    .nothrow()
    .quiet();
  const inspectOut = inspectRes.stdout?.toString() ?? "";
  const inspectErr = inspectRes.stderr?.toString() ?? "";

  let envelope: Record<string, unknown> = {};
  let ok = false;
  if (inspectRes.exitCode === 0 && inspectOut.trim().length > 0) {
    try {
      envelope = JSON.parse(inspectOut) as Record<string, unknown>;
      ok = true;
    } catch {
      ok = false;
    }
  }

  // --full-output wraps the payload in { ok, data, meta }; the payload nests the
  // run record under run / runState. Probe all of them.
  const parsed = (
    typeof envelope.data === "object" && envelope.data !== null ? envelope.data : envelope
  ) as Record<string, unknown>;
  const runRecord = (parsed.run ?? {}) as Record<string, unknown>;
  const runStateRecord = (parsed.runState ?? {}) as Record<string, unknown>;
  const nodes = ok ? flattenNodes(parsed) : [];
  const state = ok
    ? asString(runRecord.status ?? runStateRecord.state ?? parsed.status ?? parsed.state ?? "unknown") || "unknown"
    : "unknown";

  const startedAtMs = Number(runRecord.startedAtMs ?? runRecord.createdAtMs ?? parsed.startedAtMs ?? 0);
  const ageMinutes = startedAtMs > 0 ? Math.max(0, Math.round((Date.now() - startedAtMs) / 60_000)) : 0;

  const whyRes = await $`bunx smithers-orchestrator why ${runId} --json`.nothrow().quiet();
  const why = (whyRes.stdout?.toString() ?? "").slice(0, 8_000);

  const eventsRes = await $`bunx smithers-orchestrator events ${runId} --json --limit 800`.nothrow().quiet();
  const allEvents = parseNdjson(eventsRes.stdout?.toString() ?? "");
  const approval = allEvents.filter((e) => eventType(e).startsWith("Approval"));
  const human = allEvents.filter((e) => /human|ask/i.test(eventType(e)));
  const failed = allEvents.filter((e) => /Failed|Error/.test(eventType(e)));
  const recent = allEvents.slice(-60);

  const scoresRes = await $`bunx smithers-orchestrator scores ${runId}`.nothrow().quiet();
  const scoresRaw = (scoresRes.stdout?.toString() ?? "").slice(0, 6_000);

  const inboxRes = await $`bunx smithers-orchestrator human inbox --format json`.nothrow().quiet();
  const humanInboxRaw = (inboxRes.stdout?.toString() ?? "").slice(0, 8_000);

  const stale = !TERMINAL.has(state.toLowerCase()) && ageMinutes >= staleMinutes;
  const summary = ok
    ? `Run ${runId} is "${state}" with ${nodes.length} node(s), ${allEvents.length} recent event(s)` +
      (stale ? `; idle ${ageMinutes}m (past the ${staleMinutes}m stale threshold).` : ".")
    : `Could not inspect run ${runId}: ${(inspectErr || inspectOut || "no output").slice(0, 300)}`;

  return {
    targetRunId: runId,
    ok,
    state,
    summary,
    ageMinutes,
    nodes,
    why,
    events: { count: allEvents.length, approval, human, failed, recent },
    scoresRaw,
    humanInboxRaw,
    raw: (ok ? inspectOut : `${inspectOut}\n${inspectErr}`).slice(0, MAX_RAW),
  };
}

/** Write the rendered HTML report under artifacts/monitor and return its path. */
async function writeReport(
  monitorRunId: string,
  targetRunId: string,
  report: z.infer<typeof reportSchema>,
): Promise<z.infer<typeof artifactSchema>> {
  const dir = "artifacts/monitor";
  await $`mkdir -p ${dir}`.nothrow().quiet();
  // Stable name keyed off the monitor run id so resume rewrites, not duplicates.
  const safe = (targetRunId || monitorRunId).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const path = `${dir}/${safe}.html`;
  const html = report?.html ?? "";
  await Bun.write(path, html);
  const digest = `${report?.title || "Monitor report"} / ${report?.health || "unknown"} / ${report?.sectionCount ?? 0} sections / ${path}`;
  return { path, bytes: html.length, digest };
}

/**
 * Monitor one running Smithers workflow. A deterministic gather step captures the
 * run's state; a tool-equipped agent diagnoses health and answers the operator's
 * standing questions (questions/answers, approvals, outputs, diffs); an optional
 * approval-gated fix step applies the smallest safe repair; and a render step
 * produces a self-contained HTML report written to artifacts/monitor.
 */
export default smithers((ctx) => {
  const autofix = ctx.input.autofix ?? false;
  const requireApproval = ctx.input.requireApproval ?? true;
  const staleMinutes = ctx.input.staleMinutes ?? 15;
  const explicitRunId = ctx.input.targetRunId ?? null;

  const gather = ctx.outputMaybe("gather", { nodeId: "gather" });
  const diagnosis = ctx.outputMaybe("diagnose", { nodeId: "diagnose" });
  const approval = ctx.outputMaybe("approval", { nodeId: "approve-fix" });
  const fix = ctx.outputMaybe("fix", { nodeId: "fix" });
  const report = ctx.outputMaybe("report", { nodeId: "report" });
  const artifact = ctx.outputMaybe("artifact", { nodeId: "artifact" });

  const runId = gather?.targetRunId || explicitRunId || "";
  const title = ctx.input.title ?? (runId ? `Monitor: run ${runId}` : "Monitor");

  const unhealthy = diagnosis !== undefined && diagnosis.health !== "healthy";
  const wantFix = autofix && unhealthy && diagnosis?.anySelfFixable === true;
  const fixApproved = approval?.approved === true;
  const doFix = wantFix && (!requireApproval || fixApproved);
  // Report runs once diagnosis is in; if a fix is in flight, wait for it first.
  const reportReady = diagnosis !== undefined && (!doFix || fix !== undefined);

  return (
    <Workflow name="monitor">
      <Sequence>
        {/* 1 — Deterministically capture the target run's state. */}
        <Task id="gather" output={outputs.gather}>
          {async () => await gatherSnapshot(explicitRunId, staleMinutes)}
        </Task>

        {/* 2 — Diagnose health and answer the operator's standing questions. */}
        {gather ? (
          <Task id="diagnose" output={outputs.diagnose} agent={agents.smartTool} heartbeatTimeoutMs={600_000}>
            <DiagnosePrompt runId={runId} snapshot={gather} staleMinutes={staleMinutes} />
          </Task>
        ) : null}

        {/* 3 — Optional human gate before any auto-fix touches the run. */}
        <Branch
          if={wantFix && requireApproval}
          then={
            <Approval
              id="approve-fix"
              output={outputs.approval}
              request={{
                title: `Auto-fix run ${runId}?`,
                summary: diagnosis?.summary ?? "Approve the monitor applying its recommended self-fix.",
              }}
              onDeny="continue"
            />
          }
          else={null}
        />

        {/* 4 — Apply the smallest safe fix and resume the run. */}
        {doFix ? (
          <Task id="fix" output={outputs.fix} agent={agents.smartTool} heartbeatTimeoutMs={900_000}>
            <FixPrompt runId={runId} diagnosis={diagnosis} />
          </Task>
        ) : null}

        {/* 5 — Render the self-contained HTML report. */}
        {reportReady ? (
          <Task id="report" output={outputs.report} agent={agents.smart} heartbeatTimeoutMs={600_000}>
            <ReportPrompt runId={runId} title={title} snapshot={gather} diagnosis={diagnosis} fix={fix ?? null} />
          </Task>
        ) : null}

        {/* 6 — Persist the report to artifacts/monitor and return its path. */}
        {report ? (
          <Task id="artifact" output={outputs.artifact}>
            {async () => await writeReport(ctx.runId, runId, report)}
          </Task>
        ) : null}

        {/* 7 — Surface the run's most useful terminal result as the run output. */}
        {artifact ? (
          <Task id="output" output={outputs.output}>
            {() => ({
              targetRunId: runId,
              state: gather?.state ?? "unknown",
              health: diagnosis?.health ?? "unknown",
              summary: diagnosis?.summary || gather?.summary || "",
              waitingOn: diagnosis?.waitingOn ?? null,
              rootCause: diagnosis?.rootCause ?? "",
              recommendedActionCount: diagnosis?.recommendedActions?.length ?? 0,
              topRecommendation: diagnosis?.recommendedActions?.[0]?.problem ?? null,
              fixApplied: fix?.applied ?? false,
              reportPath: artifact?.path ?? null,
              nodeCount: gather?.nodes?.length ?? 0,
              eventCount: gather?.events?.count ?? 0,
            })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
