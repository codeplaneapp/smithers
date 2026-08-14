import { spawn, spawnSync } from "node:child_process";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { isRecord, toolSpecs } from "./toolSpecs.js";

const MAX_OUTPUT_CHARS = 6000;

export default definePluginEntry({
  id: "smithers",
  name: "Smithers",
  description:
    "Drive durable Smithers workflows from OpenClaw, create reusable workflows for repeated work, and improve them with evals plus optimization.",
  register(api) {
    for (const spec of toolSpecs) {
      api.registerTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        async execute(_callId, params = {}) {
          try {
            const cli = await runSmithers(spec.toArgs(params), { timeoutMs: spec.timeoutMs });
            return renderToolResult(cli, {
              next_step:
                "Inspect or watch the run, clear gates only after relaying them to the human, and convert repeatable work into a workflow with evals.",
            });
          } catch (error) {
            return renderToolResult({
              ok: false,
              exitCode: 1,
              stdout: "",
              stderr: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
    }

    if (typeof api.on === "function") {
      api.on(
        "before_prompt_build",
        async () => {
          const ps = await runSmithers(["ps", "--json"], { timeoutMs: 8_000 });
          return { appendContext: buildPromptContext(ps) };
        },
        { priority: -20, timeoutMs: 10_000 },
      );
    }
  },
});

function commandExists(command) {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 1000 });
  return !probe.error;
}

function smithersCommand() {
  if (process.env.SMITHERS_BIN?.trim()) return [process.env.SMITHERS_BIN];
  if (commandExists("smithers")) return ["smithers"];
  if (commandExists("bunx")) return ["bunx", "smthrs"];
  if (commandExists("npx")) return ["npx", "smthrs"];
  return ["smithers"];
}

function runSmithers(args, options = {}) {
  const [command, ...baseArgs] = smithersCommand();
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, [...baseArgs, ...args], {
      env: process.env,
      cwd: typeof options.cwd === "string" ? options.cwd : process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      resolve({ ok: false, exitCode: 124, stdout, stderr: `smithers timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = clip(stdout + chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = clip(stderr + chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, exitCode: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function clip(value) {
  return value.length <= MAX_OUTPUT_CHARS ? value : value.slice(value.length - MAX_OUTPUT_CHARS);
}

function parseJsonMaybe(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const starts = [trimmed.indexOf("{"), trimmed.indexOf("[")].filter((idx) => idx >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {}
  }
  return undefined;
}

function renderToolResult(cli, extra = {}) {
  const parsed = parseJsonMaybe(cli.stdout);
  const payload = {
    ok: cli.ok,
    exit_code: cli.exitCode,
    ...extra,
  };
  if (parsed !== undefined) payload.result = parsed;
  else if ((cli.stdout || cli.stderr).trim()) payload.output = clip((cli.stdout || cli.stderr).trim());
  if (!cli.ok && cli.stderr.trim()) payload.error = clip(cli.stderr.trim());
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function buildPromptContext(ps) {
  const base = [
    "Smithers operating policy:",
    "- For any repeatable, multi-step, background, or human-in-the-loop task, create or run a Smithers workflow instead of repeatedly improvising in the chat.",
    "- When no workflow fits, call smithers_create_workflow and include inputs, done condition, verification, and where human approvals should happen.",
    "- Improve workflows with evidence: keep eval cases under .smithers/evals, run smithers_eval before and after changes, and use smithers_optimize when scores expose prompt gaps.",
    "- Keep the human informed by watching runs, clearing gates only after asking them, and opening or building a Smithers UI for long-running work.",
  ];
  const live = summarizeRuns(parseJsonMaybe(ps.stdout));
  if (live) base.push(live);
  return base.join("\n");
}

function summarizeRuns(parsed) {
  const runs = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.runs) ? parsed.runs : [];
  if (!runs.length) return "";
  const active = [];
  const paused = [];
  const approvals = [];
  for (const run of runs) {
    if (!isRecord(run)) continue;
    const runId = String(run.runId ?? run.id ?? "?");
    const name = String(run.workflow ?? run.workflowKey ?? run.name ?? "workflow");
    const status = String(run.status ?? "").toLowerCase();
    if (status === "running" || status === "active") active.push(`${runId} (${name})`);
    if (status.includes("paused") || status.includes("waiting") || status.includes("suspended")) {
      paused.push(`${runId} (${name}, ${status})`);
    }
    const gates = Array.isArray(run.pendingApprovals) ? run.pendingApprovals : [];
    for (const gate of gates) {
      if (!isRecord(gate)) continue;
      approvals.push(`${runId}:${String(gate.nodeId ?? gate.node ?? "?")}`);
    }
  }
  if (!active.length && !paused.length && !approvals.length) return "";
  const lines = ["Live Smithers runs:"];
  if (active.length) lines.push(`- active: ${active.join(", ")}`);
  if (paused.length) lines.push(`- paused: ${paused.join(", ")}`);
  if (approvals.length) lines.push(`- pending approvals: ${approvals.join(", ")}`);
  return lines.join("\n");
}
