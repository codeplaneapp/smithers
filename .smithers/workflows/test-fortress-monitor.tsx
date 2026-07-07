// smithers-source: user
// smithers-display-name: Test Fortress Monitor
// smithers-description: Health check for the test-fortress run — reads run + node state and rewrites a static HTML dashboard of done / in-flight / scheduled work. Meant to run on a */3 * * * * cron.
// smithers-tags: system, monitor, health, cron
// smithers-system: true
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  /** Which workflow's latest run to watch. */
  workflowId: z.string().default("test-fortress"),
  /** Where to write the dashboard, relative to the workspace root. */
  outPath: z.string().default(".smithers/test-fortress-status.html"),
  /** Explicit run id to watch (defaults to the latest matching run). */
  watchRunId: z.string().default(""),
});

const healthSchema = z.object({
  watchedRunId: z.string().nullable(),
  status: z.string(),
  done: z.number().int(),
  inFlight: z.number().int(),
  scheduled: z.number().int(),
  outPath: z.string(),
  wroteHtml: z.boolean(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  health: healthSchema,
});

const DONE_STATES = new Set(["finished", "succeeded", "failed", "cancelled", "skipped"]);
const ACTIVE_STATES = new Set([
  "running",
  "active",
  "retrying",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "paused",
]);

export default smithers((ctx) => {
  const workflowId = ctx.input.workflowId ?? "test-fortress";
  const outPath = ctx.input.outPath ?? ".smithers/test-fortress-status.html";
  const pinnedRunId = ctx.input.watchRunId ?? "";

  return (
    <Workflow name="test-fortress-monitor">
      <Task id="health" output={outputs.health}>
        {async () => {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const { execFileSync } = await import("node:child_process");

          const cwd = process.cwd();
          const cliPath = path.resolve(cwd, "apps/cli/src/index.js");
          const useLocalCli = fs.existsSync(cliPath);

          const runCli = (args: string[]): unknown => {
            const bin = useLocalCli ? process.execPath : "smithers";
            const argv = useLocalCli ? [cliPath, ...args] : args;
            const raw = execFileSync(bin, argv, {
              cwd,
              encoding: "utf-8",
              maxBuffer: 64 * 1024 * 1024,
              stdio: ["ignore", "pipe", "ignore"],
            });
            try {
              return JSON.parse(raw);
            } catch {
              return null;
            }
          };

          const esc = (s: string) =>
            String(s)
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");

          // 1) Find the run to watch.
          type PsRun = { id: string; workflowId?: string; status?: string; started?: string };
          let runId: string | null = pinnedRunId || null;
          let status = "unknown";
          if (!runId) {
            // High --limit: this workflow's own frequent ticks flood the recent
            // list, so the default limit-20 hides the target run entirely.
            const ps = runCli(["ps", "--json", "--limit", "500"]) as {
              runs?: PsRun[];
            } | null;
            const runs = ps?.runs ?? [];
            const matches = runs.filter((r) => r.workflowId === workflowId);
            // Prefer a live run over a finished/cancelled one of the same
            // workflow; ps is newest-first, so matches[0] is the fallback.
            const match =
              matches.find((r) => ACTIVE_STATES.has(r.status ?? "")) ?? matches[0];
            if (match) {
              runId = match.id;
              status = match.status ?? "unknown";
            }
          }

          // 2) Full plan tree (every planned task node) + per-node state.
          const planned: { id: string; kind: string }[] = [];
          const stateById = new Map<string, string>();

          if (runId) {
            const tree = runCli(["tree", runId, "--json"]) as
              | { root?: unknown; runState?: { state?: string } }
              | null;
            if (tree?.runState?.state) status = tree.runState.state;
            const walk = (node: unknown) => {
              if (!node || typeof node !== "object") return;
              const n = node as {
                type?: string;
                task?: { nodeId?: string; kind?: string };
                children?: unknown[];
              };
              if (n.type === "task" && n.task?.nodeId) {
                planned.push({ id: n.task.nodeId, kind: n.task.kind ?? "task" });
              }
              for (const child of n.children ?? []) walk(child);
            };
            walk((tree as { root?: unknown } | null)?.root);

            const inspect = runCli(["inspect", runId, "--json"]) as
              | { run?: { status?: string }; steps?: { id: string; state: string }[] }
              | null;
            if (inspect?.run?.status) status = inspect.run.status;
            for (const step of inspect?.steps ?? []) {
              stateById.set(step.id, step.state);
            }
          }

          // 3) Bucket every planned node.
          const done: { id: string; state: string }[] = [];
          const inFlight: { id: string; state: string }[] = [];
          const scheduled: { id: string; state: string }[] = [];
          const seen = new Set<string>();
          for (const node of planned) {
            if (seen.has(node.id)) continue;
            seen.add(node.id);
            const state = stateById.get(node.id);
            if (state && DONE_STATES.has(state)) done.push({ id: node.id, state });
            else if (state && ACTIVE_STATES.has(state)) inFlight.push({ id: node.id, state });
            else scheduled.push({ id: node.id, state: state ?? "pending" });
          }
          // Include any steps not present in the tree (e.g. dynamic loop iterations).
          for (const [id, state] of stateById) {
            if (seen.has(id)) continue;
            seen.add(id);
            if (DONE_STATES.has(state)) done.push({ id, state });
            else if (ACTIVE_STATES.has(state)) inFlight.push({ id, state });
            else scheduled.push({ id, state });
          }

          const now = new Date();
          const total = done.length + inFlight.length + scheduled.length;
          const pct = total > 0 ? Math.round((done.length / total) * 100) : 0;

          const section = (
            title: string,
            color: string,
            items: { id: string; state: string }[],
          ) =>
            `<section class="col">
      <h2 style="border-color:${color}">${title} <span class="count">${items.length}</span></h2>
      <ul>${
        items.length === 0
          ? '<li class="empty">— none —</li>'
          : items
              .map(
                (i) =>
                  `<li><code>${esc(i.id)}</code><span class="state" style="background:${color}22;color:${color}">${esc(i.state)}</span></li>`,
              )
              .join("")
      }</ul>
    </section>`;

          const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta http-equiv="refresh" content="30"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Test Fortress — ${esc(workflowId)}</title>
<style>
  :root{color-scheme:dark light}
  *{box-sizing:border-box}
  body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:24px;background:#0b0e14;color:#c9d1d9}
  header{display:flex;flex-wrap:wrap;gap:16px;align-items:baseline;margin-bottom:20px}
  h1{font-size:20px;margin:0}
  .meta{color:#7d8590}
  .bar{height:10px;border-radius:6px;background:#161b22;overflow:hidden;margin:10px 0 24px}
  .bar>i{display:block;height:100%;background:linear-gradient(90deg,#2ea043,#3fb950);width:${pct}%}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
  .col h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid;padding-bottom:6px;margin:0 0 8px;display:flex;justify-content:space-between}
  .count{background:#161b22;border-radius:10px;padding:0 8px;font-size:12px}
  ul{list-style:none;margin:0;padding:0;max-height:60vh;overflow:auto}
  li{display:flex;justify-content:space-between;gap:8px;padding:4px 6px;border-radius:6px}
  li:nth-child(odd){background:#0f141c}
  li.empty{color:#7d8590;justify-content:center}
  code{color:#c9d1d9;word-break:break-all}
  .state{border-radius:10px;padding:0 8px;font-size:11px;white-space:nowrap}
  a{color:#58a6ff}
</style></head>
<body>
  <header>
    <h1>🏰 Test Fortress</h1>
    <span class="meta">workflow <b>${esc(workflowId)}</b></span>
    <span class="meta">run <b>${esc(runId ?? "—")}</b></span>
    <span class="meta">status <b>${esc(status)}</b></span>
    <span class="meta">updated ${esc(now.toISOString())}</span>
    <span class="meta">auto-refresh 30s</span>
  </header>
  <div class="meta">${done.length}/${total} nodes complete — ${pct}%</div>
  <div class="bar"><i></i></div>
  <div class="grid">
    ${section("✅ Done", "#3fb950", done)}
    ${section("⚙️ In flight", "#d29922", inFlight)}
    ${section("🕒 Scheduled", "#8957e5", scheduled)}
  </div>
</body></html>`;

          const absOut = path.resolve(cwd, outPath);
          fs.mkdirSync(path.dirname(absOut), { recursive: true });
          fs.writeFileSync(absOut, html, "utf-8");

          return {
            watchedRunId: runId,
            status,
            done: done.length,
            inFlight: inFlight.length,
            scheduled: scheduled.length,
            outPath: absOut,
            wroteHtml: true,
          };
        }}
      </Task>
    </Workflow>
  );
});
