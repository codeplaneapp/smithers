// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Report Slideshow
// smithers-description: Generate a concise HTML slideshow report from a Smithers run state and artifacts.
// smithers-tags: ops, reporting
/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import RenderPrompt from "../prompts/report-slideshow-render.mdx";

const inputSchema = z.object({
  // Named targetRunId (not runId): the engine reserves input.runId for the
  // run's own id, so a workflow that reports on ANOTHER run must use a
  // different field name.
  targetRunId: z
    .string()
    .describe("The Smithers run id to build a slideshow report from."),
  title: z
    .string()
    .nullable()
    .default(null)
    .describe("Optional report title. Null lets the render step derive one from the run."),
});

// 1. Deterministic capture of the run's persisted state, nodes, and a summary.
const gatherSchema = z.looseObject({
  ok: z.boolean().describe("Whether `smithers inspect` returned usable JSON."),
  state: z.string().default("unknown").describe("Run status: running | completed | failed | unknown."),
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
    .describe("One row per workflow node, flattened for the renderer."),
  summary: z.string().default("").describe("A short human summary of what the run did and where it ended."),
  raw: z.string().default("").describe("The raw inspect JSON (truncated) for the renderer to mine for detail."),
});

// 2. The self-contained HTML slideshow the render agent produces.
const renderSchema = z.looseObject({
  title: z.string().describe("The report title used in the slideshow."),
  html: z.string().describe("A complete, self-contained HTML document (inline CSS, no external deps)."),
  slideCount: z.number().default(0).describe("How many slide sections the report contains."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  gather: gatherSchema,
  render: renderSchema,
});

// --- Deterministic helpers for the gather step (no agent). ---
const MAX_RAW = 60_000;

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function pickArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Flatten whatever the inspect payload calls its node list into the minimal
 * { id, type, status, summary } rows the renderer consumes. The shape of
 * `inspect --format json` varies by version, so probe a few likely keys and
 * fall back to an empty list rather than throwing.
 */
function flattenNodes(parsed: Record<string, unknown>): Array<{ id: string; type: string; status: string; summary: string }> {
  const candidates = [parsed.nodes, parsed.steps, parsed.tasks];
  const list = candidates.find((c) => Array.isArray(c) && c.length > 0);
  return pickArray(list).map((n) => {
    const node = (n ?? {}) as Record<string, unknown>;
    return {
      id: asString(node.id ?? node.nodeId ?? node.name),
      type: asString(node.type ?? node.kind ?? node.component),
      status: asString(node.status ?? node.state ?? node.phase),
      summary: asString(node.summary ?? node.title ?? node.label).slice(0, 400),
    };
  });
}

export default smithers((ctx) => {
  const runId = ctx.input.targetRunId;

  // Gate the render step on the gather output being present.
  const gather = ctx.outputMaybe("gather", { nodeId: "gather" });

  const fallbackTitle = ctx.input.title ?? `Smithers run ${runId}`;

  return (
    <Workflow name="report-slideshow">
      <Sequence>
        {/* 1 — Deterministically capture the run state, nodes, and a summary. */}
        <Task id="gather" output={outputs.gather}>
          {async () => {
            const res = await $`bunx smithers-orchestrator inspect ${runId} --format json --full-output`
              .nothrow()
              .quiet();
            const stdout = res.stdout?.toString() ?? "";
            const stderr = res.stderr?.toString() ?? "";

            let envelope: Record<string, unknown> = {};
            let ok = false;
            if (res.exitCode === 0 && stdout.trim().length > 0) {
              try {
                envelope = JSON.parse(stdout) as Record<string, unknown>;
                ok = true;
              } catch {
                ok = false;
              }
            }

            // --full-output wraps the payload in { ok, data, meta }, and the
            // payload nests the run record under `run` / `runState` (older
            // shapes had status at the top level) — probe all of them.
            const parsed = (
              typeof envelope.data === "object" && envelope.data !== null ? envelope.data : envelope
            ) as Record<string, unknown>;
            const runRecord = (parsed.run ?? {}) as Record<string, unknown>;
            const runStateRecord = (parsed.runState ?? {}) as Record<string, unknown>;
            const nodes = ok ? flattenNodes(parsed) : [];
            const state = ok
              ? asString(runRecord.status ?? runStateRecord.state ?? parsed.status ?? parsed.state ?? "unknown") || "unknown"
              : "unknown";
            const summary = ok
              ? `Run ${runId} is "${state}" with ${nodes.length} node(s).`
              : `Could not inspect run ${runId}: ${(stderr || stdout || "no output").slice(0, 300)}`;

            return {
              ok,
              state,
              nodes,
              summary,
              raw: (ok ? stdout : `${stdout}\n${stderr}`).slice(0, MAX_RAW),
            };
          }}
        </Task>

        {/* 2 — Render a self-contained HTML slideshow from the captured state. */}
        {gather ? (
          <Task id="render" output={outputs.render} agent={agents.smart}>
            <RenderPrompt
              runId={runId}
              title={fallbackTitle}
              gather={gather}
            />
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
