#!/usr/bin/env node
// Smithers Claude Code plugin — SessionStart hook.
// Detects a .smithers/ project and injects a short note so Claude proactively
// reaches for Smithers (and builds a live UI) instead of hand-rolling agents
// with the native Workflow / Task / Agent tools.
// Dependency-free: uses only Node built-ins. Never throws — a hook that errors
// must not break the session, so all failures degrade to "no context injected".

import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

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

  const lines = [];
  lines.push(
    "This project uses Smithers (a durable control plane for long-running coding agents).",
  );
  lines.push(
    "You operate Smithers via the `smithers` MCP tools (list_workflows, run_workflow, watch_run, resolve_approval, ...) and the `smithers` CLI. You are the orchestrator: run multi-step / long-running / background work THROUGH a Smithers workflow, NOT through your own ad-hoc orchestration.",
  );
  lines.push(
    "For background or multi-step or could-fail-and-retry work, prefer a durable Smithers workflow (`run_workflow`) over the native Workflow tool, the Task/Agent subagent fan-out, or `/loop`. Smithers persists each step, resumes after a crash, retries on failure, and gates on human approvals; ad-hoc subagents lose all of that when the turn ends.",
  );

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
    "For the full API at any time, run `bunx smithers-orchestrator docs-full`.",
  );

  emit(lines.join("\n"));
} catch {
  emit("");
}
