// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Create workflow UI
// smithers-description: One agent authors .smithers/ui/<key>.tsx for a workflow that lacks one and verifies it against the live gateway; a deterministic compliance gate grades design-system usage (and NodeChatStream live chat for agent workflows) and loops violations back until the file passes. Triggered by the monitor's "Create UI" button.
// smithers-tags: ui, monitor, system
// smithers-system: true
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Loop, Sequence } from "smithers-orchestrator";
import { gradeWorkflowUiSource } from "smithers-orchestrator/scorers";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod/v4";
import { agents } from "../agents";

const inputSchema = z.object({
  targetWorkflow: z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "targetWorkflow must be a safe workflow slug"),
    ),
  gatewayUrl: z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .url()
        .refine((value) => {
          try {
            const parsed = new URL(value);
            return (parsed.protocol === "http:" || parsed.protocol === "https:") && !/[\\'"`;$(){}<>\n\r]/.test(value);
          } catch {
            return false;
          }
        }, "gatewayUrl must be a safe HTTP(S) URL"),
    )
    .default("http://127.0.0.1:7331"),
  exampleRunId: z.string().default(""),
});

const resultSchema = z.object({
  targetWorkflow: z.string(),
  uiPath: z.string(),
  verified: z.boolean(),
  summary: z.string().min(20),
});

const complianceSchema = z.object({
  targetWorkflow: z.string(),
  uiPath: z.string(),
  passed: z.boolean(),
  score: z.number(),
  violations: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  cuResult: resultSchema,
  cuCompliance: complianceSchema,
});

function prompt(target: string, gatewayUrl: string, exampleRunId: string, feedback: string): string {
  return [
    'Author a live custom UI for the smithers workflow "' +
      target +
      '" and verify it against the RUNNING gateway, all in this one task.',
    "",
    "1. Read the workflow source at .smithers/workflows/" +
      target +
      ".tsx (or .mdx): learn its node ids, WHICH NODES ARE AGENT TASKS (prompt-driven) vs deterministic, output tables, and phases.",
    "2. Read ONE existing UI under .smithers/ui/ as the pattern if any exist (structure, defensive row parsing).",
    "3. Write .smithers/ui/" +
      target +
      ".tsx. COMPOSE THE SHIPPED DESIGN SYSTEM — never hand-roll what a component covers:",
    "   - Page chrome: WorkflowUiShell (title + meta={<RunMeta runId={runId} />}) from smithers-orchestrator/gateway-ui. Never hand-format run id/status text.",
    "   - Pipeline headers: NodeStageStrip (runId + ordered top-level node ids). Fan-out ledgers: FleetTable (items with per-item nodeIds → live rollup status pills, selectable rows).",
    "   - EVERY AGENT NODE shown in a detail pane gets a NodeChatStream (runId, nodeId, title, subtitle=agent·model, status from nodeStatusIndex) — humans must be able to watch the agent's live chat/tool calls in real time. Deterministic nodes use NodeOutputCard instead.",
    "   - Stats/empty states: KpiStat, EmptyState, StatusPill from smithers-orchestrator/ui; approvals via ApprovalPanel or useGatewayActions().submitApproval({runId, nodeId, iteration, decision: { approved }}).",
    "   - Node status derivation: nodeStatusIndex(useGatewayRunTree(runId).nodes) + rollupNodeStatus — do NOT reimplement status rank maps.",
    "   - BANNED (the deterministic gate rejects the file): raw hex colors, borderRadius:999 pill spans, raw <table> markup, imports outside react + smithers-orchestrator/{gateway-react,gateway-ui,ui}.",
    "   - Pragma /** @jsxImportSource react */ and finish the file with createGatewayReactRoot(<App />).",
    "   - Data comes ONLY from smithers-orchestrator/gateway-react hooks. useGatewayRun(runId) takes a STRING; useGatewayRunEvents(runId) returns { events, streaming, error }; useGatewayNodeOutput({runId,nodeId,iteration}).data is { status, row, schema } and the row lives at .row (render 'pending' when row is null — NEVER render the envelope).",
    "   - Output rows are DB-shaped: booleans may be 0/1, arrays/objects may be JSON strings; parse defensively.",
    "   - Honor ?runId= from location.search and fall back to the latest run of this workflow from useGatewayRuns().",
    "4. Do NOT edit the workflow file itself (adding <UI> would break parked runs' resume hashes). The gateway serves .smithers/ui/<key>.tsx by convention automatically.",
    "5. VERIFY against the live gateway at " + gatewayUrl + " (it picks the new file up with no restart):",
    "   curl -s -o /dev/null -w '%{http_code}' '" + gatewayUrl + "/workflows/" + target + "'            -> must be 200",
    "   curl -s -o /dev/null -w '%{http_code}' '" +
      gatewayUrl +
      "/workflows/" +
      target +
      "/__smithers_ui/client.js' -> must be 200 (this compiles your file; on 500 read the response body for the build error, fix, retry)",
    exampleRunId
      ? "   A live example run exists: " +
        exampleRunId +
        " — mention '" +
        gatewayUrl +
        "/workflows/" +
        target +
        "?runId=" +
        exampleRunId +
        "' in your summary."
      : "",
    "A deterministic compliance gate grades your file right after this task; if it finds violations this task runs again with them as feedback.",
    feedback,
    "Only claim verified=true when both URLs returned 200. Set targetWorkflow to exactly " +
      JSON.stringify(target) +
      " and uiPath to .smithers/ui/" +
      target +
      ".tsx.",
    "Do not run git/jj/gh, do not restart anything, and touch no files other than the new UI file.",
  ]
    .filter(Boolean)
    .join("\n");
}

type UiAuthorResult = z.infer<typeof resultSchema> | undefined;
const gatewayRequestTimeoutMs = 10_000;

export async function verifyGatewayUi(
  target: string,
  gatewayUrl: string,
): Promise<Array<{ rule: string; detail: string }>> {
  const baseUrl = gatewayUrl.replace(/\/$/, "");
  const routes = [
    { rule: "gateway-workflow", url: `${baseUrl}/workflows/${target}` },
    { rule: "gateway-bundle", url: `${baseUrl}/workflows/${target}/__smithers_ui/client.js` },
  ];
  const results = await Promise.all(
    routes.map(async ({ rule, url }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), gatewayRequestTimeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (response.status === 200) return null;
        const body = (await response.text()).replace(/\s+/g, " ").slice(0, 240);
        return { rule, detail: `${url} returned HTTP ${response.status}${body ? `: ${body}` : "."}` };
      } catch (error) {
        return { rule, detail: `${url} could not be requested: ${String(error)}` };
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
  return results.filter((result): result is { rule: string; detail: string } => result !== null);
}

export async function gradeUi(
  target: string,
  gatewayUrl: string,
  cuResult?: UiAuthorResult,
): Promise<z.infer<typeof complianceSchema>> {
  const uiPath = `.smithers/ui/${target}.tsx`;
  const violations: Array<{ rule: string; detail: string }> = [];
  const expectedPath = `.smithers/ui/${target}.tsx`;
  if (!cuResult || cuResult.targetWorkflow !== target) {
    violations.push({ rule: "author-target", detail: `Author result targetWorkflow must be exactly ${target}.` });
  }
  if (!cuResult || cuResult.uiPath !== expectedPath) {
    violations.push({ rule: "author-path", detail: `Author result uiPath must be exactly ${expectedPath}.` });
  }
  if (cuResult?.verified !== true) {
    violations.push({
      rule: "author-verified",
      detail: "Author result verified must be true after both Gateway routes return HTTP 200.",
    });
  }
  if (!existsSync(uiPath)) {
    violations.push({ rule: "mount", detail: `${uiPath} was not written.` });
  } else {
    const uiSource = readFileSync(uiPath, "utf8");
    const workflowPath = [`.smithers/workflows/${target}.tsx`, `.smithers/workflows/${target}.mdx`].find(existsSync);
    const report = gradeWorkflowUiSource(uiSource, {
      ...(workflowPath ? { workflowSource: readFileSync(workflowPath, "utf8") } : {}),
    });
    violations.push(...report.violations);
  }
  violations.push(...(await verifyGatewayUi(target, gatewayUrl)));
  return {
    targetWorkflow: target,
    uiPath,
    passed: violations.length === 0,
    score: violations.length === 0 ? 1 : 0,
    violations: JSON.stringify(violations),
  };
}

export default smithers((ctx) => {
  const raw = (ctx.input ?? {}) as Record<string, unknown>;
  const target = String(raw.targetWorkflow ?? "").trim();
  const gatewayUrl = String(raw.gatewayUrl ?? "").trim() || "http://127.0.0.1:7331";
  const exampleRunId = String(raw.exampleRunId ?? "").trim();

  const compliance = ctx.latest(outputs.cuCompliance, "ui-compliance");
  const cuResult = ctx.latest(outputs.cuResult, "author-and-verify");
  const passed = compliance?.passed === true;
  const feedback =
    compliance && !passed ? "PREVIOUS COMPLIANCE VIOLATIONS (fix every one):\n" + String(compliance.violations) : "";

  return (
    <Workflow name="create-ui">
      <Loop id="author-loop" until={passed} maxIterations={3} onMaxReached="fail">
        <Sequence>
          <Task
            id="author-and-verify"
            output={outputs.cuResult}
            agent={agents.smart}
            retries={1}
            timeoutMs={30 * 60_000}
            heartbeatTimeoutMs={10 * 60_000}
          >
            {prompt(target, gatewayUrl, exampleRunId, feedback)}
          </Task>
          <Task id="ui-compliance" output={outputs.cuCompliance} retries={0} needs={{ cuResult: "author-and-verify" }}>
            {() => gradeUi(target, gatewayUrl, cuResult)}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});
