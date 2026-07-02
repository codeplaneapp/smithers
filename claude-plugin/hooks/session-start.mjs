#!/usr/bin/env node
// Smithers Claude Code plugin — SessionStart hook.
// Detects a .smithers/ project and injects a short note so Claude proactively
// reaches for Smithers, mirrors every run into /workflows via the plugin's
// generic smithers-run.mjs script, and builds a live UI, instead of
// hand-rolling agents with the native Workflow / Task / Agent tools.
// Dependency-free: uses only Node built-ins. Never throws — a hook that errors
// must not break the session, so all failures degrade to "no context injected".

import { readdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function listKeys(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".tsx") || f.endsWith(".mdx") || f.endsWith(".ts"))
      .map((f) => f.replace(/\.(tsx|mdx|ts)$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function pluginRoot() {
  const fromEnv = process.env.CLAUDE_PLUGIN_ROOT;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  // This file lives at <plugin-root>/hooks/session-start.mjs.
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return "";
  }
}

// Best-effort count of non-terminal runs so Claude offers to re-attach
// mirrors. Hard 2s cap: a slow or missing CLI must not stall session start.
function countActiveRuns() {
  try {
    const result = spawnSync("bunx", ["smithers-orchestrator", "ps", "--format", "json"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.status !== 0 || !result.stdout) {
      return undefined;
    }
    const parsed = JSON.parse(result.stdout);
    const runs = Array.isArray(parsed?.runs) ? parsed.runs : [];
    const terminal = new Set(["finished", "failed", "cancelled", "continued"]);
    return runs.filter((run) => !terminal.has(String(run.dbStatus ?? run.status ?? ""))).length;
  } catch {
    return undefined;
  }
}

function emit(additionalContext) {
  // Claude Code SessionStart hook output. additionalContext is added to the
  // session context before the first prompt. Empty string => nothing injected.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }),
  );
}

try {
  const cwd = process.cwd();
  const smithersDir = join(cwd, ".smithers");
  if (!existsSync(smithersDir) || !statSync(smithersDir).isDirectory()) {
    emit("");
    process.exit(0);
  }

  const workflows = listKeys(join(smithersDir, "workflows"));
  const uis = new Set(listKeys(join(smithersDir, "ui")));
  const mirrorScript = join(pluginRoot(), "workflows", "smithers-run.mjs");
  const activeRuns = countActiveRuns();

  const lines = [];
  lines.push(
    "This project uses Smithers (a durable control plane for long-running coding agents).",
  );
  lines.push(
    "You operate Smithers via the `smithers` MCP tools (list_workflows, run_workflow, watch_run, resolve_approval, ...) and the `smithers` CLI. You are the orchestrator: run multi-step / long-running / background work THROUGH a Smithers workflow, NOT through your own ad-hoc orchestration (Task/Agent fan-outs, `/loop`, hand-written Workflow scripts).",
  );
  lines.push(
    `LIVE VIEW RULE: every Smithers run you start or attach to gets a live /workflows mirror. Launch runs with the native Workflow tool pointed at the plugin's generic mirror script: Workflow({ scriptPath: ${JSON.stringify(mirrorScript)}, args: { workflow: "<id>", input: { ... } } }) — it starts the detached run itself and mirrors it node-by-node. Attach to an existing run with args: { runId: "<run-id>" }. This is the ONLY sanctioned use of the native Workflow tool; the durable work always lives in the Smithers engine (stopping the mirror never stops the run).`,
  );
  if (typeof activeRuns === "number" && activeRuns > 0) {
    lines.push(
      `There ${activeRuns === 1 ? "is 1 non-terminal Smithers run" : `are ${activeRuns} non-terminal Smithers runs`} in this project (see \`smithers ps\`). Offer to re-attach a /workflows mirror with args: { runId }.`,
    );
  }

  if (workflows.length) {
    const withUi = workflows.map((w) => (uis.has(w) ? w : `${w} (NO UI yet)`));
    lines.push(`Workflows in .smithers/workflows: ${withUi.join(", ")}.`);
  } else {
    lines.push("No workflows in .smithers/workflows yet.");
  }

  lines.push(
    "MANDATORY UI RULE: every workflow you create or run MUST have a custom live UI at .smithers/ui/<key>.tsx built with the `smithers-orchestrator/gateway-react` package (import ONLY from `react` + `smithers-orchestrator/gateway-react`), and you MUST launch it (`smithers ui <runId>`) so the human can watch the run. Any workflow marked 'NO UI yet' above needs one. See the `smithers` skill for the exact authoring contract.",
  );
  lines.push(
    "WORKFLOW AUTHORING RULE: ALWAYS use https://smithers.sh/llms-full.txt as the API reference when creating or editing Smithers workflows — fetch it (WebFetch) before writing workflow code. Offline fallback: `bunx smithers-orchestrator docs-full`.",
  );

  emit(lines.join("\n"));
} catch {
  emit("");
}
