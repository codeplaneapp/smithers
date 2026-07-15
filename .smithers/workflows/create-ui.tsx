// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Create workflow UI
// smithers-description: One agent authors .smithers/ui/<key>.tsx for a workflow that lacks one and verifies it against the live gateway. Triggered by the monitor's "Create UI" button.
// smithers-tags: ui, monitor, system
// smithers-system: true
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const inputSchema = z.object({
  targetWorkflow: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "targetWorkflow must be a safe workflow slug")),
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

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  cuResult: resultSchema,
});

function prompt(target: string, gatewayUrl: string, exampleRunId: string): string {
  return [
    "Author a live custom UI for the smithers workflow \"" + target + "\" and verify it against the RUNNING gateway, all in this one task.",
    "",
    "1. Read the workflow source at .smithers/workflows/" + target + ".tsx (or .mdx): learn its node ids, output tables, and phases.",
    "2. Read ONE existing UI as the pattern: .smithers/ui/ticket-fleet.tsx (structure, styles, defensive row parsing).",
    "3. Write .smithers/ui/" + target + ".tsx. Contracts that WILL bite you if ignored:",
    "   - Pragma /** @jsxImportSource react */ and finish the file with createGatewayReactRoot(<App />).",
    "   - Data comes ONLY from smithers-orchestrator/gateway-react hooks. useGatewayRun(runId) takes a STRING; useGatewayRunEvents(runId) returns { events, streaming, error }; useGatewayNodeOutput({runId,nodeId,iteration}).data is { status, row, schema } and the row lives at .row (render 'pending' when row is null — NEVER render the envelope); useGatewayRunTree(runId) gives { nodes } with per-node .status tones (ok/running/failed/waiting/queued).",
    "   - Output rows are DB-shaped: booleans may be 0/1, arrays/objects may be JSON strings; parse defensively.",
    "   - Honor ?runId= from location.search and fall back to the latest run of this workflow from useGatewayRuns().",
    "   - Show per-node lifecycle from the run tree, pending approvals with approve/deny via useGatewayActions().submitApproval({runId, nodeId, iteration, decision: { approved }}), and each key output when produced.",
    "4. Do NOT edit the workflow file itself (adding <UI> would break parked runs' resume hashes). The gateway serves .smithers/ui/<key>.tsx by convention automatically.",
    "5. VERIFY against the live gateway at " + gatewayUrl + " (it picks the new file up with no restart):",
    "   curl -s -o /dev/null -w '%{http_code}' '" + gatewayUrl + "/workflows/" + target + "'            -> must be 200",
    "   curl -s -o /dev/null -w '%{http_code}' '" + gatewayUrl + "/workflows/" + target + "/__smithers_ui/client.js' -> must be 200 (this compiles your file; on 500 read the response body for the build error, fix, retry)",
    exampleRunId ? "   A live example run exists: " + exampleRunId + " — mention '" + gatewayUrl + "/workflows/" + target + "?runId=" + exampleRunId + "' in your summary." : "",
    "Only claim verified=true when both URLs returned 200. Set targetWorkflow to exactly " + JSON.stringify(target) + " and uiPath to .smithers/ui/" + target + ".tsx.",
    "Do not run git/jj/gh, do not restart anything, and touch no files other than the new UI file.",
  ].filter(Boolean).join("\n");
}

export default smithers((ctx) => {
  const raw = (ctx.input ?? {}) as Record<string, unknown>;
  const target = String(raw.targetWorkflow ?? "").trim();
  const gatewayUrl = String(raw.gatewayUrl ?? "").trim() || "http://127.0.0.1:7331";
  const exampleRunId = String(raw.exampleRunId ?? "").trim();
  return (
    <Workflow name="create-ui">
      <Task id="author-and-verify" output={outputs.cuResult} agent={agents.smart}
        retries={1} timeoutMs={30 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
        {prompt(target, gatewayUrl, exampleRunId)}
      </Task>
    </Workflow>
  );
});
