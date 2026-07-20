// smithers-display-name: Bulletproof UI Watchdog
/** @jsxImportSource smithers-orchestrator */
import { Sequence, Task, Timer, UI, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";

// Luna polls the campaign run's health on an interval. Observe-and-escalate
// only: the watchdog never cancels, resumes, or edits anything. Sonnet is the
// quota fallback for luna per the house rate-limit policy.
const lunaChain = codexFirst(
  { model: "gpt-5.6-luna", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true },
  [providers.claudeSonnet],
);

const healthSchema = z.object({
  watchedRunId: z.string().min(4),
  watchedStatus: z.string().min(2),
  healthy: z.boolean(),
  watchedTerminal: z.boolean(),
  issues: z.array(z.string()).default([]),
  escalated: z.boolean().default(false),
  summary: z.string().min(10),
});

const inputSchema = z.object({
  watchedRunId: z.string().min(4),
  intervalSeconds: z.number().int().min(60).max(3600).default(600),
  maxChecks: z.number().int().min(1).max(200).default(72),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  bpuiHealth: healthSchema,
});

type RawRow = Record<string, unknown>;

function healthRows(ctx: any): RawRow[] {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs("bpuiHealth") : ctx.outputs?.bpuiHealth;
  return Array.isArray(rows) ? rows.filter((row): row is RawRow => typeof row === "object" && row !== null) : [];
}

function healthPrompt(watchedRunId: string, previous: RawRow | undefined): string {
  return [
    `Health-check the Smithers run ${watchedRunId} (the Bulletproof UI campaign). Return watchedRunId=${watchedRunId} exactly.`,
    "You are a READ-ONLY watchdog. You may run: smithers status/inspect/why/ps/events/logs, df, uptime, ps. You must NEVER run: smithers cancel/down/pause/resume/retry-task/up/gateway stop, kill, or any command that edits files or moves branches.",
    "Checks:",
    `1. \`smithers status ${watchedRunId}\` and \`smithers inspect ${watchedRunId} --json\` (parse run.status; note failed/stuck nodes and retry counts).`,
    `2. \`smithers why ${watchedRunId}\` if the run is not actively progressing.`,
    "3. Stall detection: compare against the previous check (below). If the same node has been the frontier for 2+ consecutive checks with no new events, that is a stall.",
    "4. Quota: look for waiting-quota / rate-limit banners in recent events (`smithers events " + watchedRunId + " | tail -40`).",
    "5. Host health: `df -h .` (flag >90% used), `uptime` load average (flag if load avg per core is extreme), and `ps aux | grep -c 'smithers-e2e'` style orphan buildup.",
    `Previous check:\n${JSON.stringify(previous ?? null, null, 2)}`,
    "Output: watchedStatus = the run's reported status string; watchedTerminal=true only when status is finished/failed/cancelled; healthy=false when you found a stall, failure, quota park, disk, or load problem; list each concrete finding in issues.",
    `Escalation: ONLY for a critical, non-self-healing problem (run failed; stalled 2+ checks; disk >90%; waiting-quota with no reset in sight), run \`smithers ask-human "watchdog ${watchedRunId}: <one-line problem + suggested operator action>" --timeout 900\` and set escalated=true. A pending approval inside the campaign is NOT critical; just report it in issues.`,
  ].join("\n");
}

export default smithers((ctx) => {
  const input = inputSchema.parse({
    watchedRunId: ctx.input.watchedRunId ?? "unknown-run",
    intervalSeconds: ctx.input.intervalSeconds ?? 600,
    maxChecks: ctx.input.maxChecks ?? 72,
  });
  const rows = healthRows(ctx);
  const latest = rows.at(-1);
  const done = latest?.watchedTerminal === true;

  return (
    <Workflow name="bulletproof-ui-watchdog">
      <UI entry="../ui/bulletproof-ui-watchdog.tsx" title="Bulletproof UI Watchdog" />
      <Loop id="bpui-health-loop" until={done} maxIterations={input.maxChecks} onMaxReached="return-last">
        <Sequence>
          <Task id="bpui-health-check" output={outputs.bpuiHealth} agent={lunaChain} retries={2} timeoutMs={20 * 60_000} heartbeatTimeoutMs={8 * 60_000}>
            {healthPrompt(input.watchedRunId, latest)}
          </Task>
          <Timer id="bpui-health-cooldown" duration={`${input.intervalSeconds}s`} />
        </Sequence>
      </Loop>
    </Workflow>
  );
});
