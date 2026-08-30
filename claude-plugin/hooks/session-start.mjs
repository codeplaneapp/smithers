#!/usr/bin/env node
// Smithers Claude Code plugin: the SessionStart hook.
// Detects a Smithers 1.0 project and injects a short note so Claude reaches
// for Smithers, and mirrors every run into /workflows through the plugin's
// generic smithers-run.mjs script, instead of hand-rolling agents with the
// native Workflow / Task / Agent tools.
// Dependency-free: uses only Node built-ins. Never throws, because a hook that errors
// must not break the session, so all failures degrade to "no context injected".

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSmithersCli, resolveSmithersShellCommand } from "../lib/resolve-smithers-cli.mjs";

/**
 * The CLI command `workflows/smithers-run.mjs` falls back to when the mirror is
 * launched without an explicit `cli` argument. Passing that same string again
 * would be noise, so the hook only names a CLI that differs from it.
 *
 * Kept in step with the mirror by `workflows/smithers-run.test.mjs`; the mirror
 * is a sandboxed Workflow script and cannot import this constant.
 */
export const MIRROR_DEFAULT_CLI = "npx --package @smthrs/cli smithers";

/** Statuses a run never leaves. `continued` is not one: rc.0 has no such status. */
export const TERMINAL_RUN_STATUSES = ["cancelled", "completed", "failed"];

/** The directory a 1.0 project keeps its flows in, relative to the project root. */
export const FLOWS_DIRECTORY = "flows";

/**
 * How long the hook waits on a CLI probe before giving up on it.
 *
 * The 0.x hook allowed two seconds. That was never a measurement, and it is
 * wrong for this CLI: a source checkout strips types on every start, so `ls`
 * and `ps` each take about five seconds cold, and a two-second cap silently
 * reported every project as having no flows. The two probes therefore run
 * concurrently under one budget wide enough for a loaded machine, and
 * `SMITHERS_HOOK_TIMEOUT_MS` overrides it. The budget only bites when the CLI
 * is genuinely wedged; a healthy one answers well inside it.
 */
export const PROBE_TIMEOUT_MS = Number.parseInt(process.env.SMITHERS_HOOK_TIMEOUT_MS ?? "", 10) || 15000;

/** Reserved flow ids the CLI always projects; they say nothing about a project. */
const isProjectFlow = (flowId) => typeof flowId === "string" && !flowId.startsWith("system/");

/**
 * Runs one CLI subcommand and resolves its parsed JSON, or undefined when the
 * command is missing, slow, failing, or not printing JSON. The timeout is a
 * hard kill, so a wedged CLI cannot stall session start.
 *
 * @param {{ command: string, args: string[] }} cli
 * @param {string[]} argv
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
export function probeJson(cli, argv, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cli.command, [...cli.args, ...argv, "--json"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutMs,
      });
    } catch {
      resolve(undefined);
      return;
    }
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if (code !== 0 || out === "") return resolve(undefined);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(undefined);
      }
    });
  });
}

/**
 * The project flows `smithers ls` discovered, sorted, with the reserved
 * `system/*` entries dropped. Undefined means the probe could not answer.
 *
 * @param {{ command: string, args: string[] }} cli
 * @returns {Promise<string[] | undefined>}
 */
export async function listProjectFlows(cli) {
  const parsed = await probeJson(cli, ["ls"]);
  const items = Array.isArray(parsed?.items) ? parsed.items : undefined;
  if (items === undefined) return undefined;
  return items
    .map((item) => item?.flowId)
    .filter(isProjectFlow)
    .sort();
}

/**
 * Non-terminal runs in this project, as `smithers ps --json` reports them.
 * Undefined means the probe could not answer.
 *
 * @param {{ command: string, args: string[] }} cli
 * @returns {Promise<number | undefined>}
 */
export async function countActiveRuns(cli) {
  const parsed = await probeJson(cli, ["ps"]);
  const items = Array.isArray(parsed?.items) ? parsed.items : undefined;
  if (items === undefined) return undefined;
  const terminal = new Set(TERMINAL_RUN_STATUSES);
  return items.filter((run) => !terminal.has(String(run?.status ?? ""))).length;
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

function hasFlowsDirectory(root) {
  try {
    return existsSync(join(root, FLOWS_DIRECTORY)) && statSync(join(root, FLOWS_DIRECTORY)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The context block for a project, or the empty string when this is not a
 * Smithers project. Pure apart from the two probes it is handed, so the test
 * suite drives it with a scripted CLI instead of a live engine.
 *
 * @param {{
 *   cwd: string,
 *   cli: { command: string, args: string[], source: string, root: string | null },
 *   cliCommand: string,
 *   mirrorScript: string,
 *   flows: string[] | undefined,
 *   activeRuns: number | undefined,
 * }} context
 * @returns {string}
 */
export function buildContext(context) {
  const { activeRuns, cli, cliCommand, cwd, flows, mirrorScript } = context;
  const hasFlows = Array.isArray(flows) && flows.length > 0;
  if (!hasFlows && !hasFlowsDirectory(cwd)) return "";

  const mirrorCliArg = cliCommand === MIRROR_DEFAULT_CLI ? "" : `cli: ${JSON.stringify(cliCommand)}, `;
  const lines = [];
  lines.push("This project uses Smithers (a durable control plane for long-running coding agents).");
  lines.push(
    "You operate Smithers through the `smithers` MCP tools (list_workflows, run_workflow, watch_run, " +
      "get_run, get_run_events, list_pending_approvals, resolve_approval, ...) and the `smithers` CLI. " +
      "You are the orchestrator: run multi-step, long-running, or background work THROUGH a Smithers flow, " +
      "NOT through your own ad-hoc orchestration (Task/Agent fan-outs, `/loop`, hand-written Workflow scripts). " +
      "Do a clear single-goal ask directly with your ordinary tools. Reserve a durable flow for work that " +
      "genuinely needs ordered stages, durability, approvals, loops, or reuse.",
  );
  lines.push(
    "AUTHORING MODEL: a flow is TypeScript or Markdown under `flows/<name>/`, built from `Flow.make`, " +
      "`Action.make`, and Effect. There is no JSX authoring API, no `<Task>`, and no React reconciler. " +
      `Run one with \`${cliCommand} up <flow> --data '{...}'\`, or plan it first with ` +
      `\`${cliCommand} plan <flow>\` and hand the printed approval payload to \`${cliCommand} approve\` and ` +
      `\`${cliCommand} run\`.`,
  );
  lines.push(
    `LIVE VIEW RULE: every Smithers run you start or attach to gets a live /workflows mirror. Launch runs ` +
      `with the native Workflow tool pointed at the plugin's generic mirror script: ` +
      `Workflow({ scriptPath: ${JSON.stringify(mirrorScript)}, args: { ${mirrorCliArg}flow: "<flow-id>", ` +
      `data: { ... } } }). It starts the detached run itself and mirrors it node by node. Attach to an ` +
      `existing run with args: { ${mirrorCliArg}runId: "<run-id>" }. This is the ONLY sanctioned use of the ` +
      `native Workflow tool; the durable work always lives in the Smithers engine (stopping the mirror never ` +
      `stops the run).`,
  );
  if (cli.source === "workspace") {
    lines.push(
      `SOURCE-CHECKOUT RULE: this project IS the Smithers source tree (${cli.root}). Every smithers command ` +
        `you run must execute the working tree, so invoke it as \`${cliCommand}\` (or plain \`smithers\`, ` +
        `which delegates to the same entry), never a package-runner invocation of the published CLI, which ` +
        `runs the released build instead of the code under edit. Running from source needs \`pnpm install\` ` +
        `and nothing else.`,
    );
  }
  if (typeof activeRuns === "number" && activeRuns > 0) {
    lines.push(
      `There ${activeRuns === 1 ? "is 1 non-terminal Smithers run" : `are ${activeRuns} non-terminal Smithers runs`}` +
        ` in this project (see \`${cliCommand} ps\`). Offer to re-attach a /workflows mirror with args: { runId }.`,
    );
  }
  lines.push(
    hasFlows
      ? `Flows in ${FLOWS_DIRECTORY}/: ${flows.join(", ")}.`
      : `No flows in ${FLOWS_DIRECTORY}/ yet. Scaffold one with \`${cliCommand} init <name>\`.`,
  );
  lines.push(
    `AUTHORING REFERENCE: read https://smithers.sh/llms-full.txt (WebFetch) before writing or editing flow ` +
      `code. Offline fallback: \`${cliCommand} docs --full\`.`,
  );
  return lines.join("\n");
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

/** True when this module was executed rather than imported by the test suite. */
const executed = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (executed) {
  try {
    const cwd = process.cwd();
    // The mirror's own default resolves the published CLI, which is a
    // bin-NAME lookup another package can answer for. So whenever this project
    // resolves to an identified CLI, a source checkout, an installed package,
    // or one on PATH, name it explicitly. Only a machine with no install at
    // all is left on the default. See lib/resolve-smithers-cli.mjs.
    const cli = resolveSmithersCli(cwd);
    // Concurrently, because each probe costs a CLI start and a session start
    // should pay for one of them, not two.
    const [flows, activeRuns] = await Promise.all([listProjectFlows(cli), countActiveRuns(cli)]);
    emit(
      buildContext({
        cwd,
        cli,
        cliCommand: resolveSmithersShellCommand(cwd),
        mirrorScript: join(pluginRoot(), "workflows", "smithers-run.mjs"),
        flows,
        activeRuns,
      }),
    );
  } catch {
    emit("");
  }
}
