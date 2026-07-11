// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Ticket fleet monitor
// smithers-description: Cron health monitor for ticket-fleet runs — a cheap agent inspects the latest run and reports whether it is progressing.
// smithers-tags: monitor, cron, tickets, system
// smithers-system: true
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { providers } from "../agents";

const repoRoot = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
})();
const monitorLog = join(repoRoot, ".smithers", "logs", "ticket-fleet-monitor.md");

const scanSchema = z.object({
  found: z.boolean(),
  watchedRunId: z.string().default(""),
  watchedStatus: z.string().default(""),
  psSnapshot: z.string().default(""),
  summary: z.string(),
});
type Scan = z.infer<typeof scanSchema>;
const healthSchema = z.object({
  watchedRunId: z.string(),
  watchedStatus: z.string().default(""),
  healthy: z.boolean(),
  progressing: z.boolean(),
  stuckNodes: z.array(z.string()).default([]),
  pendingApprovals: z.number().int().default(0),
  issuesFound: z.string().default(""),
  recommendation: z.string().default(""),
  report: z.string().min(20),
});
const recordSchema = z.object({
  logged: z.boolean(),
  summary: z.string(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  tfmScan: scanSchema,
  tfmHealth: healthSchema,
  tfmRecord: recordSchema,
});

function smithersCli(args: string[]): string {
  return execFileSync("smithers", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }).trim();
}
function scanForFleetRun(): Scan {
  let raw = "";
  try {
    raw = smithersCli(["ps", "--format", "json"]);
  } catch (error) {
    return { found: false, watchedRunId: "", watchedStatus: "", psSnapshot: "", summary: "smithers ps failed: " + String(error).slice(0, 500) };
  }
  // The CLI may append a CTA after the JSON; parse the first JSON value.
  let rows: any = [];
  try {
    rows = JSON.parse(raw.slice(raw.indexOf("[") === -1 ? raw.indexOf("{") : raw.indexOf("[")));
  } catch {
    return { found: false, watchedRunId: "", watchedStatus: "", psSnapshot: raw.slice(0, 4_000), summary: "Could not parse smithers ps output." };
  }
  const list: any[] = Array.isArray(rows) ? rows : Array.isArray(rows?.runs) ? rows.runs : Array.isArray(rows?.data) ? rows.data : [];
  const fleet = list.filter((row) => {
    const name = String(row?.workflowName ?? row?.workflow ?? row?.name ?? "");
    const key = String(row?.workflowKey ?? row?.key ?? "");
    return name.includes("ticket-fleet") || key.includes("ticket-fleet");
  }).filter((row) => !String(row?.workflowName ?? row?.workflowKey ?? "").includes("monitor"));
  if (!fleet.length) {
    return { found: false, watchedRunId: "", watchedStatus: "", psSnapshot: raw.slice(0, 4_000), summary: "No ticket-fleet run found; nothing to monitor." };
  }
  const active = fleet.find((row) => /running|waiting|paused/i.test(String(row?.status ?? row?.runState ?? ""))) ?? fleet[0];
  const watchedRunId = String(active?.runId ?? active?.id ?? "");
  const watchedStatus = String(active?.status ?? active?.runState ?? "");
  return { found: !!watchedRunId, watchedRunId, watchedStatus, psSnapshot: raw.slice(0, 4_000), summary: "Watching ticket-fleet run " + watchedRunId + " (" + watchedStatus + ")." };
}

function monitorPrompt(scan: Scan): string {
  return [
    "You are the health monitor for the long-running `ticket-fleet` smithers workflow in this repo.",
    "Watched run: " + scan.watchedRunId + " (last known status: " + scan.watchedStatus + ").",
    "`smithers ps` snapshot:", "---", scan.psSnapshot, "---",
    "Investigate with READ-ONLY commands (run them from the repo root):",
    "- `smithers inspect " + scan.watchedRunId + " --format json` (status is nested under run.status)",
    "- `smithers why " + scan.watchedRunId + "` if it looks blocked or paused",
    "- `smithers events " + scan.watchedRunId + " --format json --token-limit 4000` for recent activity",
    "- `smithers human list` / pending approvals if it is waiting on a human",
    "Judge:",
    "1. healthy — no failed guard nodes (ids containing 'guard'), no exhausted-retry failures, no error loops.",
    "2. progressing — recent events exist (new nodes started/finished within the last ~30 minutes) OR it is legitimately parked on an approval/quota wait.",
    "3. stuckNodes — node ids that look wedged (running with stale heartbeats, or waiting on something that will never arrive).",
    "4. pendingApprovals — how many human approvals are waiting.",
    "Do NOT mutate anything: no approve/deny, no cancel, no resume, no retry-task, no git commands. Your output is a diagnosis.",
    "In `recommendation`, say exactly what a human (or the next monitor tick) should do, e.g. 'approve i123:plan-approval', 'run: smithers retry-task ticket-fleet --run-id <id> --node-id <node>', or 'no action needed'.",
    "Write a compact markdown `report` covering status, phase progress, and anything anomalous. Set watchedRunId to exactly " + JSON.stringify(scan.watchedRunId) + ".",
  ].join("\n");
}

export default smithers((ctx) => {
  const scan = ctx.latest(outputs.tfmScan, "scan") as Scan | undefined;
  const health = ctx.latest(outputs.tfmHealth, "diagnose") as z.infer<typeof healthSchema> | undefined;
  return (
    <Workflow name="ticket-fleet-monitor">
      <Sequence>
        <Task id="scan" output={outputs.tfmScan} timeoutMs={5 * 60_000}>
          {() => scanForFleetRun()}
        </Task>
        {scan?.found ? (
          <Task id="diagnose" output={outputs.tfmHealth} agent={providers.claudeSonnet}
            retries={1} timeoutMs={15 * 60_000} heartbeatTimeoutMs={5 * 60_000} continueOnFail>
            {monitorPrompt(scan)}
          </Task>
        ) : null}
        <Task id="record" output={outputs.tfmRecord}>
          {() => {
            if (!scan?.found) return { logged: false, summary: scan?.summary ?? "No scan output." };
            if (!health) return { logged: false, summary: "Diagnosis did not complete." };
            mkdirSync(join(repoRoot, ".smithers", "logs"), { recursive: true });
            const stamp = new Date().toISOString();
            appendFileSync(monitorLog, [
              "", "## " + stamp + " — run " + health.watchedRunId,
              "- healthy: " + health.healthy + ", progressing: " + health.progressing + ", pendingApprovals: " + health.pendingApprovals,
              health.issuesFound ? "- issues: " + health.issuesFound : "",
              health.recommendation ? "- recommendation: " + health.recommendation : "",
              "", health.report, "",
            ].filter((line) => line !== "").join("\n") + "\n", "utf8");
            return {
              logged: true,
              summary: (health.healthy && health.progressing ? "HEALTHY" : "ATTENTION NEEDED") + ": " + health.recommendation.slice(0, 300),
            };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
