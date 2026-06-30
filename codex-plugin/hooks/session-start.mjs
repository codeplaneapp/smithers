#!/usr/bin/env node
// Smithers Codex plugin — SessionStart hook.
// Detects a .smithers/ project and injects a short note so Codex proactively
// reaches for Smithers (and builds a live UI) instead of hand-rolling agents.
// Dependency-free: uses only Node built-ins. Never throws — a hook that errors
// must not break the session, so all failures degrade to "no context injected".

import { readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, parse as parsePath } from "node:path";

const MAX_LISTED = 12; // cap the inline list; Codex can call list_workflows for the rest

function emit(additionalContext) {
  // Claude-compatible SessionStart hook output. Codex injects additionalContext
  // into the session preamble. Empty string => nothing injected.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }),
  );
}

// Read the hook event JSON from stdin (codex/claude pass it there). Guarded so a
// manual run with no piped input never hangs. Resolves to {} on anything weird.
function readStdinEvent() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let data = "";
    const done = (val) => {
      clearTimeout(timer);
      try {
        process.stdin.removeAllListeners();
      } catch {}
      resolve(val);
    };
    const timer = setTimeout(() => done({}), 250);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => {
      try {
        done(data.trim() ? JSON.parse(data) : {});
      } catch {
        done({});
      }
    });
    process.stdin.on("error", () => done({}));
  });
}

// Walk up from `start` until a directory containing `.smithers/` is found.
function findSmithersRoot(start) {
  let dir = start;
  const { root } = parsePath(dir);
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, ".smithers");
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return dir;
    } catch {}
    if (dir === root) break;
    dir = dirname(dir);
  }
  return undefined;
}

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

try {
  const event = await readStdinEvent();
  const startDir =
    (typeof event.cwd === "string" && event.cwd) ||
    (typeof event.workspaceRoot === "string" && event.workspaceRoot) ||
    process.cwd();

  const root = findSmithersRoot(startDir);
  if (!root) {
    emit("");
    process.exit(0);
  }

  const smithersDir = join(root, ".smithers");
  const workflows = listKeys(join(smithersDir, "workflows"));
  const uis = new Set(listKeys(join(smithersDir, "ui")));
  const missingUi = workflows.filter((w) => !uis.has(w));

  const lines = [];
  lines.push(
    "This project uses Smithers (durable control plane for long-running coding agents).",
  );
  lines.push(
    "You operate Smithers via the `smithers` MCP tools (list_workflows, run_workflow, watch_run, resolve_approval, ...) and the `smithers` CLI (or `bunx smithers-orchestrator <cmd>` if `smithers` is not on PATH). You are the orchestrator: run multi-step / long-running / background work THROUGH Smithers, not through your own ad-hoc subagents.",
  );

  if (workflows.length) {
    const shown = workflows.slice(0, MAX_LISTED).join(", ");
    const more = workflows.length > MAX_LISTED ? `, +${workflows.length - MAX_LISTED} more (call list_workflows for the full set)` : "";
    lines.push(`${workflows.length} workflow(s) in .smithers/workflows: ${shown}${more}.`);
    if (missingUi.length) {
      const shownMissing = missingUi.slice(0, MAX_LISTED).join(", ");
      const moreMissing = missingUi.length > MAX_LISTED ? `, +${missingUi.length - MAX_LISTED} more` : "";
      lines.push(`${missingUi.length} of them have NO custom UI yet: ${shownMissing}${moreMissing}.`);
    }
  } else {
    lines.push("No workflows in .smithers/workflows yet.");
  }

  lines.push(
    "MANDATORY UI RULE: every workflow you create or run MUST have a custom live UI at .smithers/ui/<key>.tsx built with the `smithers-orchestrator/gateway-react` package (import only from `react` + `smithers-orchestrator/gateway-react`), and you MUST launch it (`smithers ui <runId>`) so the human can watch the run. Any workflow listed above as having no UI needs one. See the `smithers` skill for the exact authoring contract.",
  );

  emit(lines.join("\n"));
} catch {
  emit("");
}
